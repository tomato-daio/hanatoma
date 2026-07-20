import { describe, expect, it } from 'vitest';
import { calcSessionXp, RANK_NAMES, rankFromXp, xpForRank } from './xp';
import type { CalcSessionXpInput } from './xp';

const base: CalcSessionXpInput = {
  mode: 'lesson',
  objectivesAchieved: 0,
  allKeyPhrasesDone: false,
  questsCompleted: 0,
  bossWin: false,
  modelAnswersShown: 0,
  streak: 0,
  isFirstSessionToday: false,
};

function breakdownSum(result: ReturnType<typeof calcSessionXp>): number {
  return result.breakdown.reduce((sum, item) => sum + item.amount, 0);
}

describe('calcSessionXp', () => {
  it('2回目以降(初回でない)はレッスン基礎点50が50%減衰してceil(25)になる', () => {
    const result = calcSessionXp({ ...base });
    expect(result.xp).toBe(25);
    expect(breakdownSum(result)).toBe(result.xp);
  });

  it('本日初回セッションは+30ボーナスが乗る(減衰なし)', () => {
    const result = calcSessionXp({ ...base, isFirstSessionToday: true });
    expect(result.xp).toBe(50 + 30);
    expect(breakdownSum(result)).toBe(result.xp);
  });

  it('quick/biteの基礎点が正しい', () => {
    const quick = calcSessionXp({ ...base, mode: 'quick', isFirstSessionToday: true });
    expect(quick.xp).toBe(25 + 30);
    const bite = calcSessionXp({ ...base, mode: 'bite', isFirstSessionToday: true });
    expect(bite.xp).toBe(10 + 30);
  });

  it('diagnosticモードはXP対象外(基礎点0)', () => {
    const result = calcSessionXp({ ...base, mode: 'diagnostic', isFirstSessionToday: true });
    expect(result.xp).toBe(0 + 30);
  });

  it('目標達成・キーフレーズ全✓・クエスト達成が加点される', () => {
    const result = calcSessionXp({
      ...base,
      objectivesAchieved: 2,
      allKeyPhrasesDone: true,
      questsCompleted: 1,
    });
    // 基礎50 + 目標20 + キーフレーズ20 + クエスト30 = 120 → 2回目以降50%でceil(60)
    expect(result.xp).toBe(60);
    expect(breakdownSum(result)).toBe(result.xp);
  });

  it('模範解答を見た分は1件5点減点され下限0でクリップされる', () => {
    const result = calcSessionXp({ ...base, mode: 'diagnostic', modelAnswersShown: 10 });
    // 基礎0 - 50 = -50 → 下限0 → 2回目以降50%でも0
    expect(result.xp).toBe(0);
    expect(breakdownSum(result)).toBe(0);
  });

  it('ストリーク倍率は streak=25 で上限1.5倍になる', () => {
    const at25 = calcSessionXp({ ...base, streak: 25, isFirstSessionToday: true });
    const at100 = calcSessionXp({ ...base, streak: 100, isFirstSessionToday: true });
    // 基礎50 * 1.5 = 75 → +30 = 105。streak100でも25で頭打ちのため同じ値。
    expect(at25.xp).toBe(105);
    expect(at100.xp).toBe(105);
  });

  it('ボス勝利時は基礎点150、未勝利は基礎点0(挑戦のみでは加点なし)', () => {
    const win = calcSessionXp({ ...base, mode: 'boss', bossWin: true, isFirstSessionToday: true });
    expect(win.xp).toBe(150 + 30);

    const lose = calcSessionXp({ ...base, mode: 'boss', bossWin: false, objectivesAchieved: 1 });
    // 基礎0 + 目標10 = 10 → 2回目以降50%でceil(5)
    expect(lose.xp).toBe(5);
  });

  it('breakdownの合計は常にxpと一致する(内訳表示に使える不変条件)', () => {
    const cases: CalcSessionXpInput[] = [
      { ...base, streak: 3, objectivesAchieved: 1, modelAnswersShown: 2, isFirstSessionToday: true },
      { ...base, mode: 'boss', bossWin: true, streak: 12, questsCompleted: 2 },
      { ...base, mode: 'quick', allKeyPhrasesDone: true, modelAnswersShown: 4, streak: 30 },
    ];
    for (const input of cases) {
      const result = calcSessionXp(input);
      expect(breakdownSum(result)).toBe(result.xp);
    }
  });
});

describe('xpForRank / rankFromXp', () => {
  it('xpForRank(n) = 50*n*(n+1)', () => {
    expect(xpForRank(0)).toBe(0);
    expect(xpForRank(1)).toBe(100);
    expect(xpForRank(2)).toBe(300);
    expect(xpForRank(3)).toBe(600);
  });

  it('rankFromXpは閾値未満なら1つ下のランクを返す', () => {
    expect(rankFromXp(0)).toBe(0);
    expect(rankFromXp(99)).toBe(0);
    expect(rankFromXp(100)).toBe(1);
    expect(rankFromXp(299)).toBe(1);
    expect(rankFromXp(300)).toBe(2);
  });

  it('RANK_NAMESは10段で末尾が伝説', () => {
    expect(RANK_NAMES.length).toBe(10);
    expect(RANK_NAMES[0]).toBe('見習い');
    expect(RANK_NAMES[RANK_NAMES.length - 1]).toBe('伝説');
  });

  it('最高ランク到達後はそれ以上XPが増えても頭打ちになる', () => {
    const maxRank = RANK_NAMES.length - 1;
    expect(rankFromXp(xpForRank(maxRank))).toBe(maxRank);
    expect(rankFromXp(xpForRank(maxRank) + 1_000_000)).toBe(maxRank);
  });
});
