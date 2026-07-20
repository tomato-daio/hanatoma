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
      { aiIntent: 'Greet', hintJa: 'あいさつ', hintEn: 'Hi, ...', modelAnswer: 'Hi, can I get a latte?' },
      { aiIntent: 'Ask size', hintJa: 'サイズ', hintEn: 'A medium...', modelAnswer: 'A medium one, please.' },
    ],
    hiddenObjectives: [],
    estimatedMinutes: 5,
    freeTalkPrompt: 'Chat about coffee.',
    ...overrides,
  };
}

describe('buildPhraseHints', () => {
  it('キーフレーズ英文と全stepsのmodelAnswerを順に集める', () => {
    const hints = buildPhraseHints(makeScenario());
    expect(hints).toEqual([
      'Can I get a latte?',
      'For here, please.',
      'Hi, can I get a latte?',
      'A medium one, please.',
    ]);
  });

  it('trimして空文字を除き、大文字小文字を無視して重複を除去する', () => {
    const hints = buildPhraseHints(
      makeScenario({
        keyPhrases: [
          { en: '  Can I get a latte?  ', ja: 'ラテ' },
          { en: '', ja: '空' },
          { en: '   ', ja: '空白のみ' },
        ],
        steps: [
          { aiIntent: 'x', hintJa: 'x', hintEn: 'x', modelAnswer: 'can i get a latte?' },
          { aiIntent: 'y', hintJa: 'y', hintEn: 'y', modelAnswer: 'Sounds good.' },
        ],
      }),
    );
    expect(hints).toEqual(['Can I get a latte?', 'Sounds good.']);
  });

  it('最大MAX_PHRASE_HINTS件で打ち切る', () => {
    const manySteps = Array.from({ length: MAX_PHRASE_HINTS + 10 }, (_, i) => ({
      aiIntent: 'x',
      hintJa: 'x',
      hintEn: 'x',
      modelAnswer: `Sentence number ${i}.`,
    }));
    const hints = buildPhraseHints(makeScenario({ keyPhrases: [], steps: manySteps }));
    expect(hints).toHaveLength(MAX_PHRASE_HINTS);
    expect(hints[0]).toBe('Sentence number 0.');
  });

  it('キーフレーズもstepsも無ければ空配列を返す', () => {
    expect(buildPhraseHints(makeScenario({ keyPhrases: [], steps: [] }))).toEqual([]);
  });
});
