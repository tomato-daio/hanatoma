/**
 * ガイド付き会話のヒント3段階（DESIGN.md §4）。
 * 段階1=日本語ヒント → 段階2=英語の言い出し → 段階3=模範解答（TTS再生可）。
 * 模範解答の表示回数はXP計算（§10）で微減点されるが、学習を止めないことを優先し制限はしない。
 */

import { useState } from 'react';
import { getLevelParams } from '../../lib/level/params';
import type { AppLevel, ScenarioStep } from '../../lib/types';
import { getAppState } from '../../lib/db';
import { getSharedAudioContext } from '../recorder/useRecorder';
import { synthesize } from '../speech/azureTts';

interface Props {
  step: ScenarioStep;
  hintLevel: 0 | 1 | 2 | 3;
  onNextHint: () => void;
  level: AppLevel;
}

const HINT_BUTTON_LABEL: Record<0 | 1 | 2, string> = {
  0: '💡 ヒント',
  1: '💡 英語のヒント',
  2: '💡 模範解答を見る',
};

export function HintPanel({ step, hintLevel, onNextHint, level }: Props) {
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);

  const playModelAnswer = async () => {
    if (playing) return;
    setPlaying(true);
    setPlayError(null);
    try {
      const voice = (await getAppState<string>('ttsVoice')) ?? 'en-US-JennyNeural';
      const rate = getLevelParams(level).ttsRate;
      const audio = await synthesize(step.modelAnswer, { voice, rate });
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

  return (
    <div className="rounded-xl border border-hana-200 bg-hana-50 p-3 text-sm">
      {hintLevel >= 1 && (
        <p className="text-neutral-700">
          <span className="font-semibold text-hana-700">ヒント: </span>
          {step.hintJa}
        </p>
      )}
      {hintLevel >= 2 && (
        <p className="mt-1 text-neutral-700">
          <span className="font-semibold text-hana-700">言い出し: </span>
          <span className="font-mono">{step.hintEn}…</span>
        </p>
      )}
      {hintLevel >= 3 && (
        <div className="mt-1 flex items-center gap-2">
          <p className="text-neutral-800">
            <span className="font-semibold text-hana-700">模範解答: </span>
            {step.modelAnswer}
          </p>
          <button
            type="button"
            onClick={() => void playModelAnswer()}
            disabled={playing}
            className="shrink-0 rounded-full bg-hana-500 px-2 py-1 text-xs text-white disabled:bg-neutral-300"
          >
            {playing ? '再生中…' : '▶ 聞く'}
          </button>
        </div>
      )}
      {playError && <p className="mt-1 text-xs text-red-600">{playError}</p>}
      {hintLevel < 3 && (
        <button
          type="button"
          onClick={onNextHint}
          className="mt-2 rounded-full border border-hana-300 bg-white px-3 py-1 text-xs text-hana-700"
        >
          {HINT_BUTTON_LABEL[hintLevel as 0 | 1 | 2]}
        </button>
      )}
    </div>
  );
}
