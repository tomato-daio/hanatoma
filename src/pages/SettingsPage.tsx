import { AnthropicSection } from '../features/settings/AnthropicSection';
import { AppInfoSection } from '../features/settings/AppInfoSection';
import { AzureSpeechSection } from '../features/settings/AzureSpeechSection';
import { BackupSection } from '../features/settings/BackupSection';
import { CollapsibleSection } from '../features/settings/CollapsibleSection';
import { PracticeSettingsSection } from '../features/settings/PracticeSettingsSection';
import { UsageDashboardSection } from '../features/settings/UsageDashboardSection';
import { VoiceSection } from '../features/settings/VoiceSection';

/** 設定画面（DESIGN.md §2・M1）。各セクションは折りたたみ可能なカードで整理する。 */
export function SettingsPage() {
  return (
    <div className="flex flex-col gap-3 p-4 pb-8">
      <h1 className="text-lg font-bold text-neutral-800">設定</h1>

      <CollapsibleSection title="Azure Speech設定" description="発音評価・AI音声の読み上げに使用" defaultOpen>
        <AzureSpeechSection />
      </CollapsibleSection>

      <CollapsibleSection title="Anthropic API設定" description="会話AI・添削に使用">
        <AnthropicSection />
      </CollapsibleSection>

      <CollapsibleSection title="AI音声選択" description="会話中に読み上げる声を選ぶ">
        <VoiceSection />
      </CollapsibleSection>

      <CollapsibleSection title="練習設定" description="音声の保存・1日の利用上限">
        <PracticeSettingsSection />
      </CollapsibleSection>

      <CollapsibleSection title="使用量ダッシュボード" description="今月の呼び出し回数・概算コスト">
        <UsageDashboardSection />
      </CollapsibleSection>

      <CollapsibleSection title="バックアップ" description="データのエクスポート/インポート">
        <BackupSection />
      </CollapsibleSection>

      <CollapsibleSection title="アプリ情報">
        <AppInfoSection />
      </CollapsibleSection>
    </div>
  );
}
