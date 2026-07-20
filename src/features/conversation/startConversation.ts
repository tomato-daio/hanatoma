/**
 * 会話セッションの開始（DESIGN.md §4, §12）。
 * 日次キャップ（sessions）を判定してから Conversation レコードを作成する。
 * 呼び出し側は返ってきたidで /talk/:conversationId へ遷移する。
 */

import { addUsage, getAppState, getUsageDay, putConversation } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { canStartSession } from '../../lib/usage/caps';
import {
  DEFAULT_DAILY_CAPS,
  type Conversation,
  type ConversationMode,
  type DailyCaps,
} from '../../lib/types';

export type StartConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; messageJa: string };

export async function startConversation(
  scenarioId: string,
  mode: ConversationMode,
): Promise<StartConversationResult> {
  const today = learningDate(new Date());
  const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
  const usage = await getUsageDay(today);
  if (!canStartSession(usage, caps)) {
    return {
      ok: false,
      messageJa: `今日の練習上限（${caps.sessions}セッション）に達しました。また明日！（設定で上限は変更できます）`,
    };
  }

  const conversation: Conversation = {
    id: crypto.randomUUID(),
    scenarioId,
    mode,
    date: today,
    startedAt: Date.now(),
    status: 'active',
    turns: [],
  };
  await putConversation(conversation);
  await addUsage(today, { sessionsStarted: 1 });
  return { ok: true, conversationId: conversation.id };
}
