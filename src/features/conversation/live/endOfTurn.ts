/**
 * ハンズフリー会話の「話し終わり」判定（DESIGN.md §5・M13。純関数・Vitest必須）。
 *
 * Azureの音声認識は無音500msで1フレーズを確定（recognized）する。その後さらに
 * 「待ち時間W」だけ新しい発話（recognizing）が来なければ、ユーザーのターンを確定してAIへ渡す。
 * Wは直前までに確定した文が「言い終わった形か」で変える:
 *   - complete   : ?/! で終わる・定型の短い返事・6語以上で言いかけの語で終わらない → 短く待つ
 *   - incomplete : and/because/to/the 等の言いかけの語やカンマで終わる → 長く待つ（考え中の間を切らない）
 *   - neutral    : それ以外（1〜5語の答え等）
 * 学習者は文の途中で考え込むことが多いため、既定値はネイティブ向けの会話AIより長め。
 */

export type EndOfTurnPatience = 'short' | 'normal' | 'long' | 'manual';
export type Completeness = 'complete' | 'neutral' | 'incomplete';

export const END_OF_TURN_PATIENCE_APP_STATE_KEY = 'endOfTurnPatience';
export const DEFAULT_END_OF_TURN_PATIENCE: EndOfTurnPatience = 'normal';

/** 標準設定での待ち時間(ms)。Azureの区切り無音(500ms)の後に上乗せされる。 */
export const END_OF_TURN_WAIT_MS: Record<Completeness, number> = {
  complete: 500,
  neutral: 1000,
  incomplete: 2500,
};

/** 設定「話し終わりの待ち時間」の倍率（manualは自動確定しない）。 */
export const PATIENCE_MULTIPLIER: Record<Exclude<EndOfTurnPatience, 'manual'>, number> = {
  short: 0.6,
  normal: 1,
  long: 1.6,
};

/** これで終わったら言いかけとみなす語（小文字）。「I think so」等の so は完結しうるため入れない。 */
const INCOMPLETE_TAIL_WORDS = new Set([
  'and', 'but', 'or', 'because', 'cause', 'if', 'when', 'while', 'that', 'which', 'who', 'where', 'then',
  'than', 'as', 'to', 'of', 'at', 'for', 'with', 'from', 'about', 'into', 'the', 'a', 'an',
  'my', 'your', 'his', 'her', 'their', 'our', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'have', 'has', 'had',
  'can', 'could', 'would', 'will', 'should', 'shall', 'may', 'might', 'must', 'do', 'does', 'did',
  'i', 'we', 'they', 'he', 'she', "i'm", "i'd", "i'll", "we're", "they're",
  'very', 'really', 'just', 'like', 'maybe', 'also',
  'um', 'uh', 'er', 'erm', 'hmm', 'mm', 'ah', 'well',
]);

/** 1〜5語でも言い終わった形とみなす定型の返事（小文字・末尾記号なしで比較）。 */
const SHORT_REPLIES = new Set([
  'yes', 'yeah', 'yep', 'no', 'nope', 'sure', 'okay', 'ok', 'alright', 'all right', 'right', 'great', 'good',
  'perfect', 'exactly', 'of course', 'certainly', 'absolutely', 'definitely', 'fine',
  'thank you', 'thanks', 'thank you very much', 'thanks a lot', 'yes please', 'no thanks', 'no thank you',
  'sounds good', 'sounds great', 'that sounds good', "that's right", 'that is right', 'i see', 'got it',
  'me too', 'see you', 'see you then', 'bye', 'goodbye', 'hello', 'hi', 'nice to meet you', "i'm fine",
  "i don't know", 'i think so', "i don't think so", 'not really', 'why not', 'no problem',
]);

/** 語の前後の記号を落として小文字化する（Azureの句読点・引用符を無視するため）。 */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

/** 確定済みテキストが「言い終わった形か」を分類する純関数。 */
export function classifyCompleteness(text: string): Completeness {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'incomplete';
  // ?/! はAzureが文の形を見て付ける＝言い終わりの強い手がかり。
  if (/[?!]["')\]]?$/.test(trimmed)) return 'complete';
  // カンマ・ダッシュ・三点リーダで終わる＝続きがある。
  if (/(,|—|–|-|\.\.\.|…)["')\]]?$/.test(trimmed)) return 'incomplete';

  // Azureはほぼ全ての確定文に「.」を付けるため、末尾ピリオドは手がかりにしない。
  const words = trimmed.split(/\s+/).map(normalizeWord).filter((w) => w.length > 0);
  if (words.length === 0) return 'incomplete';
  // 定型の返事は言いかけ語判定より先に見る（"Not really" の really 等を言いかけと誤判定しない）。
  if (SHORT_REPLIES.has(words.join(' '))) return 'complete';
  if (INCOMPLETE_TAIL_WORDS.has(words[words.length - 1])) return 'incomplete';
  return words.length >= 6 ? 'complete' : 'neutral';
}

/**
 * 最後の確定文の後、何ms新しい発話がなければターンを確定するか（manualはnull=自動確定しない）。
 */
export function endOfTurnWaitMs(text: string, patience: EndOfTurnPatience): number | null {
  if (patience === 'manual') return null;
  return Math.round(END_OF_TURN_WAIT_MS[classifyCompleteness(text)] * PATIENCE_MULTIPLIER[patience]);
}

/** appStateの生値を設定値へ正規化する（未設定・壊れた値は既定）。 */
export function parsePatience(raw: unknown): EndOfTurnPatience {
  return raw === 'short' || raw === 'normal' || raw === 'long' || raw === 'manual'
    ? raw
    : DEFAULT_END_OF_TURN_PATIENCE;
}

/**
 * 考える時間 thinkingMs（DESIGN.md §8b の流暢さ指標の元データ）を求める純関数。
 * 「聞き取りを始めた時刻」から「実際に話し始めた時刻」まで。話し始めは、認識結果の
 * 音声オフセット（その発話が音声の何ms目か）＋その音声区間の開始時刻で求める。
 * 認識イベントの到着時刻を使うと、Azureの処理遅れ（0.5〜1.5秒）が考える時間に混ざり、
 * 流暢さが不当に低く出るため使わない。
 */
export function computeThinkingMs(opts: {
  listenStartAt: number;
  segmentAudioStartAt: number;
  speechOffsetMs: number;
}): number {
  return Math.max(0, Math.round(opts.segmentAudioStartAt - opts.listenStartAt + opts.speechOffsetMs));
}
