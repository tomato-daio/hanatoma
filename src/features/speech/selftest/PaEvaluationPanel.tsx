import { useState } from 'react';
import { decodeToMono16k } from '../../../lib/audio';
import { encodeWavPcm16 } from '../../../lib/wav';
import type { RecordingResult } from '../../recorder/useRecorder';
import { assessSpeech, type AssessSpeechResult } from '../azurePaUnscripted';
import { formatLatencyStages, type LatencyStage } from './latencyLog';
import { PaResultView } from './PaResultView';

export interface PaEvaluationPanelProps {
  title: string;
  mode: 'unscripted' | 'scripted';
  /** 1で録音した最新の結果。nullの間は評価ボタンを無効化する。 */
  recording: RecordingResult | null;
}

/** scriptedモードの参照文入力欄の既定値（DESIGN.md M2手順3指定）。 */
const DEFAULT_REFERENCE_TEXT = 'The quick brown fox jumps over the lazy dog.';

type Status = 'idle' | 'running' | 'done' | 'error';

/**
 * 発音評価テストセクション（DESIGN.md M2手順2 unscripted / 手順3 scripted）。
 * 手順5の「各段階の所要ms」ログのため、WAV変換→PA応答の区間ごとに計測してformatLatencyStagesで表示する。
 * unscripted/scriptedはモード切替だけで挙動を共有できるため1コンポーネントにまとめている。
 */
export function PaEvaluationPanel({ title, mode, recording }: PaEvaluationPanelProps) {
  const [referenceText, setReferenceText] = useState(DEFAULT_REFERENCE_TEXT);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<AssessSpeechResult | null>(null);
  const [stages, setStages] = useState<LatencyStage[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canRun = recording !== null && (mode === 'unscripted' || referenceText.trim() !== '');

  const run = async () => {
    if (!recording) return;
    setStatus('running');
    setErrorMessage(null);
    setResult(null);
    setStages([]);
    const t0 = performance.now();
    try {
      const pcm = await decodeToMono16k(recording.blob);
      const wavBuffer = encodeWavPcm16(pcm);
      const t1 = performance.now();
      const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      const res = await assessSpeech(
        wavBlob,
        mode === 'scripted' ? { mode, referenceText: referenceText.trim() } : { mode },
      );
      const t2 = performance.now();
      setStages([
        { label: 'WAV変換', ms: Math.round(t1 - t0) },
        { label: 'PA応答', ms: Math.round(t2 - t1) },
      ]);
      setResult(res);
      if (res.pa.azureError) {
        setStatus('error');
        setErrorMessage(res.pa.azureError);
      } else {
        setStatus('done');
      }
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // azureErrorはPaResultView側でも表示するため、二重表示を避ける。
  const showStandaloneError = status === 'error' && errorMessage !== null && !result?.pa.azureError;

  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <h2 className="text-sm font-semibold text-neutral-700">{title}</h2>
      {mode === 'scripted' ? (
        <label className="mt-2 block text-xs text-neutral-500">
          参照文
          <input
            value={referenceText}
            onChange={(e) => setReferenceText(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm text-neutral-800"
          />
        </label>
      ) : null}
      <button
        type="button"
        onClick={() => void run()}
        disabled={!canRun || status === 'running'}
        className="mt-2 rounded-md bg-hana-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {status === 'running' ? '評価中…' : mode === 'scripted' ? 'scripted評価を実行' : '発音評価を実行'}
      </button>
      {!recording ? <p className="mt-1 text-xs text-neutral-400">先に1で録音してください。</p> : null}
      {stages.length > 0 ? <p className="mt-2 text-xs text-neutral-500">{formatLatencyStages(stages)}</p> : null}
      {result ? <PaResultView result={result} mode={mode} /> : null}
      {showStandaloneError ? <p className="mt-2 text-xs text-red-600">エラー: {errorMessage}</p> : null}
    </section>
  );
}
