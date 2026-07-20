/**
 * サイレント復習の永続化オーケストレーション（DESIGN.md §4b）。
 *
 * 純関数（lib/review/）とDB（appState 'reviewStats' / 'reviewDates'）をつなぐ層。
 * ストリーク合流のため homeData.ts / sessionEnd.ts / ProgressPage からも
 * getReviewDates() が参照される。循環importを避けるため、このファイルは
 * homeData.ts をimportしてはならない（db/dates/lib/review/streakUnion/
 * shadotomaBridge/loadScenarios のみに依存する葉モジュール）。
 */

import {
  getAppState,
  getUserProfile,
  listConversations,
  listExpressions,
  putUserProfile,
  setAppState,
} from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { applyRestTickets } from '../../lib/game/streakUnion';
import {
  applyReviewOutcomes,
  buildReviewCards,
  pruneReviewStats,
  REVIEW_SET_XP,
  type ReviewCard,
  type ReviewOutcome,
} from '../../lib/review/reviewCards';
import type { ReviewStats, Scenario } from '../../lib/types';
import { getScenarioById } from '../scenarios/loadScenarios';
import { getSisterData } from '../sisterApp/shadotomaBridge';

/** 復習セットを完走した学習日の一覧（ストリーク合流用。昇順は保証しない）。 */
export async function getReviewDates(): Promise<string[]> {
  return (await getAppState<string[]>('reviewDates')) ?? [];
}

export interface ReviewDeck {
  cards: ReviewCard[];
  stats: ReviewStats;
}

/**
 * カード一覧（表現帳∪完了済みシナリオのキーフレーズ）とSRS状態をまとめて読み込む。
 * 診断モードの会話はシナリオを持たないため除外する。
 */
export async function loadReviewDeck(): Promise<ReviewDeck> {
  const [expressions, conversations, stats] = await Promise.all([
    listExpressions(),
    listConversations(),
    getAppState<ReviewStats>('reviewStats'),
  ]);
  const completedScenarioIds = Array.from(
    new Set(
      conversations
        .filter((c) => c.status === 'completed' && c.mode !== 'diagnostic')
        .map((c) => c.scenarioId),
    ),
  );
  const scenarios = (await Promise.all(completedScenarioIds.map((id) => getScenarioById(id)))).filter(
    (s): s is Scenario => s !== undefined,
  );
  return { cards: buildReviewCards(expressions, scenarios), stats: stats ?? {} };
}

export interface FinishReviewSetResult {
  /** 今回付与されたXP（1日1回のみ。2セット目以降は0）。 */
  xpAwarded: number;
  isFirstSetToday: boolean;
  rememberedCount: number;
  againCount: number;
  /** 復習日を含めたコンビストリーク（表示用）。 */
  streak: number;
}

/**
 * 復習1セット完走を記録する:
 * 1. SRS状態へ判定を反映（sm2）→ 孤児掃除 → 保存
 * 2. reviewDates に今日の学習日を追加（初回のみ）
 * 3. 今日初めてのセットなら +REVIEW_SET_XP（ストリーク倍率・減衰の対象外）
 * 4. 会話完了日∪復習日∪shadotoma練習日でコンビストリークを算出して返す
 * お休みチケットの「付与」は行わない（会話セッション完了時のみ。DESIGN.md §10）。
 */
export async function finishReviewSet(
  outcomes: ReviewOutcome[],
  allCards: ReviewCard[],
): Promise<FinishReviewSetResult> {
  const now = Date.now();
  const today = learningDate(new Date(now));

  const prevStats = (await getAppState<ReviewStats>('reviewStats')) ?? {};
  const nextStats = pruneReviewStats(applyReviewOutcomes(prevStats, outcomes, today, now), allCards);
  await setAppState('reviewStats', nextStats);

  const dates = await getReviewDates();
  const isFirstSetToday = !dates.includes(today);
  if (isFirstSetToday) {
    await setAppState('reviewDates', [...dates, today]);
  }

  const profile = await getUserProfile();
  let xpAwarded = 0;
  if (isFirstSetToday) {
    xpAwarded = REVIEW_SET_XP;
    await putUserProfile({ ...profile, xp: profile.xp + xpAwarded });
  }

  // コンビストリーク（会話完了日∪復習日∪shadotoma練習日 + チケット消費）
  const conversations = await listConversations();
  const sisterData = await getSisterData();
  const merged = Array.from(
    new Set([
      ...conversations.filter((c) => c.status === 'completed').map((c) => c.date),
      ...(isFirstSetToday ? [...dates, today] : dates),
      ...(sisterData?.practiceDates ?? []),
    ]),
  );
  const streak = applyRestTickets(merged, profile.restTickets, today).streak;

  const rememberedCount = outcomes.filter((o) => o.remembered).length;
  return {
    xpAwarded,
    isFirstSetToday,
    rememberedCount,
    againCount: outcomes.length - rememberedCount,
    streak,
  };
}
