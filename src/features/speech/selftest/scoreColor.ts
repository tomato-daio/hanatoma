/**
 * 音声セルフテスト画面（DESIGN.md M2）のスコア表示用の色分け・整形をまとめた純関数。
 * PA（発音評価）スコアの閾値は画面仕様どおり: 80以上=緑 / 60〜79=黄 / 60未満=赤。
 * undefined（例: 韻律フォールバック時のprosodyScore、unscriptedのcompletenessScore）は
 * 「―」表示・neutral色にし、0点と紛れないようにする。
 */

export type ScoreTier = 'good' | 'ok' | 'bad';

const GOOD_THRESHOLD = 80;
const OK_THRESHOLD = 60;

export function scoreTier(score: number): ScoreTier {
  if (score >= GOOD_THRESHOLD) return 'good';
  if (score >= OK_THRESHOLD) return 'ok';
  return 'bad';
}

/** Tailwindのテキスト色クラス（index.cssのhanaパレットではなく標準色を使い、信号色として直感的にする）。 */
export const SCORE_TIER_TEXT_CLASS: Record<ScoreTier, string> = {
  good: 'text-green-700',
  ok: 'text-yellow-700',
  bad: 'text-red-600',
};

/** スコア未取得（undefined）時のクラス。 */
const SCORE_UNDEFINED_CLASS = 'text-neutral-400';

/** スコアに対応するテキスト色クラスを返す。undefinedはneutral。 */
export function scoreTextClass(score: number | undefined): string {
  if (score === undefined) return SCORE_UNDEFINED_CLASS;
  return SCORE_TIER_TEXT_CLASS[scoreTier(score)];
}

/** 表示用に小数第1位へ丸める。undefinedは「―」。 */
export function formatScore(score: number | undefined): string {
  return score === undefined ? '―' : score.toFixed(1);
}
