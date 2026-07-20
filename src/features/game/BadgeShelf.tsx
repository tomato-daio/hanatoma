/**
 * バッジ棚（DESIGN.md §10）。
 * badges.ts が返すid体系（category-<category> / streak-7|30|100 / expressions-50 / boss-first-win）と
 * 1:1で一致するカタログ定数を持ち、獲得済み(カラー)/未獲得(グレー)の棚UIとして描画する。
 */

import { CATEGORY_META } from './ScenarioMap';
import type { ScenarioCategory } from '../../lib/types';

export interface BadgeDef {
  id: string;
  emoji: string;
  name: string;
  descriptionJa: string;
}

const CATEGORY_BADGES: BadgeDef[] = (Object.keys(CATEGORY_META) as ScenarioCategory[]).map((category) => ({
  id: `category-${category}`,
  emoji: CATEGORY_META[category].emoji,
  name: `${CATEGORY_META[category].labelJa}マスター`,
  descriptionJa: `${CATEGORY_META[category].labelJa}カテゴリのシナリオを5本完了した`,
}));

/** badges.ts の id 体系と一致させたバッジカタログ（音素克服バッジはM8で追加予定・現時点では未実装）。 */
export const BADGE_CATALOG: readonly BadgeDef[] = [
  ...CATEGORY_BADGES,
  { id: 'streak-7', emoji: '🔥', name: '7日継続', descriptionJa: '7日連続で練習した' },
  { id: 'streak-30', emoji: '🔥', name: '30日継続', descriptionJa: '30日連続で練習した' },
  { id: 'streak-100', emoji: '🔥', name: '100日継続', descriptionJa: '100日連続で練習した' },
  { id: 'expressions-50', emoji: '📚', name: '表現コレクター', descriptionJa: '表現帳に50語登録した' },
  { id: 'boss-first-win', emoji: '🏆', name: 'ボス初勝利', descriptionJa: '週末ボスに初めて勝利した' },
];

export function getBadgeDef(id: string): BadgeDef | undefined {
  return BADGE_CATALOG.find((b) => b.id === id);
}

interface BadgeShelfProps {
  earnedBadgeIds: string[];
}

export function BadgeShelf({ earnedBadgeIds }: BadgeShelfProps) {
  const earned = new Set(earnedBadgeIds);

  return (
    <div className="grid grid-cols-4 gap-2">
      {BADGE_CATALOG.map((badge) => {
        const isEarned = earned.has(badge.id);
        return (
          <div
            key={badge.id}
            title={badge.descriptionJa}
            className={`flex flex-col items-center rounded-lg p-2 text-center ${
              isEarned ? 'bg-hana-50' : 'bg-neutral-100 opacity-60 grayscale'
            }`}
          >
            <span className="text-2xl" aria-hidden="true">
              {badge.emoji}
            </span>
            <span className={`mt-1 text-[10px] ${isEarned ? 'font-semibold text-hana-700' : 'text-neutral-400'}`}>
              {badge.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
