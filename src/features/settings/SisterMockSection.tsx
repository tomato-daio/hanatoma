import { useEffect, useRef, useState } from 'react';
import { deleteAppState, getAppState, setAppState } from '../../lib/db';
import {
  parseSisterDataJson,
  resetSisterDataCache,
  SISTER_MOCK_DATA_APP_STATE_KEY,
  type SisterData,
} from '../sisterApp/shadotomaBridge';
import {
  collectPracticeDates,
  toSisterSubmissions,
  weakPhonemesFromSubmissions,
} from '../sisterApp/weaknessFromSubmissions';

/**
 * shadotomaのバックアップJSON（shadotoma設定画面のエクスポート）からSisterData相当を組み立てる。
 * バックアップの形は shadotoma src/lib/backup.ts の BackupBundle
 * （app:'shadotoma' / sessions / submissions。submissionsのjudge.azure.weakPhonemesはJSONに
 * そのまま入っている）。不正なファイルはnull。
 */
function buildSisterDataFromBackupJson(text: string): SisterData | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const bundle = data as Record<string, unknown>;
  if (bundle.app !== 'shadotoma') return null;
  if (!Array.isArray(bundle.sessions) || !Array.isArray(bundle.submissions)) return null;

  return {
    practiceDates: collectPracticeDates(bundle.sessions, bundle.submissions),
    weakPhonemes: weakPhonemesFromSubmissions(toSisterSubmissions(bundle.submissions)),
  };
}

/**
 * 設定画面の開発者セクション（DESIGN.md §11a・M8。import.meta.env.DEVのみ表示）。
 *
 * devのlocalhostではshadotomaのIndexedDBが存在しない（別オリジン）ため、shadotomaの
 * バックアップJSONを読み込んでSisterData相当を appState 'sisterMockData'（JSON文字列）に
 * 保存する。getSisterData()は本物のDBがnullのとき、DEVに限りこのモックを返す。
 */
export function SisterMockSection() {
  const [mock, setMock] = useState<SisterData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppState<string>(SISTER_MOCK_DATA_APP_STATE_KEY).then((raw) => {
      if (cancelled) return;
      setMock(typeof raw === 'string' ? parseSisterDataJson(raw) : null);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFile = async (file: File) => {
    setMessage(null);
    setError(null);
    try {
      const sisterData = buildSisterDataFromBackupJson(await file.text());
      if (!sisterData) {
        setError('シャドとまのバックアップファイルとして読み込めませんでした');
        return;
      }
      await setAppState(SISTER_MOCK_DATA_APP_STATE_KEY, JSON.stringify(sisterData));
      resetSisterDataCache();
      setMock(sisterData);
      setMessage('モックデータを保存しました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'モックデータの保存に失敗しました');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClear = async () => {
    setMessage(null);
    setError(null);
    try {
      await deleteAppState(SISTER_MOCK_DATA_APP_STATE_KEY);
      resetSisterDataCache();
      setMock(null);
      setMessage('モックデータをクリアしました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'クリアに失敗しました');
    }
  };

  if (!import.meta.env.DEV) return null;
  if (!loaded) return <p className="text-xs text-neutral-400">読み込み中…</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        開発用: シャドとまのバックアップJSONから連携データ（練習日・弱点音素）のモックを作ります。
        devサーバではシャドとまのDBを直接読めない（別オリジン）ため、本物の代わりにこのモックが使われます。
      </p>

      {mock ? (
        <div className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          <p>
            練習日: {mock.practiceDates.length}日
            {mock.practiceDates.length > 0
              ? `（最終 ${mock.practiceDates[mock.practiceDates.length - 1]}）`
              : ''}
          </p>
          <p>
            弱点音素:{' '}
            {mock.weakPhonemes.length > 0
              ? mock.weakPhonemes.map((wp) => `${wp.phoneme}(${Math.round(wp.avgScore)}点)`).join(' / ')
              : 'なし'}
          </p>
        </div>
      ) : (
        <p className="text-xs text-neutral-400">モックデータは未設定です。</p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">シャドとまのバックアップJSONを読み込む</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
          className="text-sm"
        />
      </label>

      <button
        type="button"
        onClick={() => void handleClear()}
        disabled={!mock}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 disabled:opacity-50"
      >
        モックデータをクリア
      </button>

      {message ? <p className="text-xs text-green-700">{message}</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
