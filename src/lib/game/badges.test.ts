import { describe, expect, it } from 'vitest';
import { evaluateBadges } from './badges';
import type { Conversation, ExpressionItem, UserProfile } from '../types';

function makeProfile(badgeIds: string[] = []): UserProfile {
  return {
    key: 'main',
    level: 2,
    levelHistory: [],
    xp: 0,
    restTickets: 0,
    badges: badgeIds.map((id) => ({ id, earnedAt: 0 })),
    interests: [],
    createdAt: 0,
  };
}

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: `conv-${Math.random()}`,
    scenarioId: 'b-travel-001',
    mode: 'lesson',
    date: '2026-07-01',
    startedAt: 0,
    status: 'completed',
    turns: [],
    ...overrides,
  };
}

function makeExpression(i: number): ExpressionItem {
  return { id: `expr-${i}`, en: `word${i}`, ja: `単語${i}`, addedAt: 0, useCount: 0 };
}

describe('evaluateBadges', () => {
  it('bundledシナリオを同カテゴリ5本完了でカテゴリバッジを獲得', () => {
    const conversations = Array.from({ length: 5 }, (_, i) =>
      makeConversation({ scenarioId: `b-travel-00${i + 1}` }),
    );
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges).toContain('category-travel');
  });

  it('4本では未達', () => {
    const conversations = Array.from({ length: 4 }, (_, i) =>
      makeConversation({ scenarioId: `b-travel-00${i + 1}` }),
    );
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges).not.toContain('category-travel');
  });

  it('生成シナリオ(gen-接頭辞)はカテゴリ判定の対象外', () => {
    const conversations = Array.from({ length: 5 }, () =>
      makeConversation({ scenarioId: 'gen-00000000-0000-0000-0000-000000000000' }),
    );
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges.some((id) => id.startsWith('category-'))).toBe(false);
  });

  it('未完了(abandoned)の会話はカテゴリ・ストリークの集計に含めない', () => {
    const conversations = Array.from({ length: 5 }, (_, i) =>
      makeConversation({ scenarioId: `b-travel-00${i + 1}`, status: 'abandoned' }),
    );
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges).not.toContain('category-travel');
  });

  it('7日連続の練習実績があればstreak-7を獲得しstreak-30は獲得しない', () => {
    const dates = [
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
    ];
    const conversations = dates.map((date) => makeConversation({ scenarioId: 'gen-x', date }));
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges).toContain('streak-7');
    expect(badges).not.toContain('streak-30');
  });

  it('表現帳50語でexpressions-50を獲得', () => {
    const expressions = Array.from({ length: 50 }, (_, i) => makeExpression(i));
    const badges = evaluateBadges(makeProfile(), [], expressions);
    expect(badges).toContain('expressions-50');
  });

  it('49語ではexpressions-50を獲得しない', () => {
    const expressions = Array.from({ length: 49 }, (_, i) => makeExpression(i));
    const badges = evaluateBadges(makeProfile(), [], expressions);
    expect(badges).not.toContain('expressions-50');
  });

  it('starsが付いたボスレッスンでboss-first-winを獲得', () => {
    const conversations = [makeConversation({ mode: 'boss', scenarioId: 'gen-x', stars: 2 })];
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges).toContain('boss-first-win');
  });

  it('starsが0/undefinedのボスレッスンではboss-first-winを獲得しない', () => {
    const conversations = [makeConversation({ mode: 'boss', scenarioId: 'gen-x', stars: 0 })];
    const badges = evaluateBadges(makeProfile(), conversations, []);
    expect(badges).not.toContain('boss-first-win');
  });

  it('既に獲得済みのバッジは再度返さない', () => {
    const dates = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07'];
    const conversations = dates.map((date) => makeConversation({ scenarioId: 'gen-x', date }));
    const badges = evaluateBadges(makeProfile(['streak-7']), conversations, []);
    expect(badges).not.toContain('streak-7');
  });
});
