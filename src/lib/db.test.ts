import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addUsage,
  deleteAppState,
  deleteExpression,
  deleteScenario,
  getAppState,
  getConversation,
  getCorrectionReport,
  getQuestState,
  getReportByConversation,
  getScenario,
  getUsageDay,
  getUserProfile,
  listConversations,
  listConversationsByDate,
  listCorrectionReports,
  listExpressions,
  listGeneratedScenarios,
  putConversation,
  putCorrectionReport,
  putExpression,
  putQuestState,
  putScenario,
  putUserProfile,
  resetDBForTest,
  setAppState,
} from './db';
import type {
  Conversation,
  CorrectionReport,
  ExpressionItem,
  Scenario,
  UserProfile,
} from './types';

beforeEach(async () => {
  await resetDBForTest();
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

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'gen-test-1',
    source: 'generated',
    title: 'Ordering coffee',
    titleJa: 'コーヒーを注文する',
    category: 'restaurant',
    level: 2,
    setting: 'A small cafe.',
    aiRole: 'barista',
    userRole: 'customer',
    goal: 'Order a drink.',
    goalJa: '飲み物を注文する。',
    keyPhrases: [{ en: 'Can I get a latte?', ja: 'ラテをください。' }],
    steps: [{ aiIntent: 'greet the customer', hintJa: '挨拶する', hintEn: 'Hi,', modelAnswer: 'Hi there!' }],
    hiddenObjectives: [],
    estimatedMinutes: 8,
    freeTalkPrompt: 'Chat about your day.',
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    scenarioId: 'b-restaurant-001',
    mode: 'lesson',
    date: '2026-07-18',
    startedAt: 1000,
    status: 'active',
    turns: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<CorrectionReport> = {}): CorrectionReport {
  return {
    id: 'report-1',
    conversationId: 'conv-1',
    date: '2026-07-18',
    createdAt: 1000,
    items: [],
    rephrases: [],
    learnedExpressions: [],
    objectivesAchieved: [],
    grammarErrorCount: 0,
    pronunciationComments: [],
    summaryJa: 'よくできました。',
    ...overrides,
  };
}

function makeExpression(overrides: Partial<ExpressionItem> = {}): ExpressionItem {
  return {
    id: 'expr-1',
    en: 'by the way',
    ja: 'ところで',
    addedAt: 1000,
    useCount: 0,
    ...overrides,
  };
}

describe('scenarios CRUD', () => {
  it('保存したシナリオを取得できる', async () => {
    await putScenario(makeScenario());
    const fetched = await getScenario('gen-test-1');
    expect(fetched?.title).toBe('Ordering coffee');
  });

  it('listGeneratedScenariosはsource:generatedのみ返す', async () => {
    await putScenario(makeScenario({ id: 'gen-a' }));
    await putScenario(makeScenario({ id: 'gen-b' }));

    const list = await listGeneratedScenarios();
    expect(list.map((s) => s.id).sort()).toEqual(['gen-a', 'gen-b']);
  });

  it('deleteScenarioで削除できる', async () => {
    await putScenario(makeScenario());
    await deleteScenario('gen-test-1');
    expect(await getScenario('gen-test-1')).toBeUndefined();
  });
});

describe('conversations CRUD', () => {
  it('保存した会話を取得できる', async () => {
    await putConversation(makeConversation());
    const fetched = await getConversation('conv-1');
    expect(fetched?.scenarioId).toBe('b-restaurant-001');
  });

  it('listConversationsは開始時刻の新しい順に返し、limitで件数を絞れる', async () => {
    await putConversation(makeConversation({ id: 'conv-old', startedAt: 100 }));
    await putConversation(makeConversation({ id: 'conv-mid', startedAt: 200 }));
    await putConversation(makeConversation({ id: 'conv-new', startedAt: 300 }));

    const all = await listConversations();
    expect(all.map((c) => c.id)).toEqual(['conv-new', 'conv-mid', 'conv-old']);

    const limited = await listConversations(2);
    expect(limited.map((c) => c.id)).toEqual(['conv-new', 'conv-mid']);
  });

  it('listConversationsByDateは指定日の会話のみ返す', async () => {
    await putConversation(makeConversation({ id: 'conv-a', date: '2026-07-17' }));
    await putConversation(makeConversation({ id: 'conv-b', date: '2026-07-18' }));

    const list = await listConversationsByDate('2026-07-18');
    expect(list.map((c) => c.id)).toEqual(['conv-b']);
  });
});

describe('correctionReports CRUD', () => {
  it('保存したレポートを取得できる', async () => {
    await putCorrectionReport(makeReport());
    const fetched = await getCorrectionReport('report-1');
    expect(fetched?.summaryJa).toBe('よくできました。');
  });

  it('getReportByConversationは会話IDからレポートを引ける', async () => {
    await putCorrectionReport(makeReport());
    const fetched = await getReportByConversation('conv-1');
    expect(fetched?.id).toBe('report-1');
  });

  it('listCorrectionReportsは作成日時の新しい順に返し、limitで件数を絞れる', async () => {
    await putCorrectionReport(makeReport({ id: 'r-old', createdAt: 100 }));
    await putCorrectionReport(makeReport({ id: 'r-new', createdAt: 200 }));

    const list = await listCorrectionReports(1);
    expect(list.map((r) => r.id)).toEqual(['r-new']);
  });
});

describe('expressions CRUD', () => {
  it('保存した表現を一覧取得できる（追加日時の新しい順）', async () => {
    await putExpression(makeExpression({ id: 'e-old', addedAt: 100 }));
    await putExpression(makeExpression({ id: 'e-new', addedAt: 200 }));

    const list = await listExpressions();
    expect(list.map((e) => e.id)).toEqual(['e-new', 'e-old']);
  });

  it('deleteExpressionで削除できる', async () => {
    await putExpression(makeExpression());
    await deleteExpression('expr-1');
    expect((await listExpressions()).length).toBe(0);
  });
});

describe('userProfile', () => {
  it('レコードが無ければ初期値で新規作成して返す', async () => {
    const profile = await getUserProfile();

    expect(profile.key).toBe('main');
    expect(profile.level).toBe(2);
    expect(profile.xp).toBe(0);
    expect(profile.restTickets).toBe(0);
    expect(profile.badges).toEqual([]);
    expect(profile.interests).toEqual([]);
    expect(profile.levelHistory).toEqual([]);
    expect(typeof profile.createdAt).toBe('number');
  });

  it('一度作成した初期値は再取得しても同じcreatedAtのまま永続化されている', async () => {
    const first = await getUserProfile();
    const second = await getUserProfile();
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('putUserProfileで更新した内容がgetUserProfileに反映される', async () => {
    const profile = await getUserProfile();
    const updated: UserProfile = { ...profile, xp: 120, level: 3 };
    await putUserProfile(updated);

    const fetched = await getUserProfile();
    expect(fetched.xp).toBe(120);
    expect(fetched.level).toBe(3);
  });
});

describe('questState', () => {
  it('保存したクエスト状態を日付で取得できる', async () => {
    await putQuestState({ date: '2026-07-18', quests: [{ id: 'q1', progress: 1, target: 3, done: false }] });

    const state = await getQuestState('2026-07-18');
    expect(state?.quests).toHaveLength(1);
  });

  it('存在しない日付はundefinedを返す', async () => {
    expect(await getQuestState('2026-01-01')).toBeUndefined();
  });
});

describe('usageLog', () => {
  it('レコードが無い日は全0のUsageDayを返す（永続化はしない）', async () => {
    const usage = await getUsageDay('2026-07-18');
    expect(usage).toEqual({
      date: '2026-07-18',
      haikuCalls: 0,
      sonnetCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      paSeconds: 0,
      ttsChars: 0,
      sessionsStarted: 0,
    });
  });

  it('addUsageは既存レコードに加算マージする', async () => {
    await addUsage('2026-07-18', { haikuCalls: 1, inputTokens: 100 });
    await addUsage('2026-07-18', { haikuCalls: 2, sonnetCalls: 1, outputTokens: 50 });

    const usage = await getUsageDay('2026-07-18');
    expect(usage.haikuCalls).toBe(3);
    expect(usage.sonnetCalls).toBe(1);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it('addUsageは他の日付のレコードに影響しない', async () => {
    await addUsage('2026-07-17', { sonnetCalls: 5 });
    await addUsage('2026-07-18', { sonnetCalls: 1 });

    expect((await getUsageDay('2026-07-17')).sonnetCalls).toBe(5);
    expect((await getUsageDay('2026-07-18')).sonnetCalls).toBe(1);
  });
});

describe('appState', () => {
  it('setAppState/getAppStateで文字列値を往復できる', async () => {
    await setAppState('ttsVoice', 'en-US-JennyNeural');
    expect(await getAppState<string>('ttsVoice')).toBe('en-US-JennyNeural');
  });

  it('真偽値・配列・オブジェクト(DailyCaps)も往復できる', async () => {
    await setAppState('saveTurnAudio', false);
    await setAppState('interestsCache', ['travel', 'work']);
    await setAppState('dailyCaps', { sessions: 3, sonnetCalls: 8, paMinutes: 30 });

    expect(await getAppState<boolean>('saveTurnAudio')).toBe(false);
    expect(await getAppState<string[]>('interestsCache')).toEqual(['travel', 'work']);
    expect(await getAppState('dailyCaps')).toEqual({ sessions: 3, sonnetCalls: 8, paMinutes: 30 });
  });

  it('存在しないキーはundefinedを返す', async () => {
    expect(await getAppState('doesNotExist')).toBeUndefined();
  });

  it('deleteAppStateで削除できる', async () => {
    await setAppState('anthropicApiKey', 'sk-test');
    await deleteAppState('anthropicApiKey');
    expect(await getAppState('anthropicApiKey')).toBeUndefined();
  });
});
