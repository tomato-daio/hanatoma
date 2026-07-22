/**
 * AI応答から仕草・演技のト書き（stage direction）を取り除く純関数（DESIGN.md §7a）。
 *
 * systemプロンプト（prompts/partnerSystem.ts）で「発話のみ・ト書き禁止」を指示しているが、
 * Haikuはロールプレイ調の *nods with a smile* のようなアスタリスク囲みの演技描写を
 * 混ぜることがある。表示・TTS読み上げ・保存のいずれにも不要なため、防御としてここで除去する。
 *
 * - 複数語の *...* 区間は丸ごと除去（演技描写とみなす）
 * - 1語の *word* は、既知の仕草語（smiles等）なら除去、それ以外は強調とみなし語だけ残す
 *   （"That's *really* good." の really を消さないため）
 * - 文字列末尾の未閉鎖 *... はストリーミング途中表示向けに除去（閉じ待ちのちらつき防止）
 * - 除去で生じた余分な空白・句読点前の空白を整える
 *
 * マーカーの無い裸のト書き（"Nods with a smile."等）は誤除去のリスクがあるため対象外
 * （プロンプト側の禁止ルールで抑止する）。
 */

/** 1語でもト書きとみなして除去する既知の仕草語（小文字比較）。 */
const GESTURE_WORDS = new Set([
  'nods',
  'smiles',
  'laughs',
  'chuckles',
  'giggles',
  'grins',
  'waves',
  'bows',
  'shrugs',
  'sighs',
  'winks',
  'claps',
  'gasps',
  'frowns',
  'blushes',
  'pauses',
]);

export function stripStageDirections(text: string): string {
  return (
    text
      .replace(/\*([^*]*)\*/g, (_match, inner: string) => {
        const trimmed = inner.trim();
        // 複数語（空白を含む）は演技描写として除去
        if (/\s/.test(trimmed)) return ' ';
        // 1語: 既知の仕草語は除去、それ以外は強調とみなし語だけ残す
        return GESTURE_WORDS.has(trimmed.toLowerCase()) ? ' ' : ` ${trimmed} `;
      })
      // 末尾の未閉鎖 *...（ストリーミング途中）は閉じるまで表示しない
      .replace(/\*[^*]*$/, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/ +([.,!?;:])/g, '$1')
      .trim()
  );
}
