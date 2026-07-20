/**
 * push-to-talk のマイク大ボタン（DESIGN.md §5）。
 * タップで録音開始（onRecordStartがキャップ判定とストリーミング評価の開始を行う。
 * falseが返ったら録音しない）、もう一度タップで停止し RecordingResult を
 * 親（useConversation.submitVoice）へ渡す。録音中のPCMは onAudioChunk へ流れる（M11）。
 */

import { useRecorder, type RecordingResult } from '../recorder/useRecorder';

interface Props {
  disabled: boolean;
  /** 録音開始前に呼ぶ。falseなら録音を開始しない（日次上限等）。 */
  onRecordStart: () => Promise<boolean>;
  /** 録音中のマイクPCM（ストリーミング評価用）。 */
  onAudioChunk: (chunk: Float32Array, sampleRate: number) => void;
  onResult: (recording: RecordingResult) => void;
  /** 録音が結果なしで終わった場合（OSによるマイク停止等）。 */
  onAborted: () => void;
}

export function MicButton({ disabled, onRecordStart, onAudioChunk, onResult, onAborted }: Props) {
  const { isRecording, elapsedSec, level, error, start, stop } = useRecorder({ onAudioChunk });

  const handleTap = async () => {
    if (disabled) return;
    if (!isRecording) {
      const ok = await onRecordStart();
      if (!ok) return;
      await start();
    } else {
      const result = await stop();
      if (result) onResult(result);
      else onAborted();
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => void handleTap()}
        disabled={disabled}
        aria-label={isRecording ? '録音停止' : '録音開始'}
        className={`relative flex h-20 w-20 items-center justify-center rounded-full text-3xl shadow-lg transition-colors ${
          isRecording
            ? 'bg-red-500 text-white'
            : disabled
              ? 'bg-neutral-200 text-neutral-400'
              : 'bg-hana-500 text-white active:bg-hana-600'
        }`}
      >
        {/* 録音中はレベルに応じて外周リングが脈動する */}
        {isRecording && (
          <span
            className="absolute inset-0 rounded-full border-4 border-red-300"
            style={{ transform: `scale(${1 + level * 0.35})`, opacity: 0.7 }}
          />
        )}
        {isRecording ? '⏹' : '🎤'}
      </button>
      <span className="text-xs text-neutral-500">
        {isRecording ? `録音中 ${elapsedSec}秒 — もう一度タップで送信` : 'タップして話す'}
      </span>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
