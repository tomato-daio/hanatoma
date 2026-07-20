import { describe, expect, it } from 'vitest';
import { calcStreak, learningDate } from './dates';

describe('learningDate', () => {
  it('午前3時ちょうどはその日の学習日になる', () => {
    expect(learningDate(new Date(2026, 6, 18, 3, 0, 0))).toBe('2026-07-18');
  });

  it('午前3時直前(2:59)は前日の学習日になる', () => {
    expect(learningDate(new Date(2026, 6, 18, 2, 59, 59))).toBe('2026-07-17');
  });

  it('深夜0時台は前日の学習日になる', () => {
    expect(learningDate(new Date(2026, 6, 18, 0, 30, 0))).toBe('2026-07-17');
  });

  it('日中はそのままの日付になる', () => {
    expect(learningDate(new Date(2026, 6, 18, 15, 0, 0))).toBe('2026-07-18');
  });

  it('23:59は当日のまま', () => {
    expect(learningDate(new Date(2026, 6, 18, 23, 59, 0))).toBe('2026-07-18');
  });

  it('月またぎでも正しく前日になる(8/1 1:00 -> 7/31)', () => {
    expect(learningDate(new Date(2026, 7, 1, 1, 0, 0))).toBe('2026-07-31');
  });

  it('年またぎでも正しく前日になる(1/1 1:00 -> 前年12/31)', () => {
    expect(learningDate(new Date(2026, 0, 1, 1, 0, 0))).toBe('2025-12-31');
  });
});

describe('calcStreak', () => {
  it('今日を含めて連続していればその日数を返す', () => {
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18'];
    expect(calcStreak(dates, '2026-07-18')).toBe(4);
  });

  it('今日はまだ練習していないが前日まで連続していればストリークを維持する', () => {
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'];
    expect(calcStreak(dates, '2026-07-18')).toBe(3);
  });

  it('今日も前日も練習していなければ0', () => {
    const dates = ['2026-07-10', '2026-07-11'];
    expect(calcStreak(dates, '2026-07-18')).toBe(0);
  });

  it('途中で途切れている場合は最新の連続区間のみ数える', () => {
    const dates = ['2026-07-01', '2026-07-02', '2026-07-10', '2026-07-11', '2026-07-12'];
    expect(calcStreak(dates, '2026-07-12')).toBe(3);
  });

  it('配列が空なら0', () => {
    expect(calcStreak([], '2026-07-18')).toBe(0);
  });

  it('日付の並び順に依存しない', () => {
    const dates = ['2026-07-18', '2026-07-16', '2026-07-17'];
    expect(calcStreak(dates, '2026-07-18')).toBe(3);
  });

  it('重複した日付があっても正しく数える', () => {
    const dates = ['2026-07-17', '2026-07-17', '2026-07-18', '2026-07-18'];
    expect(calcStreak(dates, '2026-07-18')).toBe(2);
  });

  it('1日だけ練習していて今日ならストリーク1', () => {
    expect(calcStreak(['2026-07-18'], '2026-07-18')).toBe(1);
  });
});
