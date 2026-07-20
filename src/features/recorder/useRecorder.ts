import { useCallback, useEffect, useRef, useState } from 'react';
import { createPcmTapNode, ensurePcmTapModule, supportsPcmTap } from './pcmTapWorklet';

/**
 * 録音停止時に返す結果（DESIGN.md §5）。呼び出し側はこれをそのままWAV変換(§5パイプライン)に渡す。
 */
export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface UseRecorderOptions {
  /**
   * 録音中、マイクPCM（デバイス既定sampleRateのFloat32チャンク）を逐次通知する
   * （ストリーミング発音評価用。DESIGN.md §5 M11）。AudioWorklet初期化に失敗した
   * 環境では呼ばれない（録音自体は従来どおり続行し、評価はbatch経路に落ちる）。
   */
  onAudioChunk?: (chunk: Float32Array, sampleRate: number) => void;
}

export interface UseRecorderResult {
  isRecording: boolean;
  /** 録音開始からの経過秒。 */
  elapsedSec: number;
  /** 0〜1のレベルメーター値（簡易RMS）。 */
  level: number;
  error: string | null;
  /** マイク許可取得・録音開始。多重起動は無視する。 */
  start: () => Promise<void>;
  /** 録音停止。MediaRecorderのonstop確定を待って結果を返す（録音していなければnull）。 */
  stop: () => Promise<RecordingResult | null>;
  /** エラー・レベル表示等をリセットする（録音自体には影響しない）。 */
  reset: () => void;
}

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * 録音に使うMediaRecorderのmimeTypeを環境に応じて選ぶ（DESIGN.md §1）。
 * iPhone Safariは audio/mp4(aac)、Chrome/Edgeは audio/webm(opus) を優先的にサポートする。
 * 実際にサポートされているBlobのmimeTypeをそのまま保存に使い、変換は行わない。
 */
const RECORDER_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * アプリ全体で共有する単一のAudioContext（DESIGN.md §5・§6c）。
 * このフックのレベルメーター（マイク入力解析）と azureTts.ts のAI音声再生キューが
 * 同じコンテキストを使い回すことで、iOSで複数のオーディオセッションを行き来して
 * マイクが停止される現象（shadotoma M7で実証済みの問題）を避ける。
 * 一度生成したら明示的にはcloseせず、ページの生存期間で使い回す。
 */
let sharedAudioContext: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    return sharedAudioContext;
  }
  const w = window as WindowWithWebkitAudioContext;
  const AudioContextCtor = window.AudioContext ?? w.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('このブラウザはWeb Audio APIに対応していません');
  }
  sharedAudioContext = new AudioContextCtor();
  return sharedAudioContext;
}

/**
 * push-to-talk録音フック（DESIGN.md §5）。
 * shadotomaの useRecorder からお手本同時再生ロジックを除去し、録音本体のみに簡素化したもの。
 * 開始/停止はマイク大ボタンからの明示操作のみを前提とし、お手本終了等による自動停止はしない。
 * Wake Lockはターン全体（PA・Haiku・TTSを含む）にまたがるため、このフックの外側（会話状態機械）が管理する。
 */
export function useRecorder(options?: UseRecorderOptions): UseRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // PCMタップ（ストリーミング評価用）。コールバックはrefで持ち、依存配列を汚さない。
  const onAudioChunkRef = useRef(options?.onAudioChunk);
  onAudioChunkRef.current = options?.onAudioChunk;
  const pcmTapNodeRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  /** start()の多重起動防止（getUserMedia待ち中の連打対策）。 */
  const busyRef = useRef(false);
  /** trueの間はアンマウント済み。await後の副作用開始をここで打ち切る。 */
  const disposedRef = useRef(false);
  /** trueの間はマイクがOSに停止/ミュートされた後始末中。MediaRecorderのonstopが発火しても録音結果を確定させない。 */
  const abortedRef = useRef(false);
  /** stop()呼び出し側がonstopの確定結果を受け取るためのresolver。中断時はnullで解決する。 */
  const stopResolveRef = useRef<((result: RecordingResult | null) => void) | null>(null);

  const cleanupStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // track.stop()はendedイベントを発火させない仕様なので、ここでの正常停止が
    // handleTrackAbort（OSによる強制終了検知）を誤って再発火させることはない。
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    if (pcmTapNodeRef.current) {
      pcmTapNodeRef.current.port.onmessage = null;
      pcmTapNodeRef.current.disconnect();
      pcmTapNodeRef.current = null;
    }
    silentGainRef.current?.disconnect();
    silentGainRef.current = null;
    // 統一AudioContext自体はazureTts等が使い回すため、ここではcloseしない。
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cleanupStream();
    };
  }, [cleanupStream]);

  const monitorLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      setLevel(Math.min(1, rms * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  /**
   * マイクトラックがOSに停止/ミュートされた場合の後始末（DESIGN.md §5）。
   * ended/muteは同一トラックで連続発火しうるため、一度後始末したら二重実行しない。
   */
  const handleTrackAbort = useCallback(() => {
    if (abortedRef.current) return;
    abortedRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // 既に停止済み等は無視する
      }
    }
    cleanupStream();
    setIsRecording(false);
    setError('マイクがOSに停止されました。もう一度録音開始を押してください');
    const resolve = stopResolveRef.current;
    stopResolveRef.current = null;
    resolve?.(null);
  }, [cleanupStream]);

  const start = useCallback(async () => {
    if (busyRef.current || isRecording) return;
    busyRef.current = true;
    setError(null);
    chunksRef.current = [];
    abortedRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // エコーキャンセル等を明示指定し、イヤホン無しでもスピーカー→マイクの回り込み（AI音声）を
        // OS側で除去する。録音されるのをユーザーの声だけに近づけ、発音評価の誤判定を防ぐ。
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (disposedRef.current) {
        // getUserMedia待ち中にアンマウントされた。取得済みストリームを即座に解放して中断する。
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      // マイクがOSに停止/ミュートされたら後始末してユーザーに再試行を促す（DESIGN.md §5）。
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', handleTrackAbort, { once: true });
        track.addEventListener('mute', handleTrackAbort, { once: true });
      });

      // 統一AudioContextを使い回す。iOSはsuspendedで始まることがあるため必ずresumeする。
      const audioCtx = getSharedAudioContext();
      try {
        await audioCtx.resume();
      } catch {
        // resume失敗は致命的にしない（レベルメーターが動かない程度に留める）
      }
      if (disposedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (abortedRef.current) {
        // resume()待ち中にhandleTrackAbortが発火し、後始末済み。ここで配線・start()を行うと
        // 状態が矛盾するため何もせずreturnする（再録音はstart()冒頭のabortedRefリセットで可能）。
        return;
      }

      const micSource = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      micSource.connect(analyser);
      micSourceRef.current = micSource;
      analyserRef.current = analyser;
      monitorLevel();

      // PCMタップ（ストリーミング評価用。DESIGN.md §5 M11）。初期化失敗は録音を止めず、
      // チャンクが流れないだけにする（呼び出し側が自然にbatch評価へフォールバックする）。
      if (onAudioChunkRef.current && supportsPcmTap()) {
        try {
          await ensurePcmTapModule(audioCtx);
          if (disposedRef.current || abortedRef.current) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          const tap = createPcmTapNode(audioCtx, (chunk) => {
            onAudioChunkRef.current?.(chunk, audioCtx.sampleRate);
          });
          // 出力未接続のworkletがレンダリンググラフからpullされない環境（WebKit）対策として、
          // 無音ゲイン経由でdestinationへ繋ぐ（音は出ない）。
          const silent = audioCtx.createGain();
          silent.gain.value = 0;
          micSource.connect(tap);
          tap.connect(silent);
          silent.connect(audioCtx.destination);
          pcmTapNodeRef.current = tap;
          silentGainRef.current = silent;
        } catch (err) {
          console.warn(
            '[useRecorder] PCMタップの初期化に失敗しました（ストリーミング評価なしで録音を続行します）。',
            err,
          );
        }
      }

      const selectedMimeType = pickRecorderMimeType();
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const resolve = stopResolveRef.current;
        stopResolveRef.current = null;
        // マイクのOS強制終了で後始末済みの場合、中途半端なBlobで結果を確定させない。
        if (abortedRef.current) {
          resolve?.(null);
          return;
        }
        const finalType = selectedMimeType ?? recorder.mimeType ?? 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: finalType });
        const durationMs = Date.now() - startTimeRef.current;
        resolve?.({ blob, mimeType: finalType, durationMs });
      };

      startTimeRef.current = Date.now();
      setElapsedSec(0);
      timerRef.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'マイクの使用許可が必要です');
      cleanupStream();
      setIsRecording(false);
    } finally {
      busyRef.current = false;
    }
  }, [cleanupStream, monitorLevel, isRecording, handleTrackAbort]);

  const stop = useCallback((): Promise<RecordingResult | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        cleanupStream();
        setIsRecording(false);
        resolve(null);
        return;
      }
      stopResolveRef.current = resolve;
      setIsRecording(false);
      recorder.stop();
      cleanupStream();
    });
  }, [cleanupStream]);

  const reset = useCallback(() => {
    setElapsedSec(0);
    setLevel(0);
    setError(null);
  }, []);

  return { isRecording, elapsedSec, level, error, start, stop, reset };
}
