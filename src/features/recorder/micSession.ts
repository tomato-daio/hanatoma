/**
 * ハンズフリー会話用のマイク（DESIGN.md §5・M13。React非依存）。
 *
 * getUserMedia → 統一AudioContext（getSharedAudioContext）→ 既存のPCMタップworklet で、
 * デバイス既定sampleRateのFloat32チャンク（約43ms）を逐次コールバックする。
 * 録音ファイル（MediaRecorder）は作らない: 会話後の発音評価と保存には、Azureへ流した
 * 16kHz PCM16 をそのまま使う（liveTalkController）。
 *
 * マイク方式（設定 micMode）:
 *   - perTurn（既定）: 聞き取りの間だけ開き、AIが話す間は閉じる。iPhoneで実績のある動き
 *     （マイク使用中はiOSが通話用の音声経路に切り替え、AI音声が小さくなることがあるため）
 *   - keepOpen（実験）: 会話中ずっと開いたまま（毎ターンのマイク取得を省く）。
 *     iOSでは navigator.audioSession.type='play-and-record' を設定する
 *
 * iOSの着信・Siri等でトラックが mute されたら onMuteChange(true)（一時停止扱い）、
 * ended はOSにマイクを止められた（致命）として onEnded を呼ぶ。
 */

import { getSharedAudioContext } from './useRecorder';
import { createPcmTapNode, ensurePcmTapModule, supportsPcmTap } from './pcmTapWorklet';

export type MicMode = 'perTurn' | 'keepOpen';
export const MIC_MODE_APP_STATE_KEY = 'micMode';
export const DEFAULT_MIC_MODE: MicMode = 'perTurn';

export function parseMicMode(raw: unknown): MicMode {
  return raw === 'keepOpen' || raw === 'perTurn' ? raw : DEFAULT_MIC_MODE;
}

export interface MicSession {
  close(): void;
}

export interface OpenMicOptions {
  onChunk: (chunk: Float32Array, sampleRate: number) => void;
  onMuteChange?: (muted: boolean) => void;
  onEnded?: () => void;
  /** iOSのオーディオセッション種別（keepOpen時のみ 'play-and-record'）。 */
  audioSessionType?: 'play-and-record';
}

interface NavigatorWithAudioSession extends Navigator {
  audioSession?: { type: string };
}

function setAudioSessionType(type: string): void {
  const session = (navigator as NavigatorWithAudioSession).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // 未対応の値・環境は無視する
  }
}

export async function openMicSession(opts: OpenMicOptions): Promise<MicSession> {
  if (!supportsPcmTap()) {
    throw new Error('このブラウザは音声の逐次処理（AudioWorklet）に対応していません。');
  }
  if (opts.audioSessionType) setAudioSessionType(opts.audioSessionType);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // エコーキャンセル等を明示指定し、スピーカー→マイクの回り込み（AI音声）をOS側で除去する。
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    if (opts.audioSessionType) setAudioSessionType('auto');
    throw err;
  }

  const ctx = getSharedAudioContext();
  const nodes: AudioNode[] = [];
  const track = stream.getAudioTracks()[0];
  const onMute = () => opts.onMuteChange?.(true);
  const onUnmute = () => opts.onMuteChange?.(false);
  const onEnded = () => opts.onEnded?.();
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    track?.removeEventListener('mute', onMute);
    track?.removeEventListener('unmute', onUnmute);
    track?.removeEventListener('ended', onEnded);
    for (const node of nodes) {
      if (node instanceof AudioWorkletNode) node.port.onmessage = null;
      node.disconnect();
    }
    // track.stop()はendedイベントを発火させない仕様なので、正常終了がonEndedを誘発することはない。
    stream.getTracks().forEach((t) => t.stop());
    if (opts.audioSessionType) setAudioSessionType('auto');
    // 統一AudioContext自体はTTS再生が使い回すため、ここではcloseしない。
  };

  try {
    await ctx.resume().catch(() => undefined);
    await ensurePcmTapModule(ctx);
    if (closed) return { close };
    const source = ctx.createMediaStreamSource(stream);
    const tap = createPcmTapNode(ctx, (chunk) => {
      if (!closed) opts.onChunk(chunk, ctx.sampleRate);
    });
    // 出力未接続のworkletがpullされない環境（WebKit）対策として、無音ゲイン経由でdestinationへ繋ぐ。
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(tap);
    tap.connect(silent);
    silent.connect(ctx.destination);
    nodes.push(source, tap, silent);
  } catch (err) {
    close();
    throw err;
  }

  track?.addEventListener('mute', onMute);
  track?.addEventListener('unmute', onUnmute);
  track?.addEventListener('ended', onEnded);
  return { close };
}
