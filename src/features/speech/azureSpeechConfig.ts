/**
 * Azure Speech（発音評価・TTS）の設定管理（DESIGN.md §6）。
 *
 * APIキー・リージョンの保存/取得（appState）、接続テスト（issueTokenエンドポイント）を担う。
 * appStateの解決はこのモジュールが行い、実際の評価/合成処理（azurePaUnscripted.ts /
 * azureTts.ts）へは解決済みの値だけを渡す（shadotoma azureSpeechConfig.ts と同じ役割分担）。
 *
 * 重要: appStateキー 'azureSpeechKey' の文字列値は src/lib/backup.ts でも
 * （バックアップからの除外/復元時の保護のため。DESIGN.md §0）直接参照される。
 * キー名を変更する場合は両ファイルを同時に更新すること。
 */

import { deleteAppState, getAppState, setAppState, type PaProsodyFallbackState } from '../../lib/db';

/** appStateの保存キー（値の文字列は backup.ts の除外処理と一致させること）。 */
export const AZURE_SPEECH_KEY_APP_STATE_KEY = 'azureSpeechKey';
export const AZURE_SPEECH_REGION_APP_STATE_KEY = 'azureSpeechRegion';
/** 韻律非対応リージョンの当日キャッシュ（DESIGN.md §6a。値は {region, date}）。 */
export const PA_PROSODY_FALLBACK_APP_STATE_KEY = 'paProsodyFallback';

export interface AzureRegionOption {
  value: string;
  label: string;
}

/** 設定画面に出すリージョン一覧。japaneastが初期値（DESIGN.md §6）。 */
export const AZURE_REGION_OPTIONS: AzureRegionOption[] = [
  { value: 'japaneast', label: '東日本 (Japan East)' },
  { value: 'japanwest', label: '西日本 (Japan West)' },
  { value: 'eastus', label: '米国東部 (East US)' },
  { value: 'westus', label: '米国西部 (West US)' },
  { value: 'southeastasia', label: '東南アジア (Southeast Asia)' },
];

export const DEFAULT_AZURE_REGION = 'japaneast';

/** 保存済みのAzure APIキーを取得する。未設定（空文字含む）ならundefined。 */
export async function getAzureSpeechKey(): Promise<string | undefined> {
  const value = await getAppState(AZURE_SPEECH_KEY_APP_STATE_KEY);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 保存済みのリージョンを取得する。未設定なら初期値(japaneast)。 */
export async function getAzureSpeechRegion(): Promise<string> {
  const value = await getAppState(AZURE_SPEECH_REGION_APP_STATE_KEY);
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_AZURE_REGION;
}

/** APIキーとリージョンを端末内(appState)に保存する。 */
export async function setAzureSpeechCredentials(apiKey: string, region: string): Promise<void> {
  await setAppState(AZURE_SPEECH_KEY_APP_STATE_KEY, apiKey);
  await setAppState(AZURE_SPEECH_REGION_APP_STATE_KEY, region);
}

/** 保存済みのAPIキー・リージョンを削除する（発音評価・TTSは次回から実行されなくなる）。 */
export async function clearAzureSpeechCredentials(): Promise<void> {
  await deleteAppState(AZURE_SPEECH_KEY_APP_STATE_KEY);
  await deleteAppState(AZURE_SPEECH_REGION_APP_STATE_KEY);
}

// ---- 韻律非対応の当日キャッシュ（DESIGN.md §6a） ----
// 3ヘルパーとも決してthrowしない契約: キャッシュはレイテンシ最適化にすぎず、
// 読み書きの失敗が発音評価の成否（assessSpeechの「throwしない」契約）に影響してはならない。

/** キャッシュを読む。DB失敗・値破損でもundefinedを返す（判定はshouldSkipProsodyが行う）。 */
export async function getPaProsodyFallback(): Promise<unknown> {
  try {
    return await getAppState(PA_PROSODY_FALLBACK_APP_STATE_KEY);
  } catch (err) {
    console.warn('[azureSpeechConfig] paProsodyFallbackの読み取りに失敗しました（無視して続行）。', err);
    return undefined;
  }
}

/** キャッシュを書く（フォールバック成功時のみ呼ばれる）。失敗はconsole.warnのみ。 */
export async function setPaProsodyFallback(state: PaProsodyFallbackState): Promise<void> {
  try {
    await setAppState(PA_PROSODY_FALLBACK_APP_STATE_KEY, state);
  } catch (err) {
    console.warn('[azureSpeechConfig] paProsodyFallbackの保存に失敗しました（無視して続行）。', err);
  }
}

/** キャッシュを消す（韻律あり成功時の自己回復）。失敗はconsole.warnのみ。 */
export async function clearPaProsodyFallback(): Promise<void> {
  try {
    await deleteAppState(PA_PROSODY_FALLBACK_APP_STATE_KEY);
  } catch (err) {
    console.warn('[azureSpeechConfig] paProsodyFallbackの削除に失敗しました（無視して続行）。', err);
  }
}

export interface AzureConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * 設定ページの「接続テスト」（DESIGN.md §6）。
 * issueTokenエンドポイントへPOSTしてキーの有効性のみを検証する（音声・テキストは送信しない）。
 */
export async function testAzureSpeechConnection(apiKey: string, region: string): Promise<AzureConnectionTestResult> {
  if (!apiKey.trim()) {
    return { ok: false, message: 'APIキーを入力してください。' };
  }
  try {
    const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    });
    if (res.ok) {
      return { ok: true, message: '接続に成功しました。' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'APIキーが無効です。キーとリージョンを確認してください。' };
    }
    return { ok: false, message: `接続に失敗しました（HTTP ${res.status}）。` };
  } catch (err) {
    return {
      ok: false,
      message: `ネットワークエラーが発生しました（${err instanceof Error ? err.message : String(err)}）。`,
    };
  }
}
