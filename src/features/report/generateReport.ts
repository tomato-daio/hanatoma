/**
 * 添削レポート生成のオーケストレーション（DESIGN.md §7b・M4）。
 *
 * 手順: 日次キャップ判定(canCallSonnet) → Anthropicキー取得 → callSonnetCorrection →
 * phonemeComments合成 → putCorrectionReportで保存 → learnedExpressionsをexpressionsストアへ
 * 登録(重複enは登録しない) → addUsageでusageLog加算。
 *
 * エラー時は例外を投げず {error: string} を返す（呼び出し側でリトライ導線を出すため）。
 */

import { addUsage, getAppState, getUsageDay, listExpressions, putCorrectionReport, putExpression } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { canCallSonnet } from '../../lib/usage/caps';
import {
  DEFAULT_DAILY_CAPS,
  type AppLevel,
  type Conversation,
  type CorrectionReport,
  type DailyCaps,
  type ExpressionItem,
  type Scenario,
} from '../../lib/types';
import { getAnthropicApiKey } from '../settings/anthropicKeyConfig';
import { buildPronunciationComments } from './phonemeComments';
import { PHONEME_ADVICE } from './phonemeAdvice';
import { callSonnetCorrection } from './sonnetCorrection';

const CAP_MESSAGE_JA = '今日の添削回数の上限に達しました（設定で変更できます）。';
const NO_KEY_MESSAGE_JA = 'Anthropic APIキーが未設定です。設定画面で登録してください。';

export type GenerateCorrectionReportResult = CorrectionReport | { error: string };

/**
 * generateCorrectionReport: 完了した会話からSonnet添削レポートを生成し永続化する。
 * conversation.turnsとscenarioから入力を組み立て、成功時はDB保存済みのCorrectionReportを返す。
 * @param sisterWeakPhonemes 自アプリ+shadotoma(DESIGN.md §11)から集約した注意音素リスト
 *   （呼び出し側が用意する。未連携時は空配列でよい）。
 */
export async function generateCorrectionReport(
  conversation: Conversation,
  scenario: Scenario,
  level: AppLevel,
  sisterWeakPhonemes: string[],
): Promise<GenerateCorrectionReportResult> {
  const today = learningDate(new Date());
  const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
  const usage = await getUsageDay(today);
  if (!canCallSonnet(usage, caps)) {
    return { error: CAP_MESSAGE_JA };
  }

  const apiKey = await getAnthropicApiKey();
  if (!apiKey) {
    return { error: NO_KEY_MESSAGE_JA };
  }

  let callResult;
  try {
    callResult = await callSonnetCorrection(apiKey, conversation, scenario, level, sisterWeakPhonemes);
  } catch (err) {
    return { error: err instanceof Error ? err.message : '添削の生成に失敗しました。' };
  }
  const { output, usage: tokenUsage } = callResult;

  // Sonnet呼び出しは既に成功（課金発生済み）のため、後続の保存処理が失敗しても
  // usageLogへの加算だけは必ず行う（DESIGN.md §12: 呼び出し後は必ずusage加算）。
  await addUsage(today, {
    sonnetCalls: 1,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    cacheReadTokens: tokenUsage.cacheReadTokens,
  });

  const pronunciationComments = buildPronunciationComments(conversation.turns, PHONEME_ADVICE);

  const report: CorrectionReport = {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    date: conversation.date,
    createdAt: Date.now(),
    items: output.items,
    rephrases: output.rephrases,
    learnedExpressions: output.learnedExpressions,
    objectivesAchieved: output.objectivesAchieved,
    grammarErrorCount: output.grammarErrorCount,
    pronunciationComments,
    summaryJa: output.summaryJa,
  };

  try {
    await putCorrectionReport(report);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'レポートの保存に失敗しました。' };
  }

  // 表現帳登録はレポート本体より重要度が低い付随処理のため、失敗してもレポート自体は
  // 保存済みとして返す（コンソールに残すのみでユーザーへはエラー扱いにしない）。
  try {
    const existing = await listExpressions();
    const seenEn = new Set(existing.map((e) => e.en));
    for (const learned of output.learnedExpressions) {
      if (seenEn.has(learned.en)) continue;
      seenEn.add(learned.en); // 同一レポート内での重複登録も防ぐ
      const item: ExpressionItem = {
        id: crypto.randomUUID(),
        en: learned.en,
        ja: learned.ja,
        ...(learned.note !== undefined ? { note: learned.note } : {}),
        sourceConversationId: conversation.id,
        addedAt: Date.now(),
        useCount: 0,
      };
      await putExpression(item);
    }
  } catch (err) {
    console.error('[generateReport] 表現帳への登録に失敗しました。', err);
  }

  return report;
}
