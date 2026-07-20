/**
 * 精密添削(Sonnet, tool use強制)の呼び出し（DESIGN.md §7b）。
 * model: claude-sonnet-5。tool_choiceでCORRECTION_REPORT_TOOL_SCHEMAの使用を強制し、
 * 構造化されたCorrectionReport相当のJSONを1回のcallMessagesで取得する。
 *
 * 入力プロンプトの組み立て（buildCorrectionPrompt）はDOM/ネットワークに依存しない純関数として
 * 切り出し、Vitestでプロンプト内容を固定できるようにする（sonnetCorrection.test.ts）。
 */

import { getLevelParams } from '../../lib/level/params';
import type {
  AppLevel,
  Conversation,
  HiddenObjective,
  PaResult,
  Scenario,
  Turn,
} from '../../lib/types';
import { callMessages, type Msg, type SystemBlock, type Usage } from '../llm/anthropicClient';
import {
  CORRECTION_REPORT_TOOL_NAME,
  CORRECTION_REPORT_TOOL_SCHEMA,
  isSonnetCorrectionOutput,
  type SonnetCorrectionOutput,
} from './correctionSchema';

const MODEL = 'claude-sonnet-5';
/**
 * DESIGN.md §7bはHaiku(max_tokens:200固定)と違いSonnet添削のmax_tokensを指定していない。
 * tool use出力は複数件のitems/rephrases/learnedExpressionsを含むJSONのため、
 * 途中で打ち切られてJSONが壊れる（=isSonnetCorrectionOutputで弾かれる）事故を避けられるよう
 * 十分に余裕を持たせた値にする。
 */
const MAX_TOKENS = 4096;

/** 低スコア語とみなす閾値（DESIGN.md §7bの「低スコア語上位」の抽出基準）。 */
const LOW_SCORE_WORD_THRESHOLD = 70;
/** プロンプトに含める低スコア語の最大数。 */
const LOW_SCORE_WORD_LIMIT = 3;

/**
 * 1ユーザーターンぶんのPA要約をプロンプト用の一行文字列にする純関数。
 * azureError（発音評価失敗）またはpa自体が無ければnull（そのターンにはPA情報を付けない）。
 */
function summarizePaForPrompt(pa: PaResult | undefined): string | null {
  if (!pa || pa.azureError) return null;
  const lowScoreWords = [...pa.words]
    .filter((w) => w.accuracyScore < LOW_SCORE_WORD_THRESHOLD)
    .sort((a, b) => a.accuracyScore - b.accuracyScore)
    .slice(0, LOW_SCORE_WORD_LIMIT)
    .map((w) => w.word);
  const pronScore = Math.round(pa.pronScore);
  return lowScoreWords.length > 0
    ? `pronScore=${pronScore}, low-score words: ${lowScoreWords.join(', ')}`
    : `pronScore=${pronScore}`;
}

/** turns配列中の1ターンを、turnIndexが分かる形でトランスクリプト1行に整形する純関数。 */
function formatTurnLine(turn: Turn, index: number): string {
  const paSummary = turn.role === 'user' ? summarizePaForPrompt(turn.pa) : null;
  const suffix = paSummary ? ` [pronunciation: ${paSummary}]` : '';
  return `[${index}] ${turn.role} (${turn.phase}): "${turn.text}"${suffix}`;
}

function formatHiddenObjectiveLine(objective: HiddenObjective): string {
  return `- id="${objective.id}": ${objective.descriptionJa} (judge by: ${objective.check})`;
}

const SYSTEM_INSTRUCTIONS = `You are an expert English writing and speaking coach reviewing a transcript of a Japanese learner's English conversation practice session.

Your task: analyze the transcript and call the provided tool exactly once with a complete, structured correction report. Do not reply with plain text — only use the tool.

Guidelines:
- "items": For turns spoken by the user ("user" role) that contain a real English mistake or an unnatural phrasing, provide a correction. Set "turnIndex" to the index shown before that turn in the transcript. Classify each correction as "grammar", "word-choice", "naturalness", or "expression". Write "explanationJa" as a short, friendly explanation in Japanese aimed at a Japanese learner of English.
- "rephrases": Pick a few (roughly 1 to 3) user turns that were understandable but could be phrased in a more advanced or more native way. For each, give "levelUp" (a natural phrasing one CEFR level above the learner's current level) and "native" (how a native speaker would naturally phrase the same idea).
- "learnedExpressions": Suggest 3 to 5 useful English expressions worth remembering from this conversation (drawn from the scenario's natural vocabulary, not necessarily things the user already said). Give "en", a Japanese translation "ja", and an optional short usage "note" in Japanese.
- "objectivesAchieved": Check each hidden objective's judging instruction against the transcript and return only the ids of objectives that were actually achieved.
- "grammarErrorCount": The total number of grammar mistakes found across the whole transcript (an actual count, not a rate).
- "summaryJa": One or two encouraging sentences in Japanese summarizing overall performance.

All Japanese-language fields (explanationJa, note, ja, summaryJa) must be written in Japanese. Keep "original"/"corrected"/"levelUp"/"native"/"en" in English.`;

export interface CorrectionPrompt {
  system: SystemBlock[];
  messages: Msg[];
}

/**
 * buildCorrectionPrompt: Sonnet添削の入力（DESIGN.md §7b）を組み立てる純関数。
 * 全トランスクリプト(role/phase付き)・各userターンのPA要約・シナリオ(goal/hiddenObjectives)・
 * ユーザーレベル・弱点音素リストをまとめて1つのuserメッセージに詰める。
 * @param sisterWeakPhonemes 呼び出し側(generateReport.ts)が自アプリ+shadotoma(DESIGN.md §11)
 *   から集約した注意音素リスト（ARPAbet大文字キー）。
 */
export function buildCorrectionPrompt(
  conversation: Conversation,
  scenario: Scenario,
  level: AppLevel,
  sisterWeakPhonemes: string[],
): CorrectionPrompt {
  const levelParams = getLevelParams(level);
  const transcriptLines = conversation.turns.map((turn, index) => formatTurnLine(turn, index));
  const objectiveLines = scenario.hiddenObjectives.map(formatHiddenObjectiveLine);

  const contextLines = [
    `Scenario goal: ${scenario.goal}`,
    `Learner's current level: ${levelParams.cefr} (app level ${level}).`,
    objectiveLines.length > 0
      ? `Hidden objectives to check for (report back only the ids that were achieved):\n${objectiveLines.join('\n')}`
      : 'Hidden objectives to check for: none.',
    sisterWeakPhonemes.length > 0
      ? `Phonemes this learner should pay particular attention to (ARPAbet): ${sisterWeakPhonemes.join(', ')}`
      : 'Phonemes this learner should pay particular attention to: none recorded yet.',
    'Conversation transcript (each line: [turn index] role (phase): "text" and, for voice turns, a pronunciation summary):',
    transcriptLines.join('\n'),
  ];

  return {
    system: [{ type: 'text', text: SYSTEM_INSTRUCTIONS }],
    messages: [{ role: 'user', content: contextLines.join('\n\n') }],
  };
}

export interface CallSonnetCorrectionResult {
  output: SonnetCorrectionOutput;
  usage: Usage;
}

/**
 * callSonnetCorrection: buildCorrectionPromptで組み立てた入力をSonnetへ送り、
 * tool use強制でCorrectionReport相当のJSONを取得する。
 * 呼び出し前の日次キャップ判定・呼び出し後のusageLog加算は呼び出し側(generateReport.ts)の責務。
 */
export async function callSonnetCorrection(
  apiKey: string,
  conversation: Conversation,
  scenario: Scenario,
  level: AppLevel,
  sisterWeakPhonemes: string[],
): Promise<CallSonnetCorrectionResult> {
  const { system, messages } = buildCorrectionPrompt(conversation, scenario, level, sisterWeakPhonemes);

  const result = await callMessages({
    apiKey,
    model: MODEL,
    system,
    messages,
    maxTokens: MAX_TOKENS,
    tools: [CORRECTION_REPORT_TOOL_SCHEMA],
    toolChoice: { type: 'tool', name: CORRECTION_REPORT_TOOL_NAME },
  });

  const toolUseBlock = result.content.find(
    (block): block is { type: 'tool_use'; id: string; name: string; input: unknown } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_use' &&
      (block as { name?: unknown }).name === CORRECTION_REPORT_TOOL_NAME,
  );
  if (!toolUseBlock) {
    throw new Error('添削結果の取得に失敗しました（tool useの応答がありませんでした）。');
  }
  if (!isSonnetCorrectionOutput(toolUseBlock.input)) {
    throw new Error('添削結果の形式が不正です。もう一度お試しください。');
  }

  return { output: toolUseBlock.input, usage: result.usage };
}
