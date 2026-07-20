/**
 * バッジ判定（DESIGN.md §10）。
 *
 * 戻り値は「新規に獲得したバッジid」の配列のみ（profile.badgesに未登録のものだけ）。
 * earnedAtの付与はDate.now()という副作用になるため、この純関数ではやらない。
 * 呼び出し側（UI/store）がRewardScreen表示時などにearnedAt: Date.now()を付けてprofile.badgesへ追記する。
 *
 * カテゴリ制覇はscenarioIdからカテゴリを判定する必要があるが、この関数の引数にScenario一覧は無い。
 * DESIGN.md §3の命名規則「bundled: "b-<category>-<連番>"」を利用してscenarioIdから逆引きする
 * （生成シナリオ"gen-"+uuidはカテゴリ不明のため対象外＝カウントしない）。
 *
 * 音素克服バッジ（弱点音素のPA移動平均≥75）はshadotoma連携で弱点音素の時系列データが揃うM8で追加する。
 * 現時点ではここに実装しない。
 */

import type { Conversation, ExpressionItem, ScenarioCategory, UserProfile } from '../types';
import { calcStreak } from '../dates';

const SCENARIO_CATEGORIES: readonly ScenarioCategory[] = [
  'travel',
  'restaurant',
  'work',
  'daily',
  'interview',
  'shopping',
  'health',
  'social',
];

const CATEGORY_COMPLETE_THRESHOLD = 5;
const EXPRESSION_NOTEBOOK_THRESHOLD = 50;
const STREAK_THRESHOLDS = [7, 30, 100] as const;

const BUNDLED_SCENARIO_ID_RE = /^b-([a-z]+)-\d+$/;

/**
 * 練習日一覧から「これまでで最長の連続日数」を求める。
 * calcStreakは「today」を起点にした一方向の計算しかできないため、
 * 記録済みの各日を仮のtodayとして総当たりし最大値を取る（dates.tsのロジックを複製しない）。
 */
function longestStreak(dates: string[]): number {
  const unique = Array.from(new Set(dates));
  let max = 0;
  for (const d of unique) {
    const streak = calcStreak(unique, d);
    if (streak > max) max = streak;
  }
  return max;
}

export function evaluateBadges(
  profile: UserProfile,
  conversations: Conversation[],
  expressions: ExpressionItem[],
): string[] {
  const alreadyEarned = new Set(profile.badges.map((b) => b.id));
  const newly: string[] = [];
  const grant = (id: string): void => {
    if (!alreadyEarned.has(id)) newly.push(id);
  };

  const completed = conversations.filter((c) => c.status === 'completed');

  // カテゴリ制覇: 各カテゴリでbundledシナリオを5本以上完了
  const categoryCounts = new Map<ScenarioCategory, number>();
  for (const c of completed) {
    const match = BUNDLED_SCENARIO_ID_RE.exec(c.scenarioId);
    if (!match) continue;
    const category = match[1] as ScenarioCategory;
    if (!SCENARIO_CATEGORIES.includes(category)) continue;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  for (const category of SCENARIO_CATEGORIES) {
    if ((categoryCounts.get(category) ?? 0) >= CATEGORY_COMPLETE_THRESHOLD) {
      grant(`category-${category}`);
    }
  }

  // ストリーク7・30・100（全期間で一度でも到達したことがあれば付与）
  const longest = longestStreak(completed.map((c) => c.date));
  for (const threshold of STREAK_THRESHOLDS) {
    if (longest >= threshold) grant(`streak-${threshold}`);
  }

  // 表現帳50語
  if (expressions.length >= EXPRESSION_NOTEBOOK_THRESHOLD) {
    grant('expressions-50');
  }

  // ボス初勝利: starsが1以上付いたボスレッスンがあれば勝利とみなす
  // （Conversationに勝敗フラグは無く、starsはcomposite50以上でしか付かないため代理指標として使う）。
  const bossWon = completed.some((c) => c.mode === 'boss' && (c.stars ?? 0) > 0);
  if (bossWon) grant('boss-first-win');

  return newly;
}
