/**
 * ストリーミング発音評価の検証パネル（DESIGN.md §5 M11・セルフテスト画面用）。
 *
 * useRecorder({onAudioChunk}) + beginVoiceCapture を会話ループとは独立に直接使い、
 * 録音中ストリーミング評価のエンドツーエンドを検証する:
 * - PCMタップ層: 受信チャンク数・KB表示（Azureキー無し環境でもここまでは検証できる）
 * - Azure層: 停止→確定までの所要ms・PaResult（接続/初回認識などの内訳はconsole.info）
 * - 失敗時: エラーメッセージ表示（batchフォールバックの検証は既存のPAパネルで行う）
 */

import { useRef, useState } from 'react';
import { useRecorder } from '../../recorder/useRecorder';
import { supportsPcmTap } from '../../recorder/pcmTapWorklet';
import { beginVoiceCapture, type VoiceCaptureHandle } from '../../conversation/voiceCapture';
import type { AssessSpeechResult } from '../azurePaUnscripted';
import { PaResultView } from './PaResultView';

export function StreamingPaPanel() {
  const [mode, setMode] = useState<'unscripted' | 'scripted'>('unscripted');
  const [referenceText, setReferenceText] = useState('Could you say that again?');
  const [chunkCount, setChunkCount] = useState(0);
  const [pcmKb, setPcmKb] = useState(0);
  const [finishMs, setFinishMs] = useState<number | null>(null);
  const [result, setResult] = useState<AssessSpeechResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const captureRef = useRef<VoiceCaptureHandle | null>(null);
  const chunkCountRef = useRef(0);

  const recorder = useRecorder({
    onAudioChunk: (chunk, sampleRate) => {
      captureRef.current?.onAudioChunk(chunk, sampleRate);
      chunkCountRef.current += 1;
      // 再レンダリングを間引く（約23回/秒のチャンクを毎回stateにしない）
      if (chunkCountRef.current % 10 === 1) {
        setChunkCount(chunkCountRef.current);
        setPcmKb(Math.round(((captureRef.current?.audioSeconds() ?? 0) * 32000) / 1024));
      }
    },
  });

  const toggle = async () => {
    if (working) return;
    if (!recorder.isRecording) {
      setResult(null);
      setMessage(null);
      setFinishMs(null);
      chunkCountRef.current = 0;
      setChunkCount(0);
      setPcmKb(0);
      captureRef.current?.abort();
      captureRef.current = beginVoiceCapture({
        mode,
        ...(mode === 'scripted' ? { referenceText } : {}),
        phraseHints: mode === 'scripted' ? [referenceText] : [],
      });
      await recorder.start();
      return;
    }

    setWorking(true);
    try {
      const recording = await recorder.stop();
      setChunkCount(chunkCountRef.current);
      const capture = captureRef.current;
      captureRef.current = null;
      if (!capture) {
        setMessage('キャプチャが開始されていませんでした。');
        return;
      }
      const t0 = performance.now();
      const res = await capture.finish();
      setFinishMs(Math.round(performance.now() - t0));
      if (res) {
        setResult(res);
      } else {
        setMessage(
          'ストリーミング評価が失敗しました（詳細はconsole）。実利用ではこの場合、録音Blobからbatch評価へ自動フォールバックします。' +
            (recording ? '' : ' （録音も取得できませんでした）'),
        );
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-200 p-3">
      <h2 className="text-sm font-bold text-neutral-800">5. ストリーミング発音評価（録音中に逐次評価）</h2>
      <p className="mt-1 text-xs text-neutral-500">
        PCMタップ: {supportsPcmTap() ? 'AudioWorklet対応' : '非対応（batchのみ）'} ・ 受信 {chunkCount}
        チャンク / 約{pcmKb}KB
      </p>

      <div className="mt-2 flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === 'unscripted'} onChange={() => setMode('unscripted')} />
          unscripted
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === 'scripted'} onChange={() => setMode('scripted')} />
          scripted
        </label>
      </div>
      {mode === 'scripted' && (
        <input
          type="text"
          value={referenceText}
          onChange={(e) => setReferenceText(e.target.value)}
          className="mt-2 w-full rounded-lg border border-neutral-300 px-2 py-1 text-sm"
          placeholder="参照テキスト"
        />
      )}

      <button
        type="button"
        onClick={() => void toggle()}
        disabled={working}
        className={`mt-2 rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
          recorder.isRecording ? 'bg-red-500' : 'bg-hana-500'
        }`}
      >
        {working
          ? '確定待ち…'
          : recorder.isRecording
            ? `⏹ 停止して確定 (${recorder.elapsedSec}s)`
            : '🎤 ストリーミング録音開始'}
      </button>

      {recorder.error && <p className="mt-2 text-xs text-red-600">{recorder.error}</p>}
      {finishMs !== null && (
        <p className="mt-2 text-xs text-neutral-600">
          停止→確定 <span className="font-bold">{finishMs}ms</span>（接続/初回認識の内訳はconsole）
        </p>
      )}
      {message && <p className="mt-2 rounded-lg bg-yellow-50 px-2 py-1 text-xs text-yellow-800">{message}</p>}
      {result && <PaResultView result={result} mode={mode} />}
    </section>
  );
}
