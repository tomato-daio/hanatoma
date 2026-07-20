/**
 * サイレント復習画面（DESIGN.md §4b・M10）。タブ外フルスクリーン `/review`。
 *
 * 声を出さない完全ローカルのめくりカード復習。API・TTS・録音・外部通信は一切使わない。
 * 想起練習（testing effect）のため、カードは必ず日本語面から表示し、英文はタップするまで見せない。
 * 状態機械: loading → empty（カード0枚）| allDone（今日の分は消化済み）| review → done。
 * 途中離脱は保存しない（セット完走のみ記録。1〜2分の完走を促す設計）。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  finishReviewSet,
  loadReviewDeck,
  type FinishReviewSetResult,
  type ReviewDeck,
} from '../features/review/reviewStore';
import { learningDate } from '../lib/dates';
import {
  nextDueInfo,
  pickReviewCards,
  type ReviewCard,
  type ReviewOutcome,
} from '../lib/review/reviewCards';

type PagePhase = 'loading' | 'empty' | 'allDone' | 'review' | 'saving' | 'done';

/** "YYYY-MM-DD" を「7月23日」形式にする（表示専用）。 */
function formatDateJa(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

export function ReviewPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<PagePhase>('loading');
  const [deck, setDeck] = useState<ReviewDeck | null>(null);
  const [cardSet, setCardSet] = useState<ReviewCard[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [result, setResult] = useState<FinishReviewSetResult | null>(null);
  const [nextSetCount, setNextSetCount] = useState(0);
  const [nextDue, setNextDue] = useState<{ date: string; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outcomesRef = useRef<ReviewOutcome[]>([]);
  const savingRef = useRef(false);

  const today = learningDate(new Date());

  /** デッキを読み込み、今日のセットを組んでフェーズを決める（初回・「もう1セット」共通）。 */
  const startSet = async () => {
    const loaded = await loadReviewDeck();
    setDeck(loaded);
    setNextDue(nextDueInfo(loaded.cards, loaded.stats, today));
    if (loaded.cards.length === 0) {
      setPhase('empty');
      return;
    }
    const picked = pickReviewCards(loaded.cards, loaded.stats, today);
    if (picked.length === 0) {
      setPhase('allDone');
      return;
    }
    setCardSet(picked);
    setIndex(0);
    setFlipped(false);
    outcomesRef.current = [];
    setPhase('review');
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await startSet();
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '復習カードの読み込みに失敗しました。');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 初回マウント時のみ実行（startSetはstateから組み立てるだけで冪等）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const judge = async (remembered: boolean) => {
    if (savingRef.current || phase !== 'review') return;
    const card = cardSet[index];
    outcomesRef.current = [...outcomesRef.current, { key: card.key, remembered }];

    if (index + 1 < cardSet.length) {
      setIndex(index + 1);
      setFlipped(false);
      return;
    }

    // セット完走 → 記録して結果画面へ
    savingRef.current = true;
    setPhase('saving');
    try {
      const deckCards = deck?.cards ?? [];
      const res = await finishReviewSet(outcomesRef.current, deckCards);
      // 記録後の最新SRS状態で「もう1セット」の有無と次回期限を出す
      const fresh = await loadReviewDeck();
      setDeck(fresh);
      setNextSetCount(pickReviewCards(fresh.cards, fresh.stats, today).length);
      setNextDue(nextDueInfo(fresh.cards, fresh.stats, today));
      setResult(res);
      setPhase('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '復習結果の保存に失敗しました。');
      setPhase('review');
    } finally {
      savingRef.current = false;
    }
  };

  const exit = () => {
    if (phase === 'review' && outcomesRef.current.length > 0) {
      const ok = window.confirm('このセットの途中経過は保存されません。復習をやめますか？');
      if (!ok) return;
    }
    navigate('/');
  };

  const card = cardSet[index];

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col p-4">
      {/* ヘッダ */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={exit}
          aria-label="復習を閉じる"
          className="rounded-full px-3 py-1 text-lg text-neutral-400 active:bg-neutral-100"
        >
          ✕
        </button>
        {(phase === 'review' || phase === 'saving') && (
          <p className="text-sm font-semibold text-neutral-500">
            {Math.min(index + 1, cardSet.length)} / {cardSet.length}
          </p>
        )}
        <span className="w-10" />
      </div>

      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {phase === 'loading' && <p className="mt-8 text-center text-sm text-neutral-400">読み込み中…</p>}

      {/* カード0枚（1レッスンも未完了） */}
      {phase === 'empty' && (
        <div className="mt-16 flex flex-col items-center gap-4 text-center">
          <p className="text-4xl">🤫</p>
          <p className="text-sm font-semibold text-neutral-700">復習カードはまだありません</p>
          <p className="text-xs text-neutral-500">
            レッスンを1本終えると、キーフレーズと覚えた表現がカードになります。
          </p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-full bg-hana-500 px-6 py-3 text-sm font-bold text-white active:bg-hana-600"
          >
            ホームで今日のレッスンをはじめる
          </button>
        </div>
      )}

      {/* 今日の分は消化済み（分散学習: やりすぎ防止） */}
      {phase === 'allDone' && (
        <div className="mt-16 flex flex-col items-center gap-4 text-center">
          <p className="text-4xl">🎉</p>
          <p className="text-sm font-semibold text-neutral-700">今日の復習は完了です</p>
          <p className="text-xs text-neutral-500">
            記憶の定着には「忘れかけた頃」に思い出すのが最も効果的です。
            {nextDue
              ? `次の期限は${formatDateJa(nextDue.date)}（${nextDue.count}枚）。それまで休んで大丈夫です。`
              : '新しいレッスンを終えると、カードが増えます。'}
          </p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-full border border-neutral-300 px-6 py-3 text-sm font-semibold text-neutral-600"
          >
            とじる
          </button>
        </div>
      )}

      {/* めくりカード本体 */}
      {(phase === 'review' || phase === 'saving') && card && (
        <div className="mt-6 flex flex-1 flex-col">
          <button
            type="button"
            onClick={() => setFlipped(true)}
            disabled={flipped}
            className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-hana-200 bg-white p-6 text-center shadow-sm"
          >
            {flipped ? (
              <>
                <p className="text-xl font-bold text-neutral-800">{card.en}</p>
                <p className="text-sm text-neutral-500">{card.ja}</p>
                {card.note && <p className="text-xs text-neutral-400">{card.note}</p>}
              </>
            ) : (
              <>
                <p className="text-xl font-bold text-neutral-800">{card.ja}</p>
                <p className="mt-2 text-xs text-neutral-400">
                  英語で言えるか思い出してから、タップで答えを表示
                </p>
              </>
            )}
          </button>

          <div className="mt-4 pb-4">
            {flipped ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void judge(false)}
                  disabled={phase === 'saving'}
                  className="flex-1 rounded-full border border-neutral-300 py-3 text-sm font-semibold text-neutral-600 active:bg-neutral-100 disabled:opacity-50"
                >
                  まだ
                </button>
                <button
                  type="button"
                  onClick={() => void judge(true)}
                  disabled={phase === 'saving'}
                  className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600 disabled:opacity-50"
                >
                  覚えてた
                </button>
              </div>
            ) : (
              <p className="py-3 text-center text-xs text-neutral-400">
                {card.source === 'keyphrase' ? 'レッスンのキーフレーズ' : '表現帳より'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* セット完走 */}
      {phase === 'done' && result && (
        <div className="mt-12 flex flex-col items-center gap-4 text-center">
          <p className="text-4xl">🍅</p>
          <p className="text-base font-bold text-neutral-800">おつかれさまでした！</p>
          <p className="text-sm text-neutral-600">
            覚えてた {result.rememberedCount}枚 ・ まだ {result.againCount}枚
          </p>
          <div className="flex items-center gap-3 text-sm">
            <span className="rounded-full bg-hana-50 px-3 py-1 font-semibold text-hana-700">
              {result.xpAwarded > 0 ? `+${result.xpAwarded} XP` : '今日の分は記録済み'}
            </span>
            <span className="rounded-full bg-neutral-50 px-3 py-1 font-semibold text-neutral-600">
              🔥 {result.streak}日継続中
            </span>
          </div>
          <p className="max-w-xs text-xs text-neutral-500">
            覚えてたカードは、忘れかけた頃（1日→3日→…と間隔を広げながら）にまた出ます。
            {nextDue && `次の期限は${formatDateJa(nextDue.date)}（${nextDue.count}枚）です。`}
          </p>
          <div className="mt-2 flex w-full max-w-xs flex-col gap-2">
            {nextSetCount > 0 && (
              <button
                type="button"
                onClick={() => void startSet().catch(() => setError('次のセットの準備に失敗しました。'))}
                className="rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
              >
                もう1セット（{nextSetCount}枚）
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('/')}
              className="rounded-full border border-neutral-300 py-3 text-sm font-semibold text-neutral-600"
            >
              とじる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
