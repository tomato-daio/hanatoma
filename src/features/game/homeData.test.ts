import { describe, expect, it } from 'vitest';
import {
  buildStreakInfo,
  fallbackRecommend,
  getIsoWeekId,
  isBossWeekendWindow,
  selectWeeklyBoss,
} from './homeData';
import type { Scenario } from '../../lib/types';

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'b-travel-001',
    source: 'bundled',
    title: 'Hotel Check-in',
    titleJa: 'ホテルのチェックイン',
    category: 'travel',
    level: 1,
    setting: 'A hotel front desk.',
    aiRole: 'receptionist',
    userRole: 'guest',
    goal: 'check in',
    goalJa: 'チェックインする',
    keyPhrases: [],
    steps: [],
    hiddenObjectives: [],
    estimatedMinutes: 8,
    freeTalkPrompt: 'talk freely',
    ...overrides,
  };
}

describe('getIsoWeekId', () => {
  it('ISO週開始(月曜)の日付から正しい週番号を返す', () => {
    expect(getIsoWeekId(new Date(2024, 0, 1))).toBe('2024-W01'); // 2024-01-01は月曜
    expect(getIsoWeekId(new Date(2026, 0, 1))).toBe('2026-W01'); // 2026-01-01は木曜
  });

  it('年またぎ(12月末が翌年第1週に属するISO週の例外)を正しく扱う', () => {
    expect(getIsoWeekId(new Date(2020, 11, 31))).toBe('2020-W53'); // 木曜
    expect(getIsoWeekId(new Date(2021, 0, 1))).toBe('2020-W53'); // 金曜だが前年第53週扱い
  });

  it('同じ週内の日付は同じ週idを返す(土日は月曜始まりの週に含まれる)', () => {
    const mon = getIsoWeekId(new Date(2026, 6, 20)); // 2026-07-20 月曜
    const sat = getIsoWeekId(new Date(2026, 6, 25)); // 土曜
    const sun = getIsoWeekId(new Date(2026, 6, 26)); // 日曜
    expect(mon).toBe('2026-W30');
    expect(sat).toBe(mon);
    expect(sun).toBe(mon);
  });
});

describe('isBossWeekendWindow', () => {
  it('土曜・日曜はtrue', () => {
    expect(isBossWeekendWindow('2026-07-25')).toBe(true); // 土曜
    expect(isBossWeekendWindow('2026-07-26')).toBe(true); // 日曜
  });

  it('平日はfalse', () => {
    expect(isBossWeekendWindow('2026-07-20')).toBe(false); // 月曜
    expect(isBossWeekendWindow('2026-07-24')).toBe(false); // 金曜
  });
});

describe('selectWeeklyBoss', () => {
  const scenarios: Scenario[] = [
    makeScenario({ id: 'b-travel-002', level: 3, category: 'travel' }),
    makeScenario({ id: 'b-restaurant-002', level: 3, category: 'restaurant' }),
    makeScenario({ id: 'b-work-002', level: 3, category: 'work' }),
    makeScenario({ id: 'b-travel-001', level: 2, category: 'travel' }), // レベル違いで対象外
    makeScenario({ id: 'gen-abc', level: 3, source: 'generated', category: 'travel' }), // bundledでないので対象外
  ];

  it('現レベル+1のbundledシナリオの中から決定的に1件選ぶ', () => {
    const a = selectWeeklyBoss('2026-W30', 2, scenarios, []);
    const b = selectWeeklyBoss('2026-W30', 2, scenarios, []);
    expect(a).not.toBeNull();
    expect(a?.level).toBe(3);
    expect(a?.source).toBe('bundled');
    expect(a?.id).toBe(b?.id); // 同じ入力なら常に同じ結果
  });

  it('週idが変われば選出結果が変わりうる(少なくとも全候補を巡回する)', () => {
    const ids = new Set<string>();
    for (let w = 0; w < 20; w++) {
      const boss = selectWeeklyBoss(`2026-W${w}`, 2, scenarios, []);
      if (boss) ids.add(boss.id);
    }
    expect(ids.size).toBeGreaterThan(1);
  });

  it('未プレイのものだけが対象(完了済みは除外される)', () => {
    const completedIds = ['b-travel-002', 'b-work-002'];
    for (let w = 0; w < 20; w++) {
      const boss = selectWeeklyBoss(`2026-W${w}`, 2, scenarios, completedIds);
      expect(boss?.id).toBe('b-restaurant-002');
    }
  });

  it('レベル5の場合は上限に頭打ちしてレベル5から選ぶ', () => {
    const lv5Scenarios: Scenario[] = [makeScenario({ id: 'b-travel-005', level: 5 })];
    const boss = selectWeeklyBoss('2026-W30', 5, lv5Scenarios, []);
    expect(boss?.id).toBe('b-travel-005');
  });

  it('候補が無ければnull', () => {
    const boss = selectWeeklyBoss('2026-W30', 2, scenarios, [
      'b-travel-002',
      'b-restaurant-002',
      'b-work-002',
    ]);
    expect(boss).toBeNull();
  });
});

describe('buildStreakInfo', () => {
  it('hanatomaとshadotomaの練習日を合算しチケットなしで単純ストリークになる', () => {
    const info = buildStreakInfo(['2026-07-17'], ['2026-07-18'], 0, '2026-07-18');
    expect(info.streak).toBe(2);
    expect(info.ticketsUsed).toBe(0);
    expect(info.usedOn).toEqual([]);
  });

  it('穴をお休みチケットで埋めてストリークを継続する', () => {
    const info = buildStreakInfo(['2026-07-16'], ['2026-07-18'], 1, '2026-07-18');
    expect(info.streak).toBe(3);
    expect(info.ticketsUsed).toBe(1);
    expect(info.usedOn).toEqual(['2026-07-17']);
  });

  it('重複する練習日は二重に数えない', () => {
    const info = buildStreakInfo(['2026-07-18'], ['2026-07-18'], 0, '2026-07-18');
    expect(info.streak).toBe(1);
  });
});

describe('fallbackRecommend', () => {
  const scenarios: Scenario[] = [
    makeScenario({ id: 'b-a', level: 1 }),
    makeScenario({ id: 'b-b', level: 2 }),
    makeScenario({ id: 'b-c', level: 3 }),
    makeScenario({ id: 'b-d', level: 5 }),
  ];

  it('現レベルと同じものを最優先し、次に±1レベル、その他は最後', () => {
    const result = fallbackRecommend(scenarios, new Set(), 2);
    expect(result.map((s) => s.id)).toEqual(['b-b', 'b-a', 'b-c', 'b-d']);
  });

  it('完了済みシナリオは候補から除外する', () => {
    const result = fallbackRecommend(scenarios, new Set(['b-b']), 2);
    expect(result.map((s) => s.id)).not.toContain('b-b');
  });
});
