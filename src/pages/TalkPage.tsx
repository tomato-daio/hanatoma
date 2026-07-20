/**
 * 会話画面（DESIGN.md §2, §4, §5。タブ外フルスクリーン）。
 * M3時点: ガイド付き会話→フリー会話の2フェーズ+テキスト切替+レイテンシログ。
 * キーフレーズ予習フェーズとフィードバック画面はM5/M4で追加する。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { HintPanel } from '../features/conversation/HintPanel';
import { MicButton } from '../features/conversation/MicButton';
import { TextInputBar } from '../features/conversation/TextInputBar';
import { TurnList } from '../features/conversation/TurnList';
import { useConversation } from '../features/conversation/useConversation';

export function TalkPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const conv = useConversation(conversationId);
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const [confirmingExit, setConfirmingExit] = useState(false);

  // 終了操作なしで画面を離れたら中断扱いにする（§4: 再開はさせない単純さ優先）
  const finishedRef = useRef(false);
  const abandonRef = useRef(conv.abandon);
  abandonRef.current = conv.abandon;
  useEffect(() => {
    return () => {
      if (!finishedRef.current) void abandonRef.current();
    };
  }, []);

  const handleFinish = async () => {
    finishedRef.current = true;
    await conv.finish();
    // M4でレポート画面へ遷移させる。M3ではホームへ戻る
    navigate('/');
  };

  const busy = conv.busy !== 'idle' || conv.loading;

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-hana-50">
      {/* ヘッダー: シナリオ名・フェーズ・終了 */}
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold text-neutral-800">
            {conv.scenario ? conv.scenario.titleJa : '読み込み中…'}
          </h1>
          <p className="text-xs text-neutral-500">
            {conv.scenario &&
              (conv.phase === 'guided'
                ? `ガイド ${Math.min(conv.stepIndex + 1, conv.scenario.steps.length)}/${conv.scenario.steps.length}`
                : 'フリー会話')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirmingExit(true)}
          className="shrink-0 rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600"
        >
          会話を終える
        </button>
      </header>

      {/* ゴール表示 */}
      {conv.scenario && (
        <p className="border-b border-hana-100 bg-white px-4 py-1.5 text-xs text-neutral-500">
          🎯 {conv.scenario.goalJa}
        </p>
      )}

      {/* 会話ログ */}
      <main className="flex-1 overflow-y-auto">
        <TurnList turns={conv.turns} aiDraft={conv.aiDraft} busy={conv.busy} />
        {conv.error && (
          <p className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{conv.error}</p>
        )}
        {conv.info && (
          <p className="mx-4 mb-2 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{conv.info}</p>
        )}
      </main>

      {/* 下部コントロール */}
      <footer className="border-t border-neutral-200 bg-white px-4 pb-6 pt-3">
        {conv.currentStep && (
          <div className="mb-3">
            <HintPanel
              step={conv.currentStep}
              hintLevel={conv.hintLevel}
              onNextHint={conv.showNextHint}
              level={conv.level}
            />
          </div>
        )}

        {inputMode === 'voice' ? (
          <div className="flex items-center justify-center gap-6">
            <button
              type="button"
              onClick={() => setInputMode('text')}
              className="rounded-full border border-neutral-300 p-2 text-lg"
              aria-label="テキスト入力に切替"
            >
              ⌨️
            </button>
            <MicButton disabled={busy} onRecordStart={conv.markRecordStart} onResult={(r) => void conv.submitVoice(r)} />
            <span className="w-9" />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setInputMode('voice')}
              className="shrink-0 rounded-full border border-neutral-300 p-2 text-lg"
              aria-label="音声入力に切替"
            >
              🎤
            </button>
            <div className="min-w-0 flex-1">
              <TextInputBar disabled={busy} onSubmit={(t) => void conv.submitText(t)} />
            </div>
          </div>
        )}

        {/* レイテンシログ（M3検収項目。目立たない小ささで常時表示） */}
        {conv.latency && (
          <p className="mt-2 text-center text-[10px] text-neutral-300">
            wav {conv.latency.wavMs}ms / PA {conv.latency.paMs}ms / AI初文 {conv.latency.haikuFirstTextMs}ms
            {conv.latency.totalToSpeechMs !== null && ` / 発話→音声 ${conv.latency.totalToSpeechMs}ms`}
          </p>
        )}
      </footer>

      {/* 終了確認 */}
      {confirmingExit && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5">
            <p className="text-sm font-semibold text-neutral-800">会話を終えますか？</p>
            <p className="mt-1 text-xs text-neutral-500">
              ここまでの会話は保存されます。（添削レポートはM4で追加予定）
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingExit(false)}
                className="flex-1 rounded-full border border-neutral-300 py-2 text-sm text-neutral-600"
              >
                続ける
              </button>
              <button
                type="button"
                onClick={() => void handleFinish()}
                className="flex-1 rounded-full bg-hana-500 py-2 text-sm font-semibold text-white"
              >
                終える
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
