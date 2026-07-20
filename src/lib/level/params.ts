/**
 * レベル別パラメータの定数テーブル（DESIGN.md §8d）。
 *
 * このテーブルが Haiku system プロンプトと TTS SSML の両方に注入される唯一の難易度ソース。
 * レベルを跨いだ挙動変更（語彙制限・文長・TTS速度・日本語サポート）は必ずここを直す。
 */

import type { AppLevel } from '../types';

/** CEFR帯（表示・ログ用。診断結果のcefr文字列とも対応する）。 */
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

/**
 * 日本語サポートの種別（DESIGN.md §8d表の「日本語サポート」列に対応）。
 * - always-translation: AI発話に和訳を常時併記（Lv1）
 * - always-hint: ヒントを常時表示（Lv2）
 * - button-hint: ヒントはボタンを押して表示（Lv3）
 * - button-only: 模範解答ボタンのみ（和訳・常時ヒントなし。Lv4）
 * - none: 日本語サポートなし（Lv5）
 */
export type JapaneseSupportKind = 'always-translation' | 'always-hint' | 'button-hint' | 'button-only' | 'none';

export interface LevelParams {
  level: AppLevel;
  cefr: CefrLevel;
  /** AI語彙指示文（英語。Haiku systemプロンプトへそのまま注入する）。 */
  vocabInstruction: string;
  /** TTSのSSML `<prosody rate>` へそのまま入れる文字列（例 '-25%'）。 */
  ttsRate: string;
  /** AI文長指示文（英語。Haiku systemプロンプトへそのまま注入する）。 */
  sentenceLengthInstruction: string;
  japaneseSupport: JapaneseSupportKind;
  /** 日本語サポートの表示ラベル（DESIGN.md §8d表の文言そのまま）。 */
  japaneseSupportLabel: string;
}

/** レベル1〜5それぞれのパラメータ（DESIGN.md §8d表と1:1対応）。 */
export const LEVEL_PARAMS: Record<AppLevel, LevelParams> = {
  1: {
    level: 1,
    cefr: 'A1',
    vocabInstruction:
      'Use only the most basic ~1000 English words (simple everyday vocabulary). Avoid idioms, phrasal verbs, and rare words.',
    ttsRate: '-25%',
    sentenceLengthInstruction: 'Keep each sentence to 8 words or fewer. Use short, simple sentences.',
    japaneseSupport: 'always-translation',
    japaneseSupportLabel: 'AI発話に和訳を常時併記',
  },
  2: {
    level: 2,
    cefr: 'A2',
    vocabInstruction:
      'Use basic vocabulary (roughly the most common 2000 English words). Avoid idioms and rare words.',
    ttsRate: '-15%',
    sentenceLengthInstruction: 'Keep each sentence to 12 words or fewer.',
    japaneseSupport: 'always-hint',
    japaneseSupportLabel: 'ヒント常時表示',
  },
  3: {
    level: 3,
    cefr: 'B1',
    vocabInstruction:
      'Use plain, everyday vocabulary, but moderately uncommon words are fine when natural. Avoid obscure vocabulary.',
    ttsRate: '-8%',
    sentenceLengthInstruction: 'Use natural sentence length, as in an ordinary conversation.',
    japaneseSupport: 'button-hint',
    japaneseSupportLabel: 'ヒントはボタン',
  },
  4: {
    level: 4,
    cefr: 'B2',
    vocabInstruction: 'No vocabulary restriction. Natural idioms and phrasal verbs are fine.',
    ttsRate: '0%',
    sentenceLengthInstruction: 'Use natural sentence length; idiomatic phrasing is fine.',
    japaneseSupport: 'button-only',
    japaneseSupportLabel: 'ボタンのみ',
  },
  5: {
    level: 5,
    cefr: 'C1',
    vocabInstruction: 'No vocabulary restriction. Use idiomatic, native-level expressions freely.',
    ttsRate: '0%',
    sentenceLengthInstruction: 'Speak at a native-level pace and complexity, as with a fluent adult.',
    japaneseSupport: 'none',
    japaneseSupportLabel: 'なし',
  },
};

/** 指定レベルのパラメータを返す（LEVEL_PARAMSの参照ショートカット）。 */
export function getLevelParams(level: AppLevel): LevelParams {
  return LEVEL_PARAMS[level];
}
