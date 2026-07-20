import { useEffect, useState } from 'react';
import { learningDate } from '../../lib/dates';
import { getDB } from '../../lib/db';
import { currentMonthPrefix, filterUsageDaysForMonth, summarizeMonthlyUsage, type MonthlyUsageSummary } from './usageSummary';

/** 設定画面「使用量ダッシュボード」セクション（DESIGN.md §2・§12・M1）。 */
export function UsageDashboardSection() {
  const [summary, setSummary] = useState<MonthlyUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = await getDB();
        const all = await db.getAll('usageLog');
        const today = learningDate(new Date());
        const monthDays = filterUsageDaysForMonth(all, currentMonthPrefix(today));
        if (!cancelled) setSummary(summarizeMonthlyUsage(monthDays));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '使用量の読み込みに失敗しました');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!summary) return <p className="text-xs text-neutral-400">読み込み中…</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        金額はHaiku/Sonnetの呼び出し件数比で按分した概算です（正確なモデル別課金額ではありません）。
        Azure Speechは無料枠を前提に0円扱いです。
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-neutral-50 p-3">
          <p className="text-xs text-neutral-400">今月の概算</p>
          <p className="text-lg font-bold text-hana-600">¥{Math.round(summary.totalJpy).toLocaleString()}</p>
        </div>
        <div className="rounded-md bg-neutral-50 p-3">
          <p className="text-xs text-neutral-400">呼び出し回数</p>
          <p className="text-lg font-bold text-neutral-700">{summary.totalCalls}回</p>
        </div>
      </div>
      <p className="text-xs text-neutral-400">
        Haiku {summary.totalHaikuCalls}回・Sonnet {summary.totalSonnetCalls}回
      </p>

      {summary.dailyRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-neutral-400">
                <th className="py-1 pr-2 font-normal">日付</th>
                <th className="py-1 pr-2 text-right font-normal">Haiku</th>
                <th className="py-1 pr-2 text-right font-normal">Sonnet</th>
                <th className="py-1 text-right font-normal">概算円</th>
              </tr>
            </thead>
            <tbody>
              {summary.dailyRows.map((row) => (
                <tr key={row.date} className="border-t border-neutral-100 text-neutral-600">
                  <td className="py-1 pr-2">{row.date}</td>
                  <td className="py-1 pr-2 text-right">{row.haikuCalls}</td>
                  <td className="py-1 pr-2 text-right">{row.sonnetCalls}</td>
                  <td className="py-1 text-right">¥{Math.round(row.jpy).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-neutral-400">今月はまだ利用がありません。</p>
      )}
    </div>
  );
}
