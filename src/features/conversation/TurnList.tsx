/**
 * 会話ログの吹き出しリスト（DESIGN.md §2 会話画面）。
 * AI=左・白 / ユーザー=右・オレンジ。音声入力ターンには発音スコアのチップを出す。
 * AI発話は読み上げ中は字幕（aiDraft）として末尾に出し、再生が終わってから確定の吹き出しにする。
 */

import { useEffect, useRef } from 'react';
import type { Turn } from '../../lib/types';
import { AssessingIndicator } from './AssessingIndicator';
import type { ConversationBusy } from './useConversation';

interface Props {
  turns: Turn[];
  aiDraft: string;
  /** まだ読み上げ中のAIターン（字幕で出しているので吹き出しは隠す）。 */
  speakingTurnAt?: number | null;
  busy: ConversationBusy;
  /** ハンズフリー会話で聞き取り中のユーザー発話（確定文＋話している途中の部分認識。M13）。 */
  liveCaption?: { finals: string; partial: string } | null;
}

function paChipColor(score: number): string {
  if (score >= 80) return 'bg-green-100 text-green-700';
  if (score >= 60) return 'bg-yellow-100 text-yellow-700';
  return 'bg-red-100 text-red-700';
}

export function TurnList({ turns, aiDraft, speakingTurnAt, busy, liveCaption }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, aiDraft, busy, liveCaption?.finals, liveCaption?.partial]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {turns.map((turn, i) => turn.at === speakingTurnAt && turn.role === 'ai' ? null : (
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
            {turn.role === 'user' && turn.inputMode === 'voice' && turn.pa?.azureError && (
              // 部分テキスト最終サルベージ等でスコアが取れなかった音声ターン（DESIGN.md §6a-2）。
              <span className="mt-1 inline-block rounded-full bg-white/20 px-2 py-0.5 text-[11px]">スコアなし</span>
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

      {liveCaption && (liveCaption.finals || liveCaption.partial) && (
        // 聞き取り中の字幕（M13）: 確定した文は白、話している途中の部分は薄く表示する。
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-dashed border-hana-300 bg-hana-100 px-3 py-2 text-sm leading-relaxed text-hana-900">
            <p>
              {liveCaption.finals}
              {liveCaption.partial && (
                <span className="text-hana-900/50">
                  {liveCaption.finals ? ' ' : ''}
                  {liveCaption.partial}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {busy === 'assessing' && <AssessingIndicator className="items-center" />}
      {busy === 'thinking' && !aiDraft && <p className="text-center text-xs text-neutral-400">AIが考えています…</p>}

      <div ref={bottomRef} />
    </div>
  );
}
