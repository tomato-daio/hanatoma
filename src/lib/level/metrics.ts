/**
 * レッスンメトリクス算出（DESIGN.md §8b）。
 *
 * turns（1レッスン分の発話ログ）とSonnet添削のgrammarErrorCountから、
 * レベル昇降格判定(progress.ts)の入力となるLessonMetricsを求める純関数。
 * ユーザーの音声ターンが1件も無い場合（テキスト入力のみ・bite等でデータが少ない）でも
 * 例外を投げず、NaNを出さない（各成分は「データなし」を意味する既定値にフォールバックする）。
 */

import type { LessonMetrics, Turn } from '../types';

/** grammarComponentの傾き（誤り率1ptにつき何点減点するか）。 */
const GRAMMAR_PENALTY_PER_RATE_POINT = 10;

/** fluencyComponentが満点(100)になる思考時間の上限(ms)。これ以下は満点。 */
const FLUENCY_FULL_SCORE_MS = 2000;
/** fluencyComponentが0点になる思考時間の下限(ms)。これ以上は0点。 */
const FLUENCY_ZERO_SCORE_MS = 10000;

/** complexityComponentが0点になる平均語数。これ以下は0点。 */
const COMPLEXITY_ZERO_SCORE_WORDS = 2;
/** complexityComponentが満点(100)になる平均語数。これ以上は満点。 */
const COMPLEXITY_FULL_SCORE_WORDS = 12;

/** composite加重（DESIGN.md §8b: 0.3/0.3/0.2/0.2）。 */
const COMPOSITE_WEIGHTS = {
  pron: 0.3,
  grammar: 0.3,
  fluency: 0.2,
  complexity: 0.2,
} as const;

/**
 * 発音データが無いセッション用に、pronの重み(0.3)を残り3成分へ比例配分した加重（合計1）を返す純関数。
 * grammar/fluency/complexity の比 0.3:0.2:0.2 を保ったまま正規化する（DESIGN.md §8b）。
 */
function reweightWithoutPron(): { pron: number; grammar: number; fluency: number; complexity: number } {
  const rest = COMPOSITE_WEIGHTS.grammar + COMPOSITE_WEIGHTS.fluency + COMPOSITE_WEIGHTS.complexity;
  return {
    pron: 0,
    grammar: COMPOSITE_WEIGHTS.grammar / rest,
    fluency: COMPOSITE_WEIGHTS.fluency / rest,
    complexity: COMPOSITE_WEIGHTS.complexity / rest,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** テキストの語数（空白区切り。空文字列・空白のみは0語）。 */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * valueを [x0,y0]→[x1,y1] の直線で写像し、範囲外はクランプする。
 * fluency(減少方向)・complexity(増加方向)のどちらにも使う汎用関数。
 */
function linearScore(value: number, x0: number, y0: number, x1: number, y1: number): number {
  const t = (value - x0) / (x1 - x0);
  const clampedT = Math.min(1, Math.max(0, t));
  return y0 + clampedT * (y1 - y0);
}

/**
 * turnsとgrammarErrorCountからLessonMetrics（composite含む）を算出する（DESIGN.md §8b）。
 *
 * - pronScore: ユーザーの音声ターン（pa あり）のPA総合(pronScore)の平均。音声ターンが無ければ0
 * - grammarErrorRate: grammarErrorCount / ユーザー総語数 × 100。総語数0なら0（誤りようがないため）
 * - thinkingTimeMs: thinkingMsの中央値。値が無ければ0（= fluencyComponentは満点側）
 * - meanUtteranceWords: ユーザー発話の平均語数。ユーザーターンが無ければ0
 * - composite: 各componentの加重和
 */
export function computeLessonMetrics(turns: Turn[], grammarErrorCount: number): LessonMetrics {
  const userTurns = turns.filter((t) => t.role === 'user');

  const pronScores = userTurns.filter((t) => t.pa !== undefined).map((t) => t.pa!.pronScore);
  const pronScore = average(pronScores);

  const userWordCounts = userTurns.map((t) => countWords(t.text));
  const totalUserWords = userWordCounts.reduce((sum, n) => sum + n, 0);
  const grammarErrorRate = totalUserWords === 0 ? 0 : (grammarErrorCount / totalUserWords) * 100;

  const thinkingTimes = userTurns.map((t) => t.thinkingMs).filter((ms): ms is number => ms !== undefined);
  const thinkingTimeMs = median(thinkingTimes);

  const meanUtteranceWords = userTurns.length === 0 ? 0 : totalUserWords / userTurns.length;

  const grammarComponent = Math.max(0, 100 - grammarErrorRate * GRAMMAR_PENALTY_PER_RATE_POINT);
  const fluencyComponent = linearScore(thinkingTimeMs, FLUENCY_FULL_SCORE_MS, 100, FLUENCY_ZERO_SCORE_MS, 0);
  const complexityComponent = linearScore(
    meanUtteranceWords,
    COMPLEXITY_ZERO_SCORE_WORDS,
    0,
    COMPLEXITY_FULL_SCORE_WORDS,
    100,
  );

  // 発音データの有無で加重を切り替える（DESIGN.md §8b）。音声スコアが1件も無いセッション
  // （テキスト入力のみ・発音評価スキップ等）でpron=0を0.3の重みで足すと、他が満点でも
  // composite上限が70になり昇格ライン75へ永久に届かない。pronの重みを残り成分へ比例配分して
  // 再正規化し、取得できた指標だけで公平に採点する。
  const weights = pronScores.length > 0 ? COMPOSITE_WEIGHTS : reweightWithoutPron();
  const composite =
    weights.pron * pronScore +
    weights.grammar * grammarComponent +
    weights.fluency * fluencyComponent +
    weights.complexity * complexityComponent;

  return {
    pronScore,
    grammarErrorRate,
    thinkingTimeMs,
    meanUtteranceWords,
    composite,
  };
}
