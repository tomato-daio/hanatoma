/**
 * 会話パートナー(Haiku)のsystemプロンプト組み立て（DESIGN.md §7a）。
 * 2ブロック構成でprompt cachingを効かせる:
 *   1. 共通ルール — 完全に不変の固定文字列。どのシナリオ・レベルでも同一なので、
 *      アプリ全体で高いキャッシュヒット率になる（cache_control）。
 *   2. シナリオ+レベル+現在ステップ — レッスンごとに内容が変わる。stepはガイドフェーズの
 *      進行で変化するため、このブロックはstep切替のたびに新規キャッシュ書き込みが発生するが、
 *      cache_controlのブレークポイントは独立しているため1ブロック目のキャッシュには影響しない。
 *
 * レベル別パラメータ（語彙・文長）の正本は src/lib/level/params.ts（DESIGN.md §8d の
 * 「唯一の難易度ソース」）。このファイルは値を複製せず getLevelParams で参照する。
 */

import { getLevelParams } from '../../../lib/level/params';
import type { AppLevel, ConversationPhase, Scenario, ScenarioStep } from '../../../lib/types';
import type { SystemBlock } from '../anthropicClient';

/** 完全に不変の共通ルール。文言を変えると全アプリのキャッシュが1度だけ書き直しになる点に注意。 */
const COMMON_RULES = `You are an AI conversation partner inside an English-speaking practice app for a Japanese-speaking learner of English.
Follow these rules on every turn:
- Stay in character as the role assigned to you for this scenario. Never break character.
- Keep each reply short and natural: 1 to 3 sentences.
- Respect the vocabulary and sentence-length guidance given for the learner's current level.
- Never correct the user's English mistakes during the conversation. If you understood what they meant, continue the conversation naturally. Only ask them to repeat or rephrase if you truly could not understand their meaning.
- Gently steer the conversation toward the stated goal without being forceful about it.
- When a current guided-practice step is given, your reply should move the conversation toward accomplishing that step before the conversation moves on.
- Never mention that you are an AI, a language model, or that this is a practice exercise.`;

/**
 * DESIGN.md §8d: レベル別のAI語彙・文長指示。値はparams.ts（唯一の難易度ソース）から取り、
 * ここでは文字列の結合のみ行う。TTSのrateはazureTts.ts側の担当なのでここには含めない。
 */
function levelInstruction(level: AppLevel): string {
  const p = getLevelParams(level);
  return `Vocabulary guidance: ${p.vocabInstruction} Sentence length guidance: ${p.sentenceLengthInstruction}`;
}

/**
 * buildPartnerSystem: シナリオ・レベル・(任意で)現在のステップとフェーズから2ブロックのsystemを組み立てる。
 * @param scenario 対象シナリオ
 * @param level ユーザーの現在のアプリレベル(1〜5)
 * @param step ガイド付き会話フェーズ('guided')で現在進行中のステップ。フェーズ以外では未使用
 * @param phase 現在の会話フェーズ。'guided'はstepのaiIntentを、'free'はfreeTalkPromptを追加注入する
 */
export function buildPartnerSystem(
  scenario: Scenario,
  level: AppLevel,
  step?: ScenarioStep,
  phase?: ConversationPhase,
): SystemBlock[] {
  const scenarioLines = [
    `Scene: ${scenario.setting}`,
    `Your role: ${scenario.aiRole}. The user's role: ${scenario.userRole}.`,
    `Goal of this conversation: ${scenario.goal}`,
    levelInstruction(level),
  ];

  if (phase === 'guided' && step) {
    scenarioLines.push(`Current guided step — what your next reply should accomplish: ${step.aiIntent}`);
  } else if (phase === 'free') {
    scenarioLines.push(`Free-conversation phase guidance: ${scenario.freeTalkPrompt}`);
  }

  return [
    { type: 'text', text: COMMON_RULES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: scenarioLines.join('\n'), cache_control: { type: 'ephemeral' } },
  ];
}
