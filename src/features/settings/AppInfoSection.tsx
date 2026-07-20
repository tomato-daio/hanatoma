/** 設定画面「アプリ情報」セクション（DESIGN.md §2・M1）。package.jsonのversionはimportせず固定表記にする
 * （shadotoma SettingsPage.tsxと同じ方針。tsconfigにresolveJsonModuleが無くビルド設定を増やしたくないため）。 */
const APP_VERSION = '0.1.0';

export function AppInfoSection() {
  return (
    <div className="flex flex-col gap-1 text-xs text-neutral-400">
      <p>はなとま v{APP_VERSION}（M1）</p>
      <p>自分で文を組み立てて話す、アウトプット中心のAI英会話練習アプリです。学習データは端末内にのみ保存されます。</p>
    </div>
  );
}
