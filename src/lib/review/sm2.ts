/**
 * サイレント復習の間隔反復アルゴリズム（DESIGN.md §4b。SM-2の2択簡略版・純関数）。
 *
 * 科学的根拠: 分散学習効果（Ebbinghaus忘却曲線に基づく拡張間隔反復）。忘れかけた頃に
 * 再出題するほど記憶が定着するため、「覚えてた」が続くほど出題間隔を指数的に広げ、
 * 「まだ」なら間隔をリセットして同日中に再学習させる。SuperMemo-2（Anki等で実績のある
 * 定番方式）の品質グレードを「覚えてた/まだ」の2択に簡略化したもの。
 */

import type { ReviewCardStat } from '../types';

/** 易しさ係数の初期値（SM-2標準値）。 */
export const INITIAL_EASE_FACTOR = 2.5;
/** 易しさ係数の下限（SM-2標準値。これ未満だと同じカードが頻出しすぎる）。 */
export const MIN_EASE_FACTOR = 1.3;
/** 「まだ」1回ごとの易しさ係数の減点。 */
export const EASE_PENALTY = 0.2;
/** 連続1回目の「覚えてた」後の間隔（日）。 */
export const FIRST_INTERVAL_DAYS = 1;
/** 連続2回目の「覚えてた」後の間隔（日）。 */
export const SECOND_INTERVAL_DAYS = 3;
/** 間隔の上限（日）。半年あけば十分定着とみなす。 */
export const MAX_INTERVAL_DAYS = 180;

// dates.tsは暦日加算をexportしていないため、単純な暦日加算のみここに複製する
// （学習日切替の規則そのものはdates.ts/learningDateが正本。ProgressPage等と同じ理由での複製）。
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD文字列にdelta日を加算する純関数。 */
export function addDaysToDate(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 浮動小数の易しさ係数を小数2桁へ丸める（2.3-0.2=2.0999…のような誤差蓄積を防ぐ）。 */
function roundEase(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 1回の判定（覚えてた/まだ）を反映した次のSRS状態を返す（非破壊）。
 *
 * - stat未定義（初出題カード）は初期状態から開始し firstReviewedDate=today を刻む
 * - 覚えてた: repetition+1。間隔は rep=1→1日、rep=2→3日、以降 round(前回間隔×易しさ係数)
 *   （下限1日・上限180日）。dueDate = today + 新間隔
 * - まだ: repetition=0・intervalDays=0・dueDate=today（同日の次セットで再出題=セッション内再学習）、
 *   易しさ係数-0.2（下限1.3）、againCount+1
 */
export function sm2Next(
  stat: ReviewCardStat | undefined,
  remembered: boolean,
  today: string,
  now: number,
): ReviewCardStat {
  const base: ReviewCardStat = stat ?? {
    repetition: 0,
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 0,
    dueDate: today,
    reviewCount: 0,
    againCount: 0,
    firstReviewedDate: today,
    lastReviewedAt: 0,
  };

  if (!remembered) {
    return {
      ...base,
      repetition: 0,
      easeFactor: Math.max(MIN_EASE_FACTOR, roundEase(base.easeFactor - EASE_PENALTY)),
      intervalDays: 0,
      dueDate: today,
      reviewCount: base.reviewCount + 1,
      againCount: base.againCount + 1,
      lastReviewedAt: now,
    };
  }

  const repetition = base.repetition + 1;
  const intervalDays =
    repetition === 1
      ? FIRST_INTERVAL_DAYS
      : repetition === 2
        ? SECOND_INTERVAL_DAYS
        : Math.min(
            MAX_INTERVAL_DAYS,
            Math.max(FIRST_INTERVAL_DAYS, Math.round(base.intervalDays * base.easeFactor)),
          );

  return {
    ...base,
    repetition,
    intervalDays,
    dueDate: addDaysToDate(today, intervalDays),
    reviewCount: base.reviewCount + 1,
    lastReviewedAt: now,
  };
}
