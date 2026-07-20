/**
 * 日次キャップ判定（DESIGN.md §12）。
 *
 * コスト暴走防止のため、LLM呼び出し・PA呼び出し・セッション開始はすべて事前にここを通す。
 * キャップ超過時はAPIを呼ばず、日本語の案内メッセージのみを返す（呼び出し側の実装責務）。
 */

import type { DailyCaps, UsageDay } from '../types';

const SECONDS_PER_MINUTE = 60;

/** キャップ超過時の共通メッセージ（DESIGN.md §12の文言そのまま）。 */
const CAP_EXCEEDED_MESSAGE_JA = '今日の練習上限に達しました（設定で変更できます）';

export type CapKind = 'sessions' | 'sonnetCalls' | 'paMinutes';

export interface CapCheckResult {
  ok: boolean;
  blockedBy?: CapKind;
  messageJa?: string;
}

/** セッション開始前に呼ぶ判定。既にcaps.sessions回開始済みならfalse。 */
export function canStartSession(usage: UsageDay, caps: DailyCaps): boolean {
  return usage.sessionsStarted < caps.sessions;
}

/** Sonnet呼び出し前に呼ぶ判定。既にcaps.sonnetCalls回呼び出し済みならfalse。 */
export function canCallSonnet(usage: UsageDay, caps: DailyCaps): boolean {
  return usage.sonnetCalls < caps.sonnetCalls;
}

/** Azure発音評価(PA)呼び出し前に呼ぶ判定。paSeconds(秒)をpaMinutes(分)キャップに換算して比較する。 */
export function canRunPa(usage: UsageDay, caps: DailyCaps): boolean {
  return usage.paSeconds / SECONDS_PER_MINUTE < caps.paMinutes;
}

/**
 * 3種のキャップを sessions → sonnetCalls → paMinutes の順に判定する（DESIGN.md §12）。
 * 最初に超過が見つかったものを`blockedBy`として返し、`ok:false`とメッセージを添える。
 * 呼び出し側はこの結果が`ok:false`の間、対応するAPI（Anthropic/Azure PA/新規セッション）を呼ばない。
 */
export function checkCaps(usage: UsageDay, caps: DailyCaps): CapCheckResult {
  if (!canStartSession(usage, caps)) {
    return { ok: false, blockedBy: 'sessions', messageJa: CAP_EXCEEDED_MESSAGE_JA };
  }
  if (!canCallSonnet(usage, caps)) {
    return { ok: false, blockedBy: 'sonnetCalls', messageJa: CAP_EXCEEDED_MESSAGE_JA };
  }
  if (!canRunPa(usage, caps)) {
    return { ok: false, blockedBy: 'paMinutes', messageJa: CAP_EXCEEDED_MESSAGE_JA };
  }
  return { ok: true };
}
