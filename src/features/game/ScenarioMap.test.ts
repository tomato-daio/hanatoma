import { describe, expect, it } from 'vitest';
import type { Conversation, Scenario, ScenarioCategory } from '../../lib/types';
import { bestStarsByScenario, buildIslands } from './ScenarioMap';

function makeScenario(id: string, category: ScenarioCategory, level: 1 | 2 | 3 | 4 | 5): Scenario {
  return {
    id,
    source: 'bundled',
    title: id,
    titleJa: id,
    category,
    level,
    setting: 'x',
    aiRole: 'x',
    userRole: 'x',
    goal: 'x',
    goalJa: 'x',
    keyPhrases: [],
    steps: [],
    hiddenObjectives: [],
    estimatedMinutes: 5,
    freeTalkPrompt: 'x',
  };
}

function makeConversation(scenarioId: string, stars: 0 | 1 | 2 | 3): Conversation {
  return {
    id: `c-${scenarioId}-${stars}-${Math.floor(stars)}`,
    scenarioId,
    mode: 'lesson',
    date: '2026-07-21',
    status: 'completed',
    startedAt: 1,
    turns: [],
    stars,
  } as unknown as Conversation;
}

/** travel/restaurant/work の3島ぶんのシナリオ（各1本で十分）。 */
const SCENARIOS = [
  makeScenario('t1', 'travel', 1),
  makeScenario('r1', 'restaurant', 1),
  makeScenario('w1', 'work', 1),
];

describe('bestStarsByScenario', () => {
  it('★0の完了もエントリを作る（completedCount・ロック非表示判定に使うため）', () => {
    const map = bestStarsByScenario([makeConversation('t1', 0)]);
    expect(map.get('t1')).toBe(0);
  });

  it('複数回プレイはベスト★を採用する', () => {
    const map = bestStarsByScenario([makeConversation('t1', 1), makeConversation('t1', 3)]);
    expect(map.get('t1')).toBe(3);
  });
});

describe('buildIslands のアンロック表示', () => {
  it('最初の島は常に解錠', () => {
    const islands = buildIslands(SCENARIOS, new Map());
    expect(islands[0].category).toBe('travel');
    expect(islands[0].unlocked).toBe(true);
  });

  it('前の島で★3以上なら次の島が解錠', () => {
    const islands = buildIslands(SCENARIOS, new Map([['t1', 3]]));
    expect(islands.find((i) => i.category === 'restaurant')?.unlocked).toBe(true);
  });

  it('前の島が★3未満でも、自分の島に★があれば🔒を出さない（矛盾表示の防止）', () => {
    // travel★2（<3）だが work に★1の実績 → work は解錠表示
    const islands = buildIslands(SCENARIOS, new Map([['t1', 2], ['w1', 1]]));
    expect(islands.find((i) => i.category === 'work')?.unlocked).toBe(true);
    // restaurant は実績なし＆前島★2 → ロック表示のまま
    expect(islands.find((i) => i.category === 'restaurant')?.unlocked).toBe(false);
  });

  it('★0でも完了実績があれば解錠表示になる', () => {
    const starMap = bestStarsByScenario([makeConversation('w1', 0)]);
    const islands = buildIslands(SCENARIOS, starMap);
    const work = islands.find((i) => i.category === 'work');
    expect(work?.completedCount).toBe(1);
    expect(work?.unlocked).toBe(true);
  });

  it('実績のない後続の島はロック表示', () => {
    const islands = buildIslands(SCENARIOS, new Map());
    expect(islands.find((i) => i.category === 'restaurant')?.unlocked).toBe(false);
    expect(islands.find((i) => i.category === 'work')?.unlocked).toBe(false);
  });
});
