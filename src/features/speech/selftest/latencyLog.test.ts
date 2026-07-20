import { describe, expect, it } from 'vitest';
import { formatLatencyStages } from './latencyLog';

describe('formatLatencyStages', () => {
  it('空配列は空文字列', () => {
    expect(formatLatencyStages([])).toBe('');
  });

  it('1区間はラベルと合計msを表示する', () => {
    expect(formatLatencyStages([{ label: 'WAV変換', ms: 120 }])).toBe('WAV変換 120ms（合計 120ms）');
  });

  it('複数区間は矢印でつなぎ、合計msを末尾に付ける', () => {
    const result = formatLatencyStages([
      { label: 'WAV変換', ms: 120 },
      { label: 'PA応答', ms: 980 },
    ]);
    expect(result).toBe('WAV変換 120ms → PA応答 980ms（合計 1100ms）');
  });
});
