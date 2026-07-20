/**
 * IndexedDB永続化層（DESIGN.md §3・M1）。
 * shadotoma src/lib/db.ts の構成（DBSchema型 + 薄いCRUD関数 + fake-indexeddbテスト）を踏襲する。
 * 型は全てsrc/lib/types.ts（正本）からimportし、ここでは再定義しない。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Conversation,
  CorrectionReport,
  DailyCaps,
  ExpressionItem,
  QuestState,
  ReviewStats,
  Scenario,
  UsageDay,
  UserProfile,
} from './types';

/**
 * 韻律非対応リージョンの当日キャッシュ（appState 'paProsodyFallback'。DESIGN.md §6a）。
 * 「この学習日にこのリージョンで韻律あり評価が失敗し、韻律なしフォールバックが成功した」の記録。
 */
export interface PaProsodyFallbackState {
  region: string;
  /** learningDate形式 (YYYY-MM-DD)。日付が変わると不一致になり自動で再プローブされる。 */
  date: string;
}

/**
 * appStateに保存する値の型（DESIGN.md §3末尾のkeys一覧に対応）。
 * types.tsには存在しないため、shadotoma同様このファイルで定義する
 * （appStateは素朴なkey-valueであり、DBSchemaの都合以外でtypes.tsに置く理由が無いため）。
 * ReviewStats（'reviewStats'）とreviewDates（string[]）はサイレント復習（DESIGN.md §4b）が使う。
 * appStateはスキーマレスなためDBバージョンは1のまま。
 */
export type AppStateValue =
  | string
  | number
  | boolean
  | string[]
  | DailyCaps
  | ReviewStats
  | PaProsodyFallbackState;

interface AppStateRecord {
  key: string;
  value: AppStateValue;
}

interface HanatomaDBSchema extends DBSchema {
  scenarios: {
    key: string;
    value: Scenario;
  };
  conversations: {
    key: string;
    value: Conversation;
    indexes: { 'by-date': string };
  };
  correctionReports: {
    key: string;
    value: CorrectionReport;
    indexes: { 'by-conversation': string };
  };
  expressions: {
    key: string;
    value: ExpressionItem;
  };
  userProfile: {
    key: string;
    value: UserProfile;
  };
  questState: {
    key: string;
    value: QuestState;
  };
  usageLog: {
    key: string;
    value: UsageDay;
  };
  appState: {
    key: string;
    value: AppStateRecord;
  };
}

const DB_NAME = 'hanatoma';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<HanatomaDBSchema>> | null = null;

export function getDB(): Promise<IDBPDatabase<HanatomaDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<HanatomaDBSchema>(DB_NAME, DB_VERSION, {
      // 新しいバージョンのタブがアップグレードを待っているとき、この接続を手放して
      // 全タブが永久に固まるのを防ぐ（この接続の次回利用時は再オープンされる）。
      blocking(_currentVersion, _blockedVersion, _event) {
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
      upgrade(db) {
        if (!db.objectStoreNames.contains('scenarios')) {
          db.createObjectStore('scenarios', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('conversations')) {
          const store = db.createObjectStore('conversations', { keyPath: 'id' });
          store.createIndex('by-date', 'date');
        }
        if (!db.objectStoreNames.contains('correctionReports')) {
          const store = db.createObjectStore('correctionReports', { keyPath: 'id' });
          store.createIndex('by-conversation', 'conversationId');
        }
        if (!db.objectStoreNames.contains('expressions')) {
          db.createObjectStore('expressions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('userProfile')) {
          db.createObjectStore('userProfile', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('questState')) {
          db.createObjectStore('questState', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('usageLog')) {
          db.createObjectStore('usageLog', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('appState')) {
          db.createObjectStore('appState', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/** テスト用: 開いているDB接続を閉じてキャッシュをリセットする。 */
export async function resetDBForTest(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
  }
  dbPromise = null;
}

// ---- appState ----

export async function getAppState<T extends AppStateValue = AppStateValue>(
  key: string,
): Promise<T | undefined> {
  const db = await getDB();
  const record = await db.get('appState', key);
  return record?.value as T | undefined;
}

export async function setAppState(key: string, value: AppStateValue): Promise<void> {
  const db = await getDB();
  await db.put('appState', { key, value });
}

export async function deleteAppState(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('appState', key);
}

// ---- scenarios（動的生成分のみ。バンドル初期パックはpublic/scenarios/index.jsonから毎回fetch） ----

export async function putScenario(scenario: Scenario): Promise<void> {
  const db = await getDB();
  await db.put('scenarios', scenario);
}

export async function getScenario(id: string): Promise<Scenario | undefined> {
  const db = await getDB();
  return db.get('scenarios', id);
}

/** このストアには生成シナリオ(source:'generated')のみが入る想定だが、念のため絞り込む。 */
export async function listGeneratedScenarios(): Promise<Scenario[]> {
  const db = await getDB();
  const all = await db.getAll('scenarios');
  return all.filter((s) => s.source === 'generated');
}

export async function deleteScenario(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('scenarios', id);
}

// ---- conversations（1レッスン=1レコード） ----

export async function putConversation(conversation: Conversation): Promise<void> {
  const db = await getDB();
  await db.put('conversations', conversation);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const db = await getDB();
  return db.get('conversations', id);
}

/** 開始時刻の新しい順に返す（進捗ページ等の一覧表示用）。limit省略時は全件。 */
export async function listConversations(limit?: number): Promise<Conversation[]> {
  const db = await getDB();
  const all = await db.getAll('conversations');
  const sorted = all.sort((a, b) => b.startedAt - a.startedAt);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

export async function listConversationsByDate(date: string): Promise<Conversation[]> {
  const db = await getDB();
  return db.getAllFromIndex('conversations', 'by-date', date);
}

// ---- correctionReports（1会話=1レポート） ----

export async function putCorrectionReport(report: CorrectionReport): Promise<void> {
  const db = await getDB();
  await db.put('correctionReports', report);
}

export async function getCorrectionReport(id: string): Promise<CorrectionReport | undefined> {
  const db = await getDB();
  return db.get('correctionReports', id);
}

/** 1会話=1レポートの前提のため、by-conversationインデックスの最初の1件を返す。 */
export async function getReportByConversation(
  conversationId: string,
): Promise<CorrectionReport | undefined> {
  const db = await getDB();
  return db.getFromIndex('correctionReports', 'by-conversation', conversationId);
}

/** 作成日時の新しい順に返す（レポート一覧画面用）。limit省略時は全件。 */
export async function listCorrectionReports(limit?: number): Promise<CorrectionReport[]> {
  const db = await getDB();
  const all = await db.getAll('correctionReports');
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

// ---- expressions（表現帳） ----

export async function putExpression(item: ExpressionItem): Promise<void> {
  const db = await getDB();
  await db.put('expressions', item);
}

/** 追加日時の新しい順に返す。 */
export async function listExpressions(): Promise<ExpressionItem[]> {
  const db = await getDB();
  const all = await db.getAll('expressions');
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteExpression(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('expressions', id);
}

// ---- userProfile（key 'main' の単一レコード） ----

/**
 * userProfileを取得する。レコードが無ければ初期値で新規作成して永続化してから返す
 * （get→putを単一のreadwriteトランザクション内で行い、初回アクセスが重複しても安全にする）。
 */
export async function getUserProfile(): Promise<UserProfile> {
  const db = await getDB();
  const tx = db.transaction('userProfile', 'readwrite');
  const existing = await tx.store.get('main');
  if (existing) {
    await tx.done;
    return existing;
  }
  const fresh: UserProfile = {
    key: 'main',
    level: 2,
    levelHistory: [],
    xp: 0,
    restTickets: 0,
    badges: [],
    interests: [],
    createdAt: Date.now(),
  };
  await tx.store.put(fresh);
  await tx.done;
  return fresh;
}

export async function putUserProfile(profile: UserProfile): Promise<void> {
  const db = await getDB();
  await db.put('userProfile', profile);
}

// ---- questState（日次1レコード） ----

export async function getQuestState(date: string): Promise<QuestState | undefined> {
  const db = await getDB();
  return db.get('questState', date);
}

export async function putQuestState(state: QuestState): Promise<void> {
  const db = await getDB();
  await db.put('questState', state);
}

// ---- usageLog（日次1レコード。DESIGN.md §12） ----

function zeroUsageDay(date: string): UsageDay {
  return {
    date,
    haikuCalls: 0,
    sonnetCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    paSeconds: 0,
    ttsChars: 0,
    sessionsStarted: 0,
  };
}

/** レコードが無い日は永続化せず全0のUsageDayを返す（キャップ判定側が毎日気軽に呼べるようにするため）。 */
export async function getUsageDay(date: string): Promise<UsageDay> {
  const db = await getDB();
  const existing = await db.get('usageLog', date);
  return existing ?? zeroUsageDay(date);
}

/**
 * 指定日のusageLogに加算マージする（レコードが無ければ全0から加算して新規作成）。
 * get→putを単一のreadwriteトランザクション内で行い、同日内の複数呼び出しが競合しても
 * ロストアップデートを起こさないようにする（touchMaterialProgress同様の理由）。
 */
export async function addUsage(date: string, partial: Partial<Omit<UsageDay, 'date'>>): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('usageLog', 'readwrite');
  const base = (await tx.store.get(date)) ?? zeroUsageDay(date);
  const merged: UsageDay = {
    date,
    haikuCalls: base.haikuCalls + (partial.haikuCalls ?? 0),
    sonnetCalls: base.sonnetCalls + (partial.sonnetCalls ?? 0),
    inputTokens: base.inputTokens + (partial.inputTokens ?? 0),
    outputTokens: base.outputTokens + (partial.outputTokens ?? 0),
    cacheReadTokens: base.cacheReadTokens + (partial.cacheReadTokens ?? 0),
    paSeconds: base.paSeconds + (partial.paSeconds ?? 0),
    ttsChars: base.ttsChars + (partial.ttsChars ?? 0),
    sessionsStarted: base.sessionsStarted + (partial.sessionsStarted ?? 0),
  };
  await tx.store.put(merged);
  await tx.done;
}
