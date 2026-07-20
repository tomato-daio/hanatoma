/**
 * 進捗画面（DESIGN.md §2, §10）。
 * ランク・XP(次ランクまでバー)・レベル(CEFR)とlevelHistory・練習カレンダー(直近8週)・
 * バッジ棚(BadgeShelf)・発音スコア推移(簡易折れ線SVG)を表示する。
 */

import { useEffect, useState } from 'react';
import { BadgeShelf } from '../features/game/BadgeShelf';
import { buildStreakInfo, loadSisterData } from '../features/game/homeData';
import { getReviewDates } from '../features/review/reviewStore';
import { getUserProfile, listConversations } from '../lib/db';
import { learningDate } from '../lib/dates';
import { RANK_NAMES, rankFromXp, xpForRank } from '../lib/game/xp';
import { getLevelParams } from '../lib/level/params';
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

function buildSparklinePoints(scores: number[], width: number, height: number): string {
  if (scores.length === 0) return '';
  if (scores.length === 1) {
    const y = height - (scores[0] / 100) * height;
    return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
  }
  const stepX = width / (scores.length - 1);
  return scores.map((s, i) => `${(i * stepX).toFixed(1)},${(height - (s / 100) * height).toFixed(1)}`).join(' ');
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

        setData({ profile, conversations, shadotomaDates, reviewDates, ticketDays: streak.usedOn });
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

  const { profile, conversations, shadotomaDates, reviewDates, ticketDays } = data;

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
  const sparklinePoints = buildSparklinePoints(pronScores, 300, 60);

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

      {/* 発音スコア推移 */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <p className="text-sm font-bold text-neutral-800">発音スコア推移</p>
        {pronScores.length > 0 ? (
          <svg viewBox="0 0 300 60" preserveAspectRatio="none" className="mt-2 h-16 w-full text-hana-500">
            <polyline points={sparklinePoints} fill="none" stroke="currentColor" strokeWidth={2} />
          </svg>
        ) : (
          <p className="mt-2 text-xs text-neutral-400">まだ発音評価のデータがありません。</p>
        )}
      </section>
    </div>
  );
}
