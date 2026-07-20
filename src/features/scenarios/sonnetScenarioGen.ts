/**
 * 端末上の動的シナリオ生成（DESIGN.md §7b・§9最終項・M9）。
 *
 * 興味タグ・弱点音素・レベル・既存生成シナリオのタイトル一覧（重複回避用）をSonnetへ渡し、
 * tool use強制でScenario型に準拠したJSONを生成させる。id/sourceはLLMには出させず、
 * 受信・検証後にこちらで `id: 'gen-' + crypto.randomUUID()` / `source: 'generated'` を付与する
 * （DESIGN.md §3: Scenario.id の生成ルール）。
 *
 * sonnetDiagnostic.ts と同じクライアント基盤・流儀（tool use強制・呼び出し前canCallSonnet判定・
 * 呼び出し後addUsage・純関数へのスキーマ組み立て/検証の分離）を踏襲する
 * （DESIGN.md §7b「診断テスト採点sonnetDiagnostic.ts(M6)とシナリオ動的生成sonnetScenarioGen.ts(M9)
 * も同じクライアント基盤を使う」）。
 *
 * 品質基準は public/scenarios/parts/ のバンドルシナリオ・scripts/validate-scenarios.mjs と同等
 * （keyPhrases 3〜5個・steps 3〜5個・hiddenObjectives 2個固定・targetPhonemesは
 * src/features/report/phonemeAdvice.ts の15音素キー集合のみ）。
 */

import { addUsage, getAppState, getUsageDay } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { getLevelParams } from '../../lib/level/params';
import { canCallSonnet } from '../../lib/usage/caps';
import {
  DEFAULT_DAILY_CAPS,
  type AppLevel,
  type DailyCaps,
  type HiddenObjective,
  type KeyPhrase,
  type Scenario,
  type ScenarioCategory,
  type ScenarioStep,
} from '../../lib/types';
import { callMessages, type SystemBlock } from '../llm/anthropicClient';
import { TARGET_PHONEME_KEYS } from '../report/phonemeAdvice';
import { getAnthropicApiKey } from '../settings/anthropicKeyConfig';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2048;
const TOOL_NAME = 'submit_generated_scenario';

/** キャップ超過時の案内文言（DESIGN.md §12・caps.tsの文言に合わせる。sonnetDiagnostic.tsと同一）。 */
const CAP_EXCEEDED_MESSAGE_JA = '今日の練習上限に達しました（設定で変更できます）';

/** types.ts ScenarioCategory と同期必須（validate-scenarios.mjsのCATEGORIESと同じ8種）。 */
const SCENARIO_CATEGORIES: readonly ScenarioCategory[] = [
  'travel',
  'restaurant',
  'work',
  'daily',
  'interview',
  'shopping',
  'health',
  'social',
];

// ---- 品質基準（DESIGN.md §9・scripts/validate-scenarios.mjsと同等の範囲） ----
const KEY_PHRASES_MIN = 3;
const KEY_PHRASES_MAX = 5;
const STEPS_MIN = 3;
const STEPS_MAX = 5;
const HIDDEN_OBJECTIVES_COUNT = 2;
const TARGET_PHONEMES_MIN = 2;
const TARGET_PHONEMES_MAX = 4;
const ESTIMATED_MINUTES_MIN = 5;
const ESTIMATED_MINUTES_MAX = 12;

export interface GenerateScenarioOptions {
  /** userProfile.interests（オンボーディングで選択+自由入力）。 */
  interests: string[];
  /** 自アプリ+shadotoma(DESIGN.md §11)から集約した注意音素リスト（ARPAbet大文字キー）。 */
  weakPhonemes: string[];
  level: AppLevel;
  /** 既存の生成シナリオ（source:'generated'）のtitle一覧。重複回避のためプロンプトに含める。 */
  existingTitles: string[];
}

/** Scenarioのうちidとsourceを除いた、Sonnetに生成させる部分。 */
export type GeneratedScenarioFields = Omit<Scenario, 'id' | 'source'>;

export type GenerateScenarioResult = Scenario | { error: string };

/**
 * シナリオ品質基準とtool use強制を伝える不変のsystemプロンプト（DESIGN.md §9）。
 * 対象15音素キー(TARGET_PHONEME_KEYS)を定数として本文に埋め込む。
 * 呼び出しごとに1回しか使われないためprompt cachingは付けない（sonnetDiagnostic.tsと同様）。
 */
export function buildScenarioGenSystem(): SystemBlock[] {
  const text = `You are designing a single new English conversation practice scenario for a Japanese-speaking learner of English, for a mobile app called "hanatoma".

Your task: call the provided tool exactly once with a complete scenario definition. Do not reply with plain text — only use the tool.

Match the quality and structure of the app's professionally written bundled scenarios:
- "keyPhrases": exactly 3 to 5 short, natural, useful phrases for this scene, each with an English "en" and a Japanese translation "ja" (an optional short "note" in Japanese for phrases that need a usage tip).
- "steps": exactly 3 to 5 steps forming a guided conversation skeleton. Each step has "aiIntent" (an English instruction describing what the AI role should say at this point), "hintJa" (a Japanese hint for the learner), "hintEn" (a short English starter phrase the learner could begin with), and "modelAnswer" (a full natural English sentence the learner could say, suitable for text-to-speech playback).
- "hiddenObjectives": exactly 2 objectives. Each has a short "id" (kebab-case, unique within this scenario), a "descriptionJa" (short Japanese description of a small challenge, e.g. using past tense twice), and a "check" (an English instruction for how a later grading step should judge from the transcript whether the learner achieved it).
- "targetPhonemes": 2 to 4 pronunciation focus points, chosen ONLY from this fixed set of ARPAbet keys (never invent others): ${TARGET_PHONEME_KEYS.join(', ')}. Prefer phonemes that naturally occur in the keyPhrases/modelAnswer text, and when the learner's weak phonemes are given below, prefer those among the natural candidates.
- "setting", "aiRole", "userRole", "goal": describe a concrete, everyday scene in English, matching the learner's stated interests when provided.
- "goalJa": Japanese translation of "goal".
- "freeTalkPrompt": an English instruction for how the AI role should continue a short free-talk phase after the guided steps are done.
- "title"/"titleJa": a short, specific title for the scene (English / Japanese) that is clearly different from the learner's already-generated titles listed in the next message.
- "category": pick exactly one of: travel, restaurant, work, daily, interview, shopping, health, social — whichever best fits the scene.
- "level": must be exactly the app level given in the next message.
- "estimatedMinutes": a realistic number of minutes (roughly 5 to 12) for a single guided lesson through this scenario.

Write all Japanese-language fields (titleJa, goalJa, hintJa, descriptionJa, ja, note) entirely in Japanese. Keep all other fields in English.

Call the ${TOOL_NAME} tool exactly once with your result.`;
  return [{ type: 'text', text }];
}

/** 興味・弱点音素・レベル・既存タイトル一覧をSonnetへ渡すuserメッセージ本文に組み立てる純関数。 */
export function buildScenarioGenUserContent(opts: GenerateScenarioOptions): string {
  const levelParams = getLevelParams(opts.level);

  const interestsLine =
    opts.interests.length > 0
      ? `Learner's stated interests: ${opts.interests.join(', ')}`
      : "Learner's stated interests: none specified — choose any everyday topic.";

  const weakPhonemesLine =
    opts.weakPhonemes.length > 0
      ? `Phonemes this learner should get extra practice with (ARPAbet): ${opts.weakPhonemes.join(', ')}`
      : "Phonemes this learner should get extra practice with: none recorded yet — choose targetPhonemes naturally from the scenario's vocabulary.";

  const existingTitlesLine =
    opts.existingTitles.length > 0
      ? `Titles already generated for this learner (do not repeat these or create a very similar scenario):\n${opts.existingTitles.map((t) => `- ${t}`).join('\n')}`
      : 'Titles already generated for this learner: none yet.';

  const lines = [
    `Learner's current level: ${levelParams.cefr} (app level ${opts.level}). Write the scenario for exactly this level.`,
    interestsLine,
    weakPhonemesLine,
    existingTitlesLine,
  ];
  return lines.join('\n\n');
}

/**
 * Anthropic tool useのinput_schemaを組み立てる純関数（sonnetCorrection.tsの
 * CORRECTION_REPORT_TOOL_SCHEMAと同じ流儀）。levelはenumで指定値のみを許可し、
 * モデルが違うレベルを返す事故そのものを減らす（受信後もparseScenarioGenToolResultで再検証する）。
 */
export function buildScenarioGenTool(level: AppLevel) {
  return {
    name: TOOL_NAME,
    description: 'Submit the newly designed English conversation practice scenario.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short English title for the scenario.' },
        titleJa: { type: 'string', description: 'Japanese translation of the title.' },
        category: {
          type: 'string',
          enum: SCENARIO_CATEGORIES as unknown as string[],
        },
        level: {
          type: 'integer',
          enum: [level],
          description: 'Must be exactly this app level.',
        },
        setting: { type: 'string', description: 'English description of the scene.' },
        aiRole: { type: 'string', description: 'English description of the AI conversation partner role.' },
        userRole: { type: 'string', description: "English description of the learner's role." },
        goal: { type: 'string', description: 'English description of the conversation goal.' },
        goalJa: { type: 'string', description: 'Japanese translation of goal.' },
        keyPhrases: {
          type: 'array',
          minItems: KEY_PHRASES_MIN,
          maxItems: KEY_PHRASES_MAX,
          items: {
            type: 'object',
            properties: {
              en: { type: 'string' },
              ja: { type: 'string' },
              note: { type: 'string', description: 'Optional short usage tip in Japanese.' },
            },
            required: ['en', 'ja'],
          },
        },
        steps: {
          type: 'array',
          minItems: STEPS_MIN,
          maxItems: STEPS_MAX,
          items: {
            type: 'object',
            properties: {
              aiIntent: { type: 'string' },
              hintJa: { type: 'string' },
              hintEn: { type: 'string' },
              modelAnswer: { type: 'string' },
            },
            required: ['aiIntent', 'hintJa', 'hintEn', 'modelAnswer'],
          },
        },
        hiddenObjectives: {
          type: 'array',
          minItems: HIDDEN_OBJECTIVES_COUNT,
          maxItems: HIDDEN_OBJECTIVES_COUNT,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              descriptionJa: { type: 'string' },
              check: { type: 'string' },
            },
            required: ['id', 'descriptionJa', 'check'],
          },
        },
        targetPhonemes: {
          type: 'array',
          minItems: TARGET_PHONEMES_MIN,
          maxItems: TARGET_PHONEMES_MAX,
          items: { type: 'string', enum: TARGET_PHONEME_KEYS as unknown as string[] },
        },
        estimatedMinutes: {
          type: 'integer',
          minimum: ESTIMATED_MINUTES_MIN,
          maximum: ESTIMATED_MINUTES_MAX,
        },
        freeTalkPrompt: { type: 'string', description: 'English instruction for the free-talk phase.' },
      },
      required: [
        'title',
        'titleJa',
        'category',
        'level',
        'setting',
        'aiRole',
        'userRole',
        'goal',
        'goalJa',
        'keyPhrases',
        'steps',
        'hiddenObjectives',
        'targetPhonemes',
        'estimatedMinutes',
        'freeTalkPrompt',
      ],
    },
  } as const;
}

/** toolChoiceに渡す値（TOOL_NAMEを強制指定する。buildScenarioGenTool(level)と対で使う）。 */
export const SCENARIO_GEN_TOOL_CHOICE = { type: 'tool', name: TOOL_NAME } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidCategory(value: unknown): value is ScenarioCategory {
  return typeof value === 'string' && (SCENARIO_CATEGORIES as readonly string[]).includes(value);
}

function isValidKeyPhrase(value: unknown): value is KeyPhrase {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.en) || !isNonEmptyString(value.ja)) return false;
  if (value.note !== undefined && typeof value.note !== 'string') return false;
  return true;
}

function isValidStep(value: unknown): value is ScenarioStep {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.aiIntent) &&
    isNonEmptyString(value.hintJa) &&
    isNonEmptyString(value.hintEn) &&
    isNonEmptyString(value.modelAnswer)
  );
}

function isValidHiddenObjective(value: unknown): value is HiddenObjective {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.descriptionJa) && isNonEmptyString(value.check);
}

/** targetPhonemesが2〜4個・すべてTARGET_PHONEME_KEYS(15音素キー)内であることを検証する。 */
function isValidTargetPhonemes(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length < TARGET_PHONEMES_MIN || value.length > TARGET_PHONEMES_MAX) return false;
  return value.every((p) => typeof p === 'string' && (TARGET_PHONEME_KEYS as readonly string[]).includes(p));
}

/**
 * tool_use.inputがGeneratedScenarioFieldsとして妥当かを検証する型ガード
 * （isSonnetCorrectionOutputと同じ流儀）。levelは呼び出し時に指定した値と完全一致することを要求する。
 */
function isGeneratedScenarioFields(value: unknown, level: AppLevel): value is GeneratedScenarioFields {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.titleJa) &&
    isValidCategory(value.category) &&
    value.level === level &&
    isNonEmptyString(value.setting) &&
    isNonEmptyString(value.aiRole) &&
    isNonEmptyString(value.userRole) &&
    isNonEmptyString(value.goal) &&
    isNonEmptyString(value.goalJa) &&
    Array.isArray(value.keyPhrases) &&
    value.keyPhrases.length >= KEY_PHRASES_MIN &&
    value.keyPhrases.length <= KEY_PHRASES_MAX &&
    value.keyPhrases.every(isValidKeyPhrase) &&
    Array.isArray(value.steps) &&
    value.steps.length >= STEPS_MIN &&
    value.steps.length <= STEPS_MAX &&
    value.steps.every(isValidStep) &&
    Array.isArray(value.hiddenObjectives) &&
    value.hiddenObjectives.length === HIDDEN_OBJECTIVES_COUNT &&
    value.hiddenObjectives.every(isValidHiddenObjective) &&
    isValidTargetPhonemes(value.targetPhonemes) &&
    typeof value.estimatedMinutes === 'number' &&
    Number.isFinite(value.estimatedMinutes) &&
    value.estimatedMinutes >= ESTIMATED_MINUTES_MIN &&
    value.estimatedMinutes <= ESTIMATED_MINUTES_MAX &&
    isNonEmptyString(value.freeTalkPrompt)
  );
}

/**
 * callMessagesが返すcontent配列から、TOOL_NAMEのtool_useブロックを取り出し検証する純関数。
 * 該当ブロックが無い、またはinputの形が不正（必須フィールド欠落・配列長不正・levelの不一致・
 * targetPhonemesがキー集合外を含む等）な場合はnullを返す（呼び出し側はエラー扱いにする）。
 */
export function parseScenarioGenToolResult(content: unknown[], level: AppLevel): GeneratedScenarioFields | null {
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'tool_use' || block.name !== TOOL_NAME) continue;
    if (isGeneratedScenarioFields(block.input, level)) {
      return block.input;
    }
  }
  return null;
}

/**
 * 端末上の動的シナリオ生成本体（DESIGN.md §9・M9）。
 *
 * 手順: Anthropicキー確認 → 日次キャップ(sonnetCalls)判定 → tool use強制で1コール →
 * usageLogへ加算（Sonnet呼び出しは成功=課金発生済みのため、後続の検証結果に関わらず必ず行う。
 * generateReport.tsと同じ理由） → tool_use結果を検証 → 検証OKならid/sourceを付与して返す。
 * どの段階で失敗しても例外は投げず `{ error: string }`（日本語メッセージ）を返す
 * （呼び出し側=ScenariosPage.tsxは画面内にそのまま表示すればよい）。
 */
export async function generateScenario(opts: GenerateScenarioOptions): Promise<GenerateScenarioResult> {
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
      system: buildScenarioGenSystem(),
      messages: [{ role: 'user', content: buildScenarioGenUserContent(opts) }],
      maxTokens: MAX_TOKENS,
      tools: [buildScenarioGenTool(opts.level)],
      toolChoice: SCENARIO_GEN_TOOL_CHOICE,
    });

    await addUsage(today, {
      sonnetCalls: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
    });

    const parsed = parseScenarioGenToolResult(result.content, opts.level);
    if (!parsed) {
      return { error: 'シナリオ生成結果の解析に失敗しました。もう一度お試しください。' };
    }

    const scenario: Scenario = {
      ...parsed,
      id: `gen-${crypto.randomUUID()}`,
      source: 'generated',
    };
    return scenario;
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `シナリオ生成中にエラーが発生しました: ${err.message}`
          : 'シナリオ生成中にエラーが発生しました。',
    };
  }
}
