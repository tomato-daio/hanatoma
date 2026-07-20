import { describe, expect, it } from 'vitest';
import { applyRestTickets, unionStreak } from './streakUnion';
import { calcStreak } from '../dates';

describe('unionStreak', () => {
  it('両アプリの練習日を合算してストリークを計算する', () => {
    const hanatoma = ['2026-07-17'];
    const shadotoma = ['2026-07-18'];
    expect(unionStreak(hanatoma, shadotoma, '2026-07-18')).toBe(2);
  });

  it('片方だけ練習していても合算ストリークとして数える', () => {
    const hanatoma = ['2026-07-16', '2026-07-17', '2026-07-18'];
    const shadotoma: string[] = [];
    expect(unionStreak(hanatoma, shadotoma, '2026-07-18')).toBe(3);
  });

  it('重複日があっても二重に数えない', () => {
    const hanatoma = ['2026-07-18'];
    const shadotoma = ['2026-07-18'];
    expect(unionStreak(hanatoma, shadotoma, '2026-07-18')).toBe(1);
  });
});

describe('applyRestTickets', () => {
  it('tickets=0のときはcalcStreakと完全に一致する', () => {
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'];
    const today = '2026-07-18';
    const result = applyRestTickets(dates, 0, today);
    expect(result.streak).toBe(calcStreak(dates, today));
    expect(result.ticketsUsed).toBe(0);
    expect(result.usedOn).toEqual([]);
  });

  it('1日の穴をチケット1枚で埋めて継続させる', () => {
    // 07-17が未練習。today(07-18)は練習済みなのでgraceは働かず、07-17でチケットを使う。
    const dates = ['2026-07-16', '2026-07-18'];
    const result = applyRestTickets(dates, 1, '2026-07-18');
    expect(result.streak).toBe(3); // 07-18, 07-17(チケット), 07-16
    expect(result.ticketsUsed).toBe(1);
    expect(result.usedOn).toEqual(['2026-07-17']);
  });

  it('チケットが尽きたらそこでストリークを打ち切る(today側から近い順に消費)', () => {
    const dates = ['2026-07-10']; // 07-11〜07-13が空白、07-14が today
    const result = applyRestTickets(dates, 2, '2026-07-14');
    // today未練習→grace→07-13から判定開始。07-13,07-12をチケットで埋めて2枚使い切り、07-11で打ち切り。
    expect(result.ticketsUsed).toBe(2);
    expect(result.usedOn).toEqual(['2026-07-13', '2026-07-12']);
    expect(result.streak).toBe(2);
  });

  it('todayが未練習でも前日が練習済みならグレース扱いでチケットを消費しない', () => {
    const dates = ['2026-07-17'];
    const result = applyRestTickets(dates, 0, '2026-07-18');
    expect(result.streak).toBe(1);
    expect(result.ticketsUsed).toBe(0);
    expect(result.usedOn).toEqual([]);
  });

  it('todayも前日も未練習でチケットも無ければストリーク0', () => {
    const dates = ['2026-07-01'];
    const result = applyRestTickets(dates, 0, '2026-07-18');
    expect(result.streak).toBe(0);
    expect(result.ticketsUsed).toBe(0);
  });

  it('保有チケット数を超えて消費しない', () => {
    const dates: string[] = []; // 全日程が空白
    const result = applyRestTickets(dates, 2, '2026-07-18');
    expect(result.ticketsUsed).toBe(2);
    expect(result.streak).toBe(2);
  });
});
