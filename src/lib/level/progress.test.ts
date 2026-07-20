import { describe, expect, it } from 'vitest';
import { applyLevelProgress, type RecentLessonRecord } from './progress';
import type { AppLevel, UserProfile } from '../types';

function makeProfile(level: AppLevel, levelHistory: UserProfile['levelHistory'] = []): UserProfile {
  return {
    key: 'main',
    level,
    levelHistory,
    xp: 0,
    restTickets: 0,
    badges: [],
    interests: [],
    createdAt: 0,
  };
}

function lesson(date: string, scenarioLevel: number, composite: number): RecentLessonRecord {
  return { date, scenarioLevel, composite };
}

const TODAY = '2026-07-20';

describe('applyLevelProgress', () => {
  it('現レベル以上の直近5件中4件が75以上なら昇格する', () => {
    const profile = makeProfile(2);
    const lessons = [
      lesson('2026-07-16', 2, 80),
      lesson('2026-07-17', 2, 80),
      lesson('2026-07-18', 2, 80),
      lesson('2026-07-19', 2, 80),
      lesson('2026-07-20', 2, 40),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: 'promote' });
  });

  it('75以上が3件しかなければ昇格しない', () => {
    const profile = makeProfile(2);
    const lessons = [
      lesson('2026-07-16', 2, 80),
      lesson('2026-07-17', 2, 80),
      lesson('2026-07-18', 2, 80),
      lesson('2026-07-19', 2, 40),
      lesson('2026-07-20', 2, 40),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 2, change: null });
  });

  it('composite=75ちょうどはヒットとして数える（境界値）', () => {
    const profile = makeProfile(2);
    const lessons = [
      lesson('2026-07-16', 2, 75),
      lesson('2026-07-17', 2, 75),
      lesson('2026-07-18', 2, 75),
      lesson('2026-07-19', 2, 75),
      lesson('2026-07-20', 2, 40),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result.change).toBe('promote');
  });

  it('レベル上限(5)では条件を満たしても昇格しない', () => {
    const profile = makeProfile(5);
    const lessons = [
      lesson('2026-07-16', 5, 90),
      lesson('2026-07-17', 5, 90),
      lesson('2026-07-18', 5, 90),
      lesson('2026-07-19', 5, 90),
      lesson('2026-07-20', 5, 90),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 5, change: null });
  });

  it('現レベル未満のレッスンは昇格判定の母集団から除外される', () => {
    const profile = makeProfile(3);
    const lessons = [
      // 現レベル(3)未満なので対象外。高得点でも判定に使われない
      lesson('2026-07-18', 1, 100),
      lesson('2026-07-19', 2, 100),
      // 現レベル以上は4件のみ→5件に満たないため昇格しない
      lesson('2026-07-14', 3, 90),
      lesson('2026-07-15', 3, 90),
      lesson('2026-07-16', 4, 90),
      lesson('2026-07-17', 3, 90),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: null });
  });

  it('母集団（現レベル以上）が5件未満なら昇格しない', () => {
    const profile = makeProfile(2);
    const lessons = [lesson('2026-07-17', 2, 90), lesson('2026-07-18', 2, 90), lesson('2026-07-19', 2, 90)];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 2, change: null });
  });

  it('直近5件が全てcomposite<50なら降格する', () => {
    const profile = makeProfile(3);
    const lessons = [
      lesson('2026-07-16', 3, 40),
      lesson('2026-07-17', 3, 30),
      lesson('2026-07-18', 2, 20),
      lesson('2026-07-19', 3, 45),
      lesson('2026-07-20', 3, 10),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 2, change: 'demote' });
  });

  it('composite=50ちょうどは降格対象に数えない（境界値・<50のみ対象）', () => {
    const profile = makeProfile(3);
    const lessons = [
      lesson('2026-07-16', 3, 40),
      lesson('2026-07-17', 3, 30),
      lesson('2026-07-18', 3, 50),
      lesson('2026-07-19', 3, 45),
      lesson('2026-07-20', 3, 10),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: null });
  });

  it('レベル下限(1)では条件を満たしても降格しない', () => {
    const profile = makeProfile(1);
    const lessons = [
      lesson('2026-07-16', 1, 10),
      lesson('2026-07-17', 1, 10),
      lesson('2026-07-18', 1, 10),
      lesson('2026-07-19', 1, 10),
      lesson('2026-07-20', 1, 10),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 1, change: null });
  });

  it('直近レッスンが5件未満なら降格しない', () => {
    const profile = makeProfile(3);
    const lessons = [lesson('2026-07-19', 3, 10), lesson('2026-07-20', 3, 10)];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: null });
  });

  it('昇格から2日後は降格しない（猶予期間中）', () => {
    const profile = makeProfile(3, [{ date: '2026-07-18', level: 3, reason: 'promote' }]);
    const lessons = [
      lesson('2026-07-16', 3, 10),
      lesson('2026-07-17', 3, 10),
      lesson('2026-07-18', 3, 10),
      lesson('2026-07-19', 3, 10),
      lesson('2026-07-20', 3, 10),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: null });
  });

  it('昇格からちょうど3日後は猶予内として降格しない（境界値・以内=inclusive）', () => {
    const profile = makeProfile(3, [{ date: '2026-07-17', level: 3, reason: 'promote' }]);
    const lessons = [
      lesson('2026-07-16', 3, 10),
      lesson('2026-07-17', 3, 10),
      lesson('2026-07-18', 3, 10),
      lesson('2026-07-19', 3, 10),
      lesson('2026-07-20', 3, 10),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: null });
  });

  it('昇格から4日後は猶予が切れて降格する', () => {
    const profile = makeProfile(3, [{ date: '2026-07-16', level: 3, reason: 'promote' }]);
    const lessons = [
      lesson('2026-07-16', 3, 10),
      lesson('2026-07-17', 3, 10),
      lesson('2026-07-18', 3, 10),
      lesson('2026-07-19', 3, 10),
      lesson('2026-07-20', 3, 10),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 2, change: 'demote' });
  });

  it('recentLessonsが日付順不同で渡されても正しく判定する', () => {
    const profile = makeProfile(2);
    const lessons = [
      lesson('2026-07-20', 2, 40),
      lesson('2026-07-17', 2, 80),
      lesson('2026-07-19', 2, 80),
      lesson('2026-07-16', 2, 80),
      lesson('2026-07-18', 2, 80),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: 'promote' });
  });

  it('母集団が異なり昇格・降格の両条件が成立し得る場合は昇格を優先する', () => {
    const profile = makeProfile(2);
    const lessons = [
      // 直近5件（レベル問わず）は全て現レベル未満かつcomposite<50 → 降格条件を満たす
      lesson('2026-07-20', 1, 10),
      lesson('2026-07-19', 1, 20),
      lesson('2026-07-18', 1, 15),
      lesson('2026-07-17', 1, 25),
      lesson('2026-07-16', 1, 5),
      // 現レベル以上のレッスンだけを見ると直近5件は高得点 → 昇格条件を満たす
      lesson('2026-07-10', 2, 90),
      lesson('2026-07-09', 2, 90),
      lesson('2026-07-08', 2, 90),
      lesson('2026-07-07', 2, 90),
      lesson('2026-07-06', 3, 90),
    ];
    const result = applyLevelProgress(profile, lessons, TODAY);
    expect(result).toEqual({ level: 3, change: 'promote' });
  });
});
