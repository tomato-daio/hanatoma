import { describe, expect, it } from 'vitest';
import { canCallSonnet, canRunPa, canStartSession, checkCaps } from './caps';
import type { DailyCaps, UsageDay } from '../types';

const CAPS: DailyCaps = { sessions: 3, sonnetCalls: 8, paMinutes: 30 };

function makeUsage(overrides: Partial<UsageDay> = {}): UsageDay {
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

describe('canStartSession', () => {
  it('キャップ未満なら開始できる', () => {
    expect(canStartSession(makeUsage({ sessionsStarted: 2 }), CAPS)).toBe(true);
  });
  it('キャップに達したら開始できない', () => {
    expect(canStartSession(makeUsage({ sessionsStarted: 3 }), CAPS)).toBe(false);
  });
});

describe('canCallSonnet', () => {
  it('キャップ未満なら呼べる', () => {
    expect(canCallSonnet(makeUsage({ sonnetCalls: 7 }), CAPS)).toBe(true);
  });
  it('キャップに達したら呼べない', () => {
    expect(canCallSonnet(makeUsage({ sonnetCalls: 8 }), CAPS)).toBe(false);
  });
});

describe('canRunPa', () => {
  it('paSecondsをpaMinutesに換算し、キャップ未満なら実行できる', () => {
    expect(canRunPa(makeUsage({ paSeconds: 29 * 60 }), CAPS)).toBe(true);
  });
  it('ちょうど上限分に達したら実行できない', () => {
    expect(canRunPa(makeUsage({ paSeconds: 30 * 60 }), CAPS)).toBe(false);
  });
  it('秒数の端数も正しく分換算する', () => {
    // 29分59秒はまだ30分未満
    expect(canRunPa(makeUsage({ paSeconds: 29 * 60 + 59 }), CAPS)).toBe(true);
  });
});

describe('checkCaps', () => {
  it('全キャップ未満ならok:true', () => {
    const usage = makeUsage({ sessionsStarted: 1, sonnetCalls: 1, paSeconds: 60 });
    expect(checkCaps(usage, CAPS)).toEqual({ ok: true });
  });

  it('sessionsキャップ超過を最優先で報告する', () => {
    const usage = makeUsage({ sessionsStarted: 3, sonnetCalls: 8, paSeconds: 30 * 60 });
    const result = checkCaps(usage, CAPS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('sessions');
    expect(result.messageJa).toBe('今日の練習上限に達しました（設定で変更できます）');
  });

  it('sessionsは余裕がありsonnetCallsが超過していればsonnetCallsを報告する', () => {
    const usage = makeUsage({ sessionsStarted: 0, sonnetCalls: 8, paSeconds: 0 });
    const result = checkCaps(usage, CAPS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('sonnetCalls');
  });

  it('sessions・sonnetCallsが余裕でpaMinutesのみ超過していればpaMinutesを報告する', () => {
    const usage = makeUsage({ sessionsStarted: 0, sonnetCalls: 0, paSeconds: 30 * 60 });
    const result = checkCaps(usage, CAPS);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('paMinutes');
  });

  it('設定で変更したキャップ値を使って判定する', () => {
    const looseCaps: DailyCaps = { sessions: 10, sonnetCalls: 100, paMinutes: 120 };
    const usage = makeUsage({ sessionsStarted: 5, sonnetCalls: 50, paSeconds: 60 * 60 });
    expect(checkCaps(usage, looseCaps)).toEqual({ ok: true });
  });
});
