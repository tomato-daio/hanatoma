/**
 * ハンズフリー会話の操作バー（DESIGN.md §2 会話画面・M13）。
 * 大ボタン1つの役割が状態で変わる: 聞き取り中=「送信」／AIの番=「割り込む」／一時停止中=「再開」。
 * 話し終わりは自動で検知されるため、通常はボタンを押さずに会話が往復する。
 */

import type { LiveView } from './live/liveTalkController';
import type { HoldReason, PauseReason } from './live/liveMachine';

interface Props {
  view: LiveView;
  onSend: () => void;
  onInterrupt: () => void;
  onPause: () => void;
  onResume: () => void;
  onKeyboard: () => void;
}

const PAUSE_LABEL: Record<PauseReason, string> = {
  user: '一時停止中',
  idle: 'しばらく声が聞こえなかったので一時停止しました',
  error: '音声認識が止まりました',
  mic: 'マイクが止まりました',
  cap: '今日の音声認識の上限に達しました',
};

const HOLD_LABEL: Record<HoldReason, string> = {
  hint: 'お手本の再生中は聞き取りを止めています',
  text: 'テキスト入力中',
  background: 'アプリに戻ると再開します',
};

function statusText(view: LiveView, manualSend: boolean): string {
  switch (view.phase) {
    case 'aiThinking':
      return 'AIが考えています…';
    case 'aiSpeaking':
      return 'AIが話しています（タップで割り込めます）';
    case 'listening':
      return view.sttReady ? 'どうぞ、話してください' : '準備中…（もう話しはじめて大丈夫です）';
    case 'hearing':
      return '聞き取っています…';
    case 'endpointing':
      return manualSend ? '話し終わったら「送信」をタップ' : '続けて話せます（止まると自動で送信）';
    case 'committing':
      return '送信しています…';
    case 'waiting':
      return view.paused ? PAUSE_LABEL[view.paused] : view.holds.length > 0 ? HOLD_LABEL[view.holds[0]] : '';
    default:
      return '';
  }
}

export function LiveTalkBar({ view, onSend, onInterrupt, onPause, onResume, onKeyboard }: Props) {
  const listening =
    view.phase === 'listening' || view.phase === 'hearing' || view.phase === 'endpointing' || view.phase === 'committing';
  const aiTurn = view.phase === 'aiThinking' || view.phase === 'aiSpeaking';
  const paused = view.phase === 'waiting' && view.paused !== null;
  const canSend = view.phase === 'hearing' || view.phase === 'endpointing';
  const ringScale = listening ? 1 + view.level * 0.5 : 1;

  let button: { label: string; icon: string; onClick?: () => void; className: string };
  if (listening) {
    button = {
      label: view.phase === 'committing' ? '送信中' : '送信',
      icon: view.phase === 'listening' ? '🎧' : '➤',
      ...(canSend ? { onClick: onSend } : {}),
      className: canSend ? 'bg-hana-500 text-white' : 'bg-hana-100 text-hana-600',
    };
  } else if (aiTurn) {
    button = { label: '割り込む', icon: '✋', onClick: onInterrupt, className: 'bg-white text-hana-700 border-2 border-hana-300' };
  } else if (paused) {
    button = { label: '再開', icon: '▶', onClick: onResume, className: 'bg-hana-500 text-white' };
  } else {
    button = { label: '一時停止中', icon: '⏸', className: 'bg-neutral-200 text-neutral-500' };
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="min-h-[1rem] text-center text-xs text-neutral-500">{statusText(view, view.manualSend)}</p>
      <div className="flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={onKeyboard}
          className="rounded-full border border-neutral-300 p-2 text-lg"
          aria-label="テキスト入力に切替"
        >
          ⌨️
        </button>
        <div className="relative flex h-20 w-20 items-center justify-center">
          {listening && (
            <span
              className="absolute inset-0 rounded-full bg-hana-300/50 transition-transform duration-75"
              style={{ transform: `scale(${ringScale})` }}
              aria-hidden
            />
          )}
          <button
            type="button"
            onClick={button.onClick}
            disabled={!button.onClick}
            className={`relative flex h-20 w-20 flex-col items-center justify-center rounded-full text-sm font-bold shadow-md ${button.className}`}
          >
            <span className="text-2xl leading-none">{button.icon}</span>
            <span className="mt-1 text-[11px]">{button.label}</span>
          </button>
        </div>
        {listening ? (
          <button
            type="button"
            onClick={onPause}
            className="rounded-full border border-neutral-300 p-2 text-lg"
            aria-label="聞き取りを一時停止"
          >
            ⏸
          </button>
        ) : (
          <span className="w-9" />
        )}
      </div>
    </div>
  );
}
