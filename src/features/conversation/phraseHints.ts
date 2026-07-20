/**
 * 音声認識のフレーズヒント組み立て（DESIGN.md §6a）。
 * シナリオで登場が予想される英文（キーフレーズ・各stepの模範解答）を集め、
 * Azure Speech の PhraseListGrammar へ渡すリストを作る純関数。
 * 認識エンジンがこれらの語句を優先候補として扱うため、なまりのある発話でも
 * シナリオの文脈に沿った聞き取りになりやすくなる（発音スコアの水増しではなく認識の文脈補助）。
 */

import type { Scenario } from '../../lib/types';

/** Azureへ渡すヒント数の上限（過大なリストは接続時のメッセージを肥大させるだけのため）。 */
export const MAX_PHRASE_HINTS = 40;

/**
 * シナリオからフレーズヒントを組み立てる。
 * キーフレーズ英文 → 全stepsのmodelAnswer の順に集め、trim後の空文字を除き、
 * 大文字小文字を無視した重複を除去して最大 MAX_PHRASE_HINTS 件を返す。
 * （ガイドの現在stepに限定しないのは、ユーザーが先のstepの表現を先取りして
 * 話すことがあり、限定すると逆に聞き取りを狭めてしまうため。）
 */
export function buildPhraseHints(scenario: Scenario): string[] {
  const raw = [
    ...scenario.keyPhrases.map((k) => k.en),
    ...scenario.steps.map((s) => s.modelAnswer),
  ];
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) continue;
    seen.add(key);
    hints.push(trimmed);
    if (hints.length >= MAX_PHRASE_HINTS) break;
  }
  return hints;
}
