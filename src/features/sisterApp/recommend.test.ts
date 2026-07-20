import { describe, expect, it } from 'vitest';
import type { AppLevel, Scenario } from '../../lib/types';
import { recommendScenarios, scoreScenario } from './recommend';

function makeScenario(overrides: Partial<Scenario> & { id: string }): Scenario {
  return {
    source: 'bundled',
    title: 'Test scenario',
    titleJa: 'テストシナリオ',
    category: 'travel',
    level: 2,
    setting: 'A test setting.',
    aiRole: 'clerk',
    userRole: 'customer',
    goal: 'Do the thing.',
    goalJa: '目的を達成する',
    keyPhrases: [{ en: 'Hello.', ja: 'こんにちは' }],
    steps: [
      { aiIntent: 'Greet.', hintJa: 'あいさつ', hintEn: 'Hi...', modelAnswer: 'Hi, how are you?' },
    ],
    hiddenObjectives: [],
    estimatedMinutes: 5,
    freeTalkPrompt: 'Free talk.',
    ...overrides,
  };
}

describe('scoreScenario', () => {
  it('弱点音素との一致1件につき+10（targetPhonemes内の重複は1回として数える）', () => {
    const s = makeScenario({ id: 'a', level: 3, targetPhonemes: ['R', 'TH', 'R', 'L'] });
    // R, TH の2種一致 ×10 = 20、同レベル+5
    expect(scoreScenario(s, 3, ['R', 'TH', 'V'])).toBe(25);
  });

  it('レベル適合: 同レベル+5 / ±1レベル+2 / それ以外+0', () => {
    const base = { id: 'x', targetPhonemes: [] as string[] };
    expect(scoreScenario(makeScenario({ ...base, level: 3 }), 3, [])).toBe(5);
    expect(scoreScenario(makeScenario({ ...base, level: 2 }), 3, [])).toBe(2);
    expect(scoreScenario(makeScenario({ ...base, level: 4 }), 3, [])).toBe(2);
    expect(scoreScenario(makeScenario({ ...base, level: 1 }), 3, [])).toBe(0);
    expect(scoreScenario(makeScenario({ ...base, level: 5 }), 3, [])).toBe(0);
  });

  it('targetPhonemes未定義のシナリオはレベル適合のみ', () => {
    const s = makeScenario({ id: 'a', level: 2 });
    expect(scoreScenario(s, 2, ['R'])).toBe(5);
  });

  it('音素は大文字小文字を無視して比較する', () => {
    const s = makeScenario({ id: 'a', level: 1, targetPhonemes: ['R'] });
    expect(scoreScenario(s, 5, ['r'])).toBe(10);
  });
});

describe('recommendScenarios', () => {
  const level: AppLevel = 3;

  it('完了済みシナリオを除外する', () => {
    const scenarios = [makeScenario({ id: 'done', level: 3 }), makeScenario({ id: 'todo', level: 3 })];
    const result = recommendScenarios(scenarios, new Set(['done']), level, []);
    expect(result.map((s) => s.id)).toEqual(['todo']);
  });

  it('スコアの高い順に並べる（音素一致 > レベル適合）', () => {
    const scenarios = [
      makeScenario({ id: 'level-only', level: 3, targetPhonemes: [] }), // 5点
      makeScenario({ id: 'phoneme-far-level', level: 5, targetPhonemes: ['R'] }), // 10点
      makeScenario({ id: 'phoneme-same-level', level: 3, targetPhonemes: ['R'] }), // 15点
      makeScenario({ id: 'two-phonemes', level: 1, targetPhonemes: ['R', 'TH'] }), // 20点
    ];
    const result = recommendScenarios(scenarios, new Set(), level, ['R', 'TH']);
    expect(result.map((s) => s.id)).toEqual([
      'two-phonemes',
      'phoneme-same-level',
      'phoneme-far-level',
      'level-only',
    ]);
  });

  it('同点は入力順を維持する', () => {
    const scenarios = [
      makeScenario({ id: 'first', level: 3 }),
      makeScenario({ id: 'second', level: 3 }),
      makeScenario({ id: 'third', level: 3 }),
    ];
    const result = recommendScenarios(scenarios, new Set(), level, []);
    expect(result.map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });

  it('弱点音素が空でもレベル適合だけで並べられる', () => {
    const scenarios = [
      makeScenario({ id: 'far', level: 1 }), // 0点
      makeScenario({ id: 'adjacent', level: 4 }), // 2点
      makeScenario({ id: 'same', level: 3 }), // 5点
    ];
    const result = recommendScenarios(scenarios, new Set(), level, []);
    expect(result.map((s) => s.id)).toEqual(['same', 'adjacent', 'far']);
  });

  it('全部完了済みなら空配列', () => {
    const scenarios = [makeScenario({ id: 'a' }), makeScenario({ id: 'b' })];
    expect(recommendScenarios(scenarios, new Set(['a', 'b']), level, [])).toEqual([]);
  });
});
