import { describe, expect, it, vi } from 'vitest';
import type { PaResult, Turn } from '../../lib/types';
import type { AssessSpeechOptions } from '../speech/azurePaUnscripted';
import { mergeDeferredPa, runDeferredPa, selectClipsForPa, type TurnClip } from './deferredPa';

const clip = (at: number, text: string, seconds: number): TurnClip => ({
  at,
  text,
  pcm: new Uint8Array(Math.round(seconds * 32000)),
});

const pa = (pronScore: number, azureError?: string): PaResult => ({
  mode: 'scripted',
  pronScore,
  accuracyScore: pronScore,
  fluencyScore: pronScore,
  words: [],
  ...(azureError ? { azureError } : {}),
});

describe('selectClipsForPa', () => {
  it('語数の多いターンを優先し、予算内に収まるだけ選ぶ', () => {
    const clips = [
      clip(1, 'Yes please.', 1.5),
      clip(2, 'I would like to book a table for two tonight.', 4),
      clip(3, 'Do you have anything near the window?', 3),
    ];
    const picked = selectClipsForPa(clips, { capRemainingSec: 600, budgetSec: 7 });
    expect(picked.map((c) => c.at)).toEqual([2, 3]);
  });

  it('短すぎる・長すぎる・空のターンは除く', () => {
    const clips = [clip(1, 'Hi.', 0.5), clip(2, 'A very long story '.repeat(10), 30), clip(3, '', 3), clip(4, 'Sounds good to me.', 2)];
    expect(selectClipsForPa(clips, { capRemainingSec: 600 }).map((c) => c.at)).toEqual([4]);
  });

  it('日次上限の残りが予算より少なければ残りまで', () => {
    const clips = [clip(1, 'one two three four', 3), clip(2, 'one two three', 3)];
    expect(selectClipsForPa(clips, { capRemainingSec: 4 }).map((c) => c.at)).toEqual([1]);
    expect(selectClipsForPa(clips, { capRemainingSec: -10 })).toEqual([]);
  });
});

describe('mergeDeferredPa', () => {
  const turns: Turn[] = [
    { role: 'ai', text: 'Hello!', at: 1, phase: 'guided' },
    { role: 'user', text: 'Hi, table for two.', at: 2, phase: 'guided', inputMode: 'voice' },
    { role: 'user', text: 'Typed answer', at: 3, phase: 'free', inputMode: 'text' },
    { role: 'user', text: 'Nice view.', at: 4, phase: 'free', inputMode: 'voice' },
  ];

  it('Turn.atが一致する音声ターンにだけ結果を付け、失敗結果は付けない', () => {
    const merged = mergeDeferredPa(
      turns,
      new Map([
        [2, pa(82)],
        [3, pa(70)],
        [4, pa(0, 'timeout')],
      ]),
    );
    expect(merged[1].pa?.pronScore).toBe(82);
    expect(merged[2].pa).toBeUndefined();
    expect(merged[3].pa).toBeUndefined();
    expect(merged[0]).toBe(turns[0]);
  });
});

describe('runDeferredPa', () => {
  it('scriptedで参照文に認識テキストを渡し、韻律なしで1件ずつ評価する', async () => {
    const assess = vi.fn(async (_wav: Blob, _opts: AssessSpeechOptions) => ({ recognizedText: 'x', pa: pa(75) }));
    const progress = vi.fn();
    const r = await runDeferredPa([clip(10, 'Table for two.', 2), clip(20, 'By the window.', 1.5)], {
      assess,
      onProgress: progress,
    });
    expect(assess).toHaveBeenCalledTimes(2);
    expect(assess.mock.calls[0][1]).toMatchObject({ mode: 'scripted', referenceText: 'Table for two.', prosody: false });
    expect([...r.results.keys()]).toEqual([10, 20]);
    expect(r.sentSeconds).toBeCloseTo(3.5);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });

  it('中断されたら残りを評価しない', async () => {
    const controller = new AbortController();
    const assess = vi.fn(async () => {
      controller.abort();
      return { recognizedText: 'x', pa: pa(75) };
    });
    const r = await runDeferredPa([clip(1, 'one two', 2), clip(2, 'three four', 2)], {
      assess,
      signal: controller.signal,
    });
    expect(assess).toHaveBeenCalledTimes(1);
    expect(r.results.size).toBe(1);
  });

  it('評価の例外・失敗があっても残りを続ける', async () => {
    const assess = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ recognizedText: '', pa: pa(0, 'network') })
      .mockResolvedValueOnce({ recognizedText: 'x', pa: pa(90) });
    const r = await runDeferredPa([clip(1, 'a b', 2), clip(2, 'c d', 2), clip(3, 'e f', 2)], { assess });
    expect([...r.results.keys()]).toEqual([3]);
  });
});
