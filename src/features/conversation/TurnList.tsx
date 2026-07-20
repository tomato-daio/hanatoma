/**
 * 会話ログの吹き出しリスト（DESIGN.md §2 会話画面）。
 * AI=左・白 / ユーザー=右・オレンジ。音声入力ターンには発音スコアのチップを出す。
 * ストリーミング中のAI発話（aiDraft）は末尾に仮の吹き出しとして表示する。
 */

import { useEffect, useRef } from 'react';
import type { Turn } from '../../lib/types';
import type { ConversationBusy } from './useConversation';

interface Props {
  turns: Turn[];
  aiDraft: string;
  busy: ConversationBusy;
}

function paChipColor(score: number): string {
  if (score >= 80) return 'bg-green-100 text-green-700';
  if (score >= 60) return 'bg-yellow-100 text-yellow-700';
  return 'bg-red-100 text-red-700';
}

export function TurnList({ turns, aiDraft, busy }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, aiDraft, busy]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {turns.map((turn, i) => (
        <div key={`${turn.at}-${i}`} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
              turn.role === 'user'
                ? 'rounded-br-sm bg-hana-500 text-white'
                : 'rounded-bl-sm border border-neutral-200 bg-white text-neutral-800'
            }`}
          >
            <p>{turn.text}</p>
            {turn.role === 'user' && turn.pa && !turn.pa.azureError && (
              <span
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${paChipColor(turn.pa.pronScore)}`}
              >
                発音 {Math.round(turn.pa.pronScore)}
              </span>
            )}
            {turn.role === 'user' && turn.inputMode === 'text' && (
              <span className="mt-1 inline-block rounded-full bg-white/20 px-2 py-0.5 text-[11px]">⌨️ テキスト</span>
            )}
          </div>
        </div>
      ))}

      {aiDraft && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-3 py-2 text-sm leading-relaxed text-neutral-800">
            <p>{aiDraft}</p>
          </div>
        </div>
      )}

      {busy === 'assessing' && <p className="text-center text-xs text-neutral-400">発音を評価中…</p>}
      {busy === 'thinking' && !aiDraft && <p className="text-center text-xs text-neutral-400">AIが考えています…</p>}

      <div ref={bottomRef} />
    </div>
  );
}
