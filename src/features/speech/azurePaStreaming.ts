/**
 * 録音中ストリーミング発音評価（DESIGN.md §5・§6a M11）。
 *
 * batch方式（azurePaUnscripted.assessSpeech: 録音停止後に接続→一括送信→認識）と違い、
 * **録音開始時に** SDKロード→WebSocket事前接続→continuous認識開始まで済ませ、
 * マイクの16kHz PCM16チャンクを逐次pushする。録音停止時は pushStream.close() して
 * 確定結果を待つだけになり、「発音を評価中」の体感が1〜2秒に短縮される。
 *
 * 失敗契約（DESIGN.md §6a）: このモジュールは原則**内部層としてthrowする**。
 * 呼び出し側（voiceCapture.ts→useConversation）はthrow/失敗時に録音済みBlobから
 * 既存のbatch評価へ自動フォールバックする。「throwせずpa.azureErrorで返す」PaResult契約は
 * フォールバック先のassessSpeechが最終的に保証する。
 * 例外（M12補修）: unscriptedのタイムアウトで部分テキスト最終サルベージが成立する場合のみ、
 * throwせず pa.azureError 入りの AssessSpeechResult を返す（resolveFinishSalvage 'text-only'。
 * スコアは欠損だが会話は継続できる）。
 *
 * 韻律（プロソディ）: 当日キャッシュ（shouldSkipProsody・appState paProsodyFallback）で
 * 事前判定するのみで、ストリーミング内での韻律なしリトライは行わない（音声を再送できないため）。
 * 韻律起因で失敗した場合はbatchへフォールバックし、batch側の既存ロジックがリトライと
 * キャッシュ書き込みを行う → 翌ターン以降のストリーミングはキャッシュにより韻律なしで
 * 開始する（自己回復）。
 *
 * iOS Safariの後片付けバグ対策（privSource.turnOff）は azurePaUnscripted.ts の
 * swallowTeardownError / resolveRecognitionOutcome を共有する。
 */

import { learningDate } from '../../lib/dates';
import {
  aggregatePhraseAssessments,
  AzurePronunciationAuthError,
  AzurePronunciationNetworkError,
  AzurePronunciationNoResultError,
  AzurePronunciationTimeoutError,
  AzureSpeechKeyMissingError,
  hasProsodyFailedInSession,
  isTransientPaError,
  makeFailurePaResult,
  markProsodyFailureInSession,
  resolveRecognitionOutcome,
  shouldSkipProsody,
  swallowTeardownError,
  toPhraseAssessment,
  truncateDetail,
  type AssessSpeechResult,
  type AzureDetailResultLike,
  type PhraseAssessment,
} from './azurePaUnscripted';
import { logPaDebug } from './paDebugLog';

export interface StreamingPaOptions {
  mode: 'unscripted' | 'scripted';
  /** scripted時は必須（キーフレーズ文）。 */
  referenceText?: string;
  /** 認識の文脈補助（§6a。PhraseListGrammar）。 */
  phraseHints?: string[];
}

export interface StreamingPaSession {
  /** 16kHz mono PCM16を追記する。finish/abort後の呼び出しは無視される。 */
  writeChunk(pcm16: ArrayBuffer): void;
  /** これまでに書き込んだ音声の秒数（usageLog加算用）。 */
  audioSeconds(): number;
  /**
   * ストリームを閉じて確定結果を待つ（多重呼び出しは同じPromiseを返す）。
   * 失敗（接続断・韻律非対応・結果ゼロ・タイムアウト）はthrowする（呼び出し側がbatchへ）。
   * ただしunscriptedのタイムアウトで部分テキスト最終サルベージが成立する場合は、
   * throwせず pa.azureError 入り（スコア欠損）で返す（ファイル冒頭の失敗契約参照）。
   */
  finish(): Promise<AssessSpeechResult>;
  /** セッションを破棄する（結果は返らない）。何度呼んでも安全。 */
  abort(): void;
}

/** セッションの状態（純関数nextSessionStateで遷移。終端状態は不変）。 */
export type StreamingSessionState = 'connecting' | 'streaming' | 'finishing' | 'done' | 'failed' | 'aborted';
export type StreamingSessionEvent =
  | 'connected'
  | 'finishRequested'
  | 'settledOk'
  | 'settledError'
  | 'abortRequested';

/**
 * セッション状態遷移の純関数（Vitest対象）。
 * - done/failed/aborted は終端で不変（abortの冪等性を含む）
 * - finishRequested は connecting/streaming のどちらからでも finishing へ
 * - settledOk は finishing からのみ done へ（二重finishの整合）
 */
export function nextSessionState(
  state: StreamingSessionState,
  event: StreamingSessionEvent,
): StreamingSessionState {
  if (state === 'done' || state === 'failed' || state === 'aborted') return state;
  switch (event) {
    case 'connected':
      return state === 'connecting' ? 'streaming' : state;
    case 'finishRequested':
      return 'finishing';
    case 'settledOk':
      return state === 'finishing' ? 'done' : state;
    case 'settledError':
      return 'failed';
    case 'abortRequested':
      return 'aborted';
  }
}

/**
 * 診断ログ用: 最初のPCM書き込みからclose までの実経過秒（'?'は書き込みなし）。
 * バイト数から算出した音声秒数がこれを大きく超えていたら、PCMの二重流入や
 * サンプルレート不整合を疑う（M12補修でマイクタップ多重張りを検出した指標）。
 */
function liveSeconds(firstWriteMs: number | null, tClose: number): string {
  return firstWriteMs === null ? '?' : `${((tClose - firstWriteMs) / 1000).toFixed(1)}s`;
}

/** 16kHz mono PCM16のバイト数→秒数（32000バイト/秒）。純関数。 */
export function pcmBytesToSeconds(bytes: number): number {
  return bytes / 32000;
}

/**
 * 認識の「純粋な遅れ」秒を求める純関数（診断用。DESIGN.md §6a-2）。
 *
 * 初回認識の壁時計（最初のPCM書き込みからの経過）から、その認識結果が音声の何秒目の
 * 発話だったか（Azureが返す offset）を引く。マイクを押してから話し出すまでの無音時間が
 * 差し引かれるため、「音声の届き＋サービス側処理がどれだけ実時間から遅れているか」だけが残る。
 * 0.5秒前後ならストリーミングは健全（無音で待っていただけ）。数秒あれば送信経路かサービス側が
 * 実時間に追いついていない。値が揃わない場合はnull。
 */
export function recognitionLagSeconds(
  firstEventFromWriteMs: number | null,
  firstEventAudioOffsetSec: number | null,
): number | null {
  if (firstEventFromWriteMs === null || firstEventAudioOffsetSec === null) return null;
  return firstEventFromWriteMs / 1000 - firstEventAudioOffsetSec;
}

/**
 * Speech SDKチャンクの事前読み込み（約100KB gz）。会話画面のマウント時に呼び、
 * 初回録音時のSDK動的importコストを排除する。失敗は無視する（実行時に再importされる）。
 */
export function prewarmSpeechSdk(): void {
  void import('microsoft-cognitiveservices-speech-sdk').catch(() => {});
}

/**
 * 認識イベントを1件でも受けている（=セッションが生きている証拠あり）ときの確定待ち上限（DESIGN.md §6a-2）。
 * scripted（韻律あり短文）のclose→確定は<0.4s、unscripted（韻律なし会話）でも数秒で確定する見込み。
 * 8秒で見切り、録音中に集めた部分結果があればサルベージして返す（旧45秒→batch二重払いの廃止）。
 * batchフォールバックはF0では自由会話で60秒級と実測されており実質役に立たないため、ここで粘って
 * 確定を待つ方がよい（全体は submitVoice の15秒デッドラインで必ず頭打ちになる）。
 */
export const FINISH_TIMEOUT_WITH_EVIDENCE_MS = 8_000;
/**
 * unscriptedの確定待ち上限の上限側（音声長連動の頭打ち。DESIGN.md §6a-2）。
 * F0の確定遅延は音声長にほぼ比例して伸びる（実測: 音声3.4s→close→確定3.4s、
 * 音声12.7s→8秒でも末尾5.3s未確定）。長い発話ほど待つ側に寄せた方が、
 * 「8秒で見切ってbatch（残り時間で完了しない）」より結果が返る確率が高い。
 * submitVoiceの15秒デッドラインを超えないよう13秒で頭打ちにする。
 */
export const FINISH_TIMEOUT_MAX_MS = 13_000;
/**
 * scripted（キーフレーズ予習の短文・韻律あり）の確定待ち上限。close→確定は<0.4s実測で、
 * batchフォールバックも短文なら数秒で終わるため、unscriptedのように8秒粘る理由がない
 * （8秒はF0のbatchが無力なunscripted専用の粘り）。
 */
export const FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS = 4_000;
/** 認識イベントが1件も無い（=WS死亡の疑い）ときの確定待ち上限。ゼロチャンク即断もあるため短めでよい。 */
export const FINISH_TIMEOUT_NO_EVIDENCE_MS = 3_000;

/**
 * startContinuousRecognitionAsyncの完了待ち上限。WSハンドシェイクがハングすると成功・失敗どちらの
 * コールバックも呼ばれず、voiceCapture側の sessionPromise 待ちが無期限化する（=「評価中」が
 * 永遠に終わらない）ため、上限を張って必ず決着させる。タイムアウト時はcloseAll（事前openした
 * WSの解放）のうえthrowし、呼び出し側がbatchへフォールバックする。
 */
export const START_TIMEOUT_MS = 10_000;

/**
 * close後この時間まで確定しなければ、能動的に stopContinuousRecognitionAsync を叩いて
 * 確定を促す（nudge）。WSがclose後にストールしても sessionStopped を強制的に引き出すための一手
 * （現状は sessionStopped ハンドラ内でしか stop を呼んでおらず、ストール時に確定手段が無かった）。
 */
export const NUDGE_AFTER_CLOSE_MS = 2_000;

/**
 * タイムアウト時に部分結果をサルベージしてよい「未カバー末尾秒数」の上限（DESIGN.md §6a-2）。
 * サルベージしたテキストが発話末尾を大きく取りこぼしていると、AIが不完全な発話に返信してしまう
 * （スコア欠損より深刻）。総音声秒数とフレーズduration合計の差がこの値を超えるならサルベージせずbatchへ。
 */
export const SALVAGE_MAX_UNCOVERED_TAIL_SEC = 3;

/**
 * finishの確定待ちタイムアウトを決める純関数（DESIGN.md §6a-2）。
 * 進捗の証拠（recognizing/recognizedイベント）があれば、サルベージ前提でやや長めに待つ。
 * scriptedは短文で確定が速くbatchも実用的なため、unscriptedより短い上限（4s）にする。
 * unscriptedは音声長に連動させ、8秒（下限）〜13秒（上限）の範囲で待つ:
 * F0の確定遅延は音声長にほぼ比例するため、長い発話を8秒固定で見切るとbatch（残り時間で
 * 完了しない）に落ちて必ずエラーになっていた。audioSeconds未指定なら従来の8秒。
 */
export function finishTimeoutMs(
  mode: 'unscripted' | 'scripted',
  hasRecognitionEvidence: boolean,
  audioSeconds = 0,
): number {
  if (!hasRecognitionEvidence) return FINISH_TIMEOUT_NO_EVIDENCE_MS;
  if (mode === 'scripted') return FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS;
  return Math.min(
    FINISH_TIMEOUT_MAX_MS,
    Math.max(FINISH_TIMEOUT_WITH_EVIDENCE_MS, Math.round(audioSeconds * 1000)),
  );
}

/**
 * タイムアウト時に、録音中に集めた部分フレーズをサルベージしてよいかの純関数（Vitest対象）。
 * - フレーズ0件: サルベージ不可（batchへ）
 * - フレーズあり かつ 未カバー末尾（総音声秒数 − フレーズduration合計）が閾値以内: サルベージOK
 * - 未カバー末尾が閾値超（＝末尾が大きく切れている疑い）: サルベージせずbatchへ
 * durationTicksは100ns単位（Azure RecognitionResult.duration と同じ）。負値は0とみなす。
 */
export function canSalvagePartial(
  phrases: Pick<PhraseAssessment, 'durationTicks'>[],
  audioSeconds: number,
): boolean {
  if (phrases.length === 0) return false;
  const coveredSeconds = phrases.reduce((sum, p) => sum + Math.max(0, p.durationTicks), 0) / 1e7;
  return audioSeconds - coveredSeconds <= SALVAGE_MAX_UNCOVERED_TAIL_SEC;
}

/** finishの確定待ち終了後、結果をどう組み立てるかの判定結果（resolveFinishSalvage）。 */
export type FinishSalvageDecision =
  | { kind: 'scores' }
  | { kind: 'scores-with-tail'; tailText: string }
  | { kind: 'text-only'; text: string }
  | { kind: 'throw-timeout' }
  | { kind: 'throw-no-result' };

/**
 * finishの確定待ち終了後の結果組み立てを決める純関数（DESIGN.md §6a-2。Vitest対象）。
 * 前提: recognitionErrorの伝播（フレーズ0件+エラー→throw）はresolveRecognitionOutcomeで処理済み。
 *
 * - 非タイムアウト（正常確定）: フレーズありなら 'scores'、0件なら 'throw-no-result'（無音等）
 * - タイムアウト・フレーズあり:
 *   - 末尾カバー良好（canSalvagePartial）→ 'scores'（従来のスコア付きサルベージ）
 *   - 末尾が大きく欠け → unscriptedで新鮮な部分テキストがあれば 'scores-with-tail'
 *     （スコアは確定分の実測のまま、認識テキストだけ尻尾を補完）。なければ 'throw-timeout'
 *     — Azureは末尾を処理中のまま時間切れなので、同じ音声を送り直すbatchも残り時間で
 *     完了しない（実測: 7秒待って必ずデッドライン失敗）。timeout種別で返して
 *     shouldSkipBatchにbatchを見送らせ、無駄な待ちを足さず即「言い直し」へ回す
 * - タイムアウト・フレーズ0件: unscriptedで新鮮な部分テキストがあれば 'text-only'
 *   （スコアなし・azureError入りでテキストだけ返し、会話を継続させる）。なければ 'throw-timeout'
 * - 部分テキストの鮮度: partialEndSec（部分テキストがカバーする末尾位置）が総音声秒数より
 *   SALVAGE_MAX_UNCOVERED_TAIL_SEC 超手前で止まっていれば「尻尾が大きく欠けた古いテキスト」と
 *   みなして使わない（不完全な発話にAIが返信する事故の防止。canSalvagePartialと同じ思想）
 * - scriptedは救済しない（スコアが成果物そのもの。短文なのでbatchフォールバックも速い）
 */
export function resolveFinishSalvage(opts: {
  mode: 'unscripted' | 'scripted';
  timedOut: boolean;
  phrases: Pick<PhraseAssessment, 'durationTicks'>[];
  audioSeconds: number;
  lastPartialText: string;
  lastPartialEndSec: number;
}): FinishSalvageDecision {
  const { mode, timedOut, phrases, audioSeconds, lastPartialText, lastPartialEndSec } = opts;
  if (!timedOut) {
    return phrases.length > 0 ? { kind: 'scores' } : { kind: 'throw-no-result' };
  }
  const partialFresh =
    mode === 'unscripted' &&
    lastPartialText.trim().length > 0 &&
    audioSeconds - lastPartialEndSec <= SALVAGE_MAX_UNCOVERED_TAIL_SEC;
  if (phrases.length === 0) {
    return partialFresh ? { kind: 'text-only', text: lastPartialText.trim() } : { kind: 'throw-timeout' };
  }
  if (canSalvagePartial(phrases, audioSeconds)) {
    return { kind: 'scores' };
  }
  return partialFresh ? { kind: 'scores-with-tail', tailText: lastPartialText.trim() } : { kind: 'throw-timeout' };
}

/**
 * ストリーミング評価セッションを開始する（録音開始時に呼ぶ）。
 * 解決した時点で認識開始済み＝writeChunkを受け付けられる状態。
 * キー未設定・SDKロード失敗・認識開始失敗はthrowする。
 */
export async function startStreamingPa(opts: StreamingPaOptions): Promise<StreamingPaSession> {
  const referenceText = opts.mode === 'scripted' ? (opts.referenceText ?? '').trim() : '';
  if (opts.mode === 'scripted' && referenceText === '') {
    throw new Error('scripted評価にはreferenceTextが必要です。');
  }

  const t0 = performance.now();
  const [SpeechSDK, config] = await Promise.all([
    import('microsoft-cognitiveservices-speech-sdk'),
    import('./azureSpeechConfig'),
  ]);
  const apiKey = await config.getAzureSpeechKey();
  if (!apiKey) throw new AzureSpeechKeyMissingError();
  const region = await config.getAzureSpeechRegion();
  const today = learningDate(new Date());
  // 韻律（プロソディ）は scripted（キーフレーズ予習の短文）のみ有効にする（§6a-2）。
  // unscripted（自由会話）は音声が長く、F0無料枠だと韻律採点で「close→確定」が音声長ぶん（7〜16秒）
  // 遅延して「評価中」が長引くため無効化して高速化する（pron/accuracy/fluencyの主要スコアは維持）。
  const skipProsody =
    opts.mode === 'unscripted' ||
    hasProsodyFailedInSession() ||
    shouldSkipProsody(await config.getPaProsodyFallback(), region, today);

  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(apiKey, region);
  speechConfig.speechRecognitionLanguage = 'en-US';
  // ライブ音声は実時間で流入するため通常は無関係だが、接続遅延時のバックログ一括flushと
  // finish時の残量送信が実時間ペーシングで待たされないようにする（batch側と同じ設定）。
  speechConfig.setProperty('SPEECH-TransmitLengthBeforThrottleMs', '300000');

  // WAVヘッダなしの生PCM(16k/16bit/mono)を逐次pushする。
  const format = SpeechSDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = SpeechSDK.AudioInputStream.createPushStream(format);
  const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
    referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    opts.mode === 'scripted',
  );
  pronunciationConfig.enableProsodyAssessment = !skipProsody;
  pronunciationConfig.applyTo(recognizer);

  const hints = (opts.phraseHints ?? []).map((h) => h.trim()).filter((h) => h.length > 0);
  if (hints.length > 0) {
    SpeechSDK.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(hints);
  }
  logPaDebug(`[stream] 開始 ${opts.mode} 韻律${skipProsody ? 'なし(スキップ)' : 'あり'} ヒント${hints.length}件`);

  let state: StreamingSessionState = 'connecting';
  const phrases: PhraseAssessment[] = [];
  let recognitionError: Error | null = null;
  let bytesWritten = 0;
  let connectedMs: number | null = null;
  let firstEventMs: number | null = null;
  /**
   * 最初のPCM書き込み時刻（診断用）。マイクは実時間で流入するため、
   * 「バイト数から算出した音声秒数」は close までの実経過時間をわずかに下回るのが正常。
   * 大きく上回る場合はPCMの二重流入（タップ多重張り等）やサンプルレート不整合を疑う。
   */
  let firstWriteMs: number | null = null;
  /** 初回認識イベントの「最初のPCM書き込みからの経過ms」（診断用。recognitionLagSeconds）。 */
  let firstEventFromWriteMs: number | null = null;
  /** 初回認識イベントが音声の何秒目の発話だったか（Azureのoffset。無音待ちの差し引きに使う）。 */
  let firstEventAudioOffsetSec: number | null = null;
  /** 最終確定(recognized)以降の未確定テキスト（recognizing部分認識の最新値。最終サルベージ用）。 */
  let lastPartialText = '';
  /** lastPartialTextがカバーする音声末尾位置（100ns tick、offset+duration）。鮮度ガードに使う。 */
  let lastPartialEndTicks = 0;

  // 認識セッションの終了（sessionStopped or エラー）を待つためのシグナル。
  let settleFn: (() => void) | null = null;
  let settledFlag = false;
  const settled = new Promise<void>((resolve) => {
    settleFn = () => {
      if (settledFlag) return;
      settledFlag = true;
      resolve();
    };
  });
  const settle = () => settleFn?.();

  /**
   * 初回認識イベントの時刻と、その結果が音声の何秒目だったか（Azureのoffset）を記録する。
   * 両方あれば recognitionLagSeconds で「無音待ちを除いた純粋な遅れ」が出せる（診断用）。
   */
  const markFirstEvent = (audioOffsetTicks?: number) => {
    if (firstEventMs === null) {
      firstEventMs = performance.now() - t0;
      if (firstWriteMs !== null) firstEventFromWriteMs = performance.now() - firstWriteMs;
      if (typeof audioOffsetTicks === 'number' && audioOffsetTicks >= 0) {
        firstEventAudioOffsetSec = audioOffsetTicks / 1e7;
      }
    }
  };

  recognizer.recognizing = (_sender, e) => {
    markFirstEvent(e.result.offset);
    // 確定(recognized)前の部分テキストを保持する。確定フレーズ0件のままタイムアウトしたとき、
    // このテキストだけでも返して会話を継続させる（最終サルベージ。resolveFinishSalvage参照）。
    if (e.result.text) {
      lastPartialText = e.result.text;
      lastPartialEndTicks = e.result.offset + e.result.duration;
    }
  };
  recognizer.recognized = (_sender, e) => {
    markFirstEvent(e.result.offset);
    if (e.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) {
      // NoMatch等でもこのセグメントは「確定」。Azureが棄却したテキスト（雑音の誤認識等）を
      // 最終サルベージで拾わないよう、未確定の尻尾はここでもリセットする
      // （不変条件: lastPartialText＝最終確定以降の未確定分）。
      lastPartialText = '';
      lastPartialEndTicks = 0;
      return;
    }
    try {
      const detail = SpeechSDK.PronunciationAssessmentResult.fromResult(e.result).detailResult;
      phrases.push(
        toPhraseAssessment(detail as unknown as AzureDetailResultLike, e.result.duration, e.result.text ?? ''),
      );
      // フレーズを収集できたときだけ尻尾をリセットする（確定スコアとの二重取り防止）。
      // パース失敗時はlastPartialTextを残し、最終サルベージでテキストだけでも拾えるようにする。
      lastPartialText = '';
      lastPartialEndTicks = 0;
    } catch {
      // 個々のフレーズのパース失敗は無視して継続する（部分テキストは残す）。
    }
  };
  recognizer.canceled = (_sender, e) => {
    if (e.reason !== SpeechSDK.CancellationReason.Error) return; // EndOfStreamはsessionStopped側で解決
    let err: Error;
    if (e.errorCode === SpeechSDK.CancellationErrorCode.AuthenticationFailure) {
      err = new AzurePronunciationAuthError();
    } else if (
      e.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure ||
      e.errorCode === SpeechSDK.CancellationErrorCode.ServiceTimeout
    ) {
      err = new AzurePronunciationNetworkError(e.errorDetails);
    } else {
      // 韻律非対応リージョン等（BadRequest）は多くの場合ここに来る。
      err = new Error(e.errorDetails || 'Azure Speechでキャンセルされました。');
    }
    if (!recognitionError) recognitionError = err;
    settle();
  };
  recognizer.sessionStopped = () => {
    try {
      recognizer.stopContinuousRecognitionAsync(
        () => settle(),
        (err) => {
          console.warn('[azurePaStreaming] stopContinuousRecognitionAsyncがエラーを返しました（後片付けの失敗は評価の成否に影響させません）。', err);
          settle();
        },
      );
    } catch (err) {
      console.warn('[azurePaStreaming] stopContinuousRecognitionAsyncの呼び出しで例外が発生しました（後片付けの失敗は評価の成否に影響させません）。', err);
      settle();
    }
  };

  // WebSocketの事前確立（認識開始前にハンドシェイクを済ませる）。失敗しても
  // startContinuousRecognitionAsyncが自前で接続するため致命的ではない。
  // connection参照はcloseAllから確実に切断するため巻き上げて保持する。
  let connection: import('microsoft-cognitiveservices-speech-sdk').Connection | null = null;
  try {
    connection = SpeechSDK.Connection.fromRecognizer(recognizer);
    connection.connected = () => {
      if (connectedMs === null) connectedMs = performance.now() - t0;
      state = nextSessionState(state, 'connected');
    };
    connection.openConnection();
  } catch (err) {
    console.warn('[azurePaStreaming] WebSocketの事前確立に失敗しました（認識開始時に再接続されます）。', err);
  }

  // 後片付け（DESIGN.md §6a-2）: WebSocketを実際に切るのは connection.closeConnection()
  // （close()はラッパー破棄のみ）。iOSのteardownバグでrecognizer.close()が不完全でも
  // WSが残留してF0無料枠の同時接続を塞がないよう、closeConnectionを最初に呼ぶ。
  /** 診断ログ用の「無音待ちを除いた認識遅れ」表示（recognitionLagSeconds。'?'は算出不能）。 */
  const lagLabel = (): string => {
    const lag = recognitionLagSeconds(firstEventFromWriteMs, firstEventAudioOffsetSec);
    return lag === null ? '?' : `${lag.toFixed(1)}s`;
  };

  const closeAll = () => {
    swallowTeardownError('connection.closeConnection', () => connection?.closeConnection());
    swallowTeardownError('connection.close', () => connection?.close());
    swallowTeardownError('recognizer.close', () => recognizer.close());
    swallowTeardownError('audioConfig.close', () => audioConfig.close());
    swallowTeardownError('speechConfig.close', () => speechConfig.close());
  };

  // 認識開始の失敗時もclose群を必ず呼ぶ（呼ばないと事前openしたWSがリークし、
  // 以降のターンのセッションがサーバ側で待たされる原因になる）。
  try {
    await new Promise<void>((resolve, reject) => {
      // WSハンドシェイクがハングすると成功・失敗どちらのコールバックも呼ばれないため、
      // 上限（START_TIMEOUT_MS）を張って必ず決着させる（sessionPromise無期限化＝「評価中」ハングの根）。
      const startTimeoutId = setTimeout(
        () => reject(new AzurePronunciationNetworkError('認識開始がタイムアウトしました')),
        START_TIMEOUT_MS,
      );
      recognizer.startContinuousRecognitionAsync(
        () => {
          clearTimeout(startTimeoutId);
          resolve();
        },
        (err) => {
          clearTimeout(startTimeoutId);
          reject(new AzurePronunciationNetworkError(String(err)));
        },
      );
    });
  } catch (err) {
    logPaDebug(
      `[stream] 認識開始に失敗 (${err instanceof Error ? `${err.name}: ${truncateDetail(err.message)}` : String(err)})`,
    );
    closeAll();
    throw err;
  }

  let finishing: Promise<AssessSpeechResult> | null = null;

  const session: StreamingPaSession = {
    writeChunk(pcm16: ArrayBuffer) {
      if (state !== 'connecting' && state !== 'streaming') return;
      if (pcm16.byteLength === 0) return;
      try {
        pushStream.write(pcm16);
        if (firstWriteMs === null) firstWriteMs = performance.now();
        bytesWritten += pcm16.byteLength;
      } catch (err) {
        console.warn('[azurePaStreaming] pushStream.writeに失敗しました（このチャンクは破棄されます）。', err);
      }
    },

    audioSeconds() {
      return pcmBytesToSeconds(bytesWritten);
    },

    finish() {
      if (finishing) return finishing;
      state = nextSessionState(state, 'finishRequested');
      finishing = (async () => {
        const tClose = performance.now();
        // 適応タイムアウト（DESIGN.md §6a-2）: モード・進捗の証拠の有無・音声長で待ち時間を変える。
        const timeoutMs = finishTimeoutMs(opts.mode, firstEventMs !== null, pcmBytesToSeconds(bytesWritten));
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let nudgeId: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          swallowTeardownError('pushStream.close', () => pushStream.close());
          // nudge（DESIGN.md §6a-2）: close後ストールしたら能動的に停止を促し、確定(sessionStopped)を
          // 引き出す。現状は sessionStopped ハンドラ内でしか stop を呼ばず、ストール時に手が無かった。
          nudgeId = setTimeout(() => {
            swallowTeardownError('stopContinuousRecognitionAsync(nudge)', () => {
              recognizer.stopContinuousRecognitionAsync(
                () => {
                  // stop成功＝サービス側の認識は停止済みで、以後sessionStoppedが来る保証はない。
                  // 収集済みフレーズだけで末尾を取りこぼさず結果を組めるときのみ即settleし、
                  // タイムアウト満了（8s/4s）まで待たずに確定させる。満たさなければ従来どおり
                  // タイムアウト→サルベージ判定に委ねる。二重settleはsettledFlagガードで無害。
                  if (canSalvagePartial(phrases, pcmBytesToSeconds(bytesWritten))) {
                    logPaDebug('[stream] nudge stop成功→即settle');
                    settle();
                  }
                },
                () => {},
              );
            });
          }, NUDGE_AFTER_CLOSE_MS);
          // タイムアウトはrejectせずresolveし、後段で部分結果のサルベージ可否を判定する。
          await Promise.race([
            settled,
            new Promise<void>((resolve) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                resolve();
              }, timeoutMs);
            }),
          ]);
          // 部分結果サルベージ（DESIGN.md §6a-2）: タイムアウトでも、録音中に集めたフレーズや
          // recognizing部分テキストがあれば可能な限り結果を組んで返す（batch再認識に落とさない）。
          // 認識中エラーはフレーズがあれば警告のみ扱う（resolveRecognitionOutcomeの契約）。
          const resolved = resolveRecognitionOutcome(phrases, timedOut ? null : recognitionError);
          const audioSecondsNow = pcmBytesToSeconds(bytesWritten);
          const decision = resolveFinishSalvage({
            mode: opts.mode,
            timedOut,
            phrases: resolved,
            audioSeconds: audioSecondsNow,
            lastPartialText,
            lastPartialEndSec: lastPartialEndTicks / 1e7,
          });
          if (decision.kind === 'throw-timeout') {
            if (resolved.length > 0) {
              const uncovered =
                audioSecondsNow - resolved.reduce((s, p) => s + Math.max(0, p.durationTicks), 0) / 1e7;
              logPaDebug(`[stream] サルベージ見送り 未カバー末尾${uncovered.toFixed(1)}s（末尾が欠けるため採用しない）`);
            }
            // hadEvidence: 認識イベントの証拠なし（=WS沈黙死の疑い）なら、voiceCaptureの
            // 失敗分類を'other'にしてbatchフォールバックを見送らせない（shouldSkipBatch参照）。
            throw new AzurePronunciationTimeoutError(firstEventMs !== null);
          }
          if (decision.kind === 'throw-no-result') {
            throw new AzurePronunciationNoResultError();
          }

          let result: AssessSpeechResult;
          if (decision.kind === 'text-only') {
            // 確定フレーズ0件のタイムアウト: 部分認識テキストだけで会話を継続させる（最終サルベージ）。
            // スコアはazureError入りの欠損として返し、消費側（スコアチップ非表示・metrics除外）に委ねる。
            result = {
              recognizedText: decision.text,
              pa: makeFailurePaResult(opts.mode, new AzurePronunciationTimeoutError()),
            };
          } else {
            const aggregated = aggregatePhraseAssessments(resolved, {
              mode: opts.mode,
              usedProsody: !skipProsody,
            });
            if (!aggregated) throw new AzurePronunciationNoResultError();
            result =
              decision.kind === 'scores-with-tail'
                ? { ...aggregated, recognizedText: `${aggregated.recognizedText} ${decision.tailText}`.trim() }
                : aggregated;
          }
          state = nextSessionState(state, 'settledOk');
          const salvageTag =
            decision.kind === 'text-only'
              ? '(text-salvage)'
              : decision.kind === 'scores-with-tail'
                ? '(salvage+tail)'
                : timedOut
                  ? '(salvage)'
                  : '';
          const summary =
            `接続 ${connectedMs !== null ? Math.round(connectedMs) : '?'}ms / ` +
            `初回認識 ${firstEventMs !== null ? Math.round(firstEventMs) : '?'}ms(無音除く遅れ ${lagLabel()}) / ` +
            `close→確定 ${Math.round(performance.now() - tClose)}ms${salvageTag} / ` +
            `音声 ${audioSecondsNow.toFixed(1)}s(実時間 ${liveSeconds(firstWriteMs, tClose)}) / ${opts.mode} / ` +
            `韻律${skipProsody ? 'なし(スキップ)' : 'あり'}`;
          console.info(`[azurePaStreaming] ${summary}`);
          logPaDebug(`[stream] 確定 ${summary}`);
          return result;
        } catch (err) {
          state = nextSessionState(state, 'settledError');
          // 韻律あり実行の失敗のうち、一時障害系・結果ゼロ・タイムアウト以外（≒BadRequest=韻律非対応の疑い）は
          // 当日キャッシュを書いてからthrowする。直後のbatchフォールバックはキャッシュを読み直すため
          // 韻律なし1回で済み、「stream失敗+batch2回」の三重連鎖を断つ。タイムアウトは韻律の是非と無関係
          // なので韻律ガードも立てない（無用に以降のターンの韻律を止めない）。
          // fire-and-forgetだとbatchの読取と競合するため必ずawaitする（ヘルパーはnever throw）。
          if (
            !skipProsody &&
            !(err instanceof AzurePronunciationNoResultError) &&
            !(err instanceof AzurePronunciationTimeoutError)
          ) {
            markProsodyFailureInSession();
            if (!isTransientPaError(err)) {
              await config.setPaProsodyFallback({ region, date: today });
              logPaDebug('[stream] 韻律起因の疑い→当日キャッシュ書込（直後のbatchは韻律なし1回）');
            }
          }
          logPaDebug(
            `[stream] 失敗 ${err instanceof Error ? `${err.name}: ${truncateDetail(err.message)}` : String(err)} ` +
              `接続 ${connectedMs !== null ? Math.round(connectedMs) : '?'}ms 初回認識 ${firstEventMs !== null ? Math.round(firstEventMs) : 'なし'}(無音除く遅れ ${lagLabel()}) ` +
              `書込${Math.round(bytesWritten / 1024)}KB(音声${pcmBytesToSeconds(bytesWritten).toFixed(1)}s/実時間${liveSeconds(firstWriteMs, tClose)})`,
          );
          throw err;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (nudgeId !== undefined) clearTimeout(nudgeId);
          closeAll();
        }
      })();
      return finishing;
    },

    abort() {
      if (state === 'done' || state === 'failed' || state === 'aborted') return;
      state = nextSessionState(state, 'abortRequested');
      swallowTeardownError('pushStream.close(abort)', () => pushStream.close());
      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {},
          () => {},
        );
      } catch {
        // 停止呼び出しの失敗は破棄時には問題にしない。
      }
      closeAll();
    },
  };

  return session;
}
