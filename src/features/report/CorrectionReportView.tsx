/**
 * 添削レポート一覧/詳細（DESIGN.md §2・§7b・M4）。
 * 一覧: listCorrectionReports(日付・シナリオ名)。詳細: ターン別添削・CEFRリフレーズ・
 * 発音コメント・総評。「シャドとまで練習する」はボタンの場所だけ用意し、結線はM8担当が行う。
 */

import { useEffect, useState } from 'react';
import { getConversation, listCorrectionReports } from '../../lib/db';
import type { CorrectionItem, CorrectionReport } from '../../lib/types';
import { getScenarioById } from '../scenarios/loadScenarios';

interface ReportRow {
  report: CorrectionReport;
  scenarioTitleJa: string;
}

const KIND_LABEL_JA: Record<CorrectionItem['kind'], string> = {
  grammar: '文法',
  'word-choice': '語彙選択',
  naturalness: '自然さ',
  expression: '表現',
};

export function CorrectionReportView() {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CorrectionReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const reports = await listCorrectionReports();
        const withScenario = await Promise.all(
          reports.map(async (report): Promise<ReportRow> => {
            const conversation = await getConversation(report.conversationId);
            const scenario = conversation ? await getScenarioById(conversation.scenarioId) : undefined;
            return { report, scenarioTitleJa: scenario?.titleJa ?? '(シナリオ不明)' };
          }),
        );
        if (!cancelled) setRows(withScenario);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'レポートの読み込みに失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!rows) return <p className="text-xs text-neutral-400">読み込み中…</p>;

  if (selected) {
    return <CorrectionReportDetail report={selected} onBack={() => setSelected(null)} />;
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        まだ添削レポートがありません。レッスンを完了すると、ここに表示されます。
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map(({ report, scenarioTitleJa }) => (
        <li key={report.id}>
          <button
            type="button"
            onClick={() => setSelected(report)}
            className="w-full rounded-xl border border-neutral-200 p-3 text-left"
          >
            <p className="text-sm font-semibold text-neutral-800">{scenarioTitleJa}</p>
            <p className="mt-0.5 text-xs text-neutral-400">{report.date}</p>
            <p className="mt-1 line-clamp-2 text-xs text-neutral-600">{report.summaryJa}</p>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CorrectionReportDetail({ report, onBack }: { report: CorrectionReport; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="w-fit text-xs font-medium text-hana-600">
        ← 一覧に戻る
      </button>

      <section>
        <h2 className="text-sm font-semibold text-neutral-800">総評</h2>
        <p className="mt-1 text-sm text-neutral-700">{report.summaryJa}</p>
      </section>

      {report.items.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-neutral-800">ターン別添削</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {report.items.map((item, i) => (
              <li key={i} className="rounded-lg bg-neutral-50 p-3">
                <span className="inline-block rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">
                  ターン{item.turnIndex + 1}・{KIND_LABEL_JA[item.kind]}
                </span>
                <p className="mt-1.5 text-sm text-neutral-400 line-through">{item.original}</p>
                <p className="text-sm font-medium text-green-700">{item.corrected}</p>
                <p className="mt-1 text-xs text-neutral-500">{item.explanationJa}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.rephrases.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-neutral-800">言い換え例</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {report.rephrases.map((r, i) => (
              <li key={i} className="rounded-lg border border-neutral-200 p-3 text-sm">
                <p className="text-xs text-neutral-400">ターン{r.turnIndex + 1}</p>
                <p className="mt-1">
                  <span className="text-xs font-semibold text-hana-500">レベルアップ表現: </span>
                  {r.levelUp}
                </p>
                <p className="mt-1">
                  <span className="text-xs font-semibold text-hana-700">ネイティブ表現: </span>
                  {r.native}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.pronunciationComments.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold text-neutral-800">発音のポイント</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-neutral-700">
            {report.pronunciationComments.map((comment, i) => (
              <li key={i}>{comment}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 「シャドとまで練習する」はM8担当がexportToShadotoma.tsと結線する。ここではボタンの場所だけ用意する。 */}
      <button
        type="button"
        disabled
        title="連携準備中（M8で実装予定）"
        className="rounded-xl bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-400"
      >
        シャドとまで練習する
      </button>
    </div>
  );
}
