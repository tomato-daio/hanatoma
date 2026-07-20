import { useEffect, useState } from 'react';
import { getAppState, setAppState } from '../../lib/db';
import { DEFAULT_DAILY_CAPS, type DailyCaps } from '../../lib/types';

/** appState保存キー（DESIGN.md §3 appStateキー一覧）。 */
export const SAVE_TURN_AUDIO_APP_STATE_KEY = 'saveTurnAudio';
export const DAILY_CAPS_APP_STATE_KEY = 'dailyCaps';

type DailyCapField = keyof DailyCaps;

const CAP_FIELDS: { key: DailyCapField; label: string }[] = [
  { key: 'sessions', label: '1日のセッション数' },
  { key: 'sonnetCalls', label: '1日のSonnet添削回数' },
  { key: 'paMinutes', label: '1日の発音評価（分）' },
];

/** 設定画面「練習設定」セクション（DESIGN.md §2・§12・M1）。ターン音声保存ON/OFFと日次キャップ編集。 */
export function PracticeSettingsSection() {
  const [loaded, setLoaded] = useState(false);
  const [saveTurnAudio, setSaveTurnAudio] = useState(true);
  const [caps, setCaps] = useState<DailyCaps>(DEFAULT_DAILY_CAPS);
  const [capsSaved, setCapsSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getAppState<boolean>(SAVE_TURN_AUDIO_APP_STATE_KEY),
      getAppState<DailyCaps>(DAILY_CAPS_APP_STATE_KEY),
    ]).then(([savedFlag, savedCaps]) => {
      if (cancelled) return;
      setSaveTurnAudio(savedFlag ?? true);
      setCaps(savedCaps ?? DEFAULT_DAILY_CAPS);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleSaveAudio = async () => {
    const next = !saveTurnAudio;
    setSaveTurnAudio(next);
    await setAppState(SAVE_TURN_AUDIO_APP_STATE_KEY, next);
  };

  const handleCapInput = (field: DailyCapField, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    setCaps((prev) => ({ ...prev, [field]: Math.floor(n) }));
    setCapsSaved(false);
  };

  const handleSaveCaps = async () => {
    await setAppState(DAILY_CAPS_APP_STATE_KEY, caps);
    setCapsSaved(true);
  };

  const handleResetCaps = async () => {
    setCaps(DEFAULT_DAILY_CAPS);
    await setAppState(DAILY_CAPS_APP_STATE_KEY, DEFAULT_DAILY_CAPS);
    setCapsSaved(true);
  };

  if (!loaded) return <p className="text-xs text-neutral-400">読み込み中…</p>;

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-neutral-600">
          ターンの音声を保存する
          <span className="mt-0.5 block text-xs text-neutral-400">
            OFFにすると振り返り再生はできなくなりますが、端末の保存容量を節約できます。
          </span>
        </span>
        <input
          type="checkbox"
          checked={saveTurnAudio}
          onChange={() => void handleToggleSaveAudio()}
          className="h-5 w-5 shrink-0 accent-hana-500"
        />
      </label>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-neutral-600">日次キャップ（コスト暴走防止）</p>
        {CAP_FIELDS.map((field) => (
          <label key={field.key} className="flex items-center justify-between gap-2 text-xs text-neutral-500">
            <span>{field.label}</span>
            <input
              type="number"
              min={0}
              value={caps[field.key]}
              onChange={(e) => handleCapInput(field.key, e.target.value)}
              className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-right text-sm text-neutral-700"
            />
          </label>
        ))}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSaveCaps()}
            className="flex-1 rounded-md bg-hana-500 px-3 py-2 text-sm font-semibold text-white"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => void handleResetCaps()}
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600"
          >
            初期値に戻す
          </button>
        </div>
        {capsSaved ? <p className="text-xs text-green-700">保存しました。</p> : null}
      </div>
    </div>
  );
}
