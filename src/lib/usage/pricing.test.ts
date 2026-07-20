import { describe, expect, it } from 'vitest';
import { DEFAULT_USD_JPY, estimateMonthlyCostJpy } from './pricing';
import type { UsageDay } from '../types';

function makeDay(overrides: Partial<UsageDay> = {}): UsageDay {
  return {
    date: '2026-07-20',
    haikuCalls: 0,
    sonnetCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    paSeconds: 0,
    ttsChars: 0,
    sessionsStarted: 0,
    ...overrides,
  };
}

describe('estimateMonthlyCostJpy', () => {
  it('haiku呼び出しのみの日は全額haikuJpyに計上される', () => {
    const day = makeDay({ haikuCalls: 10, sonnetCalls: 0, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const result = estimateMonthlyCostJpy([day]);
    // (1M/1M)*1.0 + (1M/1M)*5.0 = 6 USD * 155 = 930円
    expect(result.breakdown.haikuJpy).toBeCloseTo(930, 5);
    expect(result.breakdown.sonnetJpy).toBeCloseTo(0, 5);
    expect(result.totalJpy).toBeCloseTo(930, 5);
  });

  it('sonnet呼び出しのみの日は全額sonnetJpyに計上される', () => {
    const day = makeDay({ haikuCalls: 0, sonnetCalls: 3, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const result = estimateMonthlyCostJpy([day]);
    // (1M/1M)*3.0 + (1M/1M)*15.0 = 18 USD * 155 = 2790円
    expect(result.breakdown.sonnetJpy).toBeCloseTo(2790, 5);
    expect(result.breakdown.haikuJpy).toBeCloseTo(0, 5);
    expect(result.totalJpy).toBeCloseTo(2790, 5);
  });

  it('呼び出し件数が同数なら半分ずつに按分する', () => {
    const day = makeDay({ haikuCalls: 5, sonnetCalls: 5, inputTokens: 2_000_000, outputTokens: 2_000_000 });
    const result = estimateMonthlyCostJpy([day]);
    // haiku分: 1M入力*1.0 + 1M出力*5.0 = 6 USD → 930円
    expect(result.breakdown.haikuJpy).toBeCloseTo(930, 5);
    // sonnet分: 1M入力*3.0 + 1M出力*15.0 = 18 USD → 2790円
    expect(result.breakdown.sonnetJpy).toBeCloseTo(2790, 5);
    expect(result.totalJpy).toBeCloseTo(930 + 2790, 5);
  });

  it('cacheReadTokensは入力単価の1/10で計上される', () => {
    const day = makeDay({ haikuCalls: 1, sonnetCalls: 0, cacheReadTokens: 1_000_000 });
    const result = estimateMonthlyCostJpy([day]);
    // 1M * 1.0 * 0.1 = 0.1 USD * 155 = 15.5円
    expect(result.breakdown.haikuJpy).toBeCloseTo(15.5, 5);
  });

  it('呼び出し件数が0の日はトークンが残っていても課金しない（例外・NaNを出さない）', () => {
    const day = makeDay({ haikuCalls: 0, sonnetCalls: 0, inputTokens: 1000, outputTokens: 1000 });
    const result = estimateMonthlyCostJpy([day]);
    expect(result.totalJpy).toBe(0);
    expect(Number.isFinite(result.totalJpy)).toBe(true);
  });

  it('複数日を合算する', () => {
    const day1 = makeDay({ date: '2026-07-19', haikuCalls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const day2 = makeDay({ date: '2026-07-20', sonnetCalls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const result = estimateMonthlyCostJpy([day1, day2]);
    expect(result.breakdown.haikuJpy).toBeCloseTo(930, 5);
    expect(result.breakdown.sonnetJpy).toBeCloseTo(2790, 5);
    expect(result.totalJpy).toBeCloseTo(930 + 2790, 5);
  });

  it('usdJpyを省略するとDEFAULT_USD_JPY(155)を使う', () => {
    const day = makeDay({ haikuCalls: 1, inputTokens: 1_000_000, outputTokens: 0 });
    const withDefault = estimateMonthlyCostJpy([day]);
    const withExplicit = estimateMonthlyCostJpy([day], DEFAULT_USD_JPY);
    expect(withDefault.totalJpy).toBeCloseTo(withExplicit.totalJpy, 10);
  });

  it('usdJpyを指定するとそのレートで換算する', () => {
    const day = makeDay({ haikuCalls: 1, inputTokens: 1_000_000, outputTokens: 0 });
    const result = estimateMonthlyCostJpy([day], 100);
    // 1M入力*1.0 = 1 USD * 100 = 100円
    expect(result.totalJpy).toBeCloseTo(100, 5);
  });

  it('空配列なら0円', () => {
    const result = estimateMonthlyCostJpy([]);
    expect(result).toEqual({ totalJpy: 0, breakdown: { haikuJpy: 0, sonnetJpy: 0 } });
  });
});
