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
  /** レベルの短ラベル（入門〜上級。ホームのレベル行・進捗画面で表示）。 */
  labelJa: string;
  /** このレベルでできることの一文（進捗画面のレベルカードで表示）。 */
  guideJa: string;
  /** 外部試験での目安（文科省のCEFR対照表に基づく英検・TOEIC L&R相当）。 */
  benchmarkJa: string;
  /** ttsRateの日本語表現（進捗画面の「AIの調整」行で表示）。 */
  ttsRateLabelJa: string;
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
    labelJa: '入門',
    guideJa: 'あいさつや自己紹介など、覚えた定型フレーズを使って簡単なやりとりができる段階です。',
    benchmarkJa: '英検3級・TOEIC 〜220点くらい',
    ttsRateLabelJa: 'かなりゆっくり',
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
    labelJa: '初級',
    guideJa: '買い物や注文など、日常の身近な用事を短い文でこなせる段階です。',
    benchmarkJa: '英検準2級・TOEIC 225〜545点くらい',
    ttsRateLabelJa: 'ゆっくり',
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
    labelJa: '中級',
    guideJa: '旅行先のたいていの場面に対応でき、身近な話題で自分の意見を言える段階です。',
    benchmarkJa: '英検2級・TOEIC 550〜780点くらい',
    ttsRateLabelJa: '少しゆっくり',
  },
  4: {
    level: 4,
    cefr: 'B2',
    vocabInstruction: 'No vocabulary restriction. Natural idioms and phrasal verbs are fine.',
    ttsRate: '0%',
    sentenceLengthInstruction: 'Use natural sentence length; idiomatic phrasing is fine.',
    japaneseSupport: 'button-only',
    japaneseSupportLabel: 'ボタンのみ',
    labelJa: '中上級',
    guideJa: '幅広い話題で自然に会話でき、賛成・反対など込み入ったやりとりもできる段階です。',
    benchmarkJa: '英検準1級・TOEIC 785〜940点くらい',
    ttsRateLabelJa: '自然な速さ',
  },
  5: {
    level: 5,
    cefr: 'C1',
    vocabInstruction: 'No vocabulary restriction. Use idiomatic, native-level expressions freely.',
    ttsRate: '0%',
    sentenceLengthInstruction: 'Speak at a native-level pace and complexity, as with a fluent adult.',
    japaneseSupport: 'none',
    japaneseSupportLabel: 'なし',
    labelJa: '上級',
    guideJa: '複雑な話題でも流ちょうに話せ、場面に応じて表現を使い分けられる段階です。',
    benchmarkJa: '英検1級・TOEIC 945点〜くらい',
    ttsRateLabelJa: '自然な速さ',
  },
};

/** 指定レベルのパラメータを返す（LEVEL_PARAMSの参照ショートカット）。 */
export function getLevelParams(level: AppLevel): LevelParams {
  return LEVEL_PARAMS[level];
}
