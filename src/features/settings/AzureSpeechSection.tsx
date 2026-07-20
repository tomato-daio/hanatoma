import { useEffect, useState } from 'react';
import {
  AZURE_REGION_OPTIONS,
  clearAzureSpeechCredentials,
  DEFAULT_AZURE_REGION,
  getAzureSpeechKey,
  getAzureSpeechRegion,
  setAzureSpeechCredentials,
  testAzureSpeechConnection,
} from '../speech/azureSpeechConfig';

/** 設定画面「Azure Speech設定」セクション（DESIGN.md §2・§6・M1）。 */
export function AzureSpeechSection() {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [regionInput, setRegionInput] = useState(DEFAULT_AZURE_REGION);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAzureSpeechKey(), getAzureSpeechRegion()]).then(([key, region]) => {
      if (cancelled) return;
      if (key) {
        setApiKeyInput(key);
        setConfigured(true);
      }
      setRegionInput(region);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const key = apiKeyInput.trim();
    if (!key) {
      setStatus({ ok: false, message: 'APIキーを入力してください。' });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await setAzureSpeechCredentials(key, regionInput);
      setConfigured(true);
      setStatus({ ok: true, message: '保存しました。' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setStatus(null);
    try {
      setStatus(await testAzureSpeechConnection(apiKeyInput.trim(), regionInput));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('保存済みのAzure Speech設定を削除します。よろしいですか？')) return;
    await clearAzureSpeechCredentials();
    setApiKeyInput('');
    setRegionInput(DEFAULT_AZURE_REGION);
    setConfigured(false);
    setStatus({ ok: true, message: '削除しました。以降は発音評価・AI音声が利用できません。' });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        発音評価（発音スコア）とAI音声の読み上げに使います。キーはこの端末内にのみ保存され、外部やバックアップファイルには含まれません。
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">APIキー</span>
        <input
          type="password"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder="Azure Speechのキー1を貼り付け"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          autoComplete="off"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">リージョン</span>
        <select
          value={regionInput}
          onChange={(e) => setRegionInput(e.target.value)}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          {AZURE_REGION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex-1 rounded-md bg-hana-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing || !apiKeyInput.trim()}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 disabled:opacity-50"
        >
          {testing ? '接続テスト中…' : '接続テスト'}
        </button>
      </div>

      {configured ? (
        <button
          type="button"
          onClick={() => void handleDelete()}
          className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 active:bg-red-50"
        >
          削除
        </button>
      ) : null}

      {status ? <p className={`text-xs ${status.ok ? 'text-green-700' : 'text-red-600'}`}>{status.message}</p> : null}
    </div>
  );
}
