/**
 * Float32のPCMサンプル列をWAV(RIFF)コンテナへエンコードする純関数（DESIGN.md §8c: Azure発音評価）。
 *
 * Azure発音評価へ送信する音声は、decodeToMono16k（16kHzモノラルFloat32）の結果をこの関数で
 * 16bit PCMのWAVへ変換してから azurePronunciation.ts の push stream へ渡す。
 * DOM/ブラウザAPIには依存しない（ArrayBuffer/DataViewのみを使う）純関数のみを置く。
 */

const WAV_HEADER_SIZE = 44;
const BYTES_PER_SAMPLE = 2; // 16bit PCM固定
const PCM_FORMAT_CODE = 1; // WAVEフォーマットタグ: 1 = リニアPCM

function writeAsciiString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * -1..1 の範囲へクリップしてから16bit符号付き整数へ変換する。
 * クリップせずに変換すると、範囲外の値（例: 1.5）が符号ビットを巻き込んでオーバーフローし、
 * 本来と逆極性のノイズになってしまうため、必ず先にクリップする。
 */
function floatSampleToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clipped = Math.max(-1, Math.min(1, sample));
  return clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff);
}

export interface WavEncodeOptions {
  /** サンプルレート(Hz)。既定16000（DESIGN.md §8: decodeToMono16kの出力に合わせる）。 */
  sampleRate?: number;
  /** チャンネル数。既定1（モノラル）。 */
  channels?: number;
}

/**
 * 16bit PCM・既定モノラル16kHzのWAV(RIFF)ファイルをArrayBufferとして生成する。
 * DESIGN.md §8c: 「decodeToMono16kのFloat32→WAV(16k mono PCM16)エンコード」。
 */
export function encodeWavPcm16(samples: Float32Array, options: WavEncodeOptions = {}): ArrayBuffer {
  const sampleRate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * BYTES_PER_SAMPLE;

  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);

  // RIFFチャンク
  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // ファイル全体サイズ - 8
  writeAsciiString(view, 8, 'WAVE');

  // fmtサブチャンク
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmtチャンクサイズ(PCMは16固定)
  view.setUint16(20, PCM_FORMAT_CODE, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bitsPerSample

  // dataサブチャンク
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_SIZE;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, floatSampleToInt16(samples[i]), true);
    offset += BYTES_PER_SAMPLE;
  }

  return buffer;
}
