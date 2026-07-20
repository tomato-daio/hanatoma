/**
 * プレーヤー・レコーダー共通の音声ユーティリティ。
 */

/** 秒数を "m:ss" 形式に整形する（10分未満想定のシャドーイング教材用）。 */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 録音に使うMediaRecorderのmimeTypeを環境に応じて選ぶ。
 * iPhone Safari は audio/mp4(aac)、Chrome/Edgeは audio/webm(opus) を優先的にサポートする。
 * 実際にサポートされているBlobのmimeTypeをそのまま保存・再生に使い、変換は行わない。
 */
const RECORDER_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return RECORDER_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Blobまたは音声URLから再生時間(秒)を取得する。 */
export function loadAudioDuration(src: Blob | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const isBlob = typeof src !== 'string';
    const url = isBlob ? URL.createObjectURL(src) : src;
    const cleanup = () => {
      if (isBlob) URL.revokeObjectURL(url);
    };
    audio.addEventListener('loadedmetadata', () => {
      const duration = audio.duration;
      cleanup();
      resolve(Number.isFinite(duration) ? duration : 0);
    });
    audio.addEventListener('error', () => {
      cleanup();
      reject(new Error('音声の読み込みに失敗しました'));
    });
    audio.src = url;
  });
}

/** 英文の単語数をカウントする（Materialのメタ情報用の簡易実装）。 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Whisper文字起こしが要求する入力サンプルレート(Hz)。 */
export const WHISPER_SAMPLE_RATE = 16000;

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * 提出音声Blobを、Whisper文字起こし用に16kHzモノラルのFloat32Arrayへデコード・リサンプルする
 * （DESIGN.md §8手順1）。
 *
 * 手順:
 * 1. `AudioContext.decodeAudioData` でBlobを元のサンプルレート・チャンネル数のAudioBufferへデコード
 * 2. サンプルレート16000・チャンネル数1の`OfflineAudioContext`にそのAudioBufferを再生させ、
 *    レンダリング結果を取得する。Web Audio APIはOfflineAudioContextのサンプルレート・
 *    チャンネル数に合わせて自動的にリサンプル・ダウンミックスするため、明示的な実装は不要。
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();

  const w = window as WindowWithWebkitAudioContext;
  const AudioContextCtor = window.AudioContext ?? w.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('このブラウザはWeb Audio APIに対応していません');
  }

  const decodeCtx = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    void decodeCtx.close();
  }

  const targetLength = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContext(1, targetLength, WHISPER_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

export interface SpeechBounds {
  /** 発話区間の開始秒（録音全体の先頭からの相対秒）。 */
  startSec: number;
  /** 発話区間の終了秒（録音全体の先頭からの相対秒）。 */
  endSec: number;
}

/** RMSを計算する窓の長さ(秒)。 */
const RMS_WINDOW_SEC = 0.02;
/** 窓RMSの最大値に対し、この割合未満を無音とみなす（DESIGN.md §8手順4）。 */
const SILENCE_THRESHOLD_RATIO = 0.03;
/** 突発ノイズ（1〜数窓の短いスパイク）を発話の開始/終了と誤検出しないための最小連続発話時間(秒)。 */
const MIN_VOICED_RUN_SEC = 0.1;
/** 録音全体のピークRMSがこの値未満なら、実質無音（フロートの微小ノイズのみ）として扱う。 */
const ABSOLUTE_SILENCE_FLOOR = 1e-4;

/**
 * 録音PCMの先頭・末尾の無音を除いた発話区間（最初に声が出た時刻〜最後に声が出た時刻）を求める
 * 純関数（DESIGN.md §8手順4・M10）。
 *
 * RMS窓（20ms）ごとにエネルギーを求め、全体のピークRMSの3%未満を無音とみなす。ただし、
 * 数windowだけの短い突発ノイズを発話の開始/終了と誤検出しないよう、しきい値を超える窓が
 * MIN_VOICED_RUN_SEC（100ms）以上連続して初めて「発話区間」として採用する。
 * 該当する連続区間が1つも無い場合（全体が無音、または短いノイズのみ）はnullを返す
 * （呼び出し側は録音全体の長さへフォールバックする）。
 */
export function speechBounds(pcm: Float32Array, sampleRate: number): SpeechBounds | null {
  if (pcm.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;

  const windowSize = Math.max(1, Math.round(sampleRate * RMS_WINDOW_SEC));
  const windowCount = Math.ceil(pcm.length / windowSize);
  const rms: number[] = new Array(windowCount);
  let maxRms = 0;
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSize;
    const end = Math.min(pcm.length, start + windowSize);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += pcm[i] * pcm[i];
    const value = Math.sqrt(sumSq / (end - start));
    rms[w] = value;
    if (value > maxRms) maxRms = value;
  }

  if (maxRms < ABSOLUTE_SILENCE_FLOOR) return null;

  const threshold = maxRms * SILENCE_THRESHOLD_RATIO;
  const minVoicedWindows = Math.max(1, Math.round(MIN_VOICED_RUN_SEC / RMS_WINDOW_SEC));

  let firstVoicedWindow = -1;
  let lastVoicedWindow = -1;
  let runStart = -1;
  for (let w = 0; w <= windowCount; w++) {
    const isVoiced = w < windowCount && rms[w] >= threshold;
    if (isVoiced) {
      if (runStart < 0) runStart = w;
      continue;
    }
    if (runStart >= 0) {
      const runLength = w - runStart;
      if (runLength >= minVoicedWindows) {
        if (firstVoicedWindow < 0) firstVoicedWindow = runStart;
        lastVoicedWindow = w - 1;
      }
      runStart = -1;
    }
  }

  // 十分な長さの発話区間が1つも無い（全区間無音、または短い突発ノイズのみ）。
  if (firstVoicedWindow < 0) return null;

  const startSec = (firstVoicedWindow * windowSize) / sampleRate;
  const endSampleExclusive = Math.min(pcm.length, (lastVoicedWindow + 1) * windowSize);
  const endSec = endSampleExclusive / sampleRate;

  return { startSec, endSec };
}
