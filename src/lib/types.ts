/**
 * アプリ全体で共有するデータ型の正本（DESIGN.md §3 と同期必須）。
 * DBスキーマ(db.ts)・純関数(lib/level, lib/game, lib/usage)・UIはすべてここからimportする。
 */

export type ScenarioCategory =
  | 'travel'
  | 'restaurant'
  | 'work'
  | 'daily'
  | 'interview'
  | 'shopping'
  | 'health'
  | 'social';

export type AppLevel = 1 | 2 | 3 | 4 | 5;

export interface ScenarioStep {
  aiIntent: string; // このステップでAIが言うべき内容の指示（英語）
  hintJa: string; // ヒント段階1: 日本語ヒント
  hintEn: string; // ヒント段階2: 英語の言い出しヒント
  modelAnswer: string; // ヒント段階3: 模範解答（TTS再生可）
}

export interface HiddenObjective {
  id: string;
  descriptionJa: string;
  check: string; // Sonnet添削への判定指示文
}

export interface KeyPhrase {
  en: string;
  ja: string;
  note?: string;
}

export interface Scenario {
  id: string; // bundled: "b-<category>-<連番>", 生成: "gen-" + crypto.randomUUID()
  source: 'bundled' | 'generated';
  title: string;
  titleJa: string;
  category: ScenarioCategory;
  level: AppLevel;
  setting: string; // 場面描写（英語。Haiku systemへそのまま注入）
  aiRole: string;
  userRole: string;
  goal: string;
  goalJa: string;
  keyPhrases: KeyPhrase[]; // 3〜5個
  steps: ScenarioStep[]; // ガイド付き会話の骨格 3〜5ステップ
  hiddenObjectives: HiddenObjective[];
  targetPhonemes?: string[]; // ARPAbet大文字（例 "R","TH"）
  estimatedMinutes: number;
  freeTalkPrompt: string;
}

export type ConversationMode = 'lesson' | 'quick' | 'bite' | 'diagnostic' | 'boss';
export type ConversationPhase = 'keyphrase' | 'guided' | 'free';

/** Azure発音評価結果（unscripted: completenessScoreなし / scripted: あり） */
export interface PaResult {
  mode: 'unscripted' | 'scripted';
  pronScore: number;
  accuracyScore: number;
  fluencyScore: number;
  prosodyScore?: number; // プロソディ失敗リトライ時はundefined
  completenessScore?: number; // scriptedのみ
  words: { word: string; accuracyScore: number; errorType: string }[];
  weakPhonemes?: { phoneme: string; avgScore: number; examples: string[] }[]; // 上位3件
  azureError?: string; // 失敗時のみ（cancellation errorDetails先頭120字）
}

export interface Turn {
  role: 'user' | 'ai';
  text: string; // user=認識結果(または入力テキスト) / ai=生成文
  at: number;
  phase: ConversationPhase;
  inputMode?: 'voice' | 'text'; // userのみ
  audioBlob?: Blob; // userのみ・振り返り再生用（saveTurnAudio=false なら保存しない）
  mimeType?: string;
  pa?: PaResult; // userのみ（音声入力時）
  thinkingMs?: number; // AI発話終了→録音開始までの時間（userのみ）
}

export interface LessonMetrics {
  pronScore: number; // セッション内PA総合の平均 0-100
  grammarErrorRate: number; // grammarErrorCount / ユーザー総語数 × 100
  thinkingTimeMs: number; // thinkingMsの中央値
  meanUtteranceWords: number; // ユーザー発話の平均語数
  composite: number; // 0-100（lib/level/metrics.ts で算出）
}

export interface Conversation {
  id: string;
  scenarioId: string;
  mode: ConversationMode;
  date: string; // 学習日 "YYYY-MM-DD"（午前3時切替。dates.ts）
  startedAt: number;
  finishedAt?: number;
  status: 'active' | 'completed' | 'abandoned';
  turns: Turn[];
  metrics?: LessonMetrics;
  xpAwarded?: number;
  stars?: 0 | 1 | 2 | 3;
}

export type CorrectionKind = 'grammar' | 'word-choice' | 'naturalness' | 'expression';

export interface CorrectionItem {
  turnIndex: number;
  original: string;
  corrected: string;
  kind: CorrectionKind;
  explanationJa: string;
}

export interface CorrectionReport {
  id: string;
  conversationId: string;
  date: string;
  createdAt: number;
  items: CorrectionItem[];
  rephrases: { turnIndex: number; levelUp: string; native: string }[];
  learnedExpressions: { en: string; ja: string; note?: string }[]; // 3〜5件
  objectivesAchieved: string[]; // 達成したhiddenObjectiveのid
  grammarErrorCount: number;
  pronunciationComments: string[]; // 音素助言マージ純関数の出力（LLM出力ではない）
  summaryJa: string;
}

export interface ExpressionItem {
  id: string;
  en: string;
  ja: string;
  note?: string;
  sourceConversationId?: string;
  addedAt: number;
  useCount: number; // 会話中に使えたらインクリメント（クエスト判定元）
  lastUsedAt?: number;
}

export interface UserProfile {
  key: 'main';
  level: AppLevel;
  levelHistory: {
    date: string;
    level: AppLevel;
    reason: 'diagnostic' | 'promote' | 'demote' | 'manual';
  }[];
  xp: number; // 累計（ランクはxpから導出）
  restTickets: number; // お休みチケット保有数（0〜2）
  badges: { id: string; earnedAt: number }[];
  interests: string[];
  diagnostic?: { date: string; cefr: string; comment: string };
  createdAt: number;
}

export interface QuestState {
  date: string;
  quests: { id: string; progress: number; target: number; done: boolean }[];
  bossWeekId?: string; // "2026-W30" 形式
  bossDone?: boolean;
}

export interface UsageDay {
  date: string;
  haikuCalls: number;
  sonnetCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  paSeconds: number;
  ttsChars: number;
  sessionsStarted: number;
}

export interface DailyCaps {
  sessions: number;
  sonnetCalls: number;
  paMinutes: number;
}

/** 既定の日次キャップ（DESIGN.md §12。appState 'dailyCaps' で上書き可） */
export const DEFAULT_DAILY_CAPS: DailyCaps = {
  sessions: 3,
  sonnetCalls: 8,
  paMinutes: 30,
};
