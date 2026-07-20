import { describe, expect, it } from 'vitest';
import type { UsageDay } from '../../lib/types';
import { currentMonthPrefix, filterUsageDaysForMonth, summarizeMonthlyUsage } from './usageSummary';

function makeDay(overrides: Partial<UsageDay> & { date: string }): UsageDay {
  return {
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

describe('currentMonthPrefix', () => {
  it('YYYY-MM-DDからYYYY-MMを取り出す', () => {
    expect(currentMonthPrefix('2026-07-20')).toBe('2026-07');
  });
});

describe('filterUsageDaysForMonth', () => {
  it('指定した月prefixで始まる日付だけ残す', () => {
    const days = [makeDay({ date: '2026-06-30' }), makeDay({ date: '2026-07-01' }), makeDay({ date: '2026-07-20' })];
    const result = filterUsageDaysForMonth(days, '2026-07');
    expect(result.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-20']);
  });

  it('該当日が無ければ空配列', () => {
    const days = [makeDay({ date: '2026-06-30' })];
    expect(filterUsageDaysForMonth(days, '2026-07')).toEqual([]);
  });
});

describe('summarizeMonthlyUsage', () => {
  it('空配列なら全て0の集計を返す（例外・NaNを出さない）', () => {
    const summary = summarizeMonthlyUsage([]);
    expect(summary).toEqual({
      totalCalls: 0,
      totalHaikuCalls: 0,
      totalSonnetCalls: 0,
      totalJpy: 0,
      dailyRows: [],
    });
  });

  it('呼び出し件数を日別に合算し、dailyRowsを日付の新しい順に並べる', () => {
    const days = [
      makeDay({ date: '2026-07-01', haikuCalls: 2, sonnetCalls: 1, inputTokens: 1000, outputTokens: 500 }),
      makeDay({ date: '2026-07-02', haikuCalls: 1, sonnetCalls: 0, inputTokens: 200, outputTokens: 100 }),
    ];
    const summary = summarizeMonthlyUsage(days);
    expect(summary.totalHaikuCalls).toBe(3);
    expect(summary.totalSonnetCalls).toBe(1);
    expect(summary.totalCalls).toBe(4);
    expect(summary.dailyRows.map((r) => r.date)).toEqual(['2026-07-02', '2026-07-01']);
    expect(summary.totalJpy).toBeGreaterThan(0);
  });

  it('dailyRowsのjpy合計はestimateMonthlyCostJpyの月合計と一致する（按分ロジックの二重実装を防ぐ回帰テスト）', () => {
    const days = [
      makeDay({ date: '2026-07-01', haikuCalls: 2, sonnetCalls: 1, inputTokens: 1000, outputTokens: 500 }),
      makeDay({ date: '2026-07-02', haikuCalls: 1, sonnetCalls: 3, inputTokens: 2000, outputTokens: 900 }),
    ];
    const summary = summarizeMonthlyUsage(days);
    const rowSum = summary.dailyRows.reduce((s, r) => s + r.jpy, 0);
    expect(rowSum).toBeCloseTo(summary.totalJpy, 6);
  });

  it('usdJpyを指定するとそのレートで換算する', () => {
    const days = [makeDay({ date: '2026-07-01', haikuCalls: 1, inputTokens: 1_000_000, outputTokens: 0 })];
    const summary = summarizeMonthlyUsage(days, 100);
    // 1M入力*1.0 = 1 USD * 100 = 100円
    expect(summary.totalJpy).toBeCloseTo(100, 5);
  });
});
