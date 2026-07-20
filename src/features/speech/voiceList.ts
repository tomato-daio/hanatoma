/**
 * Azure TTSの利用可能音声一覧の取得（DESIGN.md §6c）。
 *
 * リージョンのREST（voices/list）から取得し、en-US Neuralのみに絞って設定画面へ渡す
 * （ハードコードしない。リージョンにより提供音声が異なるため）。
 * SDKは使わない: 一覧取得だけのためにSDK本体を読み込む必要がなく、素のfetchで足りる。
 */

export interface VoiceListItem {
  /** SSMLのvoice nameに使う識別子（例: 'en-US-JennyNeural'）。appState ttsVoiceに保存する値。 */
  shortName: string;
  /** 表示名（例: 'Jenny'）。 */
  localName: string;
  /** 'Female' | 'Male' 等（Azure応答のまま。表示用）。 */
  gender: string;
}

/** voices/list REST応答の1音声ぶんの必要部分（Microsoft Learn「Get a list of voices」の形）。 */
interface VoicesListResponseItem {
  ShortName?: string;
  LocalName?: string;
  DisplayName?: string;
  Gender?: string;
  Locale?: string;
  VoiceType?: string;
}

/**
 * 指定リージョンの利用可能音声を取得し、en-US Neuralのみ返す。
 * 失敗時は日本語メッセージのErrorを投げる（設定画面がそのまま表示する）。
 */
export async function fetchVoices(key: string, region: string): Promise<VoiceListItem[]> {
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Azure APIキーが無効です。キーとリージョンを確認してください。');
  }
  if (!res.ok) {
    throw new Error(`音声一覧の取得に失敗しました（HTTP ${res.status}）。`);
  }

  const list = (await res.json()) as unknown;
  if (!Array.isArray(list)) {
    throw new Error('音声一覧の応答形式が想定と異なります。');
  }

  const voices: VoiceListItem[] = [];
  for (const raw of list as VoicesListResponseItem[]) {
    if (raw.Locale !== 'en-US' || raw.VoiceType !== 'Neural') continue;
    const shortName = raw.ShortName;
    if (typeof shortName !== 'string' || shortName === '') continue;
    voices.push({
      shortName,
      localName: raw.LocalName ?? raw.DisplayName ?? shortName,
      gender: raw.Gender ?? '',
    });
  }
  return voices;
}
