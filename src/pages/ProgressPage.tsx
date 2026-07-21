/**
 * 進捗画面（DESIGN.md §2, §10）。
 * ランク・XP(次ランクまでバー)・レベル(CEFR)とlevelHistory・練習カレンダー(直近8週)・
 * バッジ棚(BadgeShelf)・発音スコア推移(簡易折れ線SVG)を表示する。
 */

import { useEffect, useState } from 'react';
import { BadgeShelf } from '../features/game/BadgeShelf';
import { buildStreakInfo, loadSisterData } from '../features/game/homeData';
import { LevelUpProgress } from '../features/game/LevelUpProgress';
import { loadPromoteProgress } from '../features/game/levelProgress';
import { getReviewDates } from '../features/review/reviewStore';
import { getUserProfile, listConversations } from '../lib/db';
import { learningDate } from '../lib/dates';
import { RANK_NAMES, rankFromXp, xpForRank } from '../lib/game/xp';
import { getLevelParams } from '../lib/level/params';
import type { PromoteProgress } from '../lib/level/progress';
import type { Conversation, UserProfile } from '../lib/types';

const CALENDAR_WEEKS = 8;
const CALENDAR_DAYS = CALENDAR_WEEKS * 7;

const REASON_LABEL: Record<UserProfile['levelHistory'][number]['reason'], string> = {
  diagnostic: '診断',
  promote: '昇格',
  demote: '降格',
  manual: '手動',
};

interface ProgressData {
  profile: UserProfile;
  conversations: Conversation[];
  shadotomaDates: string[];
  reviewDates: string[];
  ticketDays: string[];
  promoteProgress: PromoteProgress;
}

// dates.tsは前日/翌日計算をexportしていないため、カレンダー用の単純な暦日加算のみここに複製する
// （学習日切替の規則そのものはdates.ts/learningDateが正本。streakUnion.tsと同じ理由での複製）。
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function addDaysLocal(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** todayを起点に過去CALENDAR_DAYS日分の日付を古い順で返す。 */
function buildCalendarDates(today: string): string[] {
  const dates: string[] = [];
  for (let i = CALENDAR_DAYS - 1; i >= 0; i--) {
    dates.push(addDaysLocal(today, -i));
  }
  return dates;
}

/** 発音スコア推移チャートの座標系（viewBox 300x84。左に縦軸ラベルぶんの余白）。 */
const CHART = {
  width: 300,
  height: 84,
  plotLeft: 26,
  plotRight: 296,
  plotTop: 6,
  plotBottom: 72,
} as const;

/** スコア(0-100)をプロット領域のy座標へ変換する。 */
function chartY(score: number): number {
  const { plotTop, plotBottom } = CHART;
  return plotBottom - (score / 100) * (plotBottom - plotTop);
}

/** i番目(0始まり)のスコアのx座標。1点だけの場合は中央に置く。 */
function chartX(index: number, count: number): number {
  const { plotLeft, plotRight } = CHART;
  if (count <= 1) return (plotLeft + plotRight) / 2;
  return plotLeft + (index / (count - 1)) * (plotRight - plotLeft);
}

function buildSparklinePoints(scores: number[]): string {
  return scores.map((s, i) => `${chartX(i, scores.length).toFixed(1)},${chartY(s).toFixed(1)}`).join(' ');
}

export function ProgressPage() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [profile, conversations, sisterData, reviewDates] = await Promise.all([
          getUserProfile(),
          listConversations(),
          loadSisterData(),
          getReviewDates(),
        ]);
        if (cancelled) return;

        const today = learningDate(new Date());
        // 練習日 = 会話完了日 ∪ サイレント復習の完走日（DESIGN.md §10）
        const hanatomaDates = [
          ...conversations.filter((c) => c.status === 'completed').map((c) => c.date),
          ...reviewDates,
        ];
        const shadotomaDates = sisterData?.practiceDates ?? [];
        const streak = buildStreakInfo(hanatomaDates, shadotomaDates, profile.restTickets, today);
        const promoteProgress = await loadPromoteProgress(conversations, profile.level);
        if (cancelled) return;

        setData({
          profile,
          conversations,
          shadotomaDates,
          reviewDates,
          ticketDays: streak.usedOn,
          promoteProgress,
        });
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : '進捗の読み込みに失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-bold text-neutral-800">進捗</h1>
        <p className="mt-2 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4">
        <h1 className="text-xl font-bold text-neutral-800">進捗</h1>
        <p className="mt-2 text-sm text-neutral-400">読み込み中…</p>
      </div>
    );
  }

  const { profile, conversations, shadotomaDates, reviewDates, ticketDays, promoteProgress } = data;

  const rank = rankFromXp(profile.xp);
  const rankName = RANK_NAMES[rank];
  const isMaxRank = rank >= RANK_NAMES.length - 1;
  const floorXp = xpForRank(rank);
  const nextXp = isMaxRank ? floorXp : xpForRank(rank + 1);
  const rankProgressPercent = isMaxRank
    ? 100
    : Math.max(0, Math.min(100, Math.round(((profile.xp - floorXp) / (nextXp - floorXp)) * 100)));

  const levelParams = getLevelParams(profile.level);
  const sortedHistory = [...profile.levelHistory].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const today = learningDate(new Date());
  const calendarDates = buildCalendarDates(today);
  const hanatomaSet = new Set(conversations.filter((c) => c.status === 'completed').map((c) => c.date));
  const reviewSet = new Set(reviewDates);
  const shadotomaSet = new Set(shadotomaDates);
  const ticketSet = new Set(ticketDays);

  const pronScores = conversations
    .filter((c) => c.status === 'completed' && c.metrics)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((c) => c.metrics!.pronScore);
  const sparklinePoints = buildSparklinePoints(pronScores);
  const lastScore = pronScores.length > 0 ? pronScores[pronScores.length - 1] : null;

  return (
    <div className="flex flex-col gap-5 p-4 pb-8">
      <h1 className="text-xl font-bold text-neutral-800">進捗</h1>

      {/* ランク・XP */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-lg font-bold text-hana-700">{rankName}</p>
          <p className="text-xs text-neutral-400">累計{profile.xp}XP</p>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-neutral-100">
          <div className="h-2 rounded-full bg-hana-500" style={{ width: `${rankProgressPercent}%` }} />
        </div>
        <p className="mt-1 text-right text-xs text-neutral-400">
          {isMaxRank ? '最高ランクです' : `次のランクまであと${nextXp - profile.xp}XP`}
        </p>
      </section>

      {/* レベル(CEFR)・目安とlevelHistory（DESIGN.md §8d） */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-bold text-neutral-800">
            レベル {profile.level}
            <span className="ml-1.5 rounded bg-hana-100 px-1.5 py-0.5 text-xs font-semibold text-hana-700">
              {levelParams.labelJa}
            </span>
          </p>
          <p className="text-xs text-neutral-400">CEFR {levelParams.cefr}相当</p>
        </div>
        <p className="mt-2 text-xs text-neutral-600">{levelParams.guideJa}</p>
        <p className="mt-1 text-xs text-neutral-400">試験の目安: {levelParams.benchmarkJa}</p>
        <p className="mt-1 text-xs text-neutral-400">
          AIの調整: 話す速さは{levelParams.ttsRateLabelJa}・日本語サポートは
          {levelParams.japaneseSupportLabel}
        </p>

        {/* 昇格プログレス（DESIGN.md §8d）: 「いつレベルが上がるか」を可視化する */}
        <div className="mt-3 rounded-xl bg-hana-50 px-3 py-2">
          <p className="text-xs font-bold text-neutral-700">レベルアップまで</p>
          <LevelUpProgress progress={promoteProgress} className="mt-1.5" />
        </div>

        {sortedHistory.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {sortedHistory.slice(0, 5).map((h, idx) => (
              <li key={`${h.date}-${idx}`} className="flex justify-between text-xs text-neutral-500">
                <span>{h.date}</span>
                <span>
                  レベル{h.level} ・ {REASON_LABEL[h.reason]}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-neutral-400">まだレベル変動の記録がありません。</p>
        )}
      </section>

      {/* 練習カレンダー(直近8週) */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <p className="text-sm font-bold text-neutral-800">練習カレンダー</p>
        <div className="mt-2 grid grid-cols-7 gap-1">
          {calendarDates.map((date) => {
            const isTicket = ticketSet.has(date);
            const isHanatoma = hanatomaSet.has(date);
            const isReviewOnly = !isHanatoma && reviewSet.has(date);
            const isShadotomaOnly = !isHanatoma && !isReviewOnly && shadotomaSet.has(date);
            const cellClass = isHanatoma
              ? 'bg-hana-500'
              : isReviewOnly
                ? 'bg-hana-300'
                : isShadotomaOnly
                  ? 'bg-hana-200'
                  : 'bg-neutral-100';
            return (
              <div
                key={date}
                title={date}
                className={`flex h-6 w-6 items-center justify-center rounded text-[9px] ${cellClass}`}
              >
                {isTicket && !isHanatoma && !isReviewOnly && !isShadotomaOnly ? '🎫' : ''}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-neutral-400">
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-hana-500" />
            はなとまで練習
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-hana-300" />
            復習のみ
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-hana-200" />
            シャドとまのみ
          </span>
          <span className="flex items-center gap-1">🎫 チケットで継続</span>
        </div>
      </section>

      {/* バッジ棚 */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <p className="text-sm font-bold text-neutral-800">バッジ棚</p>
        <div className="mt-2">
          <BadgeShelf earnedBadgeIds={profile.badges.map((b) => b.id)} />
        </div>
      </section>

      {/* 発音スコア推移（単一系列スパークライン+控えめな縦軸。均一スケールでラベルを歪ませない） */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <p className="text-sm font-bold text-neutral-800">発音スコア推移</p>
        {pronScores.length > 0 && lastScore !== null ? (
          <>
            <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className="mt-2 w-full">
              {/* 縦軸: 0/50/100の水平グリッド線と数値ラベル */}
              {[0, 50, 100].map((tick) => (
                <g key={tick}>
                  <line
                    x1={CHART.plotLeft}
                    x2={CHART.plotRight}
                    y1={chartY(tick)}
                    y2={chartY(tick)}
                    className="stroke-neutral-200"
                    strokeWidth={1}
                  />
                  <text
                    x={CHART.plotLeft - 4}
                    y={chartY(tick) + 3}
                    textAnchor="end"
                    fontSize={9}
                    className="fill-neutral-400"
                  >
                    {tick}
                  </text>
                </g>
              ))}
              <polyline
                points={sparklinePoints}
                fill="none"
                strokeWidth={2}
                className="stroke-hana-500"
              />
              {/* 直近値の直接ラベル（全点にはラベルを付けない） */}
              <circle
                cx={chartX(pronScores.length - 1, pronScores.length)}
                cy={chartY(lastScore)}
                r={3}
                className="fill-hana-500"
              />
              <text
                x={Math.min(chartX(pronScores.length - 1, pronScores.length), CHART.plotRight - 8)}
                y={Math.max(chartY(lastScore) - 6, CHART.plotTop + 8)}
                textAnchor="end"
                fontSize={10}
                fontWeight="bold"
                className="fill-neutral-600"
              >
                {Math.round(lastScore)}
              </text>
            </svg>
            <p className="mt-1 text-[10px] text-neutral-400">完了レッスン順（古い→新しい）・数値は最新スコア</p>
          </>
        ) : (
          <p className="mt-2 text-xs text-neutral-400">まだ発音評価のデータがありません。</p>
        )}
      </section>
    </div>
  );
}
