/**
 * 会話中の音声認識（発音評価なし・ストリーミング）（DESIGN.md §6d・M13）。
 *
 * 旧来は会話ターンのテキストも発音評価(PA)付きの認識からしか得られず、PAの確定遅れ
 * （発話長に比例・S0でも改善せず。§16a）がそのまま返答の遅さになっていた。
 * ここではPAを付けない素の SpeechRecognizer を使い、部分認識（recognizing）と
 * 確定（recognized）を逐次コールバックする。話し終わりの判定は呼び出し側（liveMachine）が行う。
 *
 * - 区切り: 既定は無音500msで1フレーズ確定（Speech_SegmentationSilenceTimeoutMs）。
 *   SDKでは無音指定を入れると Semantic 区切りは無効化される（排他）ため、どちらか一方だけを設定する
 * - 音声: 16kHz mono PCM16 を pushStream へ逐次書き込む（azurePaStreaming と同じ形式）
 * - 後片付け: closeConnection→connection.close→recognizer.close→audioConfig→speechConfig の順
 *   （F0の同時接続1本をWS残留で塞がないため。azurePaStreaming と同じ方針）
 * - 失敗契約: 開始失敗は throw、開始後の失敗は onError で通知する
 * - 区切り設定の自動無効化（M13補修）: 区切りの指定はWebSocketのURLパラメータにも載るため、
 *   サービス側が受け付けないとハンドシェイクが拒否され 1006 で接続できない（iPhone実測）。
 *   区切りを指定した接続が、認識結果を1件も返す前に接続エラーで終わったら、以降このアプリ
 *   セッション中は区切りを指定しない（SDK既定の区切り）。呼び出し側は1回だけ再接続する
 */

import {
  AzurePronunciationAuthError,
  AzurePronunciationNetworkError,
  AzureSpeechKeyMissingError,
  swallowTeardownError,
  truncateDetail,
} from './azurePaUnscripted';
import { pcmBytesToSeconds, START_TIMEOUT_MS } from './azurePaStreaming';
import { logPaDebug } from './paDebugLog';

export type SttSegmentation = { strategy: 'time'; silenceMs: number } | { strategy: 'semantic' };

/** 区切り指定付きの接続が拒否されたか（アプリセッション中のみ。リロードで再挑戦する）。 */
let segmentationRejected = false;

export function isSegmentationRejected(): boolean {
  return segmentationRejected;
}

/** テスト用。 */
export function resetSegmentationRejected(): void {
  segmentationRejected = false;
}

/**
 * 接続エラーが「区切り指定が原因かもしれない」ものかの純関数。区切りを指定した接続で、
 * 認識結果を1件も受け取る前に接続系のエラー（1006等のハンドシェイク拒否）で終わった場合。
 */
export function shouldDropSegmentation(opts: {
  usedCustomSegmentation: boolean;
  sawRecognitionEvent: boolean;
  connectionError: boolean;
}): boolean {
  return opts.usedCustomSegmentation && !opts.sawRecognitionEvent && opts.connectionError;
}

/** 会話中の既定の区切り（無音500ms）。 */
export const DEFAULT_STT_SEGMENTATION: SttSegmentation = { strategy: 'time', silenceMs: 500 };

export interface LiveSttOptions {
  phraseHints?: string[];
  segmentation?: SttSegmentation;
  /** 部分認識（話している途中のテキスト）。offset/durationはこのセッションの音声先頭からのms。 */
  onPartial(text: string, offsetMs: number, durationMs: number): void;
  /** 1フレーズの確定。雑音等で何も認識されなかった区切りは text=''。 */
  onFinal(text: string, offsetMs: number, durationMs: number): void;
  /** 認識開始後のエラー（接続断・認証失敗等）。 */
  onError(err: Error): void;
}

export interface LiveSttSession {
  /** 16kHz mono PCM16 を追記する。finish/abort後は無視。 */
  writeChunk(pcm16: ArrayBuffer): void;
  audioSeconds(): number;
  /** 音声の送信を締め、残りの確定を最大 graceMs 待ってから閉じる。 */
  finish(graceMs: number): Promise<void>;
  /** 即座に閉じる（結果は捨てる）。冪等。 */
  abort(): void;
}

const TICKS_PER_MS = 10_000;

export async function startLiveStt(opts: LiveSttOptions): Promise<LiveSttSession> {
  const t0 = performance.now();
  const [SpeechSDK, config] = await Promise.all([
    import('microsoft-cognitiveservices-speech-sdk'),
    import('./azureSpeechConfig'),
  ]);
  const apiKey = await config.getAzureSpeechKey();
  if (!apiKey) throw new AzureSpeechKeyMissingError();
  const region = await config.getAzureSpeechRegion();

  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(apiKey, region);
  speechConfig.speechRecognitionLanguage = 'en-US';
  // 接続遅延時のバックログ一括送信が実時間ペーシングで待たされないようにする（§6a）。
  speechConfig.setProperty('SPEECH-TransmitLengthBeforThrottleMs', '300000');
  const segmentation = opts.segmentation ?? DEFAULT_STT_SEGMENTATION;
  const useCustomSegmentation = !segmentationRejected;
  if (!useCustomSegmentation) {
    // 区切り指定が拒否された実績あり: SDK既定の区切りで接続する（URLパラメータを付けない）。
  } else if (segmentation.strategy === 'time') {
    speechConfig.setProperty(SpeechSDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(segmentation.silenceMs));
  } else {
    speechConfig.setProperty(SpeechSDK.PropertyId.Speech_SegmentationStrategy, 'Semantic');
  }
  let sawRecognitionEvent = false;
  /** 区切り指定が原因の疑いがある接続失敗なら、以降は区切りを指定しない（ファイル冒頭参照）。 */
  const noteConnectionFailure = (connectionError: boolean) => {
    if (shouldDropSegmentation({ usedCustomSegmentation: useCustomSegmentation, sawRecognitionEvent, connectionError })) {
      segmentationRejected = true;
      logPaDebug('[STT] 区切り指定付きの接続が拒否された疑い→以降は区切り指定なしで接続');
    }
  };

  const format = SpeechSDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = SpeechSDK.AudioInputStream.createPushStream(format);
  const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  const hints = (opts.phraseHints ?? []).map((h) => h.trim()).filter((h) => h.length > 0);
  if (hints.length > 0) {
    SpeechSDK.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(hints);
  }

  let state: 'starting' | 'running' | 'finishing' | 'closed' = 'starting';
  let bytesWritten = 0;
  let firstWriteAt: number | null = null;
  let connectedMs: number | null = null;
  let firstPartialLagMs: number | null = null;
  let finals = 0;

  let stoppedResolve: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    stoppedResolve = resolve;
  });

  const alive = () => state === 'starting' || state === 'running' || state === 'finishing';

  recognizer.recognizing = (_s, e) => {
    sawRecognitionEvent = true;
    if (!alive() || !e.result.text) return;
    const offsetMs = e.result.offset / TICKS_PER_MS;
    if (firstPartialLagMs === null && firstWriteAt !== null) {
      // 診断用: 認識の遅れ（壁時計の経過 − その発話が音声の何ms目か）。
      firstPartialLagMs = performance.now() - firstWriteAt - offsetMs;
    }
    opts.onPartial(e.result.text, offsetMs, e.result.duration / TICKS_PER_MS);
  };
  recognizer.recognized = (_s, e) => {
    sawRecognitionEvent = true;
    if (!alive()) return;
    const offsetMs = e.result.offset / TICKS_PER_MS;
    const durationMs = e.result.duration / TICKS_PER_MS;
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech && e.result.text) {
      finals += 1;
      opts.onFinal(e.result.text, offsetMs, durationMs);
    } else {
      opts.onFinal('', offsetMs, durationMs);
    }
  };
  recognizer.canceled = (_s, e) => {
    if (e.reason !== SpeechSDK.CancellationReason.Error) return;
    stoppedResolve?.();
    if (!alive() || state === 'finishing') return;
    let err: Error;
    if (e.errorCode === SpeechSDK.CancellationErrorCode.AuthenticationFailure) {
      err = new AzurePronunciationAuthError();
    } else if (
      e.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure ||
      e.errorCode === SpeechSDK.CancellationErrorCode.ServiceTimeout
    ) {
      err = new AzurePronunciationNetworkError(e.errorDetails);
    } else {
      err = new Error(e.errorDetails || 'Azure Speechでキャンセルされました。');
    }
    noteConnectionFailure(
      e.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure || /1006/.test(e.errorDetails ?? ''),
    );
    logPaDebug(
      `[STT] エラー ${err.name}: ${truncateDetail(err.message)}（区切り指定${useCustomSegmentation ? 'あり' : 'なし'}）`,
    );
    opts.onError(err);
  };
  recognizer.sessionStopped = () => {
    stoppedResolve?.();
  };

  // WebSocketの事前確立（認識開始前にハンドシェイクを済ませる）。失敗しても開始時に再接続される。
  let connection: import('microsoft-cognitiveservices-speech-sdk').Connection | null = null;
  try {
    connection = SpeechSDK.Connection.fromRecognizer(recognizer);
    connection.connected = () => {
      if (connectedMs === null) connectedMs = performance.now() - t0;
    };
    connection.openConnection();
  } catch (err) {
    console.warn('[azureStt] WebSocketの事前確立に失敗しました（認識開始時に再接続されます）。', err);
  }

  const closeAll = () => {
    swallowTeardownError('connection.closeConnection', () => connection?.closeConnection());
    swallowTeardownError('connection.close', () => connection?.close());
    swallowTeardownError('recognizer.close', () => recognizer.close());
    swallowTeardownError('audioConfig.close', () => audioConfig.close());
    swallowTeardownError('speechConfig.close', () => speechConfig.close());
  };

  const summary = () =>
    `接続 ${connectedMs !== null ? Math.round(connectedMs) : '?'}ms / 認識の遅れ ${
      firstPartialLagMs !== null ? `${(firstPartialLagMs / 1000).toFixed(1)}s` : '?'
    } / 確定${finals}件 / 音声 ${pcmBytesToSeconds(bytesWritten).toFixed(1)}s`;

  try {
    await new Promise<void>((resolve, reject) => {
      // WSハンドシェイクがハングすると成功・失敗どちらのコールバックも呼ばれないため上限を張る。
      const timeoutId = setTimeout(
        () => reject(new AzurePronunciationNetworkError('認識開始がタイムアウトしました')),
        START_TIMEOUT_MS,
      );
      recognizer.startContinuousRecognitionAsync(
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        (err) => {
          clearTimeout(timeoutId);
          reject(new AzurePronunciationNetworkError(String(err)));
        },
      );
    });
  } catch (err) {
    noteConnectionFailure(true);
    logPaDebug(
      `[STT] 開始に失敗 (${err instanceof Error ? `${err.name}: ${truncateDetail(err.message)}` : String(err)})（区切り指定${useCustomSegmentation ? 'あり' : 'なし'}）`,
    );
    state = 'closed';
    closeAll();
    throw err;
  }
  if (state === 'starting') state = 'running';

  const stopRecognition = () =>
    swallowTeardownError('stopContinuousRecognitionAsync', () =>
      recognizer.stopContinuousRecognitionAsync(
        () => stoppedResolve?.(),
        () => stoppedResolve?.(),
      ),
    );

  return {
    writeChunk(pcm16) {
      if (state !== 'running' || pcm16.byteLength === 0) return;
      try {
        pushStream.write(pcm16);
        if (firstWriteAt === null) firstWriteAt = performance.now();
        bytesWritten += pcm16.byteLength;
      } catch (err) {
        console.warn('[azureStt] pushStream.writeに失敗しました（このチャンクは破棄されます）。', err);
      }
    },

    audioSeconds() {
      return pcmBytesToSeconds(bytesWritten);
    },

    async finish(graceMs) {
      if (state !== 'running') return;
      state = 'finishing';
      swallowTeardownError('pushStream.close', () => pushStream.close());
      // 音声の終端を送ると、サービスは残りを確定して sessionStopped を返す。来なければ能動的に止める。
      const nudge = setTimeout(stopRecognition, Math.min(graceMs, 400));
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(nudge);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      state = 'closed';
      logPaDebug(`[STT] 送信で確定 ${summary()}`);
      closeAll();
    },

    abort() {
      if (state === 'closed') return;
      const wasRunning = state === 'running';
      state = 'closed';
      swallowTeardownError('pushStream.close(abort)', () => pushStream.close());
      stopRecognition();
      closeAll();
      if (wasRunning && bytesWritten > 0) logPaDebug(`[STT] 終了 ${summary()}`);
    },
  };
}
