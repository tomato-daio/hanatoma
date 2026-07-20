/**
 * Azure Speechの発音評価（DESIGN.md §6a unscripted / §6b scripted）。
 * shadotoma の azurePronunciation.ts を翻案。会話ターン（unscripted: referenceText空文字）と
 * キーフレーズ予習（scripted: referenceText指定・enableMiscue）の両モードを1つの
 * assessSpeech で扱い、認識テキストと PaResult を返す。
 *
 * 失敗時の契約（DESIGN.md §6a「PAエラー時も会話は継続する」）: assessSpeechはAzure側の失敗で
 * 例外を投げず、pa.azureError に一行メッセージ（errorDetails先頭120字）を入れた空のPaResultを
 * 返す（recognizedTextは''）。呼び出し側は azureError の有無だけで分岐すればよい。
 * scripted なのに referenceText が無い、といった呼び出し側のバグだけは例外を投げる。
 *
 * SDK本体（microsoft-cognitiveservices-speech-sdk）とappState解決（azureSpeechConfig→db.ts）は
 * assessSpeech内でのみ動的importする。静的importするとキー未設定ユーザーの初期バンドルにも
 * SDKが常に含まれてしまうため（バンドル分割）と、このファイルの純関数群
 * （toPhraseAssessment/aggregatePhraseAssessments/computeWeakPhonemes/normalizePhonemeKey/
 * truncateDetail/describeAzureError/resolveRecognitionOutcome/makeFailurePaResult）を
 * SDK・IndexedDBなしでVitestテストできるようにするため。
 *
 * 音素キーの表記（shadotoma M12と同じ前提）: PronunciationAssessmentConfig.phonemeAlphabet は
 * 明示的に設定していない（既定値のまま）。SDKの既定値は "SAPI" であり、en-USのSAPI音素表記は
 * ARPAbetに準じた大文字表記（例: 'R','TH','AE'）になる。そのため生の Phoneme 文字列を
 * 大文字化し、末尾の強勢番号（例: "AH1"）だけ取り除けば Scenario.targetPhonemes や
 * shadotoma弱点連携のARPAbetキーとそのまま突き合わせられる（normalizePhonemeKey）。
 * IPAへの変換は行わない（phonemeAlphabet: "IPA" を明示指定するとこの前提が崩れるため、指定しないこと）。
 *
 * iOS Safari(WebKit)の後片付けバグ対策（shadotoma M10追補で実機確認済み）: SDKには、認識終了時の
 * 後片付け（stopContinuousRecognitionAsync/close周辺のprivSource.turnOff）で
 * 「undefined is not an object (evaluating 'this.privSource.turnOff().then')」という内部例外が
 * 出る既知のバグがある。このとき認識結果自体は取得済みのことが多いため、後片付けの失敗は
 * 評価の成否に影響させず（console.warnに全文を残すのみ）、成否は
 * 「フレーズ結果を1件以上収集できたか」で判定する（resolveRecognitionOutcome）。
 *
 * プロソディ・フォールバック（DESIGN.md §6a）: 韻律（プロソディ）採点はリージョンにより
 * 未対応の場合があり（japaneastで失敗実績あり）、その場合は韻律有効でのcontinuous recognitionが
 * cancellation/エラー/結果ゼロのいずれかで失敗する。assessSpeechは、韻律有効での実行が
 * 失敗した場合に韻律なし設定で1回だけ自動リトライし、成功したらprosodyScoreをundefinedにして
 * 返す。両方失敗した場合のみazureErrorを返す。
 *
 * 韻律非対応の当日キャッシュ（DESIGN.md §6a・レイテンシ対策）: フォールバック成功時に
 * appState 'paProsodyFallback' = {region, date(学習日)} を記録し（azureSpeechConfig.tsの
 * never-throwヘルパー経由）、同日・同リージョンなら最初から韻律なし1回で実行する
 * （毎ターン2回認識になるのを防ぐ）。判定は純関数 shouldSkipProsody。学習日が変わると
 * 自動で再プローブ（Azureが韻律対応した際の自己回復）。1回目の失敗がネットワーク/認証/
 * タイムアウト系のときはキャッシュを書かない（一時障害の誤学習防止）。
 */

import { learningDate } from '../../lib/dates';
import type { PaResult } from '../../lib/types';

/** PaResult内の1語ぶんスコア（types.tsのインライン型に別名を付けたもの）。 */
export type PaWordScore = PaResult['words'][number];
/** PaResult内の弱点音素1件ぶん。 */
export type PaWeakPhoneme = NonNullable<PaResult['weakPhonemes']>[number];

export interface AssessSpeechOptions {
  mode: 'unscripted' | 'scripted';
  /** scripted時は必須（キーフレーズ文）。unscripted時は無視される。 */
  referenceText?: string;
  /**
   * 認識精度向上のためのフレーズヒント（DESIGN.md §6a）。PhraseListGrammar経由で
   * 認識エンジンに「出やすい語句」として渡す（シナリオのキーフレーズ・模範解答等）。
   * 発音スコアには直接影響せず、認識テキストの文脈補助のみ。空・未指定なら何もしない。
   */
  phraseHints?: string[];
}

export interface AssessSpeechResult {
  /** 複数フレーズの認識テキストをスペースで連結したもの。失敗時は''。 */
  recognizedText: string;
  pa: PaResult;
}

/** Words[].Phonemes[]の1音素ぶん。低スコア音素の集計に使う中間データ。 */
export interface PhonemeScoreEntry {
  /** normalizePhonemeKey済みのARPAbet大文字キー（例: 'R'）。 */
  phoneme: string;
  accuracyScore: number;
  /** 表示用の原文の語（例語の抽出に使う）。 */
  word: string;
}

/** 1回のcontinuous recognitionフレーズぶんのスコア（音声長で加重統合する前の単位）。 */
export interface PhraseAssessment {
  /** 100ns単位（Azure SDKの RecognitionResult.duration と同じ単位）。0以下は等重み扱いにフォールバックする。 */
  durationTicks: number;
  /** このフレーズの認識テキスト（RecognitionResult.text）。 */
  text: string;
  pronScore: number;
  accuracyScore: number;
  fluencyScore: number;
  completenessScore: number;
  prosodyScore: number;
  words: PaWordScore[];
  /** このフレーズに含まれる全語の音素スコア（重み付けなしの生データ）。 */
  phonemeScores: PhonemeScoreEntry[];
}

/**
 * Azure Speech SDKの `PronunciationAssessmentResult.detailResult` の必要部分だけを表す型。
 * SDKの型（distrib/lib/src/sdk/PronunciationAssessmentResult.d.ts の DetailResult）と同じ形。
 * SDKに依存せずテストできるよう、このファイル内で独自定義する。
 * Phonemes はMicrosoft Learn「Use pronunciation assessment」記載のJSONサンプル
 * （Words[].Phonemes[].Phoneme / ...PronunciationAssessment.AccuracyScore）に基づく形。
 */
export interface AzureDetailResultLike {
  Words?: {
    Word: string;
    PronunciationAssessment?: {
      AccuracyScore?: number;
      ErrorType?: string;
    };
    Phonemes?: { Phoneme: string; PronunciationAssessment?: { AccuracyScore?: number } }[];
  }[];
  PronunciationAssessment?: {
    AccuracyScore?: number;
    FluencyScore?: number;
    CompletenessScore?: number;
    PronScore?: number;
    ProsodyScore?: number;
  };
}

/**
 * 生のAzure音素表記を、ARPAbetキー体系（targetPhonemes / shadotoma phonemeAdvice互換）に
 * 正規化する純関数。前後の空白を除き大文字化し、末尾の強勢番号（母音に付く0/1/2）を取り除く
 * （例: "ah1" -> "AH"）。空文字列や数字のみの入力は空文字列のまま返す（呼び出し側で除外する）。
 */
export function normalizePhonemeKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[0-9]+$/, '');
}

/**
 * 韻律非対応キャッシュ（appState 'paProsodyFallback'）の判定純関数（DESIGN.md §6a）。
 * appStateの生値（unknown）を検証し、「今日・このリージョンで韻律なし直行してよいか」を返す。
 * 値が壊れていても false（=従来の韻律あり→フォールバックの2回方式へ劣化）にするだけで、
 * 決して例外を投げない。日付一致を要求するため、学習日が変わると自動で再プローブされる。
 */
export function shouldSkipProsody(cached: unknown, region: string, today: string): boolean {
  if (typeof cached !== 'object' || cached === null) return false;
  const record = cached as Record<string, unknown>;
  return record.region === region && record.date === today;
}

/**
 * SDKのdetailResult(1フレーズぶん)を、統合前のPhraseAssessmentへ変換する純関数。
 * errorTypeはPaResult側で必須のstringのため、欠けている場合はAzureの正常値と同じ'None'にする。
 */
export function toPhraseAssessment(
  detail: AzureDetailResultLike,
  durationTicks: number,
  text: string,
): PhraseAssessment {
  const pa = detail.PronunciationAssessment ?? {};
  const wordsRaw = detail.Words ?? [];
  const words: PaWordScore[] = wordsRaw.map((w) => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
    errorType: w.PronunciationAssessment?.ErrorType ?? 'None',
  }));

  // 音素スコアを語ごとに集める（weakPhonemes集計の生データ）。
  const phonemeScores: PhonemeScoreEntry[] = [];
  for (const w of wordsRaw) {
    for (const ph of w.Phonemes ?? []) {
      const score = ph.PronunciationAssessment?.AccuracyScore;
      const key = normalizePhonemeKey(ph.Phoneme ?? '');
      if (typeof score !== 'number' || key === '') continue;
      phonemeScores.push({ phoneme: key, accuracyScore: score, word: w.Word });
    }
  }

  return {
    durationTicks: Math.max(0, durationTicks),
    text,
    pronScore: pa.PronScore ?? 0,
    accuracyScore: pa.AccuracyScore ?? 0,
    fluencyScore: pa.FluencyScore ?? 0,
    completenessScore: pa.CompletenessScore ?? 0,
    prosodyScore: pa.ProsodyScore ?? 0,
    words,
    phonemeScores,
  };
}

const WEAK_PHONEME_LIMIT = 3;
const WEAK_PHONEME_EXAMPLE_LIMIT = 2;

/**
 * 音素スコアの生データ（複数フレーズぶんをflatMapしたもの）から、低スコア音素トップNを求める
 * 純関数（DESIGN.md §6a）。同じ音素の複数出現は平均スコアへ集約し、平均が低い順に並べる。
 * 例語はその音素の中でスコアが低かった語を優先し、重複語を除いて最大exampleLimit件にする
 * （「どこでつまずいたか」が伝わる例を出すため）。
 */
export function computeWeakPhonemes(
  entries: PhonemeScoreEntry[],
  limit: number = WEAK_PHONEME_LIMIT,
  exampleLimit: number = WEAK_PHONEME_EXAMPLE_LIMIT,
): PaWeakPhoneme[] {
  const byPhoneme = new Map<string, PhonemeScoreEntry[]>();
  for (const e of entries) {
    const list = byPhoneme.get(e.phoneme) ?? [];
    list.push(e);
    byPhoneme.set(e.phoneme, list);
  }

  const summaries = [...byPhoneme.entries()].map(([phoneme, list]) => {
    const avgScore = list.reduce((sum, e) => sum + e.accuracyScore, 0) / list.length;
    const examples: string[] = [];
    const seen = new Set<string>();
    for (const e of [...list].sort((a, b) => a.accuracyScore - b.accuracyScore)) {
      if (seen.has(e.word)) continue;
      seen.add(e.word);
      examples.push(e.word);
      if (examples.length >= exampleLimit) break;
    }
    return { phoneme, avgScore, examples };
  });

  return summaries.sort((a, b) => a.avgScore - b.avgScore).slice(0, limit);
}

/**
 * 複数フレーズ結果を音声長(duration)で加重平均し、認識テキストを連結して
 * 1つのAssessSpeechResultへ統合する純関数（DESIGN.md §6a: 60秒超対応のcontinuous recognitionで
 * 複数結果が返るため「音声長加重でスコア統合」「認識テキストは連結」）。
 * phrasesが空の場合はnullを返す（呼び出し側は「結果ゼロ」エラーとして扱う）。
 *
 * - prosodyScore: 韻律なしフォールバックで成功した場合（usedProsody=false）はundefined
 *   （EnableProsodyAssessmentが効いていないと常に既定値0になり、0点と区別できないため）
 * - completenessScore: scriptedのみ意味を持つ（unscriptedではreferenceTextが無く常に既定値の
 *   ため、同様にundefinedにする。DESIGN.md §3 PaResult「scriptedのみ」）
 */
export function aggregatePhraseAssessments(
  phrases: PhraseAssessment[],
  opts: { mode: 'unscripted' | 'scripted'; usedProsody: boolean },
): AssessSpeechResult | null {
  if (phrases.length === 0) return null;

  const totalDuration = phrases.reduce((sum, p) => sum + p.durationTicks, 0);
  // 全フレーズのdurationが取得できない(0)場合は等重みにフォールバックする（0除算防止）。
  const useEqualWeight = totalDuration <= 0;
  const weightOf = (p: PhraseAssessment) => (useEqualWeight ? 1 : p.durationTicks);
  const weightTotal = useEqualWeight ? phrases.length : totalDuration;

  const weightedAverage = (pick: (p: PhraseAssessment) => number): number =>
    phrases.reduce((sum, p) => sum + pick(p) * weightOf(p), 0) / weightTotal;

  // 音素スコアはフレーズ間で単純にflatMapしてから低スコア音素トップ3を求める（音声長での
  // 重み付けはしない。1音素あたりの出現回数自体がフレーズ長に比例するため、二重に重み付けしない）。
  const weakPhonemes = computeWeakPhonemes(phrases.flatMap((p) => p.phonemeScores));

  const pa: PaResult = {
    mode: opts.mode,
    pronScore: weightedAverage((p) => p.pronScore),
    accuracyScore: weightedAverage((p) => p.accuracyScore),
    fluencyScore: weightedAverage((p) => p.fluencyScore),
    prosodyScore: opts.usedProsody ? weightedAverage((p) => p.prosodyScore) : undefined,
    completenessScore: opts.mode === 'scripted' ? weightedAverage((p) => p.completenessScore) : undefined,
    words: phrases.flatMap((p) => p.words),
    weakPhonemes: weakPhonemes.length > 0 ? weakPhonemes : undefined,
  };

  return {
    recognizedText: phrases
      .map((p) => p.text.trim())
      .filter((t) => t.length > 0)
      .join(' '),
    pa,
  };
}

// ---- エラー種別 ----

export class AzurePronunciationTimeoutError extends Error {
  constructor() {
    super('発音スコアの取得がタイムアウトしました。');
    this.name = 'AzurePronunciationTimeoutError';
  }
}

export class AzurePronunciationNoResultError extends Error {
  constructor() {
    super('発音の認識結果が得られませんでした（無音、または短すぎる可能性があります）。');
    this.name = 'AzurePronunciationNoResultError';
  }
}

export class AzurePronunciationAuthError extends Error {
  constructor() {
    super('Azure APIキーが無効です。設定を確認してください。');
    this.name = 'AzurePronunciationAuthError';
  }
}

export class AzurePronunciationNetworkError extends Error {
  constructor(detail?: string) {
    super(`Azure Speechへの接続に失敗しました${detail ? `（${truncateDetail(detail)}）` : ''}。`);
    this.name = 'AzurePronunciationNetworkError';
  }
}

export class AzureSpeechKeyMissingError extends Error {
  constructor() {
    super('Azure APIキーが設定されていません。設定画面で登録してください。');
    this.name = 'AzureSpeechKeyMissingError';
  }
}

/** 一行メッセージに含めるSDK詳細情報の最大文字数（DESIGN.md §6a:「errorDetails先頭120字」）。 */
const ERROR_DETAIL_MAX_LENGTH = 120;

/**
 * 詳細文字列を指定長で切り詰める純関数。SDKのcancellation errorDetailsは長い場合があり、
 * そのままだと会話画面の一行メッセージ表示を壊すため、azureErrorへ含める前に切り詰める。
 * 切り詰めた場合は末尾に…を付ける。console.errorへは（呼び出し側で）切り詰めない全文を渡すこと。
 */
export function truncateDetail(detail: string, maxLength: number = ERROR_DETAIL_MAX_LENGTH): string {
  const trimmed = detail.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

/** PaResult.azureErrorに入れる一行メッセージへ変換する純関数。 */
export function describeAzureError(err: unknown): string {
  if (
    err instanceof AzurePronunciationTimeoutError ||
    err instanceof AzurePronunciationNoResultError ||
    err instanceof AzurePronunciationAuthError ||
    err instanceof AzurePronunciationNetworkError ||
    err instanceof AzureSpeechKeyMissingError
  ) {
    return err.message;
  }
  const raw = err instanceof Error ? err.message : String(err);
  return `発音スコアの取得に失敗しました: ${truncateDetail(raw)}`;
}

/**
 * 失敗時に返す空のPaResultを作る純関数（DESIGN.md §6a「PAエラー時も会話は継続する」）。
 * スコアは全て0だが、呼び出し側はスコアではなく azureError の有無で失敗を判定すること。
 */
export function makeFailurePaResult(mode: 'unscripted' | 'scripted', err: unknown): PaResult {
  return {
    mode,
    pronScore: 0,
    accuracyScore: 0,
    fluencyScore: 0,
    words: [],
    azureError: describeAzureError(err),
  };
}

/** continuous recognitionの終了待ちタイムアウト（60秒超音声も考慮した余裕のある値）。 */
const RECOGNITION_TIMEOUT_MS = 120_000;

/** このファイル内でのみ使う、動的importしたSDKモジュール名前空間の型。 */
type AzureSpeechSDK = typeof import('microsoft-cognitiveservices-speech-sdk');

/**
 * SDKの後片付け（stop/close）呼び出しの同期例外を握りつぶす（iOS Safari対策）。
 * WebKitではSDK内部の既知バグ（privSource.turnOff周辺）により後片付けで例外が出ることがあるが、
 * その時点で認識結果は取得済みのことが多い。後片付けの成否は評価の成否に影響させず、
 * console.warnに全文を残すだけにする（ファイル冒頭コメント参照）。
 */
function swallowTeardownError(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(
      `[azurePaUnscripted] ${label}で例外が発生しました（後片付けの失敗は評価の成否に影響させません）。`,
      err,
    );
  }
}

/**
 * 認識セッション終了後の成否判定（iOS Safari後片付けバグ対策の純関数）。
 * 成否は「フレーズ結果を1件以上収集できたか」で決める:
 * - 1件以上: 認識中・後片付けでエラーが発生していても成功として返す（エラーはconsole.warnに残す）
 * - 0件でエラーあり: そのエラーを投げる（後片付けバグ以外の別原因の切り分けに使う）
 * - 0件でエラーなし: 空配列を返す（呼び出し側が「結果ゼロ」として扱う）
 */
export function resolveRecognitionOutcome(
  phrases: PhraseAssessment[],
  recognitionError: Error | null,
): PhraseAssessment[] {
  if (phrases.length > 0) {
    if (recognitionError) {
      console.warn(
        '[azurePaUnscripted] 認識中にエラーが発生しましたが、フレーズ結果を取得済みのため成功として扱います。',
        recognitionError,
      );
    }
    return phrases;
  }
  if (recognitionError) throw recognitionError;
  return phrases;
}

/**
 * 1回ぶんのcontinuous recognitionを実行し、フレーズ結果配列を返す内部ヘルパー。
 * プロソディ・フォールバック（DESIGN.md §6a）のため、assessSpeechから enableProsody を
 * 切り替えて最大2回（韻律あり→失敗時のみ韻律なしで1回）呼ばれる。
 *
 * 手順:
 * 1. wavBuffer（16kHz mono PCM16のWAV）をpush streamへ書き込む
 * 2. PronunciationAssessmentConfig（referenceText/HundredMark/Phoneme/enableMiscue/
 *    enableProsodyAssessment）を適用したSpeechRecognizerでcontinuous recognitionを実行し、
 *    60秒超の音声でも最後まで処理する
 *
 * 成否判定（resolveRecognitionOutcome参照）: 認識中のエラーはrejectせず記録だけして
 * Promiseは常にresolveし、フレーズ結果を1件以上収集できていれば（後片付け例外が出ても）
 * 成功として返す。0件かつエラーありの場合のみそのエラーを投げる。0件かつエラーなし（無音等）は
 * 空配列を返す（呼び出し側が「結果ゼロ」として扱う）。
 * stopContinuousRecognitionAsync/closeの失敗はconsole.warnに残すだけで握りつぶす
 * （iOS SafariのprivSource.turnOff既知バグ対策。ファイル冒頭コメント参照）。
 */
async function recognizeOnce(
  SpeechSDK: AzureSpeechSDK,
  wavBuffer: ArrayBuffer,
  opts: {
    referenceText: string;
    enableMiscue: boolean;
    enableProsody: boolean;
    phraseHints: string[];
    apiKey: string;
    region: string;
  },
): Promise<PhraseAssessment[]> {
  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(opts.apiKey, opts.region);
  speechConfig.speechRecognitionLanguage = 'en-US';

  const pushStream = SpeechSDK.AudioInputStream.createPushStream();
  pushStream.write(wavBuffer);
  pushStream.close();

  const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
    opts.referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    opts.enableMiscue,
  );
  pronunciationConfig.enableProsodyAssessment = opts.enableProsody;
  pronunciationConfig.applyTo(recognizer);

  // フレーズヒント（DESIGN.md §6a）: シナリオで登場が予想される語句を認識エンジンへ渡す。
  if (opts.phraseHints.length > 0) {
    SpeechSDK.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(opts.phraseHints);
  }

  const phrases: PhraseAssessment[] = [];
  /**
   * 認識中に発生した最初のエラー（cancellation・開始失敗・タイムアウト・後片付け例外の伝播等）。
   * フレーズを1件も収集できなかった場合のみ、失敗としてresolveRecognitionOutcomeが投げる。
   */
  let recognitionError: Error | null = null;

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      /**
       * 二重解決防止のガード: タイムアウト・canceled・sessionStopped・stopのエラーコールバック・
       * 同期例外がどの順序・組み合わせで発生しても、最初の1回だけがこのPromiseを解決する。
       * エラーはrejectせずrecognitionErrorへ記録して常にresolveし、成否はフレーズ収集数ベースで
       * 後段が判定する。
       */
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (err && !recognitionError) recognitionError = err;
        resolve();
      };

      timeoutId = setTimeout(() => {
        // タイムアウト時も停止は試みるが、stop自体の失敗（iOS Safariの既知バグ等）は握りつぶし、
        // 停止の完了を待たずにタイムアウトとして確定する。
        swallowTeardownError('stopContinuousRecognitionAsync（タイムアウト時）', () => {
          recognizer.stopContinuousRecognitionAsync(
            () => {},
            (err) =>
              console.warn('[azurePaUnscripted] タイムアウト時の停止呼び出しがエラーを返しました。', err),
          );
        });
        finish(new AzurePronunciationTimeoutError());
      }, RECOGNITION_TIMEOUT_MS);

      recognizer.recognized = (_sender, e) => {
        if (e.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) return;
        try {
          const detail = SpeechSDK.PronunciationAssessmentResult.fromResult(e.result).detailResult;
          // microsoft-cognitiveservices-speech-sdkに同梱の型定義（DetailResult/WordResult）は、
          // 実際のAzure応答JSON（Microsoft Learn「Use pronunciation assessment」記載のサンプル）
          // に存在するWords[].Phonemes[].PronunciationAssessment.AccuracyScoreを宣言しておらず、
          // 型定義が実際の応答仕様より古い/不足している。実行時の値は変わらないため、
          // 実際の応答形を表す独自定義 AzureDetailResultLike へ橋渡しする（unknown経由のキャストが必要）。
          phrases.push(
            toPhraseAssessment(detail as unknown as AzureDetailResultLike, e.result.duration, e.result.text ?? ''),
          );
        } catch {
          // 個々のフレーズのパース失敗は無視して継続する（他のフレーズの結果は活かす）。
        }
      };

      recognizer.canceled = (_sender, e) => {
        if (e.reason !== SpeechSDK.CancellationReason.Error) {
          // EndOfStream（正常終了）はここでは何もしない。後続のsessionStoppedで解決する。
          return;
        }
        if (e.errorCode === SpeechSDK.CancellationErrorCode.AuthenticationFailure) {
          finish(new AzurePronunciationAuthError());
        } else if (
          e.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure ||
          e.errorCode === SpeechSDK.CancellationErrorCode.ServiceTimeout
        ) {
          finish(new AzurePronunciationNetworkError(e.errorDetails));
        } else {
          // 韻律採点未対応リージョン等での失敗は多くの場合ここに来る（BadRequest等）。
          // e.errorDetailsをそのままError.messageに持たせ、呼び出し側のdescribeAzureErrorで
          // azureError向けに切り詰める（console.errorには全文を出す）。
          finish(new Error(e.errorDetails || 'Azure Speechでキャンセルされました。'));
        }
      };

      recognizer.sessionStopped = () => {
        // 認識セッションは終了済みで、フレーズ結果は収集済み。ここからは後片付けのみのため、
        // stopの同期例外・エラーコールバック（iOS SafariのprivSource.turnOff既知バグが出る箇所）
        // はどちらもエラー扱いにせず、warnを残してresolveする（成否はフレーズ収集数で判定）。
        try {
          recognizer.stopContinuousRecognitionAsync(
            () => finish(),
            (err) => {
              console.warn(
                '[azurePaUnscripted] stopContinuousRecognitionAsyncがエラーを返しました（後片付けの失敗は評価の成否に影響させません）。',
                err,
              );
              finish();
            },
          );
        } catch (err) {
          console.warn(
            '[azurePaUnscripted] stopContinuousRecognitionAsyncの呼び出しで例外が発生しました（後片付けの失敗は評価の成否に影響させません）。',
            err,
          );
          finish();
        }
      };

      recognizer.startContinuousRecognitionAsync(
        () => {
          // 開始成功時は何もしない（結果はrecognized/canceled/sessionStoppedイベントで受け取る）。
        },
        (err) => finish(new AzurePronunciationNetworkError(err)),
      );
    });
  } finally {
    // close群の同期例外（iOS SafariのprivSource.turnOff内部バグ等）も評価の成否に影響させない。
    swallowTeardownError('recognizer.close', () => recognizer.close());
    swallowTeardownError('audioConfig.close', () => audioConfig.close());
    swallowTeardownError('speechConfig.close', () => speechConfig.close());
  }

  // フレーズ1件以上なら（エラーが記録されていても）成功。0件かつエラーありなら投げる。
  return resolveRecognitionOutcome(phrases, recognitionError);
}

/**
 * Azure Speechで発音評価を実行する（DESIGN.md §6a/6b）。
 *
 * 1. まず韻律（プロソディ）ありで実行する
 * 2. cancellation/エラー/結果ゼロのいずれかで失敗したら、韻律なし設定で1回だけ自動リトライする
 *    （japaneast等での韻律未対応が疑われるケースを、評価そのものは諦めずに救済する）
 * 3. リトライも失敗したら azureError 入りの空PaResultを返す（例外は投げない。会話は継続する）
 * 4. 韻律なしで成功した場合は prosodyScore を undefined にして返す（表示は「―」）
 *
 * @param wavBlob WAV(16kHz mono PCM16)のBlob（§5パイプラインのwav.ts出力をBlob化したもの）
 */
export async function assessSpeech(wavBlob: Blob, opts: AssessSpeechOptions): Promise<AssessSpeechResult> {
  // referenceText欠落は呼び出し側のバグのため、azureErrorではなく例外で早期に気付かせる。
  const referenceText = opts.mode === 'scripted' ? (opts.referenceText ?? '').trim() : '';
  if (opts.mode === 'scripted' && referenceText === '') {
    throw new Error('scripted評価にはreferenceTextが必要です。');
  }

  try {
    // SDK本体とappState解決は実際に評価を実行するときだけ読み込む（バンドル分割と
    // 純関数テストのSDK/IndexedDB非依存化。ファイル冒頭コメント参照）。
    const [SpeechSDK, config] = await Promise.all([
      import('microsoft-cognitiveservices-speech-sdk'),
      import('./azureSpeechConfig'),
    ]);
    const apiKey = await config.getAzureSpeechKey();
    if (!apiKey) {
      throw new AzureSpeechKeyMissingError();
    }
    const region = await config.getAzureSpeechRegion();
    const wavBuffer = await wavBlob.arrayBuffer();
    const recognizeOpts = {
      referenceText,
      // enableMiscueはreferenceTextとの突き合わせ（挿入/省略の検出）機能のため、
      // scriptedのみ有効にする（DESIGN.md §6b。unscriptedでは参照文が無く意味を持たない）。
      enableMiscue: opts.mode === 'scripted',
      phraseHints: (opts.phraseHints ?? []).map((h) => h.trim()).filter((h) => h.length > 0),
      apiKey,
      region,
    };

    // 韻律非対応の当日キャッシュ（DESIGN.md §6a）: 同日・同リージョンでフォールバック実績が
    // あれば最初から韻律なし1回で実行し、毎ターンの二重認識（レイテンシ倍増）を避ける。
    const today = learningDate(new Date());
    const cachedFallback = await config.getPaProsodyFallback();
    const skipProsody = shouldSkipProsody(cachedFallback, region, today);

    let phrases: PhraseAssessment[];
    let usedProsody = !skipProsody;
    let retried = false;

    if (skipProsody) {
      console.info(
        '[azurePaUnscripted] 当日キャッシュにより韻律なしで直接実行します（このリージョンで本日フォールバック実績あり）。',
      );
      phrases = await recognizeOnce(SpeechSDK, wavBuffer, { ...recognizeOpts, enableProsody: false });
      if (phrases.length === 0) {
        throw new AzurePronunciationNoResultError();
      }
    } else {
      try {
        phrases = await recognizeOnce(SpeechSDK, wavBuffer, { ...recognizeOpts, enableProsody: true });
        if (phrases.length === 0) {
          throw new AzurePronunciationNoResultError();
        }
        // 韻律あり成功: 古いキャッシュ（別日・別リージョンの残骸）があれば消す（自己回復）。
        if (cachedFallback !== undefined) {
          await config.clearPaProsodyFallback();
        }
      } catch (firstErr) {
        console.error(
          '[azurePaUnscripted] 韻律ありでの発音評価に失敗しました。韻律なしで1回だけ自動リトライします。',
          firstErr,
        );
        retried = true;
        usedProsody = false;
        try {
          phrases = await recognizeOnce(SpeechSDK, wavBuffer, { ...recognizeOpts, enableProsody: false });
          if (phrases.length === 0) {
            throw new AzurePronunciationNoResultError();
          }
          // フォールバック成功: 当日キャッシュを書き、以降のターンは韻律なし1回にする。
          // ただし1回目の失敗がネットワーク/認証/タイムアウト系のときは一時障害の可能性が
          // 高いため書かない（「韻律非対応」と誤学習しない）。
          const transientFirstError =
            firstErr instanceof AzurePronunciationNetworkError ||
            firstErr instanceof AzurePronunciationAuthError ||
            firstErr instanceof AzurePronunciationTimeoutError;
          if (!transientFirstError) {
            await config.setPaProsodyFallback({ region, date: today });
          }
        } catch (retryErr) {
          console.error('[azurePaUnscripted] 韻律なしでの自動リトライも失敗しました。', retryErr);
          console.info('[azurePaUnscripted] リトライ実施: あり（韻律あり失敗→韻律なしで再試行→こちらも失敗）');
          throw retryErr;
        }
      }

      // 接続テスト成功→会話中に失敗、という切り分けの手掛かりとしてリトライの有無を残す。
      console.info(
        retried
          ? '[azurePaUnscripted] リトライ実施: あり（韻律ありが失敗したため韻律なしで再試行し成功しました）'
          : '[azurePaUnscripted] リトライ実施: なし（韻律ありで成功しました）',
      );
    }

    const result = aggregatePhraseAssessments(phrases, { mode: opts.mode, usedProsody });
    if (!result) {
      throw new AzurePronunciationNoResultError();
    }
    return result;
  } catch (err) {
    // Azure側の失敗は例外にせず、azureError入りの空PaResultで返す（DESIGN.md §6a:
    // 「PAエラー時も会話は継続する」）。console.errorには切り詰めない全文を残す。
    console.error('[azurePaUnscripted] 発音評価に失敗しました。', err);
    return { recognizedText: '', pa: makeFailurePaResult(opts.mode, err) };
  }
}
