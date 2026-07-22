/**
 * 録音とストリーミング発音評価をつなぐグルーレイヤ（DESIGN.md §5 M11。React非依存）。
 *
 * 責務:
 * - useRecorderのonAudioChunk（デバイス既定sampleRateのFloat32）を受け取り、
 *   初回チャンクの実レートからリサンプラを生成して16kHz PCM16へ逐次変換する
 * - セッション確立（startStreamingPaの解決）前に届いたPCMはバッファに貯め、
 *   確立後に到着順でflushしてから直結する（音声の欠落・順序入れ替わりを起こさない）
 * - セッション開始・評価の失敗はすべて吸収し、finish()はnullを返す
 *   （呼び出し側=useConversationが録音済みBlobからbatch評価へフォールバックする）
 *
 * beginVoiceCaptureはawaitさせない設計: startStreamingPaのPromiseを内部保持し、
 * 録音開始（getUserMedia〜MediaRecorder.start）を一切ブロックしない。
 */

import { createResamplerState, floatChunkToPcm16, resampleLinearChunk, type LinearResamplerState } from '../../lib/pcm';
import {
  startStreamingPa as defaultStartStreamingPa,
  type StreamingPaOptions,
  type StreamingPaSession,
} from '../speech/azurePaStreaming';
import { AzurePronunciationTimeoutError, type AssessSpeechResult } from '../speech/azurePaUnscripted';
import { logPaDebug } from '../speech/paDebugLog';

/** finishの失敗種別（batch見切り判定shouldSkipBatchに使う）。 */
export type VoiceCaptureFailure = 'timeout' | 'other' | null;

export interface VoiceCaptureHandle {
  /** useRecorderのonAudioChunkへそのまま渡す。 */
  onAudioChunk(chunk: Float32Array, sampleRate: number): void;
  /**
   * ストリーミング評価の確定を待つ。セッション不成立・失敗はnull（呼び出し側がbatchへ）。
   * signalがabortされたら残り（セッション確立・確定）を待たずnullを返し、セッションを破棄する
   * （全体デッドラインの実効化。従来はここに上限がなく「評価中」が無期限化しえた）。
   */
  finish(signal?: AbortSignal): Promise<AssessSpeechResult | null>;
  /** これまでに変換した音声の秒数（バッファ済み分を含む。usageLog加算用）。 */
  audioSeconds(): number;
  /** 直近のfinish失敗の種別。'timeout'=確定待ちタイムアウト（shouldSkipBatchの判定材料）。 */
  lastFailure(): VoiceCaptureFailure;
  /** セッションを破棄する。以降のonAudioChunk/finishは何もしない。冪等。 */
  abort(): void;
}

/**
 * stream失敗後にbatchフォールバックを試みる閾値（秒）。これを超える音声の
 * 確定待ちタイムアウト後batchは、F0では全体デッドライン内に完了する見込みが薄い。
 */
export const BATCH_SKIP_MIN_AUDIO_SEC = 4;

/**
 * stream失敗後にbatchフォールバックを見送るかの純関数（DESIGN.md §6a-2）。
 * F0では長い自由会話のbatchは60秒級と実測されており、submitVoiceの15秒デッドライン内に
 * 完了しない。「確定待ちタイムアウト（=Azure側はずっと処理中だった）かつ音声が閾値超」の
 * ときはbatchも間に合わない見込みが濃厚なので試みず、即エラー表示（→即言い直し）にする。
 * セッション開始失敗・WS死亡・ゼロチャンク等（failure='other'）は新規接続のbatchに
 * 正当性があるため従来どおり実行する。
 */
export function shouldSkipBatch(failure: VoiceCaptureFailure, audioSeconds: number): boolean {
  return failure === 'timeout' && audioSeconds > BATCH_SKIP_MIN_AUDIO_SEC;
}

interface VoiceCaptureDeps {
  startStreamingPa: typeof defaultStartStreamingPa;
}

const TARGET_SAMPLE_RATE = 16000;

export function beginVoiceCapture(
  opts: StreamingPaOptions,
  deps: VoiceCaptureDeps = { startStreamingPa: defaultStartStreamingPa },
): VoiceCaptureHandle {
  let session: StreamingPaSession | null = null;
  let failed = false;
  let aborted = false;
  let resampler: LinearResamplerState | null = null;
  /** セッション確立前に届いたPCM16（到着順）。確立後にflushする。 */
  const pending: ArrayBuffer[] = [];
  let totalPcmBytes = 0;
  /** 直近のfinish失敗の種別（lastFailureで公開。batch見切り判定用）。 */
  let failureKind: VoiceCaptureFailure = null;

  const sessionPromise = deps.startStreamingPa(opts).then(
    (s) => {
      if (aborted) {
        s.abort();
        return;
      }
      session = s;
      for (const buf of pending) s.writeChunk(buf);
      pending.length = 0;
    },
    (err) => {
      failed = true;
      pending.length = 0;
      console.warn(
        '[voiceCapture] ストリーミング評価セッションの開始に失敗しました（停止後にbatch評価へフォールバックします）。',
        err,
      );
      logPaDebug(`[capture] セッション開始失敗→batchへ (${err instanceof Error ? err.name : String(err)})`);
    },
  );

  const handle: VoiceCaptureHandle = {
    onAudioChunk(chunk, sampleRate) {
      if (aborted || failed || chunk.length === 0) return;
      if (!resampler) resampler = createResamplerState(sampleRate, TARGET_SAMPLE_RATE);
      const r = resampleLinearChunk(resampler, chunk);
      resampler = r.state;
      if (r.output.length === 0) return;
      const pcm16 = floatChunkToPcm16(r.output);
      totalPcmBytes += pcm16.byteLength;
      if (session) {
        session.writeChunk(pcm16);
      } else {
        pending.push(pcm16);
      }
    },

    async finish(signal?: AbortSignal) {
      if (aborted) return null;
      if (signal?.aborted) {
        handle.abort();
        return null;
      }
      // ゼロチャンク即断（DESIGN.md §5）: PCMが1バイトも届いていない＝AudioWorkletが
      // 動いていない疑い。セッション確立やタイムアウトを待たずに即破棄してbatchへ
      // （iOSでworkletが沈黙した場合の無駄待ちを防ぐ）。
      if (totalPcmBytes === 0) {
        console.warn('[voiceCapture] PCMチャンクが1件も届いていないため、ストリーミング評価を破棄します（batchへ）。');
        logPaDebug('[capture] PCMチャンク0件→即abort（worklet不動作の疑い）→batchへ');
        failureKind = 'other';
        handle.abort();
        return null;
      }
      // 全体デッドライン（submitVoice/submitKeyPhrase）のsignalとrace: セッション確立待ち
      // （startStreamingPaの解決）と確定待ち（session.finish）のどちらでabortされても
      // 即座にnullで返し、セッションを破棄してWSを解放する。
      let onAbort: (() => void) | undefined;
      const abortedP = signal
        ? new Promise<'aborted'>((resolveAborted) => {
            onAbort = () => resolveAborted('aborted');
            signal.addEventListener('abort', onAbort, { once: true });
          })
        : null;
      try {
        const sessionReady = sessionPromise.then(() => 'session' as const);
        const first = abortedP ? await Promise.race([sessionReady, abortedP]) : await sessionReady;
        if (first === 'aborted') {
          logPaDebug('[capture] デッドラインabort（セッション確立待ち中）→破棄');
          handle.abort();
          return null;
        }
        if (!session || failed) {
          failureKind = 'other';
          return null;
        }
        try {
          const finished = abortedP
            ? await Promise.race([session.finish(), abortedP])
            : await session.finish();
          if (finished === 'aborted') {
            logPaDebug('[capture] デッドラインabort（確定待ち中）→破棄');
            handle.abort();
            return null;
          }
          return finished;
        } catch (err) {
          // hadEvidence=false（認識イベントゼロ=WS沈黙死の疑い）のタイムアウトは'other'に分類し、
          // 新規接続のbatchフォールバックを見送らせない（shouldSkipBatchのdocコメント参照）。
          failureKind =
            err instanceof AzurePronunciationTimeoutError && err.hadEvidence ? 'timeout' : 'other';
          console.warn('[voiceCapture] ストリーミング評価に失敗しました（batch評価へフォールバックします）。', err);
          logPaDebug(`[capture] stream失敗→batchへ (${err instanceof Error ? err.name : String(err)})`);
          return null;
        }
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    },

    audioSeconds() {
      return totalPcmBytes / (TARGET_SAMPLE_RATE * 2);
    },

    lastFailure() {
      return failureKind;
    },

    abort() {
      if (aborted) return;
      aborted = true;
      pending.length = 0;
      if (session) {
        session.abort();
      } else {
        // 確立待ち中のabort: 確立し次第（then内のabortedチェックで）即破棄される。
        void sessionPromise;
      }
    },
  };
  return handle;
}
