import { describe, expect, it } from 'vitest';
import type { Scenario } from '../../lib/types';
import { buildPhraseHints, MAX_PHRASE_HINTS } from './phraseHints';

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'b-restaurant-001',
    source: 'bundled',
    title: 'Ordering coffee',
    titleJa: 'カフェで注文',
    category: 'restaurant',
    level: 2,
    setting: 'A small coffee shop.',
    aiRole: 'barista',
    userRole: 'customer',
    goal: 'Order a drink.',
    goalJa: '飲み物を注文する',
    keyPhrases: [
      { en: 'Can I get a latte?', ja: 'ラテをください' },
      { en: 'For here, please.', ja: '店内でお願いします' },
    ],
    steps: [
      { aiIntent: 'Greet', hintJa: 'あいさつ', hintEn: 'Hi, ...', modelAnswer: 'Hi, can I get a mocha?' },
      { aiIntent: 'Ask size', hintJa: 'サイズ', hintEn: 'A medium...', modelAnswer: 'A medium one, please.' },
    ],
    hiddenObjectives: [],
    estimatedMinutes: 5,
    freeTalkPrompt: 'Chat about coffee.',
    ...overrides,
  };
}

describe('buildPhraseHints', () => {
  it('guided: キーフレーズ + 現在stepのmodelAnswerのみ（他のstepは含まない）', () => {
    const hints = buildPhraseHints(makeScenario(), { phase: 'guided', stepIndex: 0 });
    expect(hints).toEqual(['Can I get a latte?', 'For here, please.', 'Hi, can I get a mocha?']);
    expect(hints).not.toContain('A medium one, please.');
  });

  it('guidedでstepIndexが進むと、そのstepのmodelAnswerに切り替わる', () => {
    const hints = buildPhraseHints(makeScenario(), { phase: 'guided', stepIndex: 1 });
    expect(hints).toEqual(['Can I get a latte?', 'For here, please.', 'A medium one, please.']);
  });

  it('free: キーフレーズのみ（modelAnswerを含まない）', () => {
    const hints = buildPhraseHints(makeScenario(), { phase: 'free', stepIndex: 1 });
    expect(hints).toEqual(['Can I get a latte?', 'For here, please.']);
  });

  it('keyphraseフェーズもキーフレーズのみ', () => {
    const hints = buildPhraseHints(makeScenario(), { phase: 'keyphrase', stepIndex: 0 });
    expect(hints).toEqual(['Can I get a latte?', 'For here, please.']);
  });

  it('guidedでstepIndexが範囲外ならキーフレーズのみ（クラッシュしない）', () => {
    expect(buildPhraseHints(makeScenario(), { phase: 'guided', stepIndex: 99 })).toEqual([
      'Can I get a latte?',
      'For here, please.',
    ]);
    expect(buildPhraseHints(makeScenario(), { phase: 'guided', stepIndex: -1 })).toEqual([
      'Can I get a latte?',
      'For here, please.',
    ]);
  });

  it('現在stepのmodelAnswerがキーフレーズと重複（大小・空白無視）なら除去する', () => {
    const scenario = makeScenario({
      steps: [
        { aiIntent: 'x', hintJa: 'x', hintEn: 'x', modelAnswer: '  can i get a latte?  ' },
      ],
    });
    const hints = buildPhraseHints(scenario, { phase: 'guided', stepIndex: 0 });
    expect(hints).toEqual(['Can I get a latte?', 'For here, please.']);
  });

  it('trimして空文字を除く', () => {
    const scenario = makeScenario({
      keyPhrases: [
        { en: '  Can I get a latte?  ', ja: 'ラテ' },
        { en: '', ja: '空' },
        { en: '   ', ja: '空白のみ' },
      ],
    });
    const hints = buildPhraseHints(scenario, { phase: 'free', stepIndex: 0 });
    expect(hints).toEqual(['Can I get a latte?']);
  });

  it('最大MAX_PHRASE_HINTS件で打ち切る', () => {
    const manyKeyPhrases = Array.from({ length: MAX_PHRASE_HINTS + 10 }, (_, i) => ({
      en: `Key phrase number ${i}.`,
      ja: `フレーズ${i}`,
    }));
    const hints = buildPhraseHints(makeScenario({ keyPhrases: manyKeyPhrases }), {
      phase: 'free',
      stepIndex: 0,
    });
    expect(hints).toHaveLength(MAX_PHRASE_HINTS);
    expect(hints[0]).toBe('Key phrase number 0.');
  });

  it('キーフレーズが無ければ空配列（freeの場合）', () => {
    expect(buildPhraseHints(makeScenario({ keyPhrases: [] }), { phase: 'free', stepIndex: 0 })).toEqual([]);
  });
});
