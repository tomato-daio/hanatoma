/**
 * シナリオ島マップ（DESIGN.md §2, §10）。
 * カテゴリ=島。島内の5レベル分シナリオをノードとして並べ、★合計・完了状況を表示する。
 * アンロックは表示上のみ（前の島の★合計が閾値以上で解錠マーク。プレイ自体は常に可能）。
 */

import type { Conversation, Scenario, ScenarioCategory } from '../../lib/types';
import { starsFromComposite } from '../../lib/game/stars';

/** カテゴリの表示メタ情報（絵文字・日本語名）。BadgeShelfのカテゴリバッジ表示とも共有する。 */
export const CATEGORY_META: Record<ScenarioCategory, { emoji: string; labelJa: string }> = {
  travel: { emoji: '✈️', labelJa: '旅行' },
  restaurant: { emoji: '🍽️', labelJa: 'レストラン' },
  work: { emoji: '💼', labelJa: '仕事' },
  daily: { emoji: '🏠', labelJa: '日常' },
  interview: { emoji: '🎤', labelJa: '面接' },
  shopping: { emoji: '🛍️', labelJa: '買い物' },
  health: { emoji: '🏥', labelJa: '健康' },
  social: { emoji: '👥', labelJa: '社交' },
};

const CATEGORY_ORDER: readonly ScenarioCategory[] = [
  'travel',
  'restaurant',
  'work',
  'daily',
  'interview',
  'shopping',
  'health',
  'social',
];

/** 前の島の★合計がこの値以上で次の島が解錠される（表示のみ。DESIGN.md §10）。 */
const UNLOCK_STAR_THRESHOLD = 3;

interface ScenarioMapProps {
  scenarios: Scenario[];
  conversations: Conversation[];
  /** 島タップ時のコールバック（指定時のみ島がタップ可能になる。シナリオ一覧ページで使用）。 */
  onSelectCategory?: (category: ScenarioCategory) => void;
}

interface IslandSummary {
  category: ScenarioCategory;
  scenarios: Scenario[];
  totalStars: number;
  completedCount: number;
  unlocked: boolean;
}

/** scenarioIdごとの最高★を求める（同じシナリオを複数回プレイした場合はベストスコアを採用）。 */
function bestStarsByScenario(conversations: Conversation[]): Map<string, 0 | 1 | 2 | 3> {
  const map = new Map<string, 0 | 1 | 2 | 3>();
  for (const c of conversations) {
    if (c.status !== 'completed') continue;
    const stars = c.stars ?? (c.metrics ? starsFromComposite(c.metrics.composite) : 0);
    const prev = map.get(c.scenarioId) ?? 0;
    if (stars > prev) map.set(c.scenarioId, stars);
  }
  return map;
}

function buildIslands(scenarios: Scenario[], starMap: Map<string, 0 | 1 | 2 | 3>): IslandSummary[] {
  const base = CATEGORY_ORDER.map((category) => {
    const categoryScenarios = scenarios
      .filter((s) => s.category === category)
      .sort((a, b) => a.level - b.level);
    const totalStars = categoryScenarios.reduce((sum, s) => sum + (starMap.get(s.id) ?? 0), 0);
    const completedCount = categoryScenarios.filter((s) => starMap.has(s.id)).length;
    return { category, scenarios: categoryScenarios, totalStars, completedCount };
  });

  return base.map((island, idx) => ({
    ...island,
    unlocked: idx === 0 || base[idx - 1].totalStars >= UNLOCK_STAR_THRESHOLD,
  }));
}

export function ScenarioMap({ scenarios, conversations, onSelectCategory }: ScenarioMapProps) {
  const starMap = bestStarsByScenario(conversations);
  const islands = buildIslands(scenarios, starMap);

  return (
    <div className="grid grid-cols-2 gap-3">
      {islands.map((island) => {
        const meta = CATEGORY_META[island.category];
        const Tag = onSelectCategory ? 'button' : 'div';
        return (
          <Tag
            key={island.category}
            {...(onSelectCategory
              ? { type: 'button' as const, onClick: () => onSelectCategory(island.category) }
              : {})}
            className={`rounded-2xl border p-3 text-left ${
              island.unlocked ? 'border-hana-200 bg-hana-50' : 'border-neutral-200 bg-neutral-50'
            } ${onSelectCategory ? 'active:border-hana-400' : ''}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl" aria-hidden="true">
                {meta.emoji}
              </span>
              {!island.unlocked && (
                <span className="text-xs text-neutral-400" title="前の島で★3以上を集めると解錠マークが付きます">
                  🔒
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-bold text-neutral-800">{meta.labelJa}</p>

            <div className="mt-2 flex gap-1">
              {island.scenarios.map((s) => {
                const stars = starMap.get(s.id);
                const played = stars !== undefined;
                return (
                  <div
                    key={s.id}
                    title={`Lv${s.level} ${s.titleJa}${played ? ` ・ ${'★'.repeat(stars)}` : ''}`}
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                      played ? 'bg-hana-400 text-white' : 'border border-neutral-200 bg-white text-neutral-400'
                    }`}
                  >
                    {s.level}
                  </div>
                );
              })}
            </div>

            <p className="mt-2 text-[11px] text-neutral-500">
              ★{island.totalStars} ・ {island.completedCount}/{island.scenarios.length}完了
            </p>
            {!island.unlocked && (
              <p className="mt-1 text-[10px] text-neutral-400">前の島で★3以上ためると解放</p>
            )}
          </Tag>
        );
      })}
    </div>
  );
}
