/**
 * 使用量ダッシュボード（DESIGN.md §2・§12・設定画面M1）向けの集計純関数。
 * usageLogをそのまま画面に出すのではなく「当月分の抽出→合計→日別行への整形」をここに
 * 閉じ込め、UIコンポーネント（UsageDashboardSection.tsx）はIndexedDBアクセスと表示だけを担当する
 * （src/lib配下の純関数と同様Vitestで固定できるようにするため）。
 */

import { estimateMonthlyCostJpy } from '../../lib/usage/pricing';
import type { UsageDay } from '../../lib/types';

/** "YYYY-MM-DD" から月prefix "YYYY-MM" を取り出す純関数。 */
export function currentMonthPrefix(today: string): string {
  return today.slice(0, 7);
}

/** monthPrefix（例 "2026-07"）で始まる日付のレコードだけ残す。 */
export function filterUsageDaysForMonth(days: UsageDay[], monthPrefix: string): UsageDay[] {
  return days.filter((d) => d.date.startsWith(monthPrefix));
}

export interface DailyUsageRow {
  date: string;
  haikuCalls: number;
  sonnetCalls: number;
  jpy: number;
}

export interface MonthlyUsageSummary {
  totalCalls: number;
  totalHaikuCalls: number;
  totalSonnetCalls: number;
  totalJpy: number;
  /** 日付の新しい順（ダッシュボードの日別ミニ表用）。 */
  dailyRows: DailyUsageRow[];
}

/**
 * 当月分のusageLogレコードから、ダッシュボード表示用の集計を組み立てる。
 * 日別のjpyは1件ずつ estimateMonthlyCostJpy([day]) に通す
 * （按分ロジックの正本はpricing.tsに一本化し、ここで計算式を重複させないため）。
 */
export function summarizeMonthlyUsage(days: UsageDay[], usdJpy?: number): MonthlyUsageSummary {
  const totalHaikuCalls = days.reduce((sum, d) => sum + d.haikuCalls, 0);
  const totalSonnetCalls = days.reduce((sum, d) => sum + d.sonnetCalls, 0);
  const totalJpy = estimateMonthlyCostJpy(days, usdJpy).totalJpy;

  const dailyRows: DailyUsageRow[] = days
    .map((d) => ({
      date: d.date,
      haikuCalls: d.haikuCalls,
      sonnetCalls: d.sonnetCalls,
      jpy: estimateMonthlyCostJpy([d], usdJpy).totalJpy,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return {
    totalCalls: totalHaikuCalls + totalSonnetCalls,
    totalHaikuCalls,
    totalSonnetCalls,
    totalJpy,
    dailyRows,
  };
}
