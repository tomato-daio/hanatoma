import { describe, expect, it } from 'vitest';
import type { ExpressionItem, ReviewStats, Scenario } from '../types';
import {
  applyReviewOutcomes,
  buildReviewCards,
  countReviewQueue,
  NEW_CARDS_PER_DAY,
  nextDueInfo,
  pickReviewCards,
  pruneReviewStats,
  type ReviewCard,
} from './reviewCards';
import { INITIAL_EASE_FACTOR } from './sm2';

const TODAY = '2026-07-20';
const NOW = 1_800_000_000_000;

function makeExpression(overrides: Partial<ExpressionItem> = {}): ExpressionItem {
  return {
    id: 'e1',
    en: 'I would like a table for two.',
    ja: '2名席をお願いします。',
    addedAt: 1,
    useCount: 0,
    ...overrides,
  };
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'b-restaurant-002',
    source: 'bundled',
    title: 'At a restaurant',
    titleJa: 'レストランで',
    category: 'restaurant',
    level: 2,
    setting: 'A casual restaurant.',
    aiRole: 'server',
    userRole: 'customer',
    goal: 'Order dinner.',
    goalJa: '夕食を注文する',
    keyPhrases: [
      { en: 'Could I see the menu?', ja: 'メニューを見せてもらえますか' },
      { en: 'The check, please.', ja: 'お会計をお願いします' },
    ],
    steps: [],
    hiddenObjectives: [],
    estimatedMinutes: 8,
    freeTalkPrompt: 'Chat.',
    ...overrides,
  };
}

/** stat入りのReviewStatsを手軽に作る。 */
function statOf(dueDate: string, extra: Partial<ReviewStats[string]> = {}): ReviewStats[string] {
  return {
    repetition: 1,
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 1,
    dueDate,
    reviewCount: 1,
    againCount: 0,
    firstReviewedDate: '2026-07-01',
    lastReviewedAt: 1,
    ...extra,
  };
}

describe('buildReviewCards', () => {
  it('表現帳→完了シナリオのキーフレーズの順に集め、keyと内容を持つ', () => {
    const cards = buildReviewCards([makeExpression()], [makeScenario()]);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ key: 'ex:e1', source: 'expression' });
    expect(cards[1]).toMatchObject({
      key: 'kp:b-restaurant-002:could i see the menu?',
      source: 'keyphrase',
    });
  });

  it('en重複（大小文字・前後空白無視）は表現帳優先で1枚になる', () => {
    const cards = buildReviewCards(
      [makeExpression({ en: '  Could I see the menu?  ', ja: 'メニューを見せて' })],
      [makeScenario()],
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].source).toBe('expression');
    expect(cards.filter((c) => c.en.toLowerCase().includes('menu'))).toHaveLength(1);
  });

  it('en/jaが空のものは除外する', () => {
    const cards = buildReviewCards([makeExpression({ en: '  ' })], []);
    expect(cards).toHaveLength(0);
  });
});

describe('pickReviewCards', () => {
  const cards = buildReviewCards([], [makeScenario()]);

  it('未学習カードは新規として日次上限まで出る', () => {
    const picked = pickReviewCards(cards, {}, TODAY);
    expect(picked).toHaveLength(2);
  });

  it('期限前のカードは出さない（分散学習）', () => {
    const stats: ReviewStats = {
      [cards[0].key]: statOf('2026-07-25'),
      [cards[1].key]: statOf('2026-07-25'),
    };
    expect(pickReviewCards(cards, stats, TODAY)).toHaveLength(0);
  });

  it('期限切れは期限が古い順に先頭へ、その後に新規が続く', () => {
    const stats: ReviewStats = {
      [cards[0].key]: statOf('2026-07-19'),
    };
    const picked = pickReviewCards(cards, stats, TODAY);
    expect(picked[0].key).toBe(cards[0].key);
    expect(picked).toHaveLength(2);
  });

  it('新規カードは1日の上限（既に始めた枚数を差し引く）までしか出ない', () => {
    const manyPhrases = Array.from({ length: 20 }, (_, i) => ({
      en: `Phrase number ${i}.`,
      ja: `フレーズ${i}`,
    }));
    const bigDeck = buildReviewCards([], [makeScenario({ keyPhrases: manyPhrases })]);
    // 今日すでに NEW_CARDS_PER_DAY - 2 枚始めている → 残り予算2枚
    const stats: ReviewStats = {};
    for (let i = 0; i < NEW_CARDS_PER_DAY - 2; i++) {
      stats[`spent:${i}`] = statOf('2026-07-21', { firstReviewedDate: TODAY });
    }
    const picked = pickReviewCards(bigDeck, stats, TODAY, 8);
    expect(picked).toHaveLength(2);
  });

  it('同じ日・同じ入力なら並びが完全に決定的で、日が変わると並びが変わりうる', () => {
    const manyPhrases = Array.from({ length: 12 }, (_, i) => ({
      en: `Phrase number ${i}.`,
      ja: `フレーズ${i}`,
    }));
    const bigDeck = buildReviewCards([], [makeScenario({ keyPhrases: manyPhrases })]);
    const a = pickReviewCards(bigDeck, {}, TODAY);
    const b = pickReviewCards(bigDeck, {}, TODAY);
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));

    const otherDay = pickReviewCards(bigDeck, {}, '2026-07-21');
    expect(otherDay).toHaveLength(a.length);
  });

  it('セットサイズで切り詰める', () => {
    const manyPhrases = Array.from({ length: 12 }, (_, i) => ({
      en: `Phrase number ${i}.`,
      ja: `フレーズ${i}`,
    }));
    const bigDeck = buildReviewCards([], [makeScenario({ keyPhrases: manyPhrases })]);
    expect(pickReviewCards(bigDeck, {}, TODAY, 5, 12)).toHaveLength(5);
  });
});

describe('countReviewQueue / nextDueInfo', () => {
  const cards = buildReviewCards([makeExpression()], [makeScenario()]); // 3枚

  it('期限切れ枚数と開始可能な新規枚数を返す', () => {
    const stats: ReviewStats = { 'ex:e1': statOf('2026-07-18') };
    const q = countReviewQueue(cards, stats, TODAY);
    expect(q.due).toBe(1);
    expect(q.fresh).toBe(2);
  });

  it('nextDueInfoは最も近い将来の期限とその枚数を返す（無ければnull）', () => {
    const stats: ReviewStats = {
      'ex:e1': statOf('2026-07-23'),
      [cards[1].key]: statOf('2026-07-23'),
      [cards[2].key]: statOf('2026-08-01'),
    };
    expect(nextDueInfo(cards, stats, TODAY)).toEqual({ date: '2026-07-23', count: 2 });
    expect(nextDueInfo(cards, {}, TODAY)).toBeNull();
  });

  it('期限切れ（today以前）はnextDueInfoに含めない', () => {
    const stats: ReviewStats = { 'ex:e1': statOf(TODAY) };
    expect(nextDueInfo(cards, stats, TODAY)).toBeNull();
  });
});

describe('applyReviewOutcomes', () => {
  it('判定を反映し、入力statsを破壊しない', () => {
    const stats: ReviewStats = {};
    const next = applyReviewOutcomes(
      stats,
      [
        { key: 'ex:e1', remembered: true },
        { key: 'kp:s:x', remembered: false },
      ],
      TODAY,
      NOW,
    );
    expect(Object.keys(stats)).toHaveLength(0);
    expect(next['ex:e1'].repetition).toBe(1);
    expect(next['kp:s:x'].againCount).toBe(1);
    expect(next['kp:s:x'].dueDate).toBe(TODAY);
  });
});

describe('pruneReviewStats', () => {
  it('現存カードにないキーを取り除く', () => {
    const cards: ReviewCard[] = [{ key: 'ex:e1', en: 'a', ja: 'あ', source: 'expression' }];
    const stats: ReviewStats = {
      'ex:e1': statOf(TODAY),
      'ex:deleted': statOf(TODAY),
    };
    const pruned = pruneReviewStats(stats, cards);
    expect(Object.keys(pruned)).toEqual(['ex:e1']);
    expect(Object.keys(stats)).toHaveLength(2);
  });
});
