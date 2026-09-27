import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '../../lib/types';
import type { NextAiTurnOptions, NextAiTurnResult } from '../llm/haikuPartner';
import { startAiTurn } from './aiTurn';
import type { PlayAudio } from './speechQueue';

const scenario = { id: 's', goal: 'order coffee', steps: [] } as unknown as Scenario;
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));

/** deltaを手で流せる偽のHaiku。 */
function fakeHaiku() {
  let opts!: NextAiTurnOptions;
  let resolve!: (r: NextAiTurnResult) => void;
  const nextAiTurn = vi.fn((o: NextAiTurnOptions) => {
    opts = o;
    o.signal?.addEventListener('abort', () => resolve({ text: '', usage, aborted: true }));
    return new Promise<NextAiTurnResult>((r) => {
      resolve = r;
    });
  });
  let sent = '';
  return {
    nextAiTurn,
    send(delta: string) {
      sent += delta;
      opts.onText(delta);
    },
    end() {
      resolve({ text: sent, usage });
    },
  };
}

/** 再生は finish() を呼ぶまで終わらない偽プレイヤー。 */
function fakePlayer() {
  const played: { text: string; finish: () => void }[] = [];
  const play: PlayAudio = (audio, hooks) =>
    new Promise<void>((resolve) => {
      hooks.setStopper(resolve);
      hooks.onStart();
      played.push({ text: new TextDecoder().decode(audio), finish: resolve });
    });
  const synth = vi.fn(async (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer);
  return { played, play, synth, reset: vi.fn() };
}

const base = { apiKey: 'k', scenario, level: 2 as const, history: [], phase: 'free' as const };

describe('startAiTurn', () => {
  it('1文目は届いた時点で合成し、残りはストリーム終了時にまとめて1回で送る', async () => {
    const h = fakeHaiku();
    const a = fakePlayer();
    const firstAudio = vi.fn();
    const streamEnd = vi.fn();
    startAiTurn({
      ...base,
      tts: { synth: a.synth, reset: a.reset },
      onFirstAudio: firstAudio,
      onStreamEnd: streamEnd,
      deps: { nextAiTurn: h.nextAiTurn, play: a.play },
    });
    h.send('Oh, nice! ');
    await flush();
    expect(a.synth).toHaveBeenCalledWith('Oh, nice!');
    expect(firstAudio).toHaveBeenCalledTimes(1);
    // 1文目の再生開始で再生待ちが尽きたので、以降の完成文はまとめて送る
    h.send('What would you like to drink? We have ');
    h.send('coffee and tea.');
    h.end();
    await flush();
    await flush();
    expect(streamEnd).toHaveBeenCalledWith({ text: 'Oh, nice! What would you like to drink? We have coffee and tea.', usage });
    expect(a.synth.mock.calls.map((c) => c[0])).toEqual([
      'Oh, nice!',
      'What would you like to drink?',
      'We have coffee and tea.',
    ]);
  });

  it('全部の再生が終わってから drained で完了する', async () => {
    const h = fakeHaiku();
    const a = fakePlayer();
    const turn = startAiTurn({
      ...base,
      tts: { synth: a.synth, reset: a.reset },
      deps: { nextAiTurn: h.nextAiTurn, play: a.play },
    });
    let outcome: string | null = null;
    void turn.done.then((o) => (outcome = o.kind));
    h.send('Sure. ');
    h.send('Here you go.');
    h.end();
    await flush();
    await flush();
    expect(outcome).toBeNull();
    for (const p of a.played) p.finish();
    await flush();
    await flush();
    a.played.forEach((p) => p.finish());
    await flush();
    await flush();
    expect(outcome).toBe('drained');
  });

  it('字幕は読み上げに合わせて出し、まだ鳴っていない文は先に出さない', async () => {
    const h = fakeHaiku();
    const a = fakePlayer();
    const captions: string[] = [];
    startAiTurn({
      ...base,
      tts: { synth: a.synth, reset: a.reset },
      onCaption: (t) => captions.push(t),
      deps: { nextAiTurn: h.nextAiTurn, play: a.play },
    });
    h.send('Oh, nice! ');
    h.send('What would you like to drink?');
    h.end();
    await flush();
    await flush();
    // テキストは全部届いているが、字幕は鳴っている1文目まで
    expect(captions.at(-1)).toBe('Oh, nice!');
    a.played[0].finish();
    await flush();
    await flush();
    expect(captions.at(-1)).toBe('Oh, nice! What would you like to drink?');
    expect(captions.some((c) => c.includes('drink') && a.played.length < 2)).toBe(false);
  });

  it('TTSなしなら字幕は生成途中のテキストをそのまま出す', async () => {
    const h = fakeHaiku();
    const captions: string[] = [];
    startAiTurn({ ...base, tts: null, onCaption: (t) => captions.push(t), deps: { nextAiTurn: h.nextAiTurn } });
    h.send('Hi there. ');
    h.send('How are you?');
    expect(captions).toEqual(['Hi there.', 'Hi there. How are you?']);
  });

  it('割り込みで即 interrupted になり、合成待ちがあれば接続を作り直す', async () => {
    const h = fakeHaiku();
    const a = fakePlayer();
    const usageSpy = vi.fn();
    const turn = startAiTurn({
      ...base,
      tts: {
        synth: (t) => (t.startsWith('Slow') ? new Promise<ArrayBuffer>(() => {}) : a.synth(t)),
        reset: a.reset,
      },
      onUsage: usageSpy,
      deps: { nextAiTurn: h.nextAiTurn, play: a.play },
    });
    h.send('Slow sentence here. ');
    await flush();
    turn.interrupt();
    const o = await turn.done;
    expect(o.kind).toBe('interrupted');
    expect(o.streamCompleted).toBe(false);
    expect(o.text).toBe('Slow sentence here.');
    expect(a.reset).toHaveBeenCalledTimes(1);
    await flush();
    expect(usageSpy).toHaveBeenCalledTimes(1);
  });

  it('TTSなしならストリーム終了で drained', async () => {
    const h = fakeHaiku();
    const turn = startAiTurn({ ...base, tts: null, deps: { nextAiTurn: h.nextAiTurn } });
    h.send('Hello there.');
    h.end();
    const o = await turn.done;
    expect(o.kind).toBe('drained');
    expect(o.streamCompleted).toBe(true);
  });

  it('Haikuの失敗は failed', async () => {
    const turn = startAiTurn({
      ...base,
      tts: null,
      deps: { nextAiTurn: vi.fn(async () => Promise.reject(new Error('overloaded'))) },
    });
    const o = await turn.done;
    expect(o.kind).toBe('failed');
    expect(o.error).toBe('overloaded');
  });
});
