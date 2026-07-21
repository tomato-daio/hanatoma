/**
 * 昇格プログレス表示（DESIGN.md §8d）。「現レベル以上の直近レッスンで75点以上が何回か」を
 * ドット＋一文で示し、「いつレベルが上がるか」を可視化する。式（重み）は出さず結果のみ。
 * データは computePromoteProgress（純関数）→ loadPromoteProgress（会話履歴から組み立て）で得る。
 */

import type { PromoteProgress } from '../../lib/level/progress';

export function LevelUpProgress({
  progress,
  className = '',
}: {
  progress: PromoteProgress;
  className?: string;
}) {
  const { isMaxLevel, slots, windowSize, hits, needed, threshold, remaining } = progress;

  if (isMaxLevel) {
    return <p className={`text-xs text-neutral-500 ${className}`}>最高レベルに到達しています 🎉</p>;
  }

  const windowFull = windowSize >= slots;
  const message =
    remaining === 0
      ? '昇格条件を満たしています。次の採点レッスンでレベルアップします 🎉'
      : windowFull
        ? `直近${slots}回中${hits}回が${threshold}点以上。あと${needed - hits}回でレベルアップ`
        : `現レベル以上のレッスンをあと${slots - windowSize}回こなすと昇格判定が始まります（${threshold}点以上を${needed}回で昇格）`;

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5" aria-label={`昇格まで ${hits}/${needed}`}>
        {Array.from({ length: slots }).map((_, i) => {
          const evaluated = i < windowSize;
          const lit = i < hits; // 点灯数＝直近窓での75点以上の件数（件数の可視化が目的）
          return (
            <span
              key={i}
              className={`h-3 w-3 rounded-full ${
                lit ? 'bg-hana-500' : evaluated ? 'bg-neutral-300' : 'border border-dashed border-neutral-300'
              }`}
            />
          );
        })}
        <span className="ml-1 text-xs font-semibold text-neutral-500">
          {hits}/{needed}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-500">{message}</p>
    </div>
  );
}
