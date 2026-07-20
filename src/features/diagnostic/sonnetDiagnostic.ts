/**
 * 初回診断テストの採点（DESIGN.md §7b・§8a・M6）。
 *
 * ①自己紹介 ②場面描写 ③意見質問の3答案（文字起こし＋任意で発音評価）をSonnetへ渡し、
 * tool use強制でCEFR帯・アプリレベル(1〜5)・日本語コメントを構造化出力させる。
 * ルーブリック（語彙幅・文法正確性・複雑さ）はsystemプロンプトに埋め込む（DESIGN.md §8a）。
 *
 * 呼び出し前にAPIキー・日次キャップ(sonnetCalls)を確認し、呼び出し後はusageLogへ加算する
 * （DESIGN.md §12。プロジェクト全体のコスト暴走防止ルール）。呼び出し側（OnboardingPage.tsx）は
 * apiKeyやキャップを気にせず、この関数を呼ぶだけでよい。
 */

import { addUsage, getAppState, getUsageDay } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { canCallSonnet } from '../../lib/usage/caps';
import { DEFAULT_DAILY_CAPS, type AppLevel, type DailyCaps, type PaResult } from '../../lib/types';
import { callMessages, type SystemBlock } from '../llm/anthropicClient';
import { getAnthropicApiKey } from '../settings/anthropicKeyConfig';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const TOOL_NAME = 'submit_diagnostic_result';

/** キャップ超過時の案内文言（DESIGN.md §12・caps.tsの文言に合わせる）。 */
const CAP_EXCEEDED_MESSAGE_JA = '今日の練習上限に達しました（設定で変更できます）';

/** 1問ぶんの答案。呼び出し側（OnboardingPage.tsx）がdiagnosticQuestions.tsの指示文とPA結果を詰めて渡す。 */
export interface DiagnosticAnswer {
  /** その設問でユーザーに求めた指示文（英語。diagnosticQuestions.tsのinstructionEnを想定）。 */
  question: string;
  /** 認識されたユーザーの発話（unscripted PAの認識テキスト）。聞き取れなかった場合は空文字。 */
  transcript: string;
  /** 音声入力時の発音評価結果（任意。参考シグナルとして渡すのみで判定の主軸にはしない）。 */
  pa?: PaResult;
}

export interface DiagnosticScore {
  cefr: string;
  level: AppLevel;
  commentJa: string;
}

export type ScoreDiagnosticResult = DiagnosticScore | { error: string };

const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;

/**
 * ルーブリック（語彙幅・文法正確性・複雑さ）とCEFR↔レベル対応を定義する不変のsystemプロンプト
 * （DESIGN.md §8a）。診断はユーザーごとに1回しか呼ばれないためprompt cachingは付けない。
 */
const RUBRIC_TEXT = `You are assessing the English speaking level of a Japanese-speaking learner of English, based on three short spontaneous speech samples: a self-introduction, a description of a given scene, and an answer to an opinion question.

Score the learner using this rubric, weighting all three dimensions roughly equally:
- Vocabulary range: how varied and precise the vocabulary is, versus repetitive or very basic words.
- Grammatical accuracy: the frequency and severity of grammar mistakes (tense, articles, subject-verb agreement, word order, etc.).
- Complexity: sentence length and structure — isolated simple sentences versus connected, multi-clause speech with linking words.

Each answer may include a rough pronunciation score (0-100) from an automated speech assessment when available. Treat it only as a minor supporting signal, never as the primary basis for the level — a learner can speak grammatically well with a strong accent, or fluently with frequent mistakes.

Map your overall judgment to exactly one CEFR band and one app level (they correspond 1:1):
  A1 -> level 1 (very basic words and phrases, frequent communication breakdowns)
  A2 -> level 2 (simple everyday sentences, noticeable but generally understandable errors)
  B1 -> level 3 (connected speech on familiar topics, moderate errors)
  B2 -> level 4 (fairly fluent and detailed, occasional errors that rarely obscure meaning)
  C1 -> level 5 (fluent, precise, idiomatic, rare errors)

If an answer is missing, empty, or clearly failed speech recognition, judge from whatever is available and lean toward the lower, more cautious level when evidence is thin. Never refuse to produce a result.

Call the ${TOOL_NAME} tool exactly once with your result. Write commentJa entirely in Japanese: 1 to 3 short, encouraging sentences (this is a beginner-friendly app — avoid harsh criticism) summarizing the learner's current level and one concrete strength or point to work on.`;

/** systemプロンプトを組み立てる純関数（現状は固定文言1ブロックのみ）。 */
export function buildDiagnosticSystem(): SystemBlock[] {
  return [{ type: 'text', text: RUBRIC_TEXT }];
}

/** 発音評価結果を採点プロンプト用の一行に要約する純関数。 */
function summarizePa(pa: PaResult | undefined): string {
  if (!pa) return '(no pronunciation score available for this answer)';
  if (pa.azureError) return `(pronunciation assessment failed for this answer: ${pa.azureError})`;
  return `pronunciation score ${Math.round(pa.pronScore)}/100 (accuracy ${Math.round(pa.accuracyScore)}, fluency ${Math.round(pa.fluencyScore)})`;
}

/** 3答案をSonnetへ渡すuserメッセージ本文に組み立てる純関数。 */
export function buildDiagnosticUserContent(answers: DiagnosticAnswer[]): string {
  return answers
    .map((a, i) => {
      const transcript = a.transcript.trim() || '(no speech recognized for this answer)';
      return `Q${i + 1} instruction: ${a.question}\nLearner's answer: ${transcript}\nPronunciation: ${summarizePa(a.pa)}`;
    })
    .join('\n\n');
}

/** Anthropic tool useのinput_schema（CorrectionReportのtool use強制と同じ流儀。DESIGN.md §7b）。 */
export const DIAGNOSTIC_TOOL = {
  name: TOOL_NAME,
  description: 'Submit the CEFR-based diagnostic result for this English learner.',
  input_schema: {
    type: 'object',
    properties: {
      cefr: {
        type: 'string',
        enum: [...CEFR_LEVELS],
        description: 'Overall CEFR band (A1/A2/B1/B2/C1).',
      },
      level: {
        type: 'integer',
        enum: [1, 2, 3, 4, 5],
        description: 'App level 1-5, corresponding 1:1 to the CEFR band (A1=1 ... C1=5).',
      },
      commentJa: {
        type: 'string',
        description: '1-3 encouraging sentences in Japanese summarizing the result for the learner.',
      },
    },
    required: ['cefr', 'level', 'commentJa'],
  },
} as const;

/** toolChoiceに渡す値（DIAGNOSTIC_TOOLのnameを強制指定する）。 */
export const DIAGNOSTIC_TOOL_CHOICE = { type: 'tool', name: TOOL_NAME } as const;

function isValidCefr(value: unknown): value is (typeof CEFR_LEVELS)[number] {
  return typeof value === 'string' && (CEFR_LEVELS as readonly string[]).includes(value);
}

function isValidLevel(value: unknown): value is AppLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * callMessagesが返すcontent配列から、DIAGNOSTIC_TOOLのtool_useブロックを取り出し検証する純関数。
 * 該当ブロックが無い、またはinputの形が不正な場合はnullを返す（呼び出し側はエラー扱いにする）。
 */
export function parseDiagnosticToolResult(content: unknown[]): DiagnosticScore | null {
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== 'tool_use' || b.name !== TOOL_NAME) continue;
    if (typeof b.input !== 'object' || b.input === null) continue;
    const input = b.input as Record<string, unknown>;
    const { cefr, level, commentJa } = input;
    if (isValidCefr(cefr) && isValidLevel(level) && typeof commentJa === 'string' && commentJa.trim().length > 0) {
      return { cefr, level, commentJa };
    }
  }
  return null;
}

/**
 * 診断3答案を採点する（DESIGN.md §7b・§8a）。
 *
 * 手順: Anthropicキー確認 → 日次キャップ(sonnetCalls)判定 → tool use強制で1コール →
 * usageLogへ加算 → tool_use結果を検証して返す。
 * どの段階で失敗しても例外は投げず `{ error: string }`（日本語メッセージ）を返す
 * （呼び出し側=OnboardingPage.tsxは画面内にそのまま表示すればよい）。
 */
export async function scoreDiagnostic(answers: DiagnosticAnswer[]): Promise<ScoreDiagnosticResult> {
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) {
    return { error: 'Anthropic APIキーが未設定です。設定画面で登録してください。' };
  }

  const today = learningDate(new Date());
  const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
  const usage = await getUsageDay(today);
  if (!canCallSonnet(usage, caps)) {
    return { error: CAP_EXCEEDED_MESSAGE_JA };
  }

  try {
    const result = await callMessages({
      apiKey,
      model: MODEL,
      system: buildDiagnosticSystem(),
      messages: [{ role: 'user', content: buildDiagnosticUserContent(answers) }],
      maxTokens: MAX_TOKENS,
      tools: [DIAGNOSTIC_TOOL],
      toolChoice: DIAGNOSTIC_TOOL_CHOICE,
    });

    await addUsage(today, {
      sonnetCalls: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
    });

    const parsed = parseDiagnosticToolResult(result.content);
    if (!parsed) {
      return { error: '診断結果の解析に失敗しました。もう一度お試しください。' };
    }
    return parsed;
  } catch (err) {
    return {
      error: err instanceof Error ? `診断中にエラーが発生しました: ${err.message}` : '診断中にエラーが発生しました。',
    };
  }
}
