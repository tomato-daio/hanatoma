/**
 * Anthropic APIキーのappState管理（DESIGN.md §7・設定画面M1）。
 * azureSpeechConfig.ts同様、appStateキーの解決をこのモジュールに閉じ込め、
 * anthropicClient.tsへは解決済みのキー文字列だけを渡す設計に揃える。
 *
 * 重要: appStateキー 'anthropicApiKey' の文字列値は src/lib/backup.ts でも
 * （バックアップからの除外/復元時の保護のため。DESIGN.md §0）直接参照される。
 * キー名を変更する場合は両ファイルを同時に更新すること。
 */

import { deleteAppState, getAppState, setAppState } from '../../lib/db';

export const ANTHROPIC_API_KEY_APP_STATE_KEY = 'anthropicApiKey';

/** 保存済みのAnthropic APIキーを取得する。未設定（空文字含む）ならundefined。 */
export async function getAnthropicApiKey(): Promise<string | undefined> {
  const value = await getAppState(ANTHROPIC_API_KEY_APP_STATE_KEY);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** APIキーを端末内(appState)に保存する。 */
export async function setAnthropicApiKey(apiKey: string): Promise<void> {
  await setAppState(ANTHROPIC_API_KEY_APP_STATE_KEY, apiKey);
}

/** 保存済みのAPIキーを削除する（会話AI・添削は次回から実行されなくなる）。 */
export async function clearAnthropicApiKey(): Promise<void> {
  await deleteAppState(ANTHROPIC_API_KEY_APP_STATE_KEY);
}
