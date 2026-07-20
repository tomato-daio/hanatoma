import { useEffect, useState } from 'react';
import { LEVEL_PARAMS } from '../../../lib/level/params';
import { getSharedAudioContext } from '../../recorder/useRecorder';
import { getAzureSpeechKey, getAzureSpeechRegion } from '../azureSpeechConfig';
import { synthesize } from '../azureTts';
import { fetchVoices, type VoiceListItem } from '../voiceList';

/** appState未設定時の既定音声（DESIGN.md §6c）。 */
const DEFAULT_VOICE = 'en-US-JennyNeural';

/** §8dレベル別ttsRateの重複を除いたプリセット一覧（-25%〜0%）。 */
const RATE_PRESETS = Array.from(new Set(Object.values(LEVEL_PARAMS).map((p) => p.ttsRate)));

type Status = 'idle' | 'loading-voices' | 'ready' | 'synthesizing' | 'error';

interface TtsTestState {
  status: Status;
  voices: VoiceListItem[];
  voice: string;
  rate: string;
  text: string;
  errorMessage: string | null;
  latencyMs: number | null;
}

/**
 * TTSテストセクション（DESIGN.md M2手順4）。
 * synthesizeが返すMP3(ArrayBuffer)を、会話画面と同じ統一AudioContext（useRecorder.tsの
 * getSharedAudioContext）でdecodeAudioData→再生する（iOSオーディオセッション競合を避ける方針の検証）。
 * 音声一覧はAzureキー設定済みの場合のみvoices/list RESTから取得し、未取得時は既定音声名の
 * テキスト入力にフォールバックする（voiceList.ts参照。ハードコード一覧は持たない）。
 */
export function TtsTestPanel() {
  const [state, setState] = useState<TtsTestState>({
    status: 'idle',
    voices: [],
    voice: DEFAULT_VOICE,
    rate: RATE_PRESETS[RATE_PRESETS.length - 1] ?? '0%',
    text: 'Hello! How was your day today?',
    errorMessage: null,
    latencyMs: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const key = await getAzureSpeechKey();
      if (!key || cancelled) return;
      setState((s) => ({ ...s, status: 'loading-voices' }));
      try {
        const region = await getAzureSpeechRegion();
        const voices = await fetchVoices(key, region);
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: 'ready',
          voices,
          voice: voices.find((v) => v.shortName === DEFAULT_VOICE)?.shortName ?? voices[0]?.shortName ?? s.voice,
        }));
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePlay = async () => {
    setState((s) => ({ ...s, status: 'synthesizing', errorMessage: null }));
    const t0 = performance.now();
    try {
      const audioData = await synthesize(state.text, { voice: state.voice, rate: state.rate });
      const latencyMs = Math.round(performance.now() - t0);
      const audioCtx = getSharedAudioContext();
      try {
        await audioCtx.resume();
      } catch {
        // resume失敗は致命的にしない（useRecorder.tsと同じ方針）。
      }
      const audioBuffer = await audioCtx.decodeAudioData(audioData);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start();
      setState((s) => ({ ...s, status: 'ready', latencyMs }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const isBusy = state.status === 'synthesizing' || state.status === 'loading-voices';

  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <h2 className="text-sm font-semibold text-neutral-700">4. TTSテスト</h2>
      <textarea
        value={state.text}
        onChange={(e) => setState((s) => ({ ...s, text: e.target.value }))}
        rows={2}
        className="mt-2 w-full rounded border border-neutral-300 p-2 text-sm text-neutral-800"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {state.voices.length > 0 ? (
          <select
            value={state.voice}
            onChange={(e) => setState((s) => ({ ...s, voice: e.target.value }))}
            className="rounded border border-neutral-300 p-1 text-sm"
          >
            {state.voices.map((v) => (
              <option key={v.shortName} value={v.shortName}>
                {v.localName} ({v.gender})
              </option>
            ))}
          </select>
        ) : (
          <input
            value={state.voice}
            onChange={(e) => setState((s) => ({ ...s, voice: e.target.value }))}
            placeholder="例: en-US-JennyNeural"
            className="rounded border border-neutral-300 p-1 text-sm"
          />
        )}
        <select
          value={state.rate}
          onChange={(e) => setState((s) => ({ ...s, rate: e.target.value }))}
          className="rounded border border-neutral-300 p-1 text-sm"
        >
          {RATE_PRESETS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handlePlay()}
          disabled={isBusy || state.text.trim() === ''}
          className="rounded-md bg-hana-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
        >
          {state.status === 'synthesizing' ? '合成中…' : '再生'}
        </button>
      </div>
      {state.status === 'loading-voices' ? <p className="mt-2 text-xs text-neutral-400">音声一覧を取得中…</p> : null}
      {state.latencyMs !== null ? (
        <p className="mt-2 text-xs text-neutral-500">合成レイテンシ: {state.latencyMs}ms</p>
      ) : null}
      {state.errorMessage ? <p className="mt-2 text-xs text-red-600">エラー: {state.errorMessage}</p> : null}
    </section>
  );
}
