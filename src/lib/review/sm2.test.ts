import { describe, expect, it } from 'vitest';
import type { ReviewCardStat } from '../types';
import {
  addDaysToDate,
  EASE_PENALTY,
  FIRST_INTERVAL_DAYS,
  INITIAL_EASE_FACTOR,
  MAX_INTERVAL_DAYS,
  MIN_EASE_FACTOR,
  SECOND_INTERVAL_DAYS,
  sm2Next,
} from './sm2';

const TODAY = '2026-07-20';
const NOW = 1_800_000_000_000;

describe('addDaysToDate', () => {
  it('日を加算し、月またぎ・年またぎも正しく扱う', () => {
    expect(addDaysToDate('2026-07-20', 1)).toBe('2026-07-21');
    expect(addDaysToDate('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDate('2026-07-20', 0)).toBe('2026-07-20');
  });
});

describe('sm2Next', () => {
  it('初出題カード（stat未定義）で「覚えてた」→ rep=1・間隔1日・firstReviewedDate=today', () => {
    const next = sm2Next(undefined, true, TODAY, NOW);
    expect(next.repetition).toBe(1);
    expect(next.easeFactor).toBe(INITIAL_EASE_FACTOR);
    expect(next.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    expect(next.dueDate).toBe(addDaysToDate(TODAY, FIRST_INTERVAL_DAYS));
    expect(next.reviewCount).toBe(1);
    expect(next.againCount).toBe(0);
    expect(next.firstReviewedDate).toBe(TODAY);
    expect(next.lastReviewedAt).toBe(NOW);
  });

  it('間隔が 1日 → 3日 → round(3×EF) と伸びる', () => {
    const first = sm2Next(undefined, true, TODAY, NOW);
    const second = sm2Next(first, true, addDaysToDate(TODAY, 1), NOW);
    expect(second.repetition).toBe(2);
    expect(second.intervalDays).toBe(SECOND_INTERVAL_DAYS);

    const thirdDay = addDaysToDate(TODAY, 4);
    const third = sm2Next(second, true, thirdDay, NOW);
    expect(third.repetition).toBe(3);
    expect(third.intervalDays).toBe(Math.round(SECOND_INTERVAL_DAYS * INITIAL_EASE_FACTOR)); // 3×2.5=7.5→8
    expect(third.dueDate).toBe(addDaysToDate(thirdDay, third.intervalDays));
  });

  it('「まだ」→ rep=0・間隔0・dueDate=today（同日再出題）・EF-0.2・againCount+1', () => {
    const stat: ReviewCardStat = {
      repetition: 3,
      easeFactor: 2.5,
      intervalDays: 8,
      dueDate: TODAY,
      reviewCount: 3,
      againCount: 0,
      firstReviewedDate: '2026-07-01',
      lastReviewedAt: 1,
    };
    const next = sm2Next(stat, false, TODAY, NOW);
    expect(next.repetition).toBe(0);
    expect(next.intervalDays).toBe(0);
    expect(next.dueDate).toBe(TODAY);
    expect(next.easeFactor).toBe(2.3);
    expect(next.againCount).toBe(1);
    expect(next.reviewCount).toBe(4);
    expect(next.firstReviewedDate).toBe('2026-07-01');
  });

  it('易しさ係数は下限1.3で止まり、浮動小数誤差が蓄積しない', () => {
    let stat = sm2Next(undefined, false, TODAY, NOW);
    for (let i = 0; i < 10; i++) {
      stat = sm2Next(stat, false, TODAY, NOW);
      expect(Number.isInteger(Math.round(stat.easeFactor * 100))).toBe(true);
      expect(stat.easeFactor * 100).toBe(Math.round(stat.easeFactor * 100));
    }
    expect(stat.easeFactor).toBe(MIN_EASE_FACTOR);
  });

  it('「まだ」の後に「覚えてた」で間隔が1日からやり直しになる', () => {
    const missed = sm2Next(undefined, false, TODAY, NOW);
    const recovered = sm2Next(missed, true, TODAY, NOW);
    expect(recovered.repetition).toBe(1);
    expect(recovered.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    expect(recovered.dueDate).toBe(addDaysToDate(TODAY, 1));
  });

  it('間隔は上限180日を超えない', () => {
    const stat: ReviewCardStat = {
      repetition: 10,
      easeFactor: 2.5,
      intervalDays: 150,
      dueDate: TODAY,
      reviewCount: 10,
      againCount: 0,
      firstReviewedDate: '2026-01-01',
      lastReviewedAt: 1,
    };
    const next = sm2Next(stat, true, TODAY, NOW);
    expect(next.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it('入力のstatを破壊しない（非破壊）', () => {
    const stat = sm2Next(undefined, true, TODAY, NOW);
    const snapshot = { ...stat };
    sm2Next(stat, false, TODAY, NOW);
    sm2Next(stat, true, TODAY, NOW);
    expect(stat).toEqual(snapshot);
  });

  it('EASE_PENALTYぶんずつ減る（2.5→2.3→2.1）', () => {
    let stat = sm2Next(undefined, false, TODAY, NOW);
    expect(stat.easeFactor).toBe(INITIAL_EASE_FACTOR - EASE_PENALTY);
    stat = sm2Next(stat, false, TODAY, NOW);
    expect(stat.easeFactor).toBe(INITIAL_EASE_FACTOR - EASE_PENALTY * 2);
  });
});
