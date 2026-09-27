import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSttOptions, LiveSttSession } from '../../speech/azureStt';
import type { OpenMicOptions } from '../../recorder/micSession';
import type { AiEvent, Utterance } from '../useConversation';
import { createLiveTalkController, levelFromChunk, type LiveDeps, type LiveHost } from './liveTalkController';

/** 偽のSTT（認識イベントを手で流す）。 */
interface FakeStt {
  opts: LiveSttOptions;
  written: number;
  aborted: boolean;
  finished: boolean;
  session: LiveSttSession;
}

function setup(settings: Parameters<typeof createLiveTalkController>[1] = {}) {
  let now = 0;
  const stts: FakeStt[] = [];
  const mics: { opts: OpenMicOptions; closed: boolean }[] = [];
  const aiListeners = new Set<(e: AiEvent) => void>();
  const submitted: Utterance[] = [];
  const notices: (string | null)[] = [];
  let speechSeconds = 0;
  let canListen = true;

  const host: LiveHost = {
    beginDialogue: vi.fn(),
    submitUtterance: vi.fn((u: Utterance) => {
      submitted.push(u);
      return true;
    }),
    interruptAi: vi.fn(),
    subscribeAi: (l) => {
      aiListeners.add(l);
      return () => aiListeners.delete(l);
    },
    phraseHintsNow: () => ['table for two'],
    speech: {
      canListen: () => canListen,
      addSeconds: (s) => {
        speechSeconds += s;
      },
    },
    notify: (m) => notices.push(m),
  };

  const deps: LiveDeps = {
    now: () => now,
    unlockAudio: vi.fn(),
    openMic: vi.fn(async (opts: OpenMicOptions) => {
      const entry = { opts, closed: false };
      mics.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    }),
    startStt: vi.fn(async (opts: LiveSttOptions) => {
      const fake: FakeStt = {
        opts,
        written: 0,
        aborted: false,
        finished: false,
        session: {
          writeChunk: (b) => {
            fake.written += b.byteLength;
          },
          audioSeconds: () => fake.written / 32000,
          finish: async () => {
            fake.finished = true;
          },
          abort: () => {
            fake.aborted = true;
          },
        },
      };
      stts.push(fake);
      return fake.session;
    }),
  };

  const c = createLiveTalkController(host, settings, deps);
  const ai = (e: AiEvent) => aiListeners.forEach((l) => l(e));
  /** 48kHzで約43msぶんの音声チャンクを、現在開いているマイクへ流す。 */
  const speak = (amplitude = 0.2) => {
    const mic = [...mics].reverse().find((m) => !m.closed);
    now += 43;
    mic?.opts.onChunk(new Float32Array(2048).fill(amplitude), 48000);
  };
  return {
    c,
    host,
    deps,
    stts,
    mics,
    submitted,
    notices,
    ai,
    speak,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    setNow: (t: number) => {
      now = t;
    },
    speechSeconds: () => speechSeconds,
    setCanListen: (v: boolean) => {
      canListen = v;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('liveTalkController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('開始タップでAIに開幕発話させ、AIが話し終えたら聞き取りを始める', async () => {
    const t = setup();
    t.c.start();
    expect(t.host.beginDialogue).toHaveBeenCalledTimes(1);
    expect(t.deps.unlockAudio).toHaveBeenCalledTimes(1);
    t.ai('started');
    t.ai('firstAudio');
    expect(t.c.getView().phase).toBe('aiSpeaking');
    t.ai('drained');
    expect(t.stts).toHaveLength(0);
    t.advance(150);
    await flush();
    expect(t.c.getView().phase).toBe('listening');
    expect(t.stts).toHaveLength(1);
    expect(t.stts[0].opts.phraseHints).toEqual(['table for two']);
  });

  it('接続前の音声はためておき、接続後に流す。話し終わりで確定し、発話区間の音声を渡す', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    // STTの接続完了（startSttのPromise解決）より先に話し始める
    t.speak();
    t.speak();
    await flush();
    expect(t.stts[0].written).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) t.speak();
    t.stts[0].opts.onPartial('I would like', 300, 800);
    expect(t.c.getView().partial).toBe('I would like');
    t.stts[0].opts.onFinal('I would like a cup of coffee.', 300, 1400);
    expect(t.c.getView().phase).toBe('endpointing');
    t.advance(500);
    expect(t.submitted).toHaveLength(1);
    const u = t.submitted[0];
    expect(u.text).toBe('I would like a cup of coffee.');
    expect(u.inputMode).toBe('voice');
    // 発話 300〜1700ms ＋前後300msの余白 → 0〜2000ms（音声は約1.8秒ぶん）
    expect(u.pcm!.byteLength).toBeGreaterThan(0);
    expect(u.pcm!.byteLength).toBeLessThanOrEqual(2000 * 32);
    expect(t.stts[0].aborted).toBe(true);
    expect(t.mics.every((m) => m.closed)).toBe(true); // perTurn: 確定でマイクも閉じる
    expect(t.speechSeconds()).toBeGreaterThan(1);
  });

  it('AI発話中の音声はSTTへ送らない（半二重）', async () => {
    const t = setup({ micMode: 'keepOpen' });
    t.c.start();
    await flush();
    t.ai('started');
    t.ai('firstAudio');
    t.speak();
    expect(t.stts).toHaveLength(0);
    expect(t.mics.filter((m) => !m.closed)).toHaveLength(1);
  });

  it('送信タップは最後の確定を待ってから送る', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.speak();
    t.stts[0].opts.onPartial('Two coffees', 200, 700);
    t.c.sendNow();
    expect(t.c.getView().phase).toBe('committing');
    await flush();
    expect(t.stts[0].finished).toBe(true);
    expect(t.submitted.map((u) => u.text)).toEqual(['Two coffees']);
  });

  it('割り込みタップでAIを止めるよう会話側へ伝える', () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('firstAudio');
    t.c.interrupt();
    expect(t.host.interruptAi).toHaveBeenCalledTimes(1);
  });

  it('20秒話さなければ自動で一時停止し、再開で新しい聞き取りを始める', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.advance(20_000);
    expect(t.c.getView().phase).toBe('waiting');
    expect(t.c.getView().paused).toBe('idle');
    expect(t.stts[0].aborted).toBe(true);
    t.c.resume();
    await flush();
    expect(t.stts).toHaveLength(2);
    expect(t.c.getView().phase).toBe('listening');
  });

  it('上限に達していたら聞き取らずに一時停止して案内する', async () => {
    const t = setup();
    t.setCanListen(false);
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    expect(t.stts).toHaveLength(0);
    expect(t.c.getView().paused).toBe('cap');
    expect(t.notices.some((n) => n?.includes('上限'))).toBe(true);
  });

  it('認識エラーは案内してタップ再開の一時停止にする', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.stts[0].opts.onPartial('Well', 100, 200);
    t.stts[0].opts.onError(new Error('接続が切れました'));
    expect(t.c.getView().paused).toBe('error');
    expect(t.notices.some((n) => n?.includes('接続が切れました'))).toBe(true);
  });

  it('ひとくち（1往復）はAIの返答が終わったら止まる', async () => {
    const t = setup({ userTurnLimit: 1 });
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.speak();
    t.stts[0].opts.onFinal('I like summer.', 100, 900);
    t.advance(1000);
    expect(t.submitted).toHaveLength(1);
    t.ai('started');
    t.ai('firstAudio');
    t.ai('drained');
    expect(t.c.getView().phase).toBe('stopped');
    t.advance(1000);
    expect(t.stts).toHaveLength(1);
  });

  it('stop後はイベントを受け付けずマイクを閉じる', async () => {
    const t = setup({ micMode: 'keepOpen' });
    t.c.start();
    await flush();
    t.c.stop();
    expect(t.mics.every((m) => m.closed)).toBe(true);
    t.ai('drained');
    t.advance(1000);
    expect(t.stts).toHaveLength(0);
  });
});

describe('levelFromChunk', () => {
  it('無音は0、大きい音は1で頭打ち', () => {
    expect(levelFromChunk(new Float32Array(10))).toBe(0);
    expect(levelFromChunk(new Float32Array(10).fill(0.9))).toBe(1);
  });
});

describe('liveTalkController: 接続失敗からの自動再接続', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('認識結果が来る前の接続エラーは1回だけ自動で張り直し、ここまでの音声を送り直す', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.speak();
    t.speak();
    const sentBefore = t.stts[0].written;
    expect(sentBefore).toBeGreaterThan(0);
    t.stts[0].opts.onError(new Error('Unable to contact server. StatusCode: 1006'));
    await flush();
    expect(t.stts).toHaveLength(2);
    expect(t.stts[0].aborted).toBe(true);
    expect(t.stts[1].written).toBe(sentBefore);
    expect(t.c.getView().phase).toBe('listening');
    expect(t.c.getView().paused).toBeNull();
  });

  it('再接続も失敗したら一時停止し、1006ならキー・無料枠の確認を案内する', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.stts[0].opts.onError(new Error('StatusCode: 1006'));
    await flush();
    t.stts[1].opts.onError(new Error('StatusCode: 1006'));
    expect(t.c.getView().paused).toBe('error');
    expect(t.notices.some((n) => n?.includes('無料枠'))).toBe(true);
  });

  it('認識結果を受け取った後のエラーは張り直さずに一時停止する', async () => {
    const t = setup();
    t.c.start();
    t.ai('started');
    t.ai('drained');
    t.advance(150);
    await flush();
    t.stts[0].opts.onPartial('hello', 100, 300);
    t.stts[0].opts.onError(new Error('connection lost'));
    expect(t.stts).toHaveLength(1);
    expect(t.c.getView().paused).toBe('error');
  });
});
