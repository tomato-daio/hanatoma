/**
 * 会話画面（DESIGN.md §2, §4, §5。タブ外フルスクリーン）。
 * M13: ハンズフリー会話。開始タップ後はボタン操作なしで往復する（話し終わりを自動検知）。
 * 大ボタンは状態で役割が変わる（聞き取り中=送信／AIの番=割り込む／一時停止中=再開）。
 * 発音評価は会話を終えたあと、添削レポートと一緒に行う。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { HintPanel } from '../features/conversation/HintPanel';
import { KeyPhrasePanel } from '../features/conversation/KeyPhrasePanel';
import { LiveTalkBar } from '../features/conversation/LiveTalkBar';
import { useLiveTalk } from '../features/conversation/live/useLiveTalk';
import { runSessionEnd } from '../features/conversation/sessionEnd';
import { TextInputBar } from '../features/conversation/TextInputBar';
import { TurnList } from '../features/conversation/TurnList';
import { useConversation } from '../features/conversation/useConversation';
import { RewardScreen } from '../features/game/RewardScreen';
import type { SessionSummary } from '../features/game/sessionSummary';

export function TalkPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const conv = useConversation(conversationId);
  const live = useLiveTalk(conv);
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const [paProgress, setPaProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [hasReport, setHasReport] = useState(false);

  // 終了操作なしで画面を離れたら中断扱いにする（§4: 再開はさせない単純さ優先）
  const finishedRef = useRef(false);
  const abandonRef = useRef(conv.abandon);
  abandonRef.current = conv.abandon;
  useEffect(() => {
    return () => {
      if (!finishedRef.current) void abandonRef.current();
    };
  }, []);

  // 会話終了 → セッション終了パイプライン（添削レポート・XP・クエスト・バッジ・レベル）→ リワード画面
  const handleFinish = async () => {
    finishedRef.current = true;
    setConfirmingExit(false);
    setFinishing(true);
    try {
      // 聞き取り（マイク・STT）を先に閉じる: Azure F0は同時認識1本のため、会話後の発音評価と重ねない。
      live.actions.stop();
      const finished = await conv.finish();
      if (!finished) {
        navigate('/');
        return;
      }
      const result = await runSessionEnd(finished.conversation, conv.modelAnswersShown, {
        clips: finished.clips,
        onPaProgress: (done, total) => setPaProgress(total > 0 ? { done, total } : null),
      });
      if (result.reportError) setReportError(result.reportError);
      setHasReport(result.report !== null);
      setSummary(result.summary);
    } catch (e: unknown) {
      // パイプライン失敗でも会話の完了保存は済んでいる。ホームへ戻す
      console.warn('sessionEnd failed', e);
      navigate('/');
    } finally {
      setFinishing(false);
    }
  };

  const handleRewardClose = () => {
    // レポートが作れたときはレポートタブへ、それ以外はホームへ
    navigate(hasReport ? '/reports' : '/');
  };

  const busy = conv.busy !== 'idle' || conv.loading;
  // lessonモードで対話開始前はキーフレーズ予習フェーズを表示する（DESIGN.md §4）
  const inKeyPhrasePhase = conv.mode === 'lesson' && !conv.dialogueStarted && !conv.loading;
  // クイック・ひとくち等は開始タップで始める（iOSの音声再生アンロックとマイク許可のため。M13）
  const needsStartTap =
    !conv.loading && !conv.error && conv.mode !== 'lesson' && !conv.dialogueStarted && conv.conversation?.status === 'active';

  const switchToText = () => {
    setInputMode('text');
    live.actions.hold('text');
  };
  const switchToVoice = () => {
    setInputMode('voice');
    live.actions.release('text');
  };

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
              (inKeyPhrasePhase
                ? 'キーフレーズ予習'
                : conv.phase === 'guided'
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

      {/* 会話ログ / キーフレーズ予習 */}
      <main className="flex flex-1 flex-col overflow-y-auto">
        {inKeyPhrasePhase && conv.scenario ? (
          <KeyPhrasePanel
            scenario={conv.scenario}
            level={conv.level}
            busy={conv.busy !== 'idle'}
            beginKeyPhrase={conv.beginKeyPhrase}
            onAudioChunk={conv.handleAudioChunk}
            cancelVoiceCapture={conv.cancelVoiceCapture}
            submitKeyPhrase={conv.submitKeyPhrase}
            onDone={live.actions.start}
          />
        ) : (
          <TurnList
            turns={conv.turns.filter((t) => t.phase !== 'keyphrase')}
            aiDraft={conv.aiDraft}
            busy={conv.busy}
            liveCaption={{ finals: live.view.finals, partial: live.view.partial }}
          />
        )}
        {conv.error && (
          <p className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{conv.error}</p>
        )}
        {conv.info && (
          <p className="mx-4 mb-2 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{conv.info}</p>
        )}
      </main>

      {/* biteモード: 1往復済んだら完了を促す */}
      {conv.biteComplete && (
        <div className="border-t border-green-200 bg-green-50 px-4 py-3">
          <button
            type="button"
            onClick={() => void handleFinish()}
            className="w-full rounded-full bg-green-500 py-2.5 text-sm font-bold text-white"
          >
            ✅ 今日のひとくち完了！
          </button>
        </div>
      )}

      {/* 下部コントロール（キーフレーズ予習中・開始前・ひとくち完了後は非表示） */}
      {!inKeyPhrasePhase && !needsStartTap && !conv.biteComplete && (
      <footer className="border-t border-neutral-200 bg-white px-4 pb-6 pt-3">
        {conv.currentStep && (
          <div className="mb-3">
            <HintPanel
              step={conv.currentStep}
              hintLevel={conv.hintLevel}
              onNextHint={conv.showNextHint}
              level={conv.level}
              onPlaybackStart={() => live.actions.hold('hint')}
              onPlaybackEnd={() => live.actions.release('hint')}
            />
          </div>
        )}

        {inputMode === 'voice' ? (
          <LiveTalkBar
            view={live.view}
            onSend={live.actions.sendNow}
            onInterrupt={live.actions.interrupt}
            onPause={live.actions.pause}
            onResume={live.actions.resume}
            onKeyboard={switchToText}
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={switchToVoice}
              className="shrink-0 rounded-full border border-neutral-300 p-2 text-lg"
              aria-label="音声入力に切替"
            >
              🎤
            </button>
            <div className="min-w-0 flex-1">
              <TextInputBar disabled={busy || !conv.dialogueStarted} onSubmit={conv.submitText} />
            </div>
          </div>
        )}

        {/* レイテンシ（M13: 話し終わり→AIの音が鳴るまで。目立たない小ささで常時表示） */}
        {conv.latency && conv.latency.totalMs !== null && (
          <p className="mt-2 text-center text-[10px] text-neutral-300">
            {conv.latency.endpointMs !== null ? '発話終了' : '送信'}→AI音声 {(conv.latency.totalMs / 1000).toFixed(1)}s
            {' | '}
            {conv.latency.endpointMs !== null && `確定${(conv.latency.endpointMs / 1000).toFixed(1)}・`}
            AI初文{conv.latency.aiFirstTextMs !== null ? (conv.latency.aiFirstTextMs / 1000).toFixed(1) : '?'}・TTS
            {conv.latency.ttsMs !== null ? (conv.latency.ttsMs / 1000).toFixed(1) : '?'}
          </p>
        )}
      </footer>
      )}

      {/* 開始タップ（クイック・ひとくち等。M13） */}
      {needsStartTap && (
        <div className="border-t border-hana-200 bg-white px-4 pb-8 pt-4">
          <p className="text-center text-xs leading-relaxed text-neutral-500">
            話し終わると自動でAIが返事します（ボタン操作は不要）。
            <br />
            AIが話している途中はタップで割り込めます。発音スコアは会話を終えたあとのレポートで見られます。
          </p>
          <button
            type="button"
            onClick={live.actions.start}
            className="mt-3 w-full rounded-full bg-hana-500 py-3 text-base font-bold text-white shadow-md"
          >
            🎧 タップして会話をはじめる
          </button>
        </div>
      )}

      {/* セッション終了処理中のオーバーレイ */}
      {finishing && (
        <div className="fixed inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/50 p-6">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-hana-300 border-t-hana-600" />
          <p className="text-sm font-semibold text-white">添削レポートと発音採点を作成中…</p>
          <p className="text-xs text-white/70">
            会話の内容をAIが細かくチェックしています
            {paProgress && `（発音 ${paProgress.done}/${paProgress.total}）`}
          </p>
        </div>
      )}

      {/* リワード画面（XP・★・新表現・バッジ・クエスト） */}
      {summary && (
        <>
          <RewardScreen summary={summary} onClose={handleRewardClose} />
          {reportError && (
            <p className="fixed inset-x-4 bottom-4 z-40 rounded-lg bg-yellow-100 px-3 py-2 text-xs text-yellow-800">
              添削レポートは作成できませんでした: {reportError}
            </p>
          )}
        </>
      )}

      {/* 終了確認 */}
      {confirmingExit && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5">
            <p className="text-sm font-semibold text-neutral-800">会話を終えますか？</p>
            <p className="mt-1 text-xs text-neutral-500">
              終えるとAIが会話全体を添削してレポートを作り、XPやクエストが集計されます。
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
