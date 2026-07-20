/**
 * 初回診断テストの設問3つ（DESIGN.md §8a・M6）。
 * ①自己紹介 ②場面描写（短い日本語で場面を提示し英語で説明させる） ③意見質問。
 * 各設問は日本語の指示文（画面表示用）と英語の指示文（sonnetDiagnostic.tsがSonnetへ
 * 渡すanswers[].questionとして使う想定）を両方持つ。目安秒数は30〜60秒（DESIGN.md §8a）。
 */

export type DiagnosticQuestionId = 'self-intro' | 'scene-description' | 'opinion';

export interface DiagnosticQuestion {
  id: DiagnosticQuestionId;
  /** 画面に表示する日本語の指示文。 */
  instructionJa: string;
  /**
   * Sonnet採点への入力（DiagnosticAnswer.question）としてそのまま渡す英語の指示文。
   * 場面描写問題は下のsceneJaで提示した場面を英語で説明させる指示になっている。
   */
  instructionEn: string;
  /** 場面描写問題でのみ使う、日本語で提示する場面文。他の設問はundefined。 */
  sceneJa?: string;
  minSeconds: number;
  maxSeconds: number;
}

const SCENE_JA =
  '駅のホームで電車を待っていたら、急に大雨が降ってきて、傘を持っていないことに気づいた。';

export const DIAGNOSTIC_QUESTIONS: DiagnosticQuestion[] = [
  {
    id: 'self-intro',
    instructionJa:
      '自己紹介をしてください。名前・普段していること・趣味など、自由に30〜60秒程度英語で話してください。',
    instructionEn:
      'Introduce yourself in English. Talk freely for about 30 to 60 seconds — your name, what you usually do, your hobbies, anything you like.',
    minSeconds: 30,
    maxSeconds: 60,
  },
  {
    id: 'scene-description',
    instructionJa: `次の場面を英語で説明してください。\n「${SCENE_JA}」`,
    instructionEn:
      'Describe the following scene in English, in your own words, for about 30 to 60 seconds: You were waiting for a train on a station platform when it suddenly started raining heavily, and you realized you did not have an umbrella with you.',
    sceneJa: SCENE_JA,
    minSeconds: 30,
    maxSeconds: 60,
  },
  {
    id: 'opinion',
    instructionJa:
      '「一人で過ごす休日」と「誰かと過ごす休日」、あなたはどちらが好きですか？理由も含めて30〜60秒程度、英語で話してください。',
    instructionEn:
      'Which do you prefer: spending a day off alone, or spending it with someone else? Explain your reasons in English, speaking for about 30 to 60 seconds.',
    minSeconds: 30,
    maxSeconds: 60,
  },
];
