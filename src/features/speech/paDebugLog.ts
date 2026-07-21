/**
 * PA診断ログ（DESIGN.md §6a-2。M11補修）。
 *
 * 発音評価（stream/batch）の実行経過・失敗理由を appState 'paDebugLog' に
 * 「HH:MM:SS [tag] メッセージ」形式のリングバッファ（最新30件）として永続化する。
 * iPhoneではdevtoolsのconsoleが見られないため、/#/selftest の診断パネルで
 * 閲覧・コピーできるようにするのが目的（障害報告の一次情報になる）。
 *
 * logPaDebug は fire-and-forget かつ決してthrowしない（診断のための書き込みが
 * 評価本体を壊してはならない）。書き込みは内部Promiseチェーンで直列化し、
 * 並行呼び出しでの行ロストを防ぐ。db.ts は動的importする
 * （azurePaUnscripted.ts等の純関数テストのIndexedDB非依存を保つため）。
 */

export const PA_DEBUG_LOG_APP_STATE_KEY = 'paDebugLog';
export const PA_DEBUG_LOG_LIMIT = 30;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'HH:MM:SS メッセージ' 形式の1行を作る純関数。 */
export function formatPaDebugLine(now: Date, message: string): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())} ${message}`;
}

/**
 * appStateの生値（unknown）を検証しつつ、末尾に1行追加して最新limit件へ切り詰める純関数。
 * 既存値がstring[]でない（破損・未初期化）場合は空から始める。
 */
export function appendToRingBuffer(
  existing: unknown,
  line: string,
  limit: number = PA_DEBUG_LOG_LIMIT,
): string[] {
  const base = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === 'string') : [];
  const next = [...base, line];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** 書き込みの直列化チェーン（並行logPaDebugでのread-modify-write競合による行ロスト防止）。 */
let writeQueue: Promise<void> = Promise.resolve();

/** 診断ログへ1行追記する（fire-and-forget・never throw）。 */
export function logPaDebug(message: string): void {
  const line = formatPaDebugLine(new Date(), message);
  writeQueue = writeQueue.then(async () => {
    try {
      const db = await import('../../lib/db');
      const existing = await db.getAppState(PA_DEBUG_LOG_APP_STATE_KEY);
      await db.setAppState(PA_DEBUG_LOG_APP_STATE_KEY, appendToRingBuffer(existing, line));
    } catch (err) {
      console.warn('[paDebugLog] 診断ログの書き込みに失敗しました（無視して続行）。', err);
    }
  });
}

/** 診断ログを読み出す（パネル表示用）。破損時は空配列。 */
export async function readPaDebugLog(): Promise<string[]> {
  try {
    const db = await import('../../lib/db');
    const existing = await db.getAppState(PA_DEBUG_LOG_APP_STATE_KEY);
    return Array.isArray(existing) ? existing.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** 診断ログを全消去する（パネルのクリアボタン用）。 */
export async function clearPaDebugLog(): Promise<void> {
  try {
    const db = await import('../../lib/db');
    await db.deleteAppState(PA_DEBUG_LOG_APP_STATE_KEY);
  } catch (err) {
    console.warn('[paDebugLog] 診断ログの削除に失敗しました。', err);
  }
}
