import { useState } from 'react';
import { CorrectionReportView } from '../features/report/CorrectionReportView';
import { ExpressionNotebook } from '../features/report/ExpressionNotebook';

type ReportsTab = 'reports' | 'expressions';

/** レポート画面（DESIGN.md §2・M4）。添削レポート一覧/詳細と表現帳をタブで切り替える。 */
export function ReportsPage() {
  const [tab, setTab] = useState<ReportsTab>('reports');

  return (
    <div className="flex flex-col gap-3 p-4 pb-8">
      <h1 className="text-lg font-bold text-neutral-800">レポート</h1>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('reports')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
            tab === 'reports' ? 'bg-hana-500 text-white' : 'bg-neutral-100 text-neutral-500'
          }`}
        >
          添削レポート
        </button>
        <button
          type="button"
          onClick={() => setTab('expressions')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
            tab === 'expressions' ? 'bg-hana-500 text-white' : 'bg-neutral-100 text-neutral-500'
          }`}
        >
          表現帳
        </button>
      </div>

      {tab === 'reports' ? <CorrectionReportView /> : <ExpressionNotebook />}
    </div>
  );
}
