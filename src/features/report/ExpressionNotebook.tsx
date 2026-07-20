/**
 * 表現帳（DESIGN.md §2・§3 ExpressionItem・M4）。一覧表示と削除のみ。
 * 追加はgenerateReport.tsが添削レポート保存時に行うため、ここでは行わない。
 */

import { useEffect, useState } from 'react';
import { deleteExpression, listExpressions } from '../../lib/db';
import type { ExpressionItem } from '../../lib/types';

export function ExpressionNotebook() {
  const [items, setItems] = useState<ExpressionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setItems(await listExpressions());
    } catch (err) {
      setError(err instanceof Error ? err.message : '表現帳の読み込みに失敗しました。');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleDelete(id: string) {
    await deleteExpression(id);
    await reload();
  }

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!items) return <p className="text-xs text-neutral-400">読み込み中…</p>;
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        まだ表現が登録されていません。レッスン後の添削で覚えた表現がここに追加されます。
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id} className="rounded-xl border border-neutral-200 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-neutral-800">{item.en}</p>
              <p className="text-xs text-neutral-500">{item.ja}</p>
              {item.note ? <p className="mt-1 text-xs text-neutral-400">{item.note}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => void handleDelete(item.id)}
              className="shrink-0 text-xs text-neutral-400"
            >
              削除
            </button>
          </div>
          {item.useCount > 0 ? <p className="mt-1 text-[10px] text-hana-600">使用 {item.useCount}回</p> : null}
        </li>
      ))}
    </ul>
  );
}
