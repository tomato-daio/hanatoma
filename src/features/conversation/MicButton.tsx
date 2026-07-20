/**
 * push-to-talk のマイク大ボタン（DESIGN.md §5）。
 * タップで録音開始（thinkingMs計測のため onRecordStart を通知）、もう一度タップで停止し
 * RecordingResult を親（useConversation.submitVoice）へ渡す。
 */

import { useRecorder, type RecordingResult } from '../recorder/useRecorder';

interface Props {
  disabled: boolean;
  onRecordStart: () => void;
  onResult: (recording: RecordingResult) => void;
}

export function MicButton({ disabled, onRecordStart, onResult }: Props) {
  const { isRecording, elapsedSec, level, error, start, stop } = useRecorder();

  const handleTap = async () => {
    if (disabled) return;
    if (!isRecording) {
      onRecordStart();
      await start();
    } else {
      const result = await stop();
      if (result) onResult(result);
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
