// backup.tsはDOM APIに依存しない。jsdom環境ではfake-indexeddbのstructuredCloneが
// jsdom製Blobをプレーンオブジェクトに壊してしまう（Node側のstructuredCloneがjsdom Blobを
// 認識できないため）ので、node環境で実行しBlobをNodeネイティブのまま扱えるようにする。
// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportAllData, importAllData, type BackupBundle } from './backup';
import {
  getAppState,
  getConversation,
  getScenario,
  getUserProfile,
  putConversation,
  putScenario,
  putUserProfile,
  resetDBForTest,
  setAppState,
} from './db';
import type { Conversation, Scenario } from './types';

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

async function readBundle(blob: Blob): Promise<BackupBundle> {
  return JSON.parse(await blob.text()) as BackupBundle;
}

function makeEmptyBundle(appState: BackupBundle['appState']): BackupBundle {
  return {
    app: 'hanatoma',
    version: 1,
    exportedAt: Date.now(),
    includesAudio: false,
    scenarios: [],
    conversations: [],
    correctionReports: [],
    expressions: [],
    userProfile: [],
    questState: [],
    usageLog: [],
    appState,
  };
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'gen-1',
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
    steps: [],
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
    status: 'completed',
    turns: [
      { role: 'ai', text: 'Hi there!', at: 1, phase: 'guided' },
      {
        role: 'user',
        text: 'I would like a latte.',
        at: 2,
        phase: 'guided',
        inputMode: 'voice',
        audioBlob: new Blob(['fake-audio-bytes']),
        mimeType: 'audio/webm',
      },
    ],
    ...overrides,
  };
}

describe('exportAllData (DESIGN.md §0: APIキーの除外)', () => {
  it('azureSpeechKeyとanthropicApiKeyをエクスポートから除外する', async () => {
    await setAppState('azureSpeechKey', 'azure-secret');
    await setAppState('anthropicApiKey', 'sk-secret');
    await setAppState('ttsVoice', 'en-US-JennyNeural');

    const blob = await exportAllData();
    const bundle = await readBundle(blob);

    expect(bundle.appState.some((e) => e.key === 'azureSpeechKey')).toBe(false);
    expect(bundle.appState.some((e) => e.key === 'anthropicApiKey')).toBe(false);
    expect(bundle.appState.find((e) => e.key === 'ttsVoice')?.value).toBe('en-US-JennyNeural');
  });

  it('turns[].audioBlobは既定では含めない', async () => {
    await putConversation(makeConversation());

    const blob = await exportAllData();
    const bundle = await readBundle(blob);

    expect(bundle.includesAudio).toBe(false);
    const userTurn = bundle.conversations[0].turns[1];
    expect(userTurn.audioBlob).toBeUndefined();
    // テキストや発話モードなど音声以外の情報は残る
    expect(userTurn.text).toBe('I would like a latte.');
    expect(userTurn.inputMode).toBe('voice');
  });

  it('includeAudio:trueならturns[].audioBlobをbase64で含める', async () => {
    await putConversation(makeConversation());

    const blob = await exportAllData({ includeAudio: true });
    const bundle = await readBundle(blob);

    expect(bundle.includesAudio).toBe(true);
    const userTurn = bundle.conversations[0].turns[1];
    expect(userTurn.audioBlob?.mimeType).toBe('audio/webm');
    expect(typeof userTurn.audioBlob?.base64).toBe('string');
    expect(userTurn.audioBlob?.base64.length).toBeGreaterThan(0);
  });
});

describe('importAllData (DESIGN.md §0: 復元時も既存キーを消さない)', () => {
  it('インポート後も端末に保存済みのAPIキーを保持する', async () => {
    await setAppState('azureSpeechKey', 'original-azure-secret');
    await setAppState('anthropicApiKey', 'original-anthropic-secret');

    const bundle = makeEmptyBundle([{ key: 'ttsVoice', value: 'en-US-GuyNeural' }]);
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });

    await importAllData(blob);

    expect(await getAppState('azureSpeechKey')).toBe('original-azure-secret');
    expect(await getAppState('anthropicApiKey')).toBe('original-anthropic-secret');
    expect(await getAppState('ttsVoice')).toBe('en-US-GuyNeural');
  });

  it('バックアップ側にAPIキーが含まれていても取り込まない（未設定なら未設定のまま）', async () => {
    const bundle = makeEmptyBundle([{ key: 'azureSpeechKey', value: 'from-shared-backup-file' }]);
    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });

    await importAllData(blob);

    expect(await getAppState('azureSpeechKey')).toBeUndefined();
  });

  it('JSONとして壊れているファイルはエラーを投げる', async () => {
    const blob = new Blob(['not json'], { type: 'application/json' });
    await expect(importAllData(blob)).rejects.toThrow();
  });

  it('はなとまのバックアップでないファイルはエラーを投げる', async () => {
    const blob = new Blob([JSON.stringify({ app: 'shadotoma', version: 1 })], { type: 'application/json' });
    await expect(importAllData(blob)).rejects.toThrow();
  });
});

describe('往復（export→import）でデータが一致する', () => {
  it('scenarios/userProfileが往復で一致する', async () => {
    await putScenario(makeScenario());
    const profile = await getUserProfile();
    await putUserProfile({ ...profile, xp: 250, level: 3 });

    const blob = await exportAllData();
    await importAllData(blob);

    expect(await getScenario('gen-1')).toEqual(makeScenario());
    const restoredProfile = await getUserProfile();
    expect(restoredProfile.xp).toBe(250);
    expect(restoredProfile.level).toBe(3);
  });

  it('audioBlobを含めてエクスポートした会話は、往復後も音声データが復元される', async () => {
    await putConversation(makeConversation());

    const blob = await exportAllData({ includeAudio: true });
    await importAllData(blob);

    const restored = await getConversation('conv-1');
    const userTurn = restored?.turns[1];
    expect(userTurn?.audioBlob).toBeInstanceOf(Blob);
    expect(userTurn?.audioBlob?.type).toBe('audio/webm');
    const text = await userTurn?.audioBlob?.text();
    expect(text).toBe('fake-audio-bytes');
  });

  it('audioBlobを含めずにエクスポートした会話は、往復後は音声無しで復元される（他の情報は残る）', async () => {
    await putConversation(makeConversation());

    const blob = await exportAllData();
    await importAllData(blob);

    const restored = await getConversation('conv-1');
    const userTurn = restored?.turns[1];
    expect(userTurn?.audioBlob).toBeUndefined();
    expect(userTurn?.text).toBe('I would like a latte.');
  });
});
