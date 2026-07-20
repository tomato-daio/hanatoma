/**
 * レッスン総合スコア(composite)から★評価への変換（DESIGN.md §10: 50/70/85 → ★1/2/3）。
 * compositeはlib/level/metrics.tsが算出する0-100の値を想定。
 */

export function starsFromComposite(composite: number): 0 | 1 | 2 | 3 {
  if (composite >= 85) return 3;
  if (composite >= 70) return 2;
  if (composite >= 50) return 1;
  return 0;
}
