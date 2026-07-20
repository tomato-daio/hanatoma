/**
 * テキスト入力フォールバック（DESIGN.md §5）。
 * 電車内など声を出せない環境でも練習（とストリーク）を継続できるようにする。
 * テキスト入力ターンは発音評価なし（文法・表現のみ添削対象）。
 */

import { useState } from 'react';

interface Props {
  disabled: boolean;
  onSubmit: (text: string) => void;
}

export function TextInputBar({ disabled, onSubmit }: Props) {
  const [text, setText] = useState('');

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSubmit();
        }}
        placeholder="英語で入力…"
        disabled={disabled}
        className="min-w-0 flex-1 rounded-full border border-neutral-300 px-4 py-2 text-sm focus:border-hana-400 focus:outline-none"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || !text.trim()}
        className="shrink-0 rounded-full bg-hana-500 px-4 py-2 text-sm font-semibold text-white disabled:bg-neutral-300"
      >
        送信
      </button>
    </div>
  );
}
