import { describe, expect, it } from 'vitest';
import { applyQuestEvent, pickDailyQuests, QUEST_CATALOG } from './quests';
import type { QuestState } from '../types';

function baseIdOf(questId: string): string {
  const i = questId.indexOf(':');
  return i === -1 ? questId : questId.slice(0, i);
}

describe('pickDailyQuests', () => {
  it('同じ引数なら常に同じ3件を返す(決定性)', () => {
    const a = pickDailyQuests('2026-07-20', 3, ['R', 'TH']);
    const b = pickDailyQuests('2026-07-20', 3, ['R', 'TH']);
    expect(b).toEqual(a);
    expect(a.length).toBe(3);
  });

  it('弱点音素が空の日は音素クエストが選ばれない', () => {
    for (const date of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']) {
      const quests = pickDailyQuests(date, 5, []);
      expect(quests.some((q) => baseIdOf(q.id) === 'quest-phoneme-word')).toBe(false);
    }
  });

  it('レベル1では高レベル限定クエスト(minLevel3/4)が選ばれない', () => {
    for (const date of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']) {
      const quests = pickDailyQuests(date, 1, ['R']);
      const ids = quests.map((q) => baseIdOf(q.id));
      expect(ids).not.toContain('quest-new-expressions-5');
      expect(ids).not.toContain('quest-pa-high-8');
    }
  });

  it('弱点音素が指定された日の音素クエストは合成idにその音素を含む', () => {
    // 弱点音素クエストが選ばれる日が見つかるまで探索する(選択自体は決定的なので固定日でも良いが、
    // 特定の日に依存しすぎないよう複数日から拾う)。
    let found: string | undefined;
    for (let day = 1; day <= 28 && !found; day++) {
      const date = `2026-08-${String(day).padStart(2, '0')}`;
      const quests = pickDailyQuests(date, 5, ['R', 'TH', 'V']);
      const hit = quests.find((q) => baseIdOf(q.id) === 'quest-phoneme-word');
      if (hit) found = hit.id;
    }
    expect(found).toBeDefined();
    const phoneme = (found as string).slice((found as string).indexOf(':') + 1);
    expect(['R', 'TH', 'V']).toContain(phoneme);
  });

  it('選ばれたクエストのidはすべてカタログに存在する', () => {
    const quests = pickDailyQuests('2026-09-10', 5, ['R']);
    const catalogIds = new Set(QUEST_CATALOG.map((e) => e.id));
    for (const q of quests) {
      expect(catalogIds.has(baseIdOf(q.id))).toBe(true);
      expect(q.progress).toBe(0);
      expect(q.done).toBe(false);
    }
  });
});

describe('applyQuestEvent', () => {
  function questStateOf(id: string, target: number): QuestState {
    return { date: '2026-07-20', quests: [{ id, progress: 0, target, done: false }] };
  }

  it('sessionDoneはtarget1のクエストを即完了させる', () => {
    const state = questStateOf('quest-scenario-complete', 1);
    const next = applyQuestEvent(state, { type: 'sessionDone' });
    expect(next.quests[0].progress).toBe(1);
    expect(next.quests[0].done).toBe(true);
  });

  it('countを指定しない場合は1ずつ進捗する', () => {
    let state = questStateOf('quest-pa-high-5', 5);
    for (let i = 0; i < 4; i++) {
      state = applyQuestEvent(state, { type: 'paHighTurn' });
    }
    expect(state.quests[0].progress).toBe(4);
    expect(state.quests[0].done).toBe(false);

    state = applyQuestEvent(state, { type: 'paHighTurn' });
    expect(state.quests[0].progress).toBe(5);
    expect(state.quests[0].done).toBe(true);
  });

  it('countを指定すればまとめて進捗する', () => {
    const state = questStateOf('quest-new-expressions-3', 3);
    const next = applyQuestEvent(state, { type: 'newExpressionsUsed', count: 3 });
    expect(next.quests[0].progress).toBe(3);
    expect(next.quests[0].done).toBe(true);
  });

  it('進捗はtargetを超えない(下限target)', () => {
    const state = questStateOf('quest-quick-2', 2);
    const next = applyQuestEvent(state, { type: 'quickDone', count: 10 });
    expect(next.quests[0].progress).toBe(2);
    expect(next.quests[0].done).toBe(true);
  });

  it('phonemeWordSpokenは合成idの音素と一致した場合のみ進捗する', () => {
    const state = questStateOf('quest-phoneme-word:R', 3);
    const mismatched = applyQuestEvent(state, { type: 'phonemeWordSpoken', phoneme: 'TH' });
    expect(mismatched.quests[0].progress).toBe(0);

    const matched = applyQuestEvent(state, { type: 'phonemeWordSpoken', phoneme: 'R' });
    expect(matched.quests[0].progress).toBe(1);
  });

  it('達成済みクエストはイベントを受けても変化しない', () => {
    const doneState: QuestState = {
      date: '2026-07-20',
      quests: [{ id: 'quest-scenario-complete', progress: 1, target: 1, done: true }],
    };
    const next = applyQuestEvent(doneState, { type: 'sessionDone' });
    expect(next.quests[0]).toEqual(doneState.quests[0]);
  });

  it('種類の異なるイベントは無関係なクエストに影響しない', () => {
    const state = questStateOf('quest-quick-2', 2);
    const next = applyQuestEvent(state, { type: 'sessionDone' });
    expect(next.quests[0].progress).toBe(0);
  });
});
