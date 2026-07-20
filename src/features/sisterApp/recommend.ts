/**
 * shadotoma弱点連携のシナリオ推薦（DESIGN.md §11a「シナリオ推薦（targetPhonemes×弱点音素の
 * 一致スコア）」・M8。純関数・Vitestテスト必須）。
 *
 * スコア = |targetPhonemes ∩ weakPhonemes| × 10 + レベル適合（同レベル+5 / ±1レベル+2）。
 * 未完了シナリオのみをスコア降順で返す（同点は入力順を維持）。
 */

import type { AppLevel, Scenario } from '../../lib/types';

const PHONEME_MATCH_POINTS = 10;
const SAME_LEVEL_POINTS = 5;
const ADJACENT_LEVEL_POINTS = 2;

/**
 * 1シナリオの推薦スコアを計算する。
 * 音素はARPAbet大文字キー体系（例 'R','TH'）だが、念のため大文字化して比較する。
 * targetPhonemes内の重複は1回として数える（Set化）。
 */
export function scoreScenario(scenario: Scenario, level: AppLevel, weakPhonemes: string[]): number {
  const weakSet = new Set(weakPhonemes.map((p) => p.toUpperCase()));
  const targetSet = new Set((scenario.targetPhonemes ?? []).map((p) => p.toUpperCase()));

  let matches = 0;
  for (const phoneme of targetSet) {
    if (weakSet.has(phoneme)) matches++;
  }

  const levelDiff = Math.abs(scenario.level - level);
  const levelPoints = levelDiff === 0 ? SAME_LEVEL_POINTS : levelDiff === 1 ? ADJACENT_LEVEL_POINTS : 0;

  return matches * PHONEME_MATCH_POINTS + levelPoints;
}

/**
 * 未完了シナリオを推薦スコアの高い順に並べて返す（DESIGN.md §11a・M8）。
 *
 * @param scenarios 候補シナリオ（バンドル+生成）
 * @param completedIds 完了済み（status:'completed'の会話がある）シナリオidの集合
 * @param level ユーザーの現在レベル
 * @param weakPhonemes 弱点音素（自アプリ+shadotoma。ARPAbet大文字キー）
 */
export function recommendScenarios(
  scenarios: Scenario[],
  completedIds: Set<string>,
  level: AppLevel,
  weakPhonemes: string[],
): Scenario[] {
  return scenarios
    .filter((s) => !completedIds.has(s.id))
    .map((scenario, index) => ({ scenario, index, score: scoreScenario(scenario, level, weakPhonemes) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.scenario);
}
