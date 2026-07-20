/**
 * コスト概算（DESIGN.md §12）。単価定数と、usageLog（日別）から月額概算円を出す純関数。
 *
 * ⚠️ UsageDayはhaiku/sonnetの呼び出しをまとめて1本のトークン数(inputTokens/outputTokens/
 * cacheReadTokens)に集計する形（DESIGN.md §3・types.ts、変更禁止）のため、モデル別の実トークン数は
 * 保存されていない。breakdownはhaikuCalls/sonnetCallsの呼び出し件数比でトークン量を按分する近似値
 * （呼び出し1回あたりの平均トークン量が両モデルで同程度という前提の概算。ダッシュボード表示用の
 * 目安であり、正確なモデル別課金額ではない）。
 */

import type { UsageDay } from '../types';

/** モデル単価（USD / 100万トークン）。DESIGN.md §12。 */
export const PRICING = {
  haiku: { inputPerMTokUsd: 1.0, outputPerMTokUsd: 5.0 },
  sonnet: { inputPerMTokUsd: 3.0, outputPerMTokUsd: 15.0 },
  /** キャッシュ読み取りは入力単価のこの割合（DESIGN.md §12: 1/10）。 */
  cacheReadDiscountRatio: 0.1,
} as const;

/** 既定為替レート（DESIGN.md §12。設定画面で変更可）。 */
export const DEFAULT_USD_JPY = 155;

const TOKENS_PER_MILLION = 1_000_000;

/** haikuCalls/sonnetCallsの件数比でtotalを按分する。呼び出し合計0件なら両方0。 */
function splitByCallShare(total: number, haikuCalls: number, sonnetCalls: number): { haiku: number; sonnet: number } {
  const totalCalls = haikuCalls + sonnetCalls;
  if (totalCalls === 0) return { haiku: 0, sonnet: 0 };
  const haikuShare = haikuCalls / totalCalls;
  return { haiku: total * haikuShare, sonnet: total * (1 - haikuShare) };
}

function tokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  rate: { inputPerMTokUsd: number; outputPerMTokUsd: number },
): number {
  const inputCost = (inputTokens / TOKENS_PER_MILLION) * rate.inputPerMTokUsd;
  const outputCost = (outputTokens / TOKENS_PER_MILLION) * rate.outputPerMTokUsd;
  const cacheReadCost = (cacheReadTokens / TOKENS_PER_MILLION) * rate.inputPerMTokUsd * PRICING.cacheReadDiscountRatio;
  return inputCost + outputCost + cacheReadCost;
}

export interface MonthlyCostEstimate {
  totalJpy: number;
  breakdown: { haikuJpy: number; sonnetJpy: number };
}

/**
 * days（usageLogの日別レコード群、通常は当月分）からモデル別・合計の概算円を算出する。
 * usdJpyを省略するとDEFAULT_USD_JPY(155)を使う（設定画面で上書きしたレートを渡せる）。
 */
export function estimateMonthlyCostJpy(days: UsageDay[], usdJpy: number = DEFAULT_USD_JPY): MonthlyCostEstimate {
  let haikuUsd = 0;
  let sonnetUsd = 0;

  for (const day of days) {
    const input = splitByCallShare(day.inputTokens, day.haikuCalls, day.sonnetCalls);
    const output = splitByCallShare(day.outputTokens, day.haikuCalls, day.sonnetCalls);
    const cacheRead = splitByCallShare(day.cacheReadTokens, day.haikuCalls, day.sonnetCalls);

    haikuUsd += tokenCostUsd(input.haiku, output.haiku, cacheRead.haiku, PRICING.haiku);
    sonnetUsd += tokenCostUsd(input.sonnet, output.sonnet, cacheRead.sonnet, PRICING.sonnet);
  }

  const haikuJpy = haikuUsd * usdJpy;
  const sonnetJpy = sonnetUsd * usdJpy;
  return { totalJpy: haikuJpy + sonnetJpy, breakdown: { haikuJpy, sonnetJpy } };
}
