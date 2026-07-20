/**
 * セッション完了時のXP計算とランク導出（DESIGN.md §10）。
 *
 * 設計思想「1日がっつり」より「毎日少しずつ」を数値で体現する場所:
 * - 初回セッションはボーナス、2回目以降は減衰させる（がっつり周回のうまみを削る）
 * - ストリーク倍率は上限1.5倍で頭打ち（連続日数を稼ぐほど得だが青天井にはしない）
 *
 * UI・db.tsには依存しない純関数のみ。
 */

import type { ConversationMode } from '../types';

export interface CalcSessionXpInput {
  mode: ConversationMode;
  objectivesAchieved: number;
  allKeyPhrasesDone: boolean;
  questsCompleted: number;
  bossWin: boolean;
  modelAnswersShown: number;
  streak: number;
  isFirstSessionToday: boolean;
}

export interface XpBreakdownItem {
  label: string;
  amount: number;
}

export interface CalcSessionXpResult {
  xp: number;
  breakdown: XpBreakdownItem[];
}

// diagnostic（オンボーディング診断）はXP対象外。lesson/quick/bite/bossの基礎点はDESIGN.md §10。
const BASE_XP: Record<Exclude<ConversationMode, 'boss'>, number> = {
  lesson: 50,
  quick: 25,
  bite: 10,
  diagnostic: 0,
};

const BASE_LABEL: Record<Exclude<ConversationMode, 'boss'>, string> = {
  lesson: 'レッスン完了',
  quick: 'クイック会話完了',
  bite: 'ひとくち英会話完了',
  diagnostic: '診断(XP対象外)',
};

const OBJECTIVE_XP = 10;
const KEY_PHRASE_XP = 20;
const QUEST_XP = 30;
const MODEL_ANSWER_PENALTY = 5;
const BOSS_WIN_XP = 150;
const DAILY_FIRST_BONUS = 30;
const STREAK_CAP_DAYS = 25;
const STREAK_RATE_PER_DAY = 0.02;

/**
 * 1セッション分のXPを計算する。DESIGN.md §10の式:
 * 基礎点 + 目標達成*10 + キーフレーズ全✓20 + クエスト*30 - 模範解答*5(下限0)
 *   → ストリーク倍率 ×(1+min(streak,25)*0.02)（端数切上げ）
 *   → 初回なら+30、2回目以降は最終値50%（切上げ）
 *
 * breakdownの各amountの合計は必ずxpと一致する（内訳表示にそのまま使える）。
 */
export function calcSessionXp(input: CalcSessionXpInput): CalcSessionXpResult {
  const breakdown: XpBreakdownItem[] = [];

  // ボス戦は「挑戦しただけ」では基礎点を与えない。勝利(bossWin)して初めて150点。
  // 挑戦のみでも目標達成やキーフレーズ等の加点は別途つく（練習自体は無駄にならない）。
  let base: number;
  if (input.mode === 'boss') {
    base = input.bossWin ? BOSS_WIN_XP : 0;
    breakdown.push({ label: input.bossWin ? 'ボス撃破' : 'ボスへの挑戦(未勝利)', amount: base });
  } else {
    base = BASE_XP[input.mode];
    breakdown.push({ label: BASE_LABEL[input.mode], amount: base });
  }

  if (input.objectivesAchieved > 0) {
    breakdown.push({ label: '隠れ目標を達成', amount: input.objectivesAchieved * OBJECTIVE_XP });
  }
  if (input.allKeyPhrasesDone) {
    breakdown.push({ label: 'キーフレーズ全部✓', amount: KEY_PHRASE_XP });
  }
  if (input.questsCompleted > 0) {
    breakdown.push({ label: 'デイリークエスト達成', amount: input.questsCompleted * QUEST_XP });
  }
  if (input.modelAnswersShown > 0) {
    breakdown.push({ label: '模範解答を見た', amount: -(input.modelAnswersShown * MODEL_ANSWER_PENALTY) });
  }

  const subtotal = breakdown.reduce((sum, item) => sum + item.amount, 0);
  const floored = Math.max(0, subtotal);
  if (floored !== subtotal) {
    // 模範解答ペナルティ等でマイナスになった分をここで下限0まで戻す。
    breakdown.push({ label: '下限調整', amount: floored - subtotal });
  }

  const multiplier = 1 + Math.min(input.streak, STREAK_CAP_DAYS) * STREAK_RATE_PER_DAY;
  const afterStreak = Math.ceil(floored * multiplier);
  const streakBonus = afterStreak - floored;
  if (streakBonus > 0) {
    breakdown.push({ label: `連続練習ボーナス(streak${input.streak}日)`, amount: streakBonus });
  }

  let xp: number;
  if (input.isFirstSessionToday) {
    xp = afterStreak + DAILY_FIRST_BONUS;
    breakdown.push({ label: '本日初回ボーナス', amount: DAILY_FIRST_BONUS });
  } else {
    xp = Math.ceil(afterStreak * 0.5);
    breakdown.push({ label: '同日2回目以降(50%)', amount: xp - afterStreak });
  }

  return { xp, breakdown };
}

/** ランク名（見習い→…→伝説）。indexがそのままrankFromXpの戻り値に対応する。 */
export const RANK_NAMES: readonly string[] = [
  '見習い',
  '旅人',
  '冒険者',
  '開拓者',
  '熟練者',
  '達人',
  '賢者',
  '英雄',
  '覇者',
  '伝説',
];

/**
 * ランクnに到達するために必要な累積XP閾値（DESIGN.md §10: 50×n×(n+1)）。
 * n=0（見習い開始時点）は常に0。
 */
export function xpForRank(n: number): number {
  if (n <= 0) return 0;
  return 50 * n * (n + 1);
}

/** 累計XPから現在のランクindex（RANK_NAMESの添字）を返す。範囲外XPはRANK_NAMES末尾で頭打ち。 */
export function rankFromXp(xp: number): number {
  let rank = 0;
  for (let n = 1; n < RANK_NAMES.length; n++) {
    if (xp >= xpForRank(n)) {
      rank = n;
    } else {
      break;
    }
  }
  return rank;
}
