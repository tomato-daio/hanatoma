/**
 * ARPAbetキー→日本語アドバイスの手書き辞書（DESIGN.md §7b M4）。
 *
 * shadotoma `src/features/judge/phonemeAdvice.ts` からのコピー。
 * ⚠️ shadotoma側でこの辞書の内容を更新した場合は、このファイルも同期すること
 * （DESIGN.md §7b「phonemeAdvice.ts（shadotomaコピー・15音素辞書）」）。
 *
 * Azure発音評価（azurePaUnscripted.ts）はPhoneme granularityで語ごとの音素スコアを返す。
 * phonemeComments.tsがその応答から低スコア音素トップ3を抽出し、ここに掲げる
 * 「日本人が特につまずきやすい音15種」について、カタカナ＋口の動きのコツを人手で執筆した。
 * キーはazurePaUnscripted.tsのnormalizePhonemeKeyで正規化した後のARPAbet大文字表記
 * （例: 'R','TH','AE'）。辞書に無い音素（この15種以外）はコツ文を付けない
 * （辞書に無い音素は記号と例語のみでコツ文なし。呼び出し側=phonemeComments.tsの責務）。
 *
 * 純関数・静的データのみで、DOM/ブラウザAPI・SDKには依存しない。
 */

export interface PhonemeAdviceEntry {
  /** ARPAbet大文字キー（辞書のキーと同じ値を持たせておく。単独で受け渡しやすくするため）。 */
  key: string;
  /** UI表示用の音の名前（例: 'rの音'）。 */
  displayName: string;
  /** カタカナ＋口の動きのコツ文（人手で執筆）。 */
  advice: string;
}

/**
 * 日本人が特につまずきやすい音15種（r, l, θ, ð, v, f, w, æ, ʌ, ə, ɜː, ɪ/iː, s/ʃ 等）を
 * ARPAbetキーで表したもの。
 */
export const PHONEME_ADVICE: Readonly<Record<string, PhonemeAdviceEntry>> = {
  R: {
    key: 'R',
    displayName: 'rの音',
    advice: '舌先をどこにも付けず、口の奥に軽く引いてから「ゥ」と唸るように出します。舌が丸まっても歯や歯茎には触れません。',
  },
  L: {
    key: 'L',
    displayName: 'lの音',
    advice: '舌先を上の前歯の裏（歯茎）にしっかり付けたまま発音します。舌先が触れているかどうかがRとの一番の違いです。',
  },
  TH: {
    key: 'TH',
    displayName: 'thの音（無声・think等）',
    advice: '舌先を上下の前歯で軽く挟み、声を出さずに息だけを出します。sの音にならないよう、舌先を歯の間から少し覗かせます。',
  },
  DH: {
    key: 'DH',
    displayName: 'thの音（有声・this等）',
    advice: '舌先を上下の前歯で軽く挟んだまま、今度は声を出します。無声のTHと形は同じで、声帯が震えるかどうかだけが違います。',
  },
  V: {
    key: 'V',
    displayName: 'vの音',
    advice: '上の前歯を下唇に軽く当てて、震わせながら声を出します。唇を閉じて破裂させるbとは違い、隙間から息が漏れ続けます。',
  },
  F: {
    key: 'F',
    displayName: 'fの音',
    advice: '上の前歯を下唇に軽く当てて、声を出さず息だけを出します。vとの違いは声帯を震わせるかどうかです。',
  },
  W: {
    key: 'W',
    displayName: 'wの音',
    advice: '唇をすぼめて丸く前に突き出した形から、素早く開きながら次の音につなげます。「ウ」ではなく唇の動きが主役です。',
  },
  AE: {
    key: 'AE',
    displayName: 'æの音（cat等）',
    advice: '「ア」と「エ」の中間の音です。口を横に大きく開き、あごを下げて出す日本語の「ア」よりも口角を横に引きます。',
  },
  AH: {
    key: 'AH',
    displayName: 'ʌの音（cup等）',
    advice: '力を抜いた短い「ア」です。口はあまり大きく開けず、日本語の「ア」よりもこもった、短く軽い音にします。',
  },
  AX: {
    key: 'AX',
    displayName: 'あいまい母音（ə）',
    advice: '力を完全に抜いて、こもった弱い「ア」を一瞬だけ出す音です。強く発音せず、聞こえるか聞こえないかくらいで構いません。',
  },
  ER: {
    key: 'ER',
    displayName: 'erの音（ɜːr・bird等）',
    advice: '舌先をどこにも付けず、口の中で舌全体を奥へ丸めながら「アー」と伸ばします。舌先が触れるとlやrの別の音になります。',
  },
  IH: {
    key: 'IH',
    displayName: '短いiの音（ɪ・it等）',
    advice: '力を抜いた短い「イ」です。口角を横に引きすぎず、日本語の「イ」よりも力を抜いてあいまいに出します。',
  },
  IY: {
    key: 'IY',
    displayName: '長いiの音（iː・see等）',
    advice: '口角をしっかり横に引いて、はっきり長く伸ばす「イー」です。短いIHとの長さ・力の入れ方の差を意識します。',
  },
  S: {
    key: 'S',
    displayName: 'sの音',
    advice: '歯を閉じ気味にして、舌先を歯茎に近づけ、隙間から鋭い息を出します。唇は丸めません。SHとの違いは唇の形です。',
  },
  SH: {
    key: 'SH',
    displayName: 'shの音（ʃ）',
    advice: '唇を少しすぼめて前に突き出し、舌全体を少し後ろに引いて、こもった「シュ」という息を出します。',
  },
};

/** 対象15音素のARPAbetキー一覧。 */
export const TARGET_PHONEME_KEYS: readonly string[] = Object.keys(PHONEME_ADVICE);

/** 辞書からアドバイスを引く。無ければundefined（呼び出し側はコツ文なしにフォールバックする）。 */
export function getPhonemeAdvice(phonemeKey: string): PhonemeAdviceEntry | undefined {
  return PHONEME_ADVICE[phonemeKey];
}

/** 表示名を引く。辞書に無い音素は「{キー}の音」で代用する（記号だけは伝わるように）。 */
export function phonemeDisplayName(phonemeKey: string): string {
  return PHONEME_ADVICE[phonemeKey]?.displayName ?? `${phonemeKey}の音`;
}
