/**
 * 音声認識のフレーズヒント組み立て（DESIGN.md §6a）。
 * シナリオで登場が予想される英文を Azure Speech の PhraseListGrammar へ渡すリストを作る純関数。
 * 認識エンジンがこれらの語句を優先候補として扱うため、なまりのある発話でも
 * シナリオの文脈に沿った聞き取りになりやすくなる（発音スコアの水増しではなく認識の文脈補助）。
 *
 * ⚠️ヒントは文脈で絞ること（over-biasing対策）: 当初は全stepsのmodelAnswer（平均74字の
 * 長文8〜10件）を渡していたが、実際の発話がヒント文へ引っ張られて認識精度が体感悪化する
 * 実害があった。現在は「ガイド中=キーフレーズ+現在stepの模範解答のみ／それ以外=キーフレーズのみ」
 * に絞る。範囲を再び広げないこと。
 */

import type { ConversationPhase, Scenario } from '../../lib/types';

/** Azureへ渡すヒント数の上限（過大なリストは接続時のメッセージを肥大させるだけのため）。 */
export const MAX_PHRASE_HINTS = 40;

/** ヒントの文脈: 会話のどのフェーズ・どのステップにいるか。 */
export interface PhraseHintContext {
  phase: ConversationPhase;
  /** guidedフェーズの現在ステップ。guided以外では使われない。範囲外でも安全。 */
  stepIndex: number;
}

/**
 * フレーズヒントを組み立てる。
 * - guided: キーフレーズ英文 + 現在stepのmodelAnswer（ユーザーが模範解答ヒントを
 *   読み上げる可能性が高い）のみ
 * - それ以外（free/keyphrase）: キーフレーズ英文のみ
 * trim後の空文字を除き、大文字小文字を無視した重複を除去して最大 MAX_PHRASE_HINTS 件を返す。
 */
export function buildPhraseHints(scenario: Scenario, ctx: PhraseHintContext): string[] {
  const raw = [...scenario.keyPhrases.map((k) => k.en)];
  if (ctx.phase === 'guided') {
    const current = scenario.steps[ctx.stepIndex];
    if (current) raw.push(current.modelAnswer);
  }

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
