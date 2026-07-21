import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAzureSpeechKey } from '../features/speech/azureSpeechConfig';
import { PaDebugLogPanel } from '../features/speech/selftest/PaDebugLogPanel';
import { PaEvaluationPanel } from '../features/speech/selftest/PaEvaluationPanel';
import { RecordingPanel } from '../features/speech/selftest/RecordingPanel';
import { StreamingPaPanel } from '../features/speech/selftest/StreamingPaPanel';
import { TtsTestPanel } from '../features/speech/selftest/TtsTestPanel';
import type { RecordingResult } from '../features/recorder/useRecorder';

/**
 * 音声セルフテスト画面（DESIGN.md M2・このアプリの技術検証の要）。
 * タブ外フルスクリーンルート /selftest。設定画面のAzureキーUIは別エージェントが並行実装中のため、
 * ここではルート直打ちでテストできるようにし、キー未設定時は誘導表示のみ行う（設定画面へは遷移するが
 * まだ入力UIが無い可能性がある）。
 *
 * 検証パイプライン: マイク録音(1)→WAV変換→Azure発音評価 unscripted(2)/scripted(3)→Azure TTS再生(4)。
 * 各PA評価の所要msログ(5)は PaEvaluationPanel 側で計測・表示する。
 */
export function SelfTestPage() {
  const [azureKeyPresent, setAzureKeyPresent] = useState<boolean | null>(null);
  const [recording, setRecording] = useState<RecordingResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAzureSpeechKey().then((key) => {
      if (!cancelled) setAzureKeyPresent(key !== undefined);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 bg-white p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-neutral-800">音声セルフテスト</h1>
        <Link to="/" className="text-sm text-hana-600 underline">
          ホームへ
        </Link>
      </div>
      <p className="text-xs text-neutral-500">
        録音→WAV変換→Azure発音評価(unscripted/scripted)→Azure TTS再生の音声パイプラインを
        単体で検証する画面です。
      </p>

      {azureKeyPresent === false ? (
        <div className="rounded-lg border border-hana-300 bg-hana-50 p-3 text-sm text-hana-800">
          Azure Speechのキーが未設定です。発音評価・TTSはエラーになります。
          <Link to="/settings" className="ml-1 underline">
            設定画面
          </Link>
          でキーを登録してください。
        </div>
      ) : null}

      <RecordingPanel onRecorded={setRecording} />
      <PaEvaluationPanel title="2. 発音評価を実行（unscripted）" mode="unscripted" recording={recording} />
      <PaEvaluationPanel title="3. scriptedモードテスト" mode="scripted" recording={recording} />
      <TtsTestPanel />
      <StreamingPaPanel />
      <PaDebugLogPanel />
    </div>
  );
}
