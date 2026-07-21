/**
 * セッション終了後のリワード画面（DESIGN.md §10）。全画面オーバーレイ。
 * XP内訳 → ★評価 → 新表現 → 新バッジ → 昇格/降格 → クエスト進捗 の順に段階表示する
 * （内容が無い段階はスキップする）。「すべて表示」で一気に最後まで進められる。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { BADGE_CATALOG } from './BadgeShelf';
import { LevelUpProgress } from './LevelUpProgress';
import type { SessionSummary } from './sessionSummary';

/** 昇格ライン（PROMOTE_THRESHOLD）。表示用のためここでも定数を持つ。 */
const PROMOTE_LINE = 75;

interface RewardScreenProps {
  summary: SessionSummary;
  onClose: () => void;
}

type StageKind = 'xp' | 'stars' | 'promotion' | 'expressions' | 'badges' | 'level' | 'quests';

const STAR_LABEL: Record<0 | 1 | 2 | 3, string> = { 0: '―', 1: '★', 2: '★★', 3: '★★★' };
/** 段階の自動進行間隔(ms)。「全表示」ボタンでいつでも一気に飛ばせる。 */
const AUTO_ADVANCE_MS = 900;

/** 各段階の初回表示時にふわっと現れるラッパー（CSSトランジションのみ・キーフレーム不使用）。 */
function FadeInStage({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={`transition-all duration-500 ease-out ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      {children}
    </div>
  );
}

function buildStages(summary: SessionSummary): StageKind[] {
  const stages: StageKind[] = ['xp', 'stars'];
  // 採点付きセッションのみ「昇格の進み」を出す（bite等は対象外）。
  if (summary.graded) stages.push('promotion');
  if (summary.newExpressions.length > 0) stages.push('expressions');
  if (summary.newBadgeIds.length > 0) stages.push('badges');
  if (summary.levelChange) stages.push('level');
  stages.push('quests');
  return stages;
}

export function RewardScreen({ summary, onClose }: RewardScreenProps) {
  const [stages] = useState(() => buildStages(summary));
  const [revealed, setRevealed] = useState(1);
  const isLast = revealed >= stages.length;

  useEffect(() => {
    if (isLast) return;
    const timer = setTimeout(() => setRevealed((n) => Math.min(stages.length, n + 1)), AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [isLast, stages.length]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col rounded-2xl bg-white p-5">
        <p className="text-center text-xs font-semibold text-hana-600">お疲れさまでした！</p>

        {stages.slice(0, revealed).map((stage) => (
          <FadeInStage key={stage}>
            {stage === 'xp' && (
              <section className="mt-4">
                <p className="text-sm font-bold text-neutral-800">獲得XP</p>
                <ul className="mt-2 flex flex-col gap-1">
                  {summary.xpBreakdown.map((item) => (
                    <li key={item.label} className="flex justify-between text-xs text-neutral-600">
                      <span>{item.label}</span>
                      <span className={item.amount < 0 ? 'text-red-500' : 'text-neutral-700'}>
                        {item.amount >= 0 ? '+' : ''}
                        {item.amount}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-right text-2xl font-extrabold text-hana-600">+{summary.xp} XP</p>
              </section>
            )}

            {stage === 'stars' && (
              <section className="mt-4 text-center">
                <p className="text-sm font-bold text-neutral-800">今回の評価</p>
                <p className="mt-1 text-4xl">{STAR_LABEL[summary.stars]}</p>
              </section>
            )}

            {stage === 'promotion' && (
              <section className="mt-4">
                <p className="text-sm font-bold text-neutral-800">レベルアップの進み</p>
                <p className="mt-1 text-xs text-neutral-600">
                  このレッスンの総合スコア: <span className="font-bold">{Math.round(summary.composite)}点</span>
                </p>
                {summary.promotionEligible ? (
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {summary.composite >= PROMOTE_LINE
                      ? `昇格ライン(${PROMOTE_LINE}点)クリア ✓`
                      : `昇格ライン(${PROMOTE_LINE}点)まであと${Math.max(1, Math.ceil(PROMOTE_LINE - summary.composite))}点`}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-neutral-400">
                    ※このレッスンは昇格判定の対象外（現レベル以上の難易度が対象）
                  </p>
                )}
                <LevelUpProgress progress={summary.promoteProgress} className="mt-2" />
              </section>
            )}

            {stage === 'expressions' && (
              <section className="mt-4">
                <p className="text-sm font-bold text-neutral-800">新しい表現</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {summary.newExpressions.map((expr) => (
                    <li key={expr.en} className="rounded-lg bg-hana-50 p-2">
                      <p className="text-sm font-semibold text-neutral-800">{expr.en}</p>
                      <p className="text-xs text-neutral-500">{expr.ja}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {stage === 'badges' && (
              <section className="mt-4">
                <p className="text-sm font-bold text-neutral-800">新しいバッジ</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {summary.newBadgeIds.map((id) => {
                    const def = BADGE_CATALOG.find((b) => b.id === id);
                    return (
                      <div key={id} className="flex flex-col items-center rounded-lg bg-hana-50 p-2 text-center">
                        <span className="text-2xl" aria-hidden="true">
                          {def?.emoji ?? '🏅'}
                        </span>
                        <span className="mt-1 text-[10px] font-semibold text-hana-700">{def?.name ?? id}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {stage === 'level' && (
              <section className="mt-4 rounded-lg bg-hana-50 p-3 text-center">
                <p className="text-sm font-bold text-hana-700">
                  {summary.levelChange === 'promote' ? '🎉 レベルアップ！' : 'サポートを増やしました'}
                </p>
              </section>
            )}

            {stage === 'quests' && (
              <section className="mt-4">
                <p className="text-sm font-bold text-neutral-800">デイリークエスト</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {summary.questsAfter.map((quest) => (
                    <li key={quest.id} className="text-xs text-neutral-600">
                      <div className="flex justify-between gap-2">
                        <span>{quest.descriptionJa}</span>
                        <span className="shrink-0">{quest.done ? '✓' : `${quest.progress}/${quest.target}`}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-neutral-100">
                        <div
                          className="h-1.5 rounded-full bg-hana-400"
                          style={{
                            width: `${quest.target > 0 ? Math.min(100, (quest.progress / quest.target) * 100) : 0}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-center text-xs text-neutral-400">🔥 ストリーク{summary.streak}日</p>
              </section>
            )}
          </FadeInStage>
        ))}

        <div className="mt-6 flex gap-2">
          {!isLast && (
            <button
              type="button"
              onClick={() => setRevealed(stages.length)}
              className="flex-1 rounded-full border border-neutral-200 py-2 text-xs font-semibold text-neutral-600"
            >
              すべて表示
            </button>
          )}
          {isLast && (
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
            >
              閉じる
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
