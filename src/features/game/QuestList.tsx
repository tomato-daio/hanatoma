/**
 * デイリークエスト一覧（DESIGN.md §2, §10）。ホーム画面に3件のカードとして表示する。
 */

import type { SessionSummary } from './sessionSummary';

interface QuestListProps {
  quests: SessionSummary['questsAfter'];
}

export function QuestList({ quests }: QuestListProps) {
  if (quests.length === 0) {
    return <p className="text-xs text-neutral-400">今日のクエストはまだありません。</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {quests.map((quest) => {
        const percent = quest.target > 0 ? Math.min(100, Math.round((quest.progress / quest.target) * 100)) : 0;
        return (
          <div key={quest.id} className="rounded-xl border border-neutral-200 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-neutral-700">{quest.descriptionJa}</p>
              {quest.done && <span className="shrink-0 text-xs font-bold text-hana-600">達成✓</span>}
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-neutral-100">
              <div
                className={`h-2 rounded-full ${quest.done ? 'bg-hana-500' : 'bg-hana-300'}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs text-neutral-400">
              {quest.progress}/{quest.target}
            </p>
          </div>
        );
      })}
    </div>
  );
}
