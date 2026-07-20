/**
 * キーフレーズ予習フェーズ（DESIGN.md §4 フェーズ2。lessonモードのみ）。
 * フレーズごとに「TTSで聞く → 自分で発音 → scripted発音評価」を回す。
 * 80点以上で✓。スキップ自由（学習を止めないことを最優先）。
 */

import { useState } from 'react';
import { getAppState } from '../../lib/db';
import { getLevelParams } from '../../lib/level/params';
import type { AppLevel, PaResult, Scenario } from '../../lib/types';
import { getSharedAudioContext, useRecorder, type RecordingResult } from '../recorder/useRecorder';
import { synthesize } from '../speech/azureTts';

const PASS_SCORE = 80;

interface Props {
  scenario: Scenario;
  level: AppLevel;
  busy: boolean;
  submitKeyPhrase: (phraseEn: string, recording: RecordingResult) => Promise<PaResult | null>;
  /** 予習を終えて対話へ進む（スキップ時も呼ばれる）。 */
  onDone: () => void;
}

export function KeyPhrasePanel({ scenario, level, busy, submitKeyPhrase, onDone }: Props) {
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<(PaResult | null)[]>(() =>
    scenario.keyPhrases.map(() => null),
  );
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const recorder = useRecorder();

  const phrase = scenario.keyPhrases[index];
  const isLast = index >= scenario.keyPhrases.length - 1;
  const current = results[index];

  const play = async () => {
    if (playing || !phrase) return;
    setPlaying(true);
    setPlayError(null);
    try {
      const voice = (await getAppState<string>('ttsVoice')) ?? 'en-US-JennyNeural';
      const rate = getLevelParams(level).ttsRate;
      const audio = await synthesize(phrase.en, { voice, rate });
      const ctx = getSharedAudioContext();
      const buffer = await ctx.decodeAudioData(audio.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
    } catch (e: unknown) {
      setPlayError(e instanceof Error ? e.message : '再生に失敗しました。');
    } finally {
      setPlaying(false);
    }
  };

  const record = async () => {
    if (!phrase) return;
    if (!recorder.isRecording) {
      await recorder.start();
      return;
    }
    const recording = await recorder.stop();
    if (!recording) return;
    const pa = await submitKeyPhrase(phrase.en, recording);
    if (pa) {
      setResults((prev) => prev.map((r, i) => (i === index ? pa : r)));
    }
  };

  if (!phrase) {
    // キーフレーズが無いシナリオは即対話へ
    onDone();
    return null;
  }

  return (
    <div className="flex flex-1 flex-col p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-hana-700">
          キーフレーズ予習 {index + 1}/{scenario.keyPhrases.length}
        </p>
        <button type="button" onClick={onDone} className="text-xs text-neutral-400 underline">
          予習をとばす
        </button>
      </div>

      {/* 進捗ドット */}
      <div className="mt-2 flex gap-1.5">
        {scenario.keyPhrases.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full ${
              results[i] && results[i]!.pronScore >= PASS_SCORE
                ? 'bg-green-400'
                : i === index
                  ? 'bg-hana-400'
                  : results[i]
                    ? 'bg-yellow-300'
                    : 'bg-neutral-200'
            }`}
          />
        ))}
      </div>

      <div className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5">
        <p className="text-lg font-bold text-neutral-800">{phrase.en}</p>
        <p className="mt-1 text-sm text-neutral-500">{phrase.ja}</p>
        {phrase.note && <p className="mt-1 text-xs text-hana-700">💡 {phrase.note}</p>}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void play()}
            disabled={playing || busy}
            className="rounded-full border border-hana-300 bg-hana-50 px-4 py-2 text-sm text-hana-700 disabled:opacity-50"
          >
            {playing ? '再生中…' : '▶ お手本を聞く'}
          </button>
          <button
            type="button"
            onClick={() => void record()}
            disabled={busy && !recorder.isRecording}
            className={`rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
              recorder.isRecording ? 'bg-red-500' : 'bg-hana-500'
            }`}
          >
            {recorder.isRecording ? `⏹ 停止 (${recorder.elapsedSec}s)` : '🎤 発音する'}
          </button>
        </div>
        {recorder.error && <p className="mt-2 text-xs text-red-600">{recorder.error}</p>}
        {playError && <p className="mt-2 text-xs text-red-600">{playError}</p>}
        {busy && !recorder.isRecording && <p className="mt-2 text-xs text-neutral-400">発音を評価中…</p>}

        {current && (
          <div className="mt-4 rounded-xl bg-neutral-50 p-3 text-sm">
            <p
              className={`font-bold ${
                current.pronScore >= PASS_SCORE
                  ? 'text-green-600'
                  : current.pronScore >= 60
                    ? 'text-yellow-600'
                    : 'text-red-600'
              }`}
            >
              {current.pronScore >= PASS_SCORE ? '✓ いい発音です！' : 'もう一歩！'} 総合{' '}
              {Math.round(current.pronScore)}点
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">
              正確さ {Math.round(current.accuracyScore)} ・ 流暢さ {Math.round(current.fluencyScore)}
              {current.completenessScore !== undefined && ` ・ 完全性 ${Math.round(current.completenessScore)}`}
            </p>
            {current.words.filter((w) => w.accuracyScore < 60).length > 0 && (
              <p className="mt-1 text-xs text-neutral-500">
                苦手な語:{' '}
                {current.words
                  .filter((w) => w.accuracyScore < 60)
                  .slice(0, 3)
                  .map((w) => w.word)
                  .join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => (isLast ? onDone() : setIndex(index + 1))}
          disabled={busy}
          className="w-full rounded-full bg-hana-500 py-3 text-sm font-bold text-white disabled:bg-neutral-300"
        >
          {isLast ? '会話をはじめる' : current ? '次のフレーズへ' : 'とばして次へ'}
        </button>
      </div>
    </div>
  );
}
