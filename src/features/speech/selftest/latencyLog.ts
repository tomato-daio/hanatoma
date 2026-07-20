/**
 * 音声セルフテスト画面（DESIGN.md M2手順5）のレイテンシ計測ログ整形。
 * 会話本番のレイテンシログ（DESIGN.md §5「区間別ログ」）の先行実装として、
 * ここでは「録音停止→WAV変換→PA応答」のような区間ごとの所要msを1行の文字列にまとめる。
 */

export interface LatencyStage {
  /** 区間名（例: 'WAV変換', 'PA応答'）。 */
  label: string;
  /** 区間の所要ミリ秒。 */
  ms: number;
}

/** 区間配列を「ラベル ms → ラベル ms（合計 msms）」形式の1行へ整形する純関数。空配列は空文字列。 */
export function formatLatencyStages(stages: LatencyStage[]): string {
  if (stages.length === 0) return '';
  const total = stages.reduce((sum, s) => sum + s.ms, 0);
  const parts = stages.map((s) => `${s.label} ${s.ms}ms`);
  return `${parts.join(' → ')}（合計 ${total}ms）`;
}
