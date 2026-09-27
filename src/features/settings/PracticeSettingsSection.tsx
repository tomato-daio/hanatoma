import { useEffect, useState } from 'react';
import { getAppState, setAppState } from '../../lib/db';
import { DEFAULT_DAILY_CAPS, type DailyCaps } from '../../lib/types';
import {
  END_OF_TURN_PATIENCE_APP_STATE_KEY,
  parsePatience,
  type EndOfTurnPatience,
} from '../conversation/live/endOfTurn';
import { MIC_MODE_APP_STATE_KEY, parseMicMode, type MicMode } from '../recorder/micSession';

/** appState保存キー（DESIGN.md §3 appStateキー一覧）。 */
export const SAVE_TURN_AUDIO_APP_STATE_KEY = 'saveTurnAudio';
export const DAILY_CAPS_APP_STATE_KEY = 'dailyCaps';

type DailyCapField = keyof DailyCaps;

const CAP_FIELDS: { key: DailyCapField; label: string }[] = [
  { key: 'sessions', label: '1日のセッション数' },
  { key: 'sonnetCalls', label: '1日のSonnet添削回数' },
  { key: 'paMinutes', label: '1日の音声認識・発音評価（分）' },
];

const PATIENCE_OPTIONS: { value: EndOfTurnPatience; label: string }[] = [
  { value: 'short', label: '短め（テンポ重視）' },
  { value: 'normal', label: '標準' },
  { value: 'long', label: '長め（考えながら話す）' },
  { value: 'manual', label: '手動（「送信」をタップ）' },
];

const MIC_MODE_OPTIONS: { value: MicMode; label: string }[] = [
  { value: 'perTurn', label: '聞き取り中だけ使う（おすすめ）' },
  { value: 'keepOpen', label: '会話中ずっと使う（実験）' },
];

/**
 * 設定画面「練習設定」セクション（DESIGN.md §2・§12・M1）。
 * 話し終わりの待ち時間・会話中のマイク方式（M13）、ターン音声保存ON/OFF、日次キャップ編集。
 */
export function PracticeSettingsSection() {
  const [loaded, setLoaded] = useState(false);
  const [saveTurnAudio, setSaveTurnAudio] = useState(true);
  const [caps, setCaps] = useState<DailyCaps>(DEFAULT_DAILY_CAPS);
  const [capsSaved, setCapsSaved] = useState(false);
  const [patience, setPatience] = useState<EndOfTurnPatience>('normal');
  const [micMode, setMicMode] = useState<MicMode>('perTurn');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getAppState<boolean>(SAVE_TURN_AUDIO_APP_STATE_KEY),
      getAppState<DailyCaps>(DAILY_CAPS_APP_STATE_KEY),
      getAppState(END_OF_TURN_PATIENCE_APP_STATE_KEY),
      getAppState(MIC_MODE_APP_STATE_KEY),
    ]).then(([savedFlag, savedCaps, savedPatience, savedMicMode]) => {
      if (cancelled) return;
      setSaveTurnAudio(savedFlag ?? true);
      setCaps(savedCaps ?? DEFAULT_DAILY_CAPS);
      setPatience(parsePatience(savedPatience));
      setMicMode(parseMicMode(savedMicMode));
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

  const handlePatience = async (value: EndOfTurnPatience) => {
    setPatience(value);
    await setAppState(END_OF_TURN_PATIENCE_APP_STATE_KEY, value);
  };

  const handleMicMode = async (value: MicMode) => {
    setMicMode(value);
    await setAppState(MIC_MODE_APP_STATE_KEY, value);
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
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">
          話し終わりの待ち時間
          <span className="mt-0.5 block text-xs text-neutral-400">
            話すのをやめてから、AIへ送るまでの待ち時間です。考えている途中で送られてしまうなら「長め」に。
          </span>
        </span>
        <select
          value={patience}
          onChange={(e) => void handlePatience(e.target.value as EndOfTurnPatience)}
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-700"
        >
          {PATIENCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">
          会話中のマイク
          <span className="mt-0.5 block text-xs text-neutral-400">
            「ずっと使う」は毎回のマイク準備を省けますが、iPhoneではAIの声が小さくなることがあります。
          </span>
        </span>
        <select
          value={micMode}
          onChange={(e) => void handleMicMode(e.target.value as MicMode)}
          className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-700"
        >
          {MIC_MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

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
