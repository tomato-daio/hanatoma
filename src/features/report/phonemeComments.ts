/**
 * 発音コメントの合成（DESIGN.md §7b）。
 * LLMではなく純関数で、会話中の全userターンのpa.weakPhonemesを集計し、
 * phonemeAdvice.ts（shadotomaコピー・15音素辞書）のコツ文とマージして
 * CorrectionReport.pronunciationComments に入れる文字列配列を作る。
 */

import type { PaResult, Turn } from '../../lib/types';
import type { PhonemeAdviceEntry } from './phonemeAdvice';

/** 平均スコアがこれ未満の音素だけをコメント対象にする（「苦手」とみなす閾値）。 */
const WEAK_SCORE_THRESHOLD = 60;
/** コメントとして出す音素の最大数（優先度＝平均スコアが低い順）。 */
const COMMENT_LIMIT = 3;
/** 1コメントに含める例語の最大数。 */
const EXAMPLE_LIMIT = 2;

export interface AggregatedWeakPhoneme {
  /** normalizePhonemeKey済みのARPAbet大文字キー。 */
  phoneme: string;
  /** 会話全体でのこの音素の平均スコア（ターンをまたいだweakPhonemes出現の単純平均）。 */
  avgScore: number;
  /** 例語（重複除去・出現順）。 */
  examples: string[];
}

/**
 * 全userターンのpa.weakPhonemesを音素キーで集計する純関数。
 * 同じ音素が複数ターンに出現した場合はavgScoreの単純平均を取り、examplesはターンをまたいで
 * 重複を除いて連結する。平均スコアがWEAK_SCORE_THRESHOLD以上の音素は除外し、
 * 低いスコア順（＝苦手優先）に並べて返す。
 */
export function aggregateWeakPhonemes(turns: Turn[]): AggregatedWeakPhoneme[] {
  const byPhoneme = new Map<string, { totalScore: number; count: number; examples: string[] }>();

  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const weakPhonemes: PaResult['weakPhonemes'] = turn.pa?.weakPhonemes;
    if (!weakPhonemes) continue;

    for (const wp of weakPhonemes) {
      const entry = byPhoneme.get(wp.phoneme) ?? { totalScore: 0, count: 0, examples: [] };
      entry.totalScore += wp.avgScore;
      entry.count += 1;
      for (const example of wp.examples) {
        if (!entry.examples.includes(example)) entry.examples.push(example);
      }
      byPhoneme.set(wp.phoneme, entry);
    }
  }

  return [...byPhoneme.entries()]
    .map(([phoneme, entry]) => ({
      phoneme,
      avgScore: entry.totalScore / entry.count,
      examples: entry.examples,
    }))
    .filter((entry) => entry.avgScore < WEAK_SCORE_THRESHOLD)
    .sort((a, b) => a.avgScore - b.avgScore);
}

/**
 * buildPronunciationComments: 会話のturnsとphonemeAdvice辞書から、
 * 優先度順(平均スコアが低い順)最大COMMENT_LIMIT件の発音コメントを組み立てる純関数。
 * 辞書にコツ文が無い音素（15種以外）は記号と例語のみのコメントにする。
 * @param adviceDict phonemeAdvice.tsのPHONEME_ADVICE相当（テスト用に差し替え可能にするため引数で受け取る）
 */
export function buildPronunciationComments(
  turns: Turn[],
  adviceDict: Readonly<Record<string, PhonemeAdviceEntry>>,
): string[] {
  const weakPhonemes = aggregateWeakPhonemes(turns).slice(0, COMMENT_LIMIT);

  return weakPhonemes.map((wp) => {
    const examples = wp.examples.slice(0, EXAMPLE_LIMIT);
    const exampleSuffix = examples.length > 0 ? `（例: ${examples.join('、')}）` : '';
    const entry = adviceDict[wp.phoneme];
    return entry ? `${entry.displayName}: ${entry.advice}${exampleSuffix}` : `${wp.phoneme}の音${exampleSuffix}`;
  });
}
