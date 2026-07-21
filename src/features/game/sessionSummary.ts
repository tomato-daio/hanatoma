/**
 * セッション終了時のリワード画面(RewardScreen)向けサマリー型（DESIGN.md §10）。
 *
 * 型定義のみ。XP計算(xp.ts)・バッジ判定(badges.ts)・クエスト反映(quests.ts)・
 * レベル判定(level/progress.ts)・★評価(stars.ts)を1回のセッション完了時にまとめて実行し、
 * この形へ組み立てるのは後工程の「セッション終了パイプライン」の責務（このファイルはその契約のみ）。
 */

import type { PromoteProgress } from '../../lib/level/progress';

export interface SessionSummary {
  xp: number;
  xpBreakdown: { label: string; amount: number }[];
  stars: 0 | 1 | 2 | 3;
  newExpressions: { en: string; ja: string }[];
  newBadgeIds: string[];
  levelChange: 'promote' | 'demote' | null;
  questsAfter: {
    id: string;
    descriptionJa: string;
    progress: number;
    target: number;
    done: boolean;
  }[];
  streak: number;
  /** 採点付き（lesson/quick/boss）セッションか。昇格プログレス表示の出し分けに使う。 */
  graded: boolean;
  /** このレッスンの総合スコア（composite, 0-100）。 */
  composite: number;
  /** このレッスンが昇格判定の対象（プレイ時レベル以上の難易度）だったか。 */
  promotionEligible: boolean;
  /** 更新後の昇格プログレス（ドット表示用。§8d）。 */
  promoteProgress: PromoteProgress;
}
