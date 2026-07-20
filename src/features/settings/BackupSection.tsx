import { useRef, useState } from 'react';
import { buildBackupFileName, exportAllData, importAllData } from '../../lib/backup';

/** 設定画面「バックアップ」セクション（DESIGN.md §2・§0・M1）。 */
export function BackupSection() {
  const [includeAudio, setIncludeAudio] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const blob = await exportAllData({ includeAudio });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildBackupFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage('エクスポートしました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'エクスポートに失敗しました');
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    const confirmed = window.confirm(
      '現在のデータをすべて上書きして復元します。よろしいですか？（この操作は取り消せません）',
    );
    if (!confirmed) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      await importAllData(file);
      setMessage('復元しました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '復元に失敗しました');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        学習データ（会話記録・添削レポート・表現帳・進捗）は端末内(IndexedDB)にのみ保存され、外部へ送信されることはありません。
        APIキーはバックアップファイルに含まれません。
      </p>

      <label className="flex items-center gap-2 text-xs text-neutral-500">
        <input
          type="checkbox"
          checked={includeAudio}
          onChange={(e) => setIncludeAudio(e.target.checked)}
          className="h-4 w-4 accent-hana-500"
        />
        録音した音声も含める（ファイルサイズが大きくなります）
      </label>

      <button
        type="button"
        onClick={() => void handleExport()}
        disabled={exporting}
        className="rounded-md bg-hana-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {exporting ? '書き出し中…' : 'エクスポート（ダウンロード）'}
      </button>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">バックアップファイルから復元</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          disabled={importing}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportFile(file);
          }}
          className="text-sm"
        />
      </label>

      {message ? <p className="text-xs text-green-700">{message}</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
