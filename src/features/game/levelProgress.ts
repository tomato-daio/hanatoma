/**
 * 昇格プログレスの表示用データ組み立て（DESIGN.md §8c・§8d）。
 *
 * Home/Progress画面で「あと何回で昇格か」を出すため、完了済みの採点レッスン（lesson/quick/boss）から
 * 昇格判定と同じ母集団（sessionEnd.tsと同じ: 直近20件・現レベル以上フィルタは純関数側）を組み立て、
 * lib/level/progress の純関数 computePromoteProgress に渡す。
 * シナリオのレベルは getScenarioById（bundled優先→generated）で解決し、見つからなければ現レベルに
 * フォールバックする（sessionEnd.ts と同じ扱い）。
 */

import { computePromoteProgress, type PromoteProgress, type RecentLessonRecord } from '../../lib/level/progress';
import type { AppLevel, Conversation } from '../../lib/types';
import { getScenarioById } from '../scenarios/loadScenarios';

const GRADED_MODES = new Set(['lesson', 'quick', 'boss']);
/** sessionEnd.ts の判定窓と揃える（直近20件から純関数側が現レベル以上5件を選ぶ）。 */
const RECENT_WINDOW = 20;

/**
 * 完了済み採点レッスンから RecentLessonRecord を新しい順に組み立てる（sessionEnd.ts と同一母集団）。
 * scenarioLevel は getScenarioById で解決し、不明時は currentLevel にフォールバックする。
 */
export async function buildRecentGradedRecords(
  conversations: Conversation[],
  currentLevel: AppLevel,
): Promise<RecentLessonRecord[]> {
  const recent = conversations
    .filter((c) => c.status === 'completed' && GRADED_MODES.has(c.mode) && c.metrics)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, RECENT_WINDOW);
  const records: RecentLessonRecord[] = [];
  for (const c of recent) {
    const s = await getScenarioById(c.scenarioId);
    records.push({
      date: c.date,
      scenarioLevel: s?.level ?? currentLevel,
      composite: c.metrics!.composite,
    });
  }
  return records;
}

/** 会話一覧＋現レベルから昇格プログレスを算出する（Home/Progress表示用）。 */
export async function loadPromoteProgress(
  conversations: Conversation[],
  currentLevel: AppLevel,
): Promise<PromoteProgress> {
  const records = await buildRecentGradedRecords(conversations, currentLevel);
  return computePromoteProgress(currentLevel, records);
}
