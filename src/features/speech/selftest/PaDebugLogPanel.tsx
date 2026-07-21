/**
 * PA診断ログの閲覧パネル（DESIGN.md §6a-2。M11補修・セルフテスト画面用）。
 *
 * iPhoneではconsoleが見られないため、発音評価（stream/batch）の実行経過・失敗理由を
 * このパネルで閲覧・コピーできるようにする（障害報告の一次情報）。
 * あわせて韻律の当日キャッシュ・セッションガードの現在値を表示し、
 * 切り分け用にセッションガードのリセットも行える。
 */

import { useCallback, useEffect, useState } from 'react';
import { getPaProsodyFallback } from '../azureSpeechConfig';
import { hasProsodyFailedInSession, resetProsodySessionGuard } from '../azurePaUnscripted';
import { clearPaDebugLog, readPaDebugLog } from '../paDebugLog';

export function PaDebugLogPanel() {
  const [lines, setLines] = useState<string[]>([]);
  const [prosodyCache, setProsodyCache] = useState<string>('読込中…');
  const [guardActive, setGuardActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLines(await readPaDebugLog());
    const cached = await getPaProsodyFallback();
    setProsodyCache(
      cached && typeof cached === 'object'
        ? JSON.stringify(cached)
        : 'なし（次の評価は韻律ありで試行）',
    );
    setGuardActive(hasProsodyFailedInSession());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setMessage('コピーしました。そのまま貼り付けて共有できます。');
    } catch {
      setMessage('コピーに失敗しました（テキストを長押しで選択してください）。');
    }
  };

  const clear = async () => {
    await clearPaDebugLog();
    setMessage('ログを消去しました。');
    await reload();
  };

  const resetGuard = () => {
    resetProsodySessionGuard();
    setMessage('セッションガードをリセットしました（次の評価は韻律ありで試行されます）。');
    void reload();
  };

  return (
    <section className="rounded-xl border border-neutral-200 p-3">
      <h2 className="text-sm font-bold text-neutral-800">6. 直近のPA診断ログ</h2>
      <p className="mt-1 text-xs text-neutral-500">
        発音評価の実行経過（最新{30}件）。遅い・失敗するときはこの内容をコピーして共有してください。
      </p>
      <p className="mt-1 text-[11px] text-neutral-500">
        韻律キャッシュ: {prosodyCache} ／ セッションガード: {guardActive ? '発動中（韻律なし直行）' : 'なし'}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600"
        >
          更新
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={lines.length === 0}
          className="rounded-full bg-hana-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          📋 コピー
        </button>
        <button
          type="button"
          onClick={() => void clear()}
          disabled={lines.length === 0}
          className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:opacity-50"
        >
          クリア
        </button>
        {guardActive && (
          <button
            type="button"
            onClick={resetGuard}
            className="rounded-full border border-yellow-400 bg-yellow-50 px-3 py-1.5 text-xs text-yellow-800"
          >
            ガードをリセット
          </button>
        )}
      </div>

      {message && <p className="mt-2 rounded-lg bg-green-50 px-2 py-1 text-xs text-green-700">{message}</p>}

      {lines.length > 0 ? (
        <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-neutral-50 p-2 text-[10px] leading-relaxed text-neutral-700">
          {lines.join('\n')}
        </pre>
      ) : (
        <p className="mt-2 text-xs text-neutral-400">
          まだログがありません。会話やキーフレーズ予習で発音評価を行うと記録されます。
        </p>
      )}
    </section>
  );
}
