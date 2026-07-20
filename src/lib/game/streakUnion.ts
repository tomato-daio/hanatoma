/**
 * コンビストリーク（hanatoma∪shadotoma）とお休みチケットによるストリーク保険（DESIGN.md §10・§11）。
 *
 * 「切れる恐怖」ではなく「守られている安心」で継続させる、という設計思想のため、
 * ここでの判定はチケットが尽きるまで極力ストリークを継続させる方向に倒す。
 */

import { calcStreak } from '../dates';

/** 両アプリの練習日集合を合算したコンビストリーク。判定ロジック自体はdates.tsのcalcStreakをそのまま使う。 */
export function unionStreak(hanatomaDates: string[], shadotomaDates: string[], today: string): number {
  const merged = Array.from(new Set([...hanatomaDates, ...shadotomaDates]));
  return calcStreak(merged, today);
}

export interface ApplyRestTicketsResult {
  streak: number;
  ticketsUsed: number;
  usedOn: string[]; // チケットで埋めた日付。today側から近い順。
}

// dates.tsはaddDaysをexportしていないため、学習日の前日を求める最小限のロジックをここに複製する
// （学習日切替そのものの規則はdates.ts/learningDateが正本。ここでは単純な暦日の前日計算のみ）。
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseDateStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function previousDay(dateStr: string): string {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() - 1);
  return formatDateStr(d);
}

/**
 * 練習しなかった日をお休みチケットで埋めてストリークを計算する。
 *
 * - today自体はcalcStreakと同じく「まだ当日中」として特別扱いし、未練習でもチケットは消費しない
 *   （前日が練習済みなら継続、前日も未練習ならそこから先はチケット消費の対象になる）
 * - today以前で練習していない日は、today側から近い順にチケットを1枚ずつ消費して埋める
 * - チケットが尽きた時点で未練習日に当たったらそこでストリークを打ち切る
 * - tickets=0のときはcalcStreakと完全に同じ結果になる
 */
export function applyRestTickets(
  practiceDates: string[],
  tickets: number,
  today: string,
): ApplyRestTicketsResult {
  const set = new Set(practiceDates);

  let cursor = today;
  if (!set.has(cursor)) {
    cursor = previousDay(cursor);
  }

  let streak = 0;
  let ticketsUsed = 0;
  const usedOn: string[] = [];

  while (true) {
    if (set.has(cursor)) {
      streak++;
      cursor = previousDay(cursor);
      continue;
    }
    if (ticketsUsed < tickets) {
      ticketsUsed++;
      usedOn.push(cursor);
      streak++;
      cursor = previousDay(cursor);
      continue;
    }
    break;
  }

  return { streak, ticketsUsed, usedOn };
}
