/**
 * サイレント復習のカード組み立てと出題選択（DESIGN.md §4b・純関数）。
 *
 * カード供給源は「表現帳 ∪ 完了済みシナリオのキーフレーズ」。カード自体は永続化しない
 * 導出型で、SRS状態（ReviewStats。sm2.ts参照）だけを appState に保存する。
 *
 * 出題の科学的方針（分散学習）: 期限が来たカードだけを出し、覚えているカードを
 * 無駄に見せない。新規カードは1日あたり NEW_CARDS_PER_DAY 枚まで（詰め込み防止）。
 * 並びは学習日シードのFNV-1aで決定的（quests.tsと同じ原則。Math.random禁止）。
 */

import type { ExpressionItem, ReviewStats, Scenario } from '../types';
import { sm2Next } from './sm2';

/** 1セットの枚数（1枚8〜10秒×8枚≒1〜1.5分。§4「1回1〜2分」に収める）。 */
export const REVIEW_SET_SIZE = 8;
/** 新規カードを1日に始める上限枚数（Anki流の詰め込み防止）。 */
export const NEW_CARDS_PER_DAY = 8;
/** セット完走XP（1日1回のみ。ストリーク倍率・減衰の対象外）。 */
export const REVIEW_SET_XP = 10;

export type ReviewCardSource = 'expression' | 'keyphrase';

/** 復習カード1枚（永続化しない導出型）。keyがReviewStatsのキーと対応する。 */
export interface ReviewCard {
  key: string;
  en: string;
  ja: string;
  note?: string;
  source: ReviewCardSource;
}

/** 1枚ぶんの判定結果。 */
export interface ReviewOutcome {
  key: string;
  remembered: boolean;
}

/** quests.ts/homeData.tsと同じFNV-1a。私設なので複製する（決定的タイブレーク用）。 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 表現帳と完了済みシナリオのキーフレーズからカード一覧を組み立てる。
 * 表現帳 → キーフレーズの順に集め、en（trim・大文字小文字無視）の重複は先勝ち
 * （=表現帳優先。添削由来の表現の方が文脈note付きで質が高いため）。
 */
export function buildReviewCards(
  expressions: ExpressionItem[],
  completedScenarios: Scenario[],
): ReviewCard[] {
  const cards: ReviewCard[] = [];
  const seenEn = new Set<string>();

  const push = (card: ReviewCard) => {
    const en = card.en.trim();
    const ja = card.ja.trim();
    if (en === '' || ja === '') return;
    const enKey = en.toLowerCase();
    if (seenEn.has(enKey)) return;
    seenEn.add(enKey);
    cards.push({ ...card, en, ja });
  };

  for (const item of expressions) {
    push({
      key: `ex:${item.id}`,
      en: item.en,
      ja: item.ja,
      ...(item.note ? { note: item.note } : {}),
      source: 'expression',
    });
  }
  for (const scenario of completedScenarios) {
    for (const phrase of scenario.keyPhrases) {
      push({
        key: `kp:${scenario.id}:${phrase.en.trim().toLowerCase()}`,
        en: phrase.en,
        ja: phrase.ja,
        ...(phrase.note ? { note: phrase.note } : {}),
        source: 'keyphrase',
      });
    }
  }
  return cards;
}

/** seedDateシードの決定的比較器（同順位カードの並びを日替わりで変えつつ再現可能にする）。 */
function seededCompare(seedDate: string): (a: ReviewCard, b: ReviewCard) => number {
  return (a, b) => fnv1a(`${seedDate}:${a.key}`) - fnv1a(`${seedDate}:${b.key}`);
}

/** statsのうち今日初めて出題されたカードの枚数（新規上限の消化数）。 */
function countIntroducedToday(stats: ReviewStats, today: string): number {
  return Object.values(stats).filter((s) => s.firstReviewedDate === today).length;
}

/**
 * 今日のセットを選ぶ（分散学習の核）:
 * 1. 期限切れ（dueDate <= today）を期限が古い順（同日はシードタイブレーク）
 * 2. 未学習カードを新規予算（NEW_CARDS_PER_DAY - 今日すでに始めた枚数）まで
 * 期限前のカードは出さない。返り値が空 = 今日の復習はすべて消化済み。
 */
export function pickReviewCards(
  cards: ReviewCard[],
  stats: ReviewStats,
  today: string,
  size: number = REVIEW_SET_SIZE,
  newLimit: number = NEW_CARDS_PER_DAY,
): ReviewCard[] {
  const tiebreak = seededCompare(today);

  const due = cards
    .filter((c) => stats[c.key] !== undefined && stats[c.key].dueDate <= today)
    .sort((a, b) => {
      const da = stats[a.key].dueDate;
      const db = stats[b.key].dueDate;
      if (da !== db) return da < db ? -1 : 1;
      return tiebreak(a, b);
    });

  const newBudget = Math.max(0, newLimit - countIntroducedToday(stats, today));
  const fresh = cards
    .filter((c) => stats[c.key] === undefined)
    .sort(tiebreak)
    .slice(0, newBudget);

  return [...due, ...fresh].slice(0, size);
}

/** ホームのバッジと「今日は消化済み」判定用: 期限切れ枚数と、今日まだ始められる新規枚数。 */
export function countReviewQueue(
  cards: ReviewCard[],
  stats: ReviewStats,
  today: string,
  newLimit: number = NEW_CARDS_PER_DAY,
): { due: number; fresh: number } {
  const due = cards.filter((c) => stats[c.key] !== undefined && stats[c.key].dueDate <= today).length;
  const newBudget = Math.max(0, newLimit - countIntroducedToday(stats, today));
  const freshAvailable = cards.filter((c) => stats[c.key] === undefined).length;
  return { due, fresh: Math.min(newBudget, freshAvailable) };
}

/** 次に期限が来る日付とその枚数（today以降で最も近い期限。無ければnull）。完了画面の案内用。 */
export function nextDueInfo(
  cards: ReviewCard[],
  stats: ReviewStats,
  today: string,
): { date: string; count: number } | null {
  const future = cards
    .map((c) => stats[c.key]?.dueDate)
    .filter((d): d is string => d !== undefined && d > today);
  if (future.length === 0) return null;
  const date = future.reduce((min, d) => (d < min ? d : min));
  return { date, count: future.filter((d) => d === date).length };
}

/** セットの判定結果をSRS状態へ反映する（非破壊。判定順にsm2Nextを畳み込む）。 */
export function applyReviewOutcomes(
  stats: ReviewStats,
  outcomes: ReviewOutcome[],
  today: string,
  now: number,
): ReviewStats {
  const next: ReviewStats = { ...stats };
  for (const outcome of outcomes) {
    next[outcome.key] = sm2Next(next[outcome.key], outcome.remembered, today, now);
  }
  return next;
}

/** 現存カードに対応しないSRS状態を取り除く（表現削除等の孤児掃除。非破壊）。 */
export function pruneReviewStats(stats: ReviewStats, cards: ReviewCard[]): ReviewStats {
  const validKeys = new Set(cards.map((c) => c.key));
  const next: ReviewStats = {};
  for (const [key, stat] of Object.entries(stats)) {
    if (validKeys.has(key)) next[key] = stat;
  }
  return next;
}
