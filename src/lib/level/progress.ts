/**
 * レベル昇降格判定（DESIGN.md §8c）。
 *
 * - 現レベル以上の難易度のレッスン直近5件中4件がcomposite≥75 → 昇格（上限5）
 * - 直近5件（レベル問わず）が全てcomposite<50 → 降格（下限1）。ただし昇格から3日以内は降格しない
 * - 判定に必要な件数（5件）に満たない場合はどちらも発生しない
 * - 昇格・降格が同時に成立し得るケース（母集団が異なるため理論上は起こり得る）は昇格を優先する
 * - 手動オーバーライドは設定画面側の責務。ここでは自動判定のみを行う純関数
 */

import type { AppLevel, UserProfile } from '../types';

export interface RecentLessonRecord {
  date: string; // "YYYY-MM-DD"
  scenarioLevel: number;
  composite: number;
}

export interface LevelProgressResult {
  level: AppLevel;
  change: 'promote' | 'demote' | null;
}

const PROMOTE_LOOKBACK = 5;
const PROMOTE_MIN_HITS = 4;
const PROMOTE_THRESHOLD = 75;

const DEMOTE_LOOKBACK = 5;
const DEMOTE_THRESHOLD = 50;
/** 昇格からこの日数「以内」は降格判定を行わない（DESIGN.md §8c）。境界日を含む（以内=inclusive）。 */
const PROMOTE_GRACE_DAYS = 3;

const MIN_LEVEL: AppLevel = 1;
const MAX_LEVEL: AppLevel = 5;

/** date昇順ではなく降順（新しい日付が先頭）に並べ替える。同日はもとの順序を保つ（安定ソート）。 */
function sortByDateDesc<T extends { date: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** "YYYY-MM-DD" 同士の日数差（to - from）。UTC基準の日数計算でタイムゾーン起因のずれを避ける。 */
function daysBetween(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

/** levelHistoryのうち最新のreason==='promote'の日付（無ければnull）。 */
function findLastPromoteDate(history: UserProfile['levelHistory']): string | null {
  const promotes = history.filter((h) => h.reason === 'promote');
  if (promotes.length === 0) return null;
  return promotes.reduce((latest, h) => (h.date > latest ? h.date : latest), promotes[0].date);
}

/**
 * profile.levelとrecentLessonsから昇降格を判定する（DESIGN.md §8c）。
 * recentLessonsは順不同で渡してよい（内部でdate降順に並べ替える）。
 */
export function applyLevelProgress(
  profile: UserProfile,
  recentLessons: RecentLessonRecord[],
  today: string,
): LevelProgressResult {
  const currentLevel = profile.level;

  // --- 昇格判定: 現レベル以上の難易度のレッスンのみを対象に、直近5件中4件が閾値以上か ---
  const atOrAboveLevel = sortByDateDesc(recentLessons.filter((l) => l.scenarioLevel >= currentLevel));
  if (atOrAboveLevel.length >= PROMOTE_LOOKBACK && currentLevel < MAX_LEVEL) {
    const window = atOrAboveLevel.slice(0, PROMOTE_LOOKBACK);
    const hits = window.filter((l) => l.composite >= PROMOTE_THRESHOLD).length;
    if (hits >= PROMOTE_MIN_HITS) {
      return { level: (currentLevel + 1) as AppLevel, change: 'promote' };
    }
  }

  // --- 降格判定: 昇格猶予期間中でなければ、直近5件（レベル問わず）が全て閾値未満か ---
  const lastPromoteDate = findLastPromoteDate(profile.levelHistory);
  const withinPromoteGrace = lastPromoteDate !== null && daysBetween(lastPromoteDate, today) <= PROMOTE_GRACE_DAYS;

  if (!withinPromoteGrace && currentLevel > MIN_LEVEL) {
    const allSorted = sortByDateDesc(recentLessons);
    if (allSorted.length >= DEMOTE_LOOKBACK) {
      const window = allSorted.slice(0, DEMOTE_LOOKBACK);
      if (window.every((l) => l.composite < DEMOTE_THRESHOLD)) {
        return { level: (currentLevel - 1) as AppLevel, change: 'demote' };
      }
    }
  }

  return { level: currentLevel, change: null };
}
