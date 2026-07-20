import { useEffect, useState } from 'react';
import { getAppState, setAppState } from '../../lib/db';
import { getSharedAudioContext } from '../recorder/useRecorder';
import { getAzureSpeechKey, getAzureSpeechRegion } from '../speech/azureSpeechConfig';
import { synthesize } from '../speech/azureTts';
import { fetchVoices, type VoiceListItem } from '../speech/voiceList';

/** appState保存キー（DESIGN.md §3 appStateキー一覧）。 */
export const TTS_VOICE_APP_STATE_KEY = 'ttsVoice';
/** 初期値（DESIGN.md §6c）。 */
export const DEFAULT_TTS_VOICE = 'en-US-JennyNeural';

const PREVIEW_TEXT = 'Hello! This is a preview of the AI voice.';
/** 試聴はレベル1相当の等速（rate=0%）で固定する。レベル別rateは会話中のTTSでのみ使う。 */
const PREVIEW_RATE = '0%';

/** 設定画面「AI音声選択」セクション（DESIGN.md §2・§6c・M1）。 */
export function VoiceSection() {
  const [hasAzureKey, setHasAzureKey] = useState(false);
  const [voices, setVoices] = useState<VoiceListItem[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState(DEFAULT_TTS_VOICE);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAzureSpeechKey().then((key) => {
      if (!cancelled) setHasAzureKey(Boolean(key));
    });
    void getAppState<string>(TTS_VOICE_APP_STATE_KEY).then((saved) => {
      if (!cancelled && saved) setSelectedVoice(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoadVoices = async () => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const key = await getAzureSpeechKey();
      if (!key) {
        setVoicesError('先にAzure Speechのキーを設定してください。');
        return;
      }
      const region = await getAzureSpeechRegion();
      const list = await fetchVoices(key, region);
      setVoices(list);
    } catch (err) {
      setVoicesError(err instanceof Error ? err.message : '音声一覧の取得に失敗しました');
    } finally {
      setLoadingVoices(false);
    }
  };

  const handleSelect = async (shortName: string) => {
    setSelectedVoice(shortName);
    await setAppState(TTS_VOICE_APP_STATE_KEY, shortName);
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const buffer = await synthesize(PREVIEW_TEXT, { voice: selectedVoice, rate: PREVIEW_RATE });
      const ctx = getSharedAudioContext();
      try {
        await ctx.resume();
      } catch {
        // resume失敗は致命的にしない（iOSの一部状況でスキップされても再生自体は試みる）
      }
      // decodeAudioDataは渡したArrayBufferをdetachしうるため、コピーを渡す
      // （azureTts.tsのキャッシュ内部バッファをこの呼び出しで空にしないため）。
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '試聴の再生に失敗しました');
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">会話中に読み上げるAI音声の声を選べます（en-US Neural音声のみ）。</p>

      <button
        type="button"
        onClick={() => void handleLoadVoices()}
        disabled={loadingVoices}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600 disabled:opacity-50"
      >
        {loadingVoices ? '取得中…' : '音声一覧を取得'}
      </button>
      {voicesError ? <p className="text-xs text-red-600">{voicesError}</p> : null}

      {voices.length > 0 ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">声</span>
          <select
            value={selectedVoice}
            onChange={(e) => void handleSelect(e.target.value)}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
          >
            {voices.map((v) => (
              <option key={v.shortName} value={v.shortName}>
                {v.localName}（{v.gender}）
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {hasAzureKey ? (
        <>
          <button
            type="button"
            onClick={() => void handlePreview()}
            disabled={previewing}
            className="rounded-md bg-hana-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {previewing ? '再生中…' : '試聴する'}
          </button>
          {previewError ? <p className="text-xs text-red-600">{previewError}</p> : null}
        </>
      ) : (
        <p className="text-xs text-neutral-400">Azure Speechのキーを設定すると試聴できます。</p>
      )}
    </div>
  );
}
