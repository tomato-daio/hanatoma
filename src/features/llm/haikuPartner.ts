/**
 * 会話パートナー(Haiku, streaming)の呼び出し（DESIGN.md §7a）。
 * model: claude-haiku-4-5 / max_tokens: 200 / stream: true固定。
 * 履歴が20ターンを超えたら古い分を1行要約に畳んでコストを抑える（LLMは使わず機械組み立て）。
 */

import type { AppLevel, ConversationPhase, Scenario, ScenarioStep, Turn } from '../../lib/types';
import { streamMessages, type Msg, type Usage } from './anthropicClient';
import { buildPartnerSystem } from './prompts/partnerSystem';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 200;
/** これを超える履歴は古い分を要約に畳む（DESIGN.md §7a）。 */
const HISTORY_LIMIT = 20;

export interface NextAiTurnOptions {
  apiKey: string;
  scenario: Scenario;
  level: AppLevel;
  history: Turn[];
  phase: ConversationPhase;
  step?: ScenarioStep;
  onText: (delta: string) => void;
}

export interface NextAiTurnResult {
  text: string;
  usage: Usage;
}

/**
 * 履歴がHISTORY_LIMITターンを超えたら、古い分を1行要約のaiターンに畳んだ配列を返す純関数。
 * 要約はLLMを使わず機械的に組み立てる（「(earlier: talked about X over N turns)」程度）。
 * topicにはシナリオのgoal等、呼び出し側が既に持っている文字列を渡す想定（追加のLLM呼び出しはしない）。
 * HISTORY_LIMIT以下ならhistoryをそのまま返す。
 */
export function truncateHistory(history: Turn[], topic: string): Turn[] {
  if (history.length <= HISTORY_LIMIT) return history;

  const cutIndex = history.length - HISTORY_LIMIT;
  const older = history.slice(0, cutIndex);
  const recent = history.slice(cutIndex);

  const summaryTurn: Turn = {
    role: 'ai',
    text: `(earlier: talked about ${topic} over ${older.length} turns)`,
    at: older[older.length - 1].at,
    phase: recent[0].phase,
  };

  return [summaryTurn, ...recent];
}

/** Turn[]をAnthropic messages形式に変換する純関数（user/aiロールをuser/assistantへ写像するだけ）。 */
export function turnsToMessages(turns: Turn[]): Msg[] {
  return turns.map((turn) => ({
    role: turn.role === 'ai' ? 'assistant' : 'user',
    content: turn.text,
  }));
}

/**
 * 次のAI発話をstreamingで取得する。system組み立て・履歴切り詰め・messages変換をまとめて行う。
 * 呼び出し前の日次キャップ判定・usageLogへの加算は呼び出し側（useConversation.ts等）の責務。
 */
export async function nextAiTurn(opts: NextAiTurnOptions): Promise<NextAiTurnResult> {
  const { apiKey, scenario, level, history, phase, step, onText } = opts;

  const truncated = truncateHistory(history, scenario.goal);
  const messages = turnsToMessages(truncated);
  const system = buildPartnerSystem(scenario, level, step, phase);

  return streamMessages({
    apiKey,
    model: MODEL,
    system,
    messages,
    maxTokens: MAX_TOKENS,
    onText,
  });
}
