/**
 * AI発話の字幕を読み上げに合わせて出す（DESIGN.md §5）。
 * Haikuのテキストは音声より何秒も早く届くため、そのまま出すと「全文が先に出て、あとから声が追う」
 * 不自然な見え方になる。再生中のチャンクは、音声の経過時間に比例して単語単位で出していく。
 */

/** 字幕を声より少しだけ先に出す（TTS冒頭の無音ぶん＋目で追う余裕）。 */
export const CAPTION_LEAD_MS = 250;

/**
 * textのうち、再生の進み具合 fraction(0〜1) までに読み上げた分を単語の切れ目で返す純関数。
 * 文字数比で進める（英語の単語は文字数と発話時間がおおむね比例するため）。
 */
export function revealWords(text: string, fraction: number): string {
  if (fraction >= 1) return text;
  if (fraction <= 0) return '';
  const target = text.length * fraction;
  // 単語の終わり（直後が空白 or 終端）のうち target 以下の最後の位置まで出す。
  let cut = 0;
  const re = /\S+/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = m.index + m[0].length;
    // 単語の途中まで来ていれば、その単語は出す（出すのが遅れて見えるより少し早いほうが自然）。
    if (m.index < target) cut = end;
    else break;
  }
  return text.slice(0, cut);
}

/** 読み上げ済みのチャンクと再生中チャンクの途中までをつないだ字幕。 */
export function joinCaption(spoken: string[], current: string): string {
  return [...spoken, current].filter((s) => s.length > 0).join(' ');
}
