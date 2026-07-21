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
import type { AssessSpeechResult } from '../speech/azurePaUnscripted';
import { logPaDebug } from '../speech/paDebugLog';

export interface VoiceCaptureHandle {
  /** useRecorderのonAudioChunkへそのまま渡す。 */
  onAudioChunk(chunk: Float32Array, sampleRate: number): void;
  /** ストリーミング評価の確定を待つ。セッション不成立・失敗はnull（呼び出し側がbatchへ）。 */
  finish(): Promise<AssessSpeechResult | null>;
  /** これまでに変換した音声の秒数（バッファ済み分を含む。usageLog加算用）。 */
  audioSeconds(): number;
  /** セッションを破棄する。以降のonAudioChunk/finishは何もしない。冪等。 */
  abort(): void;
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

    async finish() {
      if (aborted) return null;
      // ゼロチャンク即断（DESIGN.md §5）: PCMが1バイトも届いていない＝AudioWorkletが
      // 動いていない疑い。セッション確立やタイムアウトを待たずに即破棄してbatchへ
      // （iOSでworkletが沈黙した場合の無駄待ちを防ぐ）。
      if (totalPcmBytes === 0) {
        console.warn('[voiceCapture] PCMチャンクが1件も届いていないため、ストリーミング評価を破棄します（batchへ）。');
        logPaDebug('[capture] PCMチャンク0件→即abort（worklet不動作の疑い）→batchへ');
        handle.abort();
        return null;
      }
      await sessionPromise;
      if (!session || failed) return null;
      try {
        return await session.finish();
      } catch (err) {
        console.warn('[voiceCapture] ストリーミング評価に失敗しました（batch評価へフォールバックします）。', err);
        logPaDebug(`[capture] stream失敗→batchへ (${err instanceof Error ? err.name : String(err)})`);
        return null;
      }
    },

    audioSeconds() {
      return totalPcmBytes / (TARGET_SAMPLE_RATE * 2);
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
