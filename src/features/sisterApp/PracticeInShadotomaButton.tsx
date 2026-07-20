/**
 * 「シャドとまで練習する」ボタン（DESIGN.md §11b）。
 * 模範英文(buildModelSentences)をAzure TTSで文ごとに合成→無音を挟んで連結したWAVを作り、
 * shadotomaのローカル教材として直接書き込む。失敗時（dev環境含む）はWAVダウンロード+
 * スクリプトのクリップボードコピーにフォールバックする。
 */

import { useState } from 'react';
import { addUsage, getAppState, getConversation } from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from '../../lib/audio';
import { encodeWavPcm16 } from '../../lib/wav';
import type { CorrectionReport, Scenario } from '../../lib/types';
import { synthesize } from '../speech/azureTts';
import { getScenarioById } from '../scenarios/loadScenarios';
import { downloadToShadotomaFallback } from './downloadFallback';
import { buildModelSentences, exportConversationToShadotoma } from './exportToShadotoma';

/** 文間に挟む無音（シャドーイングの区切りとして0.5秒）。 */
const GAP_SAMPLES = Math.round(WHISPER_SAMPLE_RATE * 0.5);
/** 教材音声はレベルに関係なく自然速度で合成する（シャドーイングのお手本のため）。 */
const MATERIAL_TTS_RATE = '0%';

type Status = 'idle' | 'working' | 'done' | 'fallback' | 'error';

async function buildMaterialWav(report: CorrectionReport, scenario: Scenario): Promise<Blob> {
  const sentences = buildModelSentences(report, scenario);
  if (sentences.length === 0) {
    throw new Error('書き出せる模範英文がありません。');
  }
  const voice = (await getAppState<string>('ttsVoice')) ?? 'en-US-JennyNeural';

  const chunks: Float32Array[] = [];
  let totalChars = 0;
  for (const sentence of sentences) {
    const audio = await synthesize(sentence.en, { voice, rate: MATERIAL_TTS_RATE });
    totalChars += sentence.en.length;
    const pcm = await decodeToMono16k(new Blob([audio.slice(0)], { type: 'audio/mpeg' }));
    chunks.push(pcm, new Float32Array(GAP_SAMPLES));
  }
  await addUsage(learningDate(new Date()), { ttsChars: totalChars });

  const totalLength = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new Blob([encodeWavPcm16(merged)], { type: 'audio/wav' });
}

export function PracticeInShadotomaButton({ report }: { report: CorrectionReport }) {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    setConfirming(false);
    setStatus('working');
    setMessage('模範音声を合成しています…');
    try {
      const conversation = await getConversation(report.conversationId);
      const scenario = conversation ? await getScenarioById(conversation.scenarioId) : undefined;
      if (!scenario) {
        setStatus('error');
        setMessage('シナリオ情報が見つかりませんでした。');
        return;
      }
      const title = `はなとま: ${scenario.titleJa} (${report.date})`;
      const wav = await buildMaterialWav(report, scenario);

      const result = await exportConversationToShadotoma(report, scenario, wav, title);
      if (result.ok) {
        setStatus('done');
        setMessage('シャドとまに教材を追加しました。シャドとまの「教材」タブに表示されます。');
        return;
      }

      // 直接書き込み失敗（dev環境・DB不存在等）→ ダウンロード+クリップボードへ
      const fallback = await downloadToShadotomaFallback(report, scenario, wav, title);
      if (fallback.downloaded) {
        setStatus('fallback');
        setMessage(
          `直接追加できなかったため（${result.reason}）、音声をダウンロードしスクリプトをコピーしました。シャドとまの「教材」→「ローカル取り込み」から追加してください。`,
        );
      } else {
        setStatus('error');
        setMessage(`書き出しに失敗しました: ${fallback.reason ?? result.reason}`);
      }
    } catch (e: unknown) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : '書き出しに失敗しました。');
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={status === 'working'}
        className="rounded-xl bg-hana-500 px-4 py-2 text-sm font-medium text-white disabled:bg-neutral-300"
      >
        {status === 'working' ? '書き出し中…' : '🍅 シャドとまで練習する'}
      </button>
      {message && (
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-xs ${
            status === 'done'
              ? 'bg-green-50 text-green-700'
              : status === 'error'
                ? 'bg-red-50 text-red-700'
                : 'bg-yellow-50 text-yellow-800'
          }`}
        >
          {message}
        </p>
      )}

      {confirming && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5">
            <p className="text-sm font-semibold text-neutral-800">シャドとまに教材を追加しますか？</p>
            <p className="mt-1 text-xs text-neutral-500">
              このレポートの模範英文とAI音声を、シャドとまのローカル教材として追加します
              （シャドとまのデータに教材が1件書き込まれます）。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-full border border-neutral-300 py-2 text-sm text-neutral-600"
              >
                やめる
              </button>
              <button
                type="button"
                onClick={() => void run()}
                className="flex-1 rounded-full bg-hana-500 py-2 text-sm font-semibold text-white"
              >
                追加する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
