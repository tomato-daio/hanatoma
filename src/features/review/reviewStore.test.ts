import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppState, getUserProfile, putUserProfile, resetDBForTest } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { REVIEW_SET_XP, type ReviewCard } from '../../lib/review/reviewCards';
import type { ReviewStats } from '../../lib/types';
import { resetSisterDataCache } from '../sisterApp/shadotomaBridge';
import { finishReviewSet, getReviewDates, loadReviewDeck } from './reviewStore';

beforeEach(async () => {
  await resetDBForTest();
  resetSisterDataCache();
});

afterEach(async () => {
  await resetDBForTest();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('hanatoma');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error as Error);
    req.onblocked = () => resolve();
  });
});

const CARDS: ReviewCard[] = [
  { key: 'ex:e1', en: 'I would like a table for two.', ja: '2名席をお願いします。', source: 'expression' },
  { key: 'kp:b-x-001:the check, please.', en: 'The check, please.', ja: 'お会計をお願いします', source: 'keyphrase' },
];

describe('finishReviewSet', () => {
  it('今日初めてのセット完走で +XP・reviewDatesに今日を記録・streak=1（shadotoma不在）', async () => {
    const before = await getUserProfile();
    const result = await finishReviewSet(
      [
        { key: 'ex:e1', remembered: true },
        { key: CARDS[1].key, remembered: false },
      ],
      CARDS,
    );

    expect(result.isFirstSetToday).toBe(true);
    expect(result.xpAwarded).toBe(REVIEW_SET_XP);
    expect(result.rememberedCount).toBe(1);
    expect(result.againCount).toBe(1);
    expect(result.streak).toBe(1);

    const after = await getUserProfile();
    expect(after.xp).toBe(before.xp + REVIEW_SET_XP);

    const today = learningDate(new Date());
    expect(await getReviewDates()).toEqual([today]);

    const stats = (await getAppState<ReviewStats>('reviewStats')) ?? {};
    expect(stats['ex:e1'].repetition).toBe(1);
    expect(stats[CARDS[1].key].againCount).toBe(1);
  });

  it('同日2セット目はXP 0・reviewDatesは重複しない・SRS状態は更新される', async () => {
    await finishReviewSet([{ key: 'ex:e1', remembered: false }], CARDS);
    const beforeXp = (await getUserProfile()).xp;

    const second = await finishReviewSet([{ key: 'ex:e1', remembered: true }], CARDS);
    expect(second.isFirstSetToday).toBe(false);
    expect(second.xpAwarded).toBe(0);

    expect((await getUserProfile()).xp).toBe(beforeXp);
    expect(await getReviewDates()).toHaveLength(1);

    const stats = (await getAppState<ReviewStats>('reviewStats')) ?? {};
    expect(stats['ex:e1'].reviewCount).toBe(2);
    expect(stats['ex:e1'].repetition).toBe(1);
  });

  it('現存カードにないSRS状態はセット完走時に掃除される', async () => {
    await finishReviewSet([{ key: 'ex:deleted', remembered: true }], CARDS);
    const stats = (await getAppState<ReviewStats>('reviewStats')) ?? {};
    expect(stats['ex:deleted']).toBeUndefined();
  });

  it('XP付与前のprofileが存在しなくても初期プロファイルに加算される', async () => {
    await putUserProfile({ ...(await getUserProfile()), xp: 40 });
    await finishReviewSet([{ key: 'ex:e1', remembered: true }], CARDS);
    expect((await getUserProfile()).xp).toBe(40 + REVIEW_SET_XP);
  });
});

describe('loadReviewDeck', () => {
  it('会話も表現も無ければ空デッキを返す', async () => {
    const deck = await loadReviewDeck();
    expect(deck.cards).toEqual([]);
    expect(deck.stats).toEqual({});
  });
});
