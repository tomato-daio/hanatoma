import { useEffect, useState } from 'react';
import { testConnection } from '../llm/anthropicClient';
import { clearAnthropicApiKey, getAnthropicApiKey, setAnthropicApiKey } from './anthropicKeyConfig';

/** 設定画面「Anthropic API設定」セクション（DESIGN.md §2・§7c・M1）。 */
export function AnthropicSection() {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; messageJa: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAnthropicApiKey().then((key) => {
      if (cancelled) return;
      if (key) {
        setApiKeyInput(key);
        setConfigured(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const key = apiKeyInput.trim();
    if (!key) {
      setStatus({ ok: false, messageJa: 'APIキーを入力してください。' });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await setAnthropicApiKey(key);
      setConfigured(true);
      setStatus({ ok: true, messageJa: '保存しました。' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setStatus(null);
    try {
      setStatus(await testConnection(apiKeyInput.trim()));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('保存済みのAnthropic APIキーを削除します。よろしいですか？')) return;
    await clearAnthropicApiKey();
    setApiKeyInput('');
    setConfigured(false);
    setStatus({ ok: true, messageJa: '削除しました。以降は会話・添削が利用できません。' });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        会話パートナー（Haiku）と精密添削（Sonnet）に使います。キーはこの端末内にのみ保存され、外部やバックアップファイルには含まれません。
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">APIキー</span>
        <input
          type="password"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder="sk-ant-... を貼り付け"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          autoComplete="off"
        />
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

      {status ? (
        <p className={`text-xs ${status.ok ? 'text-green-700' : 'text-red-600'}`}>{status.messageJa}</p>
      ) : null}

      <details className="rounded-md border border-neutral-200 p-3 text-xs text-neutral-500">
        <summary className="cursor-pointer text-sm font-medium text-neutral-600">キーの取得方法</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>ブラウザで console.anthropic.com を開き、Anthropicアカウントでログインします。</li>
          <li>左メニューの「API Keys」を開きます。</li>
          <li>「Create Key」でキーを新規作成し、表示された文字列をコピーします（再表示できないため必ず控えてください）。</li>
        </ol>
        <p className="mt-2">
          利用は従量課金です（クレジットカードの登録が必要）。はなとまの通常利用（1日1〜3セッション程度）なら、
          月あたりの目安は概ね500円程度です。使いすぎ防止として、下の「練習設定」で日次キャップも変更できます。
        </p>
      </details>
    </div>
  );
}
