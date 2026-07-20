/**
 * 全IndexedDBデータのエクスポート/インポート（DESIGN.md §0・§3・M1・設定画面）。
 *
 * conversationsの各turnが持つ音声Blob（Turn.audioBlob）はJSONにできないため、含める場合は
 * base64文字列へ変換する。既定では**含めない**（バックアップファイルの肥大化を避けるため。
 * DESIGN.md §3のTurn.audioBlobコメント「振り返り再生用」の通り、無くても学習記録の本体
 * （テキスト・PA結果・添削）は復元できる）。
 *
 * appStateのAPIキー（azureSpeechKey/anthropicApiKey）はDESIGN.md §0の絶対ルールにより
 * エクスポートから常に除外し、リストア時も端末に既存のキーを上書きしない。
 * エクスポート/インポートいずれも端末内で完結し、外部へは一切送信しない。
 */

import {
  getDB,
  type AppStateValue,
} from './db';
import type {
  Conversation,
  CorrectionReport,
  ExpressionItem,
  QuestState,
  Scenario,
  Turn,
  UsageDay,
  UserProfile,
} from './types';

// v1: 初版（DESIGN.md M1）。
const BACKUP_VERSION = 1;
const BACKUP_APP_ID = 'hanatoma';

/**
 * バックアップに含めない/復元時に上書きしないappStateキー（DESIGN.md §0の絶対ルール）。
 * 値の文字列は各キー設定画面が使う appState キー名と一致させること。
 */
const EXCLUDED_APP_STATE_KEYS: readonly string[] = ['azureSpeechKey', 'anthropicApiKey'];
const EXCLUDED_APP_STATE_KEY_SET = new Set(EXCLUDED_APP_STATE_KEYS);

export interface BackupOptions {
  /** turns[].audioBlobをbase64で含めるか（既定false）。 */
  includeAudio?: boolean;
}

interface BlobField {
  base64: string;
  mimeType: string;
}

interface ExportedTurn extends Omit<Turn, 'audioBlob'> {
  audioBlob?: BlobField;
}

interface ExportedConversation extends Omit<Conversation, 'turns'> {
  turns: ExportedTurn[];
}

interface AppStateEntry {
  key: string;
  value: AppStateValue;
}

export interface BackupBundle {
  app: typeof BACKUP_APP_ID;
  version: number;
  exportedAt: number;
  /** このバンドルにturns[].audioBlobの実データが含まれているか（インポート側の参考情報）。 */
  includesAudio: boolean;
  scenarios: Scenario[];
  conversations: ExportedConversation[];
  correctionReports: CorrectionReport[];
  expressions: ExpressionItem[];
  userProfile: UserProfile[]; // keyPath 'key' の単一レコードストアだが、他ストアと同様に配列で扱う
  questState: QuestState[];
  usageLog: UsageDay[];
  appState: AppStateEntry[];
}

// FileReader.readAsDataURL + Blob はテスト環境(jsdom)でグローバルのBlob実体が食い違い
// 例外になることがあるため使わず、Blob.arrayBuffer()から手動でbase64化する
// （ブラウザ・iOS Safari・jsdomのいずれでも同じ経路で動く）。
const BASE64_CHUNK_SIZE = 0x8000;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function exportTurn(turn: Turn, includeAudio: boolean): Promise<ExportedTurn> {
  const { audioBlob, ...rest } = turn;
  if (!includeAudio || !audioBlob) return rest;
  const base64 = await blobToBase64(audioBlob);
  const mimeType = turn.mimeType || audioBlob.type || 'application/octet-stream';
  return { ...rest, audioBlob: { base64, mimeType } };
}

async function exportConversation(conv: Conversation, includeAudio: boolean): Promise<ExportedConversation> {
  const turns = await Promise.all(conv.turns.map((t) => exportTurn(t, includeAudio)));
  return { ...conv, turns };
}

/** 全データをエクスポート用のJSON Blobにまとめる。 */
export async function exportAllData(options: BackupOptions = {}): Promise<Blob> {
  const includeAudio = options.includeAudio ?? false;
  const db = await getDB();
  const [scenarios, conversations, correctionReports, expressions, userProfile, questState, usageLog, rawAppState] =
    await Promise.all([
      db.getAll('scenarios'),
      db.getAll('conversations'),
      db.getAll('correctionReports'),
      db.getAll('expressions'),
      db.getAll('userProfile'),
      db.getAll('questState'),
      db.getAll('usageLog'),
      db.getAll('appState'),
    ]);

  const exportedConversations = await Promise.all(
    conversations.map((c) => exportConversation(c, includeAudio)),
  );

  // DESIGN.md §0: APIキーはバックアップファイルに含めない（ファイル共有時の漏えい防止）。
  const appState = rawAppState.filter((entry) => !EXCLUDED_APP_STATE_KEY_SET.has(entry.key));

  const bundle: BackupBundle = {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    includesAudio: includeAudio,
    scenarios,
    conversations: exportedConversations,
    correctionReports,
    expressions,
    userProfile,
    questState,
    usageLog,
    appState,
  };

  return new Blob([JSON.stringify(bundle)], { type: 'application/json' });
}

/** エクスポートファイルのファイル名（例: hanatoma-backup-20260718.json）を組み立てる。 */
export function buildBackupFileName(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `hanatoma-backup-${y}${m}${d}.json`;
}

function isBackupBundle(data: unknown): data is BackupBundle {
  if (!data || typeof data !== 'object') return false;
  const b = data as Record<string, unknown>;
  return (
    b.app === BACKUP_APP_ID &&
    typeof b.version === 'number' &&
    Array.isArray(b.scenarios) &&
    Array.isArray(b.conversations) &&
    Array.isArray(b.correctionReports) &&
    Array.isArray(b.expressions) &&
    Array.isArray(b.userProfile) &&
    Array.isArray(b.questState) &&
    Array.isArray(b.usageLog) &&
    Array.isArray(b.appState)
  );
}

function importTurn(t: ExportedTurn): Turn {
  const { audioBlob, ...rest } = t;
  if (!audioBlob) return rest;
  return { ...rest, audioBlob: base64ToBlob(audioBlob.base64, audioBlob.mimeType) };
}

function importConversation(c: ExportedConversation): Conversation {
  return { ...c, turns: c.turns.map(importTurn) };
}

/**
 * バックアップJSONから全データを復元する。既存の全ストアをクリアしてから書き込む
 * （「復元は上書き確認あり」— この関数を呼ぶ前にUI側で確認ダイアログを出すこと）。
 * azureSpeechKey/anthropicApiKeyは、バックアップに含まれていても取り込まず、
 * 復元前に端末へ保存されていた値を常に優先する（DESIGN.md §0）。
 */
export async function importAllData(file: Blob): Promise<void> {
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み込めませんでした');
  }
  if (!isBackupBundle(data)) {
    throw new Error('はなとまのバックアップファイルではないようです');
  }

  const conversations = data.conversations.map(importConversation);
  const importedAppState = data.appState.filter((entry) => !EXCLUDED_APP_STATE_KEY_SET.has(entry.key));

  const db = await getDB();
  const storeNames = [
    'scenarios',
    'conversations',
    'correctionReports',
    'expressions',
    'userProfile',
    'questState',
    'usageLog',
    'appState',
  ] as const;
  const tx = db.transaction(storeNames, 'readwrite');

  // 全ストアをclearする前に、既存のAPIキー類を退避しておく（clear後に書き戻すため）。
  const preservedAppStateEntries = (
    await Promise.all(EXCLUDED_APP_STATE_KEYS.map((key) => tx.objectStore('appState').get(key)))
  ).filter((entry): entry is AppStateEntry => entry !== undefined);

  await Promise.all(storeNames.map((name) => tx.objectStore(name).clear()));

  await Promise.all([
    ...data.scenarios.map((s) => tx.objectStore('scenarios').put(s)),
    ...conversations.map((c) => tx.objectStore('conversations').put(c)),
    ...data.correctionReports.map((r) => tx.objectStore('correctionReports').put(r)),
    ...data.expressions.map((e) => tx.objectStore('expressions').put(e)),
    ...data.userProfile.map((p) => tx.objectStore('userProfile').put(p)),
    ...data.questState.map((q) => tx.objectStore('questState').put(q)),
    ...data.usageLog.map((u) => tx.objectStore('usageLog').put(u)),
    ...importedAppState.map((a) => tx.objectStore('appState').put(a)),
    ...preservedAppStateEntries.map((a) => tx.objectStore('appState').put(a)),
  ]);
  await tx.done;
}
