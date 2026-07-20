/**
 * Sonnet精密添削（DESIGN.md §7b）のtool use強制で使うJSON Schema定数と、
 * そのレスポンス（tool_use blockのinput）を表す型・実行時バリデータ。
 *
 * ここで定義するプロパティは types.ts の CorrectionReport のうち、Sonnetに生成させる部分
 * （items/rephrases/learnedExpressions/objectivesAchieved/grammarErrorCount/summaryJa）のみ。
 * id/conversationId/date/createdAt はgenerateReport.tsが組み立て、pronunciationCommentsは
 * phonemeComments.ts（LLMを使わない純関数）が生成するため、ここには含めない。
 *
 * isSonnetCorrectionOutput は、Anthropic APIから返る tool_use.input（型は unknown）を
 * 信頼する前に形を検証する防御的チェック。tool_choiceで強制していてもモデルが
 * スキーマ通りの型（特にenum値やoptional）を返すとは限らないため、DB保存・UI表示の前に
 * ここで弾く（sonnetCorrection.ts が呼び出す）。
 */

import type { CorrectionItem, CorrectionKind } from '../../lib/types';

export const CORRECTION_REPORT_TOOL_NAME = 'record_correction_report';

const CORRECTION_KIND_VALUES: readonly CorrectionKind[] = [
  'grammar',
  'word-choice',
  'naturalness',
  'expression',
];

/** callMessages/streamMessagesのtools:unknown[]にそのまま渡すtool定義。 */
export const CORRECTION_REPORT_TOOL_SCHEMA = {
  name: CORRECTION_REPORT_TOOL_NAME,
  description:
    'Record the structured correction report for this English conversation practice transcript.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Per-turn corrections for mistakes or unnatural phrasing found in user turns.',
        items: {
          type: 'object',
          properties: {
            turnIndex: {
              type: 'integer',
              description: '0-based index into the conversation turns array shown in the transcript.',
            },
            original: { type: 'string', description: 'The original English text as the user said it.' },
            corrected: { type: 'string', description: 'The corrected/improved English text.' },
            kind: { type: 'string', enum: CORRECTION_KIND_VALUES as unknown as string[] },
            explanationJa: { type: 'string', description: 'Short explanation in Japanese.' },
          },
          required: ['turnIndex', 'original', 'corrected', 'kind', 'explanationJa'],
        },
      },
      rephrases: {
        type: 'array',
        description: 'CEFR-staged rephrases for a few notable user turns.',
        items: {
          type: 'object',
          properties: {
            turnIndex: { type: 'integer' },
            levelUp: {
              type: 'string',
              description: 'How to phrase the same idea one CEFR level above the learner.',
            },
            native: { type: 'string', description: 'How a native speaker would naturally phrase it.' },
          },
          required: ['turnIndex', 'levelUp', 'native'],
        },
      },
      learnedExpressions: {
        type: 'array',
        description: '3 to 5 expressions worth adding to the learner’s notebook.',
        items: {
          type: 'object',
          properties: {
            en: { type: 'string' },
            ja: { type: 'string', description: 'Japanese translation.' },
            note: { type: 'string', description: 'Optional short usage note in Japanese.' },
          },
          required: ['en', 'ja'],
        },
      },
      objectivesAchieved: {
        type: 'array',
        description: 'ids of the scenario’s hiddenObjectives that were achieved in this transcript.',
        items: { type: 'string' },
      },
      grammarErrorCount: {
        type: 'integer',
        description: 'Total number of grammar mistakes found (an actual count, not a rate).',
        minimum: 0,
      },
      summaryJa: { type: 'string', description: 'One or two encouraging sentences in Japanese.' },
    },
    required: [
      'items',
      'rephrases',
      'learnedExpressions',
      'objectivesAchieved',
      'grammarErrorCount',
      'summaryJa',
    ],
  },
} as const;

export interface SonnetRephrase {
  turnIndex: number;
  levelUp: string;
  native: string;
}

export interface SonnetLearnedExpression {
  en: string;
  ja: string;
  note?: string;
}

/** Sonnetのtool_use.inputが持つべき形（CorrectionReportのうちLLM生成分のみ）。 */
export interface SonnetCorrectionOutput {
  items: CorrectionItem[];
  rephrases: SonnetRephrase[];
  learnedExpressions: SonnetLearnedExpression[];
  objectivesAchieved: string[];
  grammarErrorCount: number;
  summaryJa: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCorrectionItem(value: unknown): value is CorrectionItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.turnIndex === 'number' &&
    typeof value.original === 'string' &&
    typeof value.corrected === 'string' &&
    typeof value.kind === 'string' &&
    (CORRECTION_KIND_VALUES as readonly string[]).includes(value.kind) &&
    typeof value.explanationJa === 'string'
  );
}

function isRephrase(value: unknown): value is SonnetRephrase {
  if (!isRecord(value)) return false;
  return (
    typeof value.turnIndex === 'number' &&
    typeof value.levelUp === 'string' &&
    typeof value.native === 'string'
  );
}

function isLearnedExpression(value: unknown): value is SonnetLearnedExpression {
  if (!isRecord(value)) return false;
  if (typeof value.en !== 'string' || typeof value.ja !== 'string') return false;
  if (value.note !== undefined && typeof value.note !== 'string') return false;
  return true;
}

/** Anthropic APIのtool_use.inputを信頼する前の形チェック（ファイル冒頭コメント参照）。 */
export function isSonnetCorrectionOutput(value: unknown): value is SonnetCorrectionOutput {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.items) &&
    value.items.every(isCorrectionItem) &&
    Array.isArray(value.rephrases) &&
    value.rephrases.every(isRephrase) &&
    Array.isArray(value.learnedExpressions) &&
    value.learnedExpressions.every(isLearnedExpression) &&
    Array.isArray(value.objectivesAchieved) &&
    value.objectivesAchieved.every((id) => typeof id === 'string') &&
    typeof value.grammarErrorCount === 'number' &&
    typeof value.summaryJa === 'string'
  );
}
