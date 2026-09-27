import { describe, expect, it } from 'vitest';
import { encodeWavPcm16, trimPcm16, wavFromPcm16 } from './wav';

function readAsciiString(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('encodeWavPcm16', () => {
  it('RIFF/WAVE/fmt /dataのヘッダーを正しく書き込む', () => {
    const buffer = encodeWavPcm16(new Float32Array([0, 0, 0]));
    const view = new DataView(buffer);

    expect(readAsciiString(view, 0, 4)).toBe('RIFF');
    expect(readAsciiString(view, 8, 4)).toBe('WAVE');
    expect(readAsciiString(view, 12, 4)).toBe('fmt ');
    expect(readAsciiString(view, 36, 4)).toBe('data');
  });

  it('既定値(16kHz・モノラル・16bit)がヘッダーに反映される', () => {
    const buffer = encodeWavPcm16(new Float32Array([0]));
    const view = new DataView(buffer);

    expect(view.getUint16(20, true)).toBe(1); // PCMフォーマットタグ
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000); // sampleRate
    expect(view.getUint16(34, true)).toBe(16); // bitsPerSample
    expect(view.getUint16(32, true)).toBe(2); // blockAlign = channels * bitsPerSample/8
    expect(view.getUint32(28, true)).toBe(32000); // byteRate = sampleRate * blockAlign
  });

  it('sampleRate/channelsオプションを反映する', () => {
    const buffer = encodeWavPcm16(new Float32Array([0, 0]), { sampleRate: 48000, channels: 2 });
    const view = new DataView(buffer);

    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint16(32, true)).toBe(4); // blockAlign = 2ch * 2byte
    expect(view.getUint32(28, true)).toBe(48000 * 4);
  });

  it('全体サイズが 44(ヘッダー) + サンプル数*2byte になる', () => {
    const samples = new Float32Array(1000);
    const buffer = encodeWavPcm16(samples);
    expect(buffer.byteLength).toBe(44 + 1000 * 2);
  });

  it('dataチャンクサイズフィールドとRIFFサイズフィールドが正しい', () => {
    const samples = new Float32Array(100);
    const buffer = encodeWavPcm16(samples);
    const view = new DataView(buffer);
    expect(view.getUint32(40, true)).toBe(200); // dataSize = 100 * 2byte
    expect(view.getUint32(4, true)).toBe(36 + 200); // RIFFサイズ = 全体 - 8
  });

  it('無音(0)は全サンプルが16bit 0になる', () => {
    const buffer = encodeWavPcm16(new Float32Array([0, 0, 0]));
    const view = new DataView(buffer);
    for (let i = 0; i < 3; i++) {
      expect(view.getInt16(44 + i * 2, true)).toBe(0);
    }
  });

  it('フルスケール(+1/-1)が16bitの最大・最小値に変換される', () => {
    const buffer = encodeWavPcm16(new Float32Array([1, -1]));
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(32767); // +1 -> 0x7fff
    expect(view.getInt16(46, true)).toBe(-32768); // -1 -> -0x8000
  });

  it('範囲外の値は折り返さずクリップされる(オーバーフロー防止)', () => {
    const buffer = encodeWavPcm16(new Float32Array([1.5, -2, 10, -100]));
    const view = new DataView(buffer);
    // クリップされていれば常に境界値のまま。折り返し(wraparound)していれば符号が反転したり
    // 予期しない値になるため、境界値ちょうどであることを確認する。
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(50, true)).toBe(-32768);
  });

  it('NaN/Infinityは0として扱う(異常入力での破損防止)', () => {
    const buffer = encodeWavPcm16(new Float32Array([NaN, Infinity, -Infinity]));
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it('中間値が概ね比例した16bit値に変換される', () => {
    const buffer = encodeWavPcm16(new Float32Array([0.5, -0.5]));
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(16384); // 0.5 * 32767 ≈ 16384(四捨五入)
    expect(view.getInt16(46, true)).toBe(-16384); // -0.5 * 32768
  });

  it('空のサンプル配列でもヘッダーのみの44byteを返す', () => {
    const buffer = encodeWavPcm16(new Float32Array([]));
    expect(buffer.byteLength).toBe(44);
    const view = new DataView(buffer);
    expect(view.getUint32(40, true)).toBe(0);
  });
});

describe('wavFromPcm16', () => {
  it('PCMチャンクを連結して16k monoのWAVヘッダを付ける', () => {
    const a = new Uint8Array([1, 0, 2, 0]);
    const b = new Uint8Array([3, 0]).buffer;
    const wav = wavFromPcm16([a, b]);
    const view = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 6);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(new Uint8Array(wav, 44))).toEqual([1, 0, 2, 0, 3, 0]);
  });
});

describe('trimPcm16', () => {
  // 16kHz PCM16 = 32バイト/ms
  const oneSecond = new Uint8Array(32000).map((_, i) => i % 256);

  it('前後に余白を付けて切り出す', () => {
    const r = trimPcm16(oneSecond, 400, 600, { padMs: 100 });
    expect(r.byteLength).toBe(400 * 32);
    expect(r[0]).toBe(oneSecond[300 * 32]);
  });

  it('範囲外はクランプする', () => {
    expect(trimPcm16(oneSecond, 0, 2000, { padMs: 300 }).byteLength).toBe(32000);
  });

  it('逆転した範囲は空', () => {
    expect(trimPcm16(oneSecond, 800, 100, { padMs: 0 }).byteLength).toBe(0);
  });
});
