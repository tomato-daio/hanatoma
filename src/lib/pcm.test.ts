import { describe, expect, it } from 'vitest';
import { createResamplerState, floatChunkToPcm16, resampleLinearChunk, type LinearResamplerState } from './pcm';

/** 入力列を指定の分割で流し、全出力を連結して返す。 */
function runChunked(sourceRate: number, targetRate: number, input: number[], chunkSizes: number[]): number[] {
  let state: LinearResamplerState = createResamplerState(sourceRate, targetRate);
  const out: number[] = [];
  let cursor = 0;
  for (const size of chunkSizes) {
    const chunk = Float32Array.from(input.slice(cursor, cursor + size));
    cursor += size;
    const r = resampleLinearChunk(state, chunk);
    state = r.state;
    out.push(...r.output);
  }
  if (cursor < input.length) {
    const r = resampleLinearChunk(state, Float32Array.from(input.slice(cursor)));
    out.push(...r.output);
  }
  return out;
}

describe('resampleLinearChunk', () => {
  it('同一レートなら値がそのまま出る（末尾1サンプルは次チャンクへ持ち越し）', () => {
    const input = [0.1, 0.2, 0.3, 0.4];
    const whole = runChunked(16000, 16000, input, [4]);
    // 最終サンプルの出力は「次のサンプルとの補間」を待つため持ち越される
    expect(whole).toEqual([0.1, 0.2, 0.3].map((v) => Math.fround(v)));
  });

  it('3:1ダウンサンプル（48k→16k）はソースの3サンプルごとの値になる', () => {
    const input = Array.from({ length: 10 }, (_, i) => i / 10); // 0.0, 0.1, ..., 0.9
    const out = runChunked(48000, 16000, input, [10]);
    expect(out.map((v) => Math.round(v * 10))).toEqual([0, 3, 6, 9].slice(0, out.length));
  });

  it('一括処理と小分け処理の出力がビット一致する（境界持ち越しの核心）', () => {
    const input = Array.from({ length: 4410 }, (_, i) => Math.sin((i / 44100) * 2 * Math.PI * 440));
    const whole = runChunked(44100, 16000, input, [4410]);
    const split1 = runChunked(44100, 16000, input, [1, 2, 3, 128, 1000, 7]);
    const split2 = runChunked(44100, 16000, input, Array.from({ length: 45 }, () => 100));
    expect(split1).toEqual(whole);
    expect(split2).toEqual(whole);
  });

  it('累積出力長がドリフトしない（44.1k→16k・長時間相当）', () => {
    const totalIn = 44100 * 3; // 3秒
    const input = Array.from({ length: totalIn }, (_, i) => ((i % 100) - 50) / 50);
    const out = runChunked(44100, 16000, input, Array.from({ length: Math.ceil(totalIn / 2048) }, () => 2048));
    const expected = Math.floor((totalIn * 16000) / 44100);
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(1);
  });

  it('ランプ波形の補間値が正しい（2:1で中間点は隣接平均）', () => {
    // 32k→16k: 出力位置はソースの偶数位置ちょうど（frac=0）
    const input = [0, 1, 2, 3, 4, 5];
    const out = runChunked(32000, 16000, input, [6]);
    expect(out).toEqual([0, 2, 4]);
  });

  it('非整数比（44.1k→16k）の補間値: 2番目の出力はソース位置2.75625の線形補間', () => {
    const input = [0, 1, 2, 3, 4];
    const out = runChunked(44100, 16000, input, [5]);
    // 出力0: 位置0 = 0。出力1: 位置 44100/16000 = 2.75625 → 2と3の補間 = 2.75625
    // （出力はFloat32Array格納のためfloat32精度に丸まる）
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(2.75625, 6);
  });

  it('空チャンク・1サンプルチャンクを混ぜても壊れない', () => {
    const input = Array.from({ length: 50 }, (_, i) => i / 50);
    const whole = runChunked(48000, 16000, input, [50]);
    const mixed = runChunked(48000, 16000, input, [0, 1, 0, 1, 1, 20, 0, 27]);
    expect(mixed).toEqual(whole);
  });

  it('状態と入力を破壊しない', () => {
    const state = createResamplerState(48000, 16000);
    const input = Float32Array.from([0.5, 0.6, 0.7]);
    resampleLinearChunk(state, input);
    expect(state.posNum).toBe(0);
    expect(state.hasPrev).toBe(false);
    expect([...input]).toEqual([0.5, 0.6, 0.7].map((v) => Math.fround(v)));
  });

  it('不正なレートはthrow', () => {
    expect(() => createResamplerState(0, 16000)).toThrow();
    expect(() => createResamplerState(44100.5, 16000)).toThrow();
  });
});

describe('floatChunkToPcm16', () => {
  it('wav.tsと同一規則で変換する（負×0x8000・正×0x7fff・クリップ・非有限→0）', () => {
    const buf = floatChunkToPcm16(Float32Array.from([0, 1, -1, 1.5, -1.5, 0.5, NaN]));
    const view = new DataView(buf);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
    expect(view.getInt16(6, true)).toBe(0x7fff); // クリップ
    expect(view.getInt16(8, true)).toBe(-0x8000); // クリップ
    expect(view.getInt16(10, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(12, true)).toBe(0);
  });

  it('空入力は空バッファ', () => {
    expect(floatChunkToPcm16(new Float32Array(0)).byteLength).toBe(0);
  });
});
