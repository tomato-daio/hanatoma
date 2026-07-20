import { useEffect, useRef, useState } from 'react';
import { createWakeLockController, type WakeLockController } from '../../../lib/wakeLock';
import { useRecorder, type RecordingResult } from '../../recorder/useRecorder';

export interface RecordingPanelProps {
  /** 録音確定（stop()成功）ごとに呼ばれる。以降のPA評価はこの結果を対象にする。 */
  onRecorded: (result: RecordingResult) => void;
}

/**
 * マイク録音セクション（DESIGN.md M2手順1: レベルメーター・経過秒・Wake Lock・自分の録音再生確認）。
 * useRecorderは録音本体のみを扱いWake Lockを持たない設計のため（useRecorder.tsのコメント参照。
 * Wake Lockはターン全体にまたがるため呼び出し側が管理する）、このコンポーネントが
 * 録音中のWake Lock取得/解放を担う（shadotoma PracticePage.tsxと同じ「effect内でcreateし
 * cleanupでdisposeする」パターン）。
 */
export function RecordingPanel({ onRecorded }: RecordingPanelProps) {
  const recorder = useRecorder();
  const wakeLockRef = useRef<WakeLockController | null>(null);
  const playbackUrlRef = useRef<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);

  useEffect(() => {
    wakeLockRef.current = createWakeLockController();
    return () => {
      wakeLockRef.current?.dispose();
      wakeLockRef.current = null;
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current);
        playbackUrlRef.current = null;
      }
    };
  }, []);

  // マイクのOS強制停止・start()失敗もrecorder.errorに反映されるため、
  // 録音状態に関わらずエラーが立ったら保持中のWake Lockを解放する。
  useEffect(() => {
    if (recorder.error) {
      wakeLockRef.current?.release();
    }
  }, [recorder.error]);

  const replacePlaybackUrl = (next: string | null) => {
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    playbackUrlRef.current = next;
    setPlaybackUrl(next);
  };

  const handleStart = async () => {
    replacePlaybackUrl(null);
    await wakeLockRef.current?.acquire();
    await recorder.start();
  };

  const handleStop = async () => {
    const result = await recorder.stop();
    wakeLockRef.current?.release();
    if (!result) return;
    replacePlaybackUrl(URL.createObjectURL(result.blob));
    setLastDurationMs(result.durationMs);
    onRecorded(result);
  };

  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <h2 className="text-sm font-semibold text-neutral-700">1. マイク録音</h2>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void (recorder.isRecording ? handleStop() : handleStart())}
          className={`rounded-full px-4 py-2 text-sm font-semibold text-white ${
            recorder.isRecording ? 'bg-red-600' : 'bg-hana-600'
          }`}
        >
          {recorder.isRecording ? '■ 停止' : '● 録音開始'}
        </button>
        <span className="w-10 text-sm text-neutral-500">{recorder.elapsedSec}秒</span>
        <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-100" aria-label="録音レベルメーター">
          <div
            className="h-full bg-hana-400 transition-[width]"
            style={{ width: `${Math.round(recorder.level * 100)}%` }}
          />
        </div>
      </div>
      {recorder.error ? <p className="mt-2 text-xs text-red-600">{recorder.error}</p> : null}
      {playbackUrl ? (
        <div className="mt-2">
          <p className="text-xs text-neutral-500">
            録音を再生して確認できます
            {lastDurationMs !== null ? `（${(lastDurationMs / 1000).toFixed(1)}秒）` : ''}。
          </p>
          <audio controls src={playbackUrl} className="mt-1 w-full" />
        </div>
      ) : null}
    </section>
  );
}
