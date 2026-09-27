import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_CONFIG,
  INITIAL_LIVE_STATE,
  liveReducer,
  type LiveConfig,
  type LiveEffect,
  type LiveEvent,
  type LiveState,
} from './liveMachine';

/** イベント列を順に流し、最終状態と全副作用を返す。 */
function run(events: LiveEvent[], config: LiveConfig = DEFAULT_LIVE_CONFIG, from: LiveState = INITIAL_LIVE_STATE) {
  let state = from;
  const effects: LiveEffect[] = [];
  const perEvent: LiveEffect[][] = [];
  for (const e of events) {
    const t = liveReducer(state, e, config);
    state = t.state;
    effects.push(...t.effects);
    perEvent.push(t.effects);
  }
  return { state, effects, perEvent, last: perEvent[perEvent.length - 1] ?? [] };
}

const timing = (offsetMs: number, durationMs = 800, segmentAudioStartAt = 10_000) => ({
  segmentAudioStartAt,
  offsetMs,
  durationMs,
});

/** AIの開幕発話が終わって聞き取りが始まった状態まで進める。 */
const toListening: LiveEvent[] = [
  { type: 'begin' },
  { type: 'aiStarted' },
  { type: 'aiFirstAudio' },
  { type: 'aiDrained' },
  { type: 'timer', timer: 'resume', now: 10_000 },
];

describe('liveReducer: 基本のターン交代', () => {
  it('AIが話し終えたら残響待ちの後に聞き取りを開始する', () => {
    const r1 = run(toListening.slice(0, 4));
    expect(r1.state.phase).toBe('aiSpeaking');
    expect(r1.last).toEqual([{ type: 'setTimer', timer: 'resume', ms: 150 }]);

    const r2 = run(toListening);
    expect(r2.state.phase).toBe('listening');
    expect(r2.state.sttOpen).toBe(true);
    expect(r2.last).toEqual([{ type: 'openStt' }, { type: 'setTimer', timer: 'idle', ms: 20_000 }]);
  });

  it('部分認識→確定文→待ち時間経過でターンを確定しAIへ渡す', () => {
    const r = run([
      ...toListening,
      { type: 'partial', text: 'I would like', ...timing(1200) },
      { type: 'final', text: 'I would like a cup of coffee.', ...timing(1200, 2000) },
    ]);
    expect(r.state.phase).toBe('endpointing');
    expect(r.last).toContainEqual({ type: 'setTimer', timer: 'eot', ms: 500 });

    const done = run([{ type: 'timer', timer: 'eot', now: 14_000 }], DEFAULT_LIVE_CONFIG, r.state);
    expect(done.state.phase).toBe('aiThinking');
    expect(done.state.userTurns).toBe(1);
    expect(done.state.sttOpen).toBe(false);
    expect(done.last).toContainEqual({ type: 'closeStt' });
    expect(done.last).toContainEqual({
      type: 'commit',
      text: 'I would like a cup of coffee.',
      thinkingMs: 1200,
      speechEndAt: 10_000 + 1200 + 2000,
    });
  });

  it('言いかけで止まったら長く待ち、続きを話せば待ちを取り消して1つの発話にまとめる', () => {
    const r = run([
      ...toListening,
      { type: 'final', text: 'I went to Kyoto because.', ...timing(500, 1500) },
    ]);
    expect(r.last).toContainEqual({ type: 'setTimer', timer: 'eot', ms: 2500 });

    const cont = run(
      [
        { type: 'partial', text: 'I wanted to', ...timing(3000) },
        { type: 'final', text: 'I wanted to see the temples.', ...timing(3000, 1800) },
        { type: 'timer', timer: 'eot', now: 20_000 },
      ],
      DEFAULT_LIVE_CONFIG,
      r.state,
    );
    expect(cont.perEvent[0]).toContainEqual({ type: 'clearTimer', timer: 'eot' });
    const commit = cont.last.find((e) => e.type === 'commit');
    expect(commit).toMatchObject({ text: 'I went to Kyoto because. I wanted to see the temples.', thinkingMs: 500 });
  });

  it('手動設定では待ち時間で確定せず、送信タップで確定する', () => {
    const config = { ...DEFAULT_LIVE_CONFIG, patience: 'manual' as const };
    const r = run([...toListening, { type: 'final', text: 'Can I pay by card?', ...timing(800) }], config);
    expect(r.last.some((e) => e.type === 'setTimer' && e.timer === 'eot')).toBe(false);
    const sent = run([{ type: 'sendTap' }], config, r.state);
    expect(sent.last).toContainEqual(expect.objectContaining({ type: 'commit', text: 'Can I pay by card?' }));
  });

  it('手動設定で話した後に黙ったままなら、確定文を残して一時停止する（送信で送れる）', () => {
    const config = { ...DEFAULT_LIVE_CONFIG, patience: 'manual' as const };
    const r = run(
      [...toListening, { type: 'final', text: 'Can I pay by card?', ...timing(800) }, { type: 'timer', timer: 'idle', now: 40_000 }],
      config,
    );
    expect(r.state.phase).toBe('waiting');
    expect(r.state.paused).toBe('idle');
    expect(r.state.finals).toEqual(['Can I pay by card?']);
    expect(r.last).toContainEqual({ type: 'closeStt' });
    const sent = run([{ type: 'sendTap' }], config, r.state);
    expect(sent.last).toContainEqual(expect.objectContaining({ type: 'commit', text: 'Can I pay by card?' }));
  });
});

describe('liveReducer: 送信タップ', () => {
  it('話している途中の送信は最後の確定を待ってから送る', () => {
    const r = run([...toListening, { type: 'partial', text: 'Two coffees', ...timing(900) }, { type: 'sendTap' }]);
    expect(r.state.phase).toBe('committing');
    expect(r.last).toContainEqual({ type: 'finishStt' });

    const fin = run(
      [
        { type: 'final', text: 'Two coffees, please.', ...timing(900, 1200) },
        { type: 'sttFinished', now: 13_000 },
      ],
      DEFAULT_LIVE_CONFIG,
      r.state,
    );
    expect(fin.last).toContainEqual(expect.objectContaining({ type: 'commit', text: 'Two coffees, please.' }));
  });

  it('確定が来なくても部分認識があればそれで送る', () => {
    const r = run([
      ...toListening,
      { type: 'partial', text: 'Two coffees', ...timing(900) },
      { type: 'sendTap' },
      { type: 'sttFinished', now: 13_000 },
    ]);
    expect(r.last).toContainEqual(expect.objectContaining({ type: 'commit', text: 'Two coffees' }));
  });

  it('何も聞こえていなければ送らずに聞き取りを続ける', () => {
    const r = run([...toListening, { type: 'sendTap' }]);
    expect(r.state.phase).toBe('listening');
    expect(r.last).toEqual([]);
  });
});

describe('liveReducer: 一時停止', () => {
  it('20秒無音で自動停止し、再開タップで考える時間を数え直す', () => {
    const r = run([...toListening, { type: 'timer', timer: 'idle', now: 30_000 }]);
    expect(r.state.phase).toBe('waiting');
    expect(r.state.paused).toBe('idle');
    expect(r.last).toEqual([{ type: 'closeStt' }]);

    const resumed = run(
      [
        { type: 'resumeTap', now: 60_000 },
        { type: 'final', text: 'Sorry, I was busy.', ...timing(700, 900, 60_000) },
      ],
      DEFAULT_LIVE_CONFIG,
      r.state,
    );
    expect(resumed.perEvent[0]).toContainEqual({ type: 'openStt' });
    expect(resumed.state.thinkingMs).toBe(700);
  });

  it('ヒント再生中は聞き取りを閉じ、部分認識は確定文として残して再開後に引き継ぐ', () => {
    const r = run([
      ...toListening,
      { type: 'partial', text: 'I would', ...timing(800) },
      { type: 'hold', reason: 'hint' },
    ]);
    expect(r.state.phase).toBe('waiting');
    expect(r.state.finals).toEqual(['I would']);
    expect(r.last).toContainEqual({ type: 'closeStt' });

    const released = run([{ type: 'release', reason: 'hint', now: 15_000 }], DEFAULT_LIVE_CONFIG, r.state);
    expect(released.state.phase).toBe('endpointing');
    expect(released.last).toContainEqual({ type: 'openStt' });
  });

  it('AI発話中にテキスト入力へ切り替えたら、AIが終わっても聞き取りを始めない', () => {
    const r = run([
      { type: 'begin' },
      { type: 'aiStarted' },
      { type: 'hold', reason: 'text' },
      { type: 'aiDrained' },
      { type: 'timer', timer: 'resume', now: 5000 },
    ]);
    expect(r.state.phase).toBe('waiting');
    expect(r.effects.some((e) => e.type === 'openStt')).toBe(false);
  });

  it('ヒントとテキストの両方を解除するまで聞き取らない（入れ子）', () => {
    const r = run([
      ...toListening,
      { type: 'hold', reason: 'hint' },
      { type: 'hold', reason: 'text' },
      { type: 'release', reason: 'hint', now: 12_000 },
    ]);
    expect(r.state.phase).toBe('waiting');
    const r2 = run([{ type: 'release', reason: 'text', now: 13_000 }], DEFAULT_LIVE_CONFIG, r.state);
    expect(r2.state.phase).toBe('listening');
  });

  it('認識エラーはタップ再開の一時停止にする', () => {
    const r = run([...toListening, { type: 'sttError' }]);
    expect(r.state.paused).toBe('error');
    expect(r.state.phase).toBe('waiting');
    expect(r.state.sttOpen).toBe(false);
  });
});

describe('liveReducer: 割り込み・終了', () => {
  it('AI発話中の割り込みタップはAIを止める指示を出し、止まったら即聞き取り', () => {
    const r = run([{ type: 'begin' }, { type: 'aiStarted' }, { type: 'aiFirstAudio' }, { type: 'interruptTap' }]);
    expect(r.last).toContainEqual({ type: 'interruptAi' });
    const r2 = run([{ type: 'aiInterrupted', now: 7000 }], DEFAULT_LIVE_CONFIG, r.state);
    expect(r2.state.phase).toBe('listening');
    expect(r2.last).toContainEqual({ type: 'openStt' });
  });

  it('ひとくち（1往復）はAIが返答し終えたら停止する', () => {
    const config = { ...DEFAULT_LIVE_CONFIG, userTurnLimit: 1 };
    const r = run(
      [
        ...toListening,
        { type: 'final', text: 'I like summer because it is warm.', ...timing(900, 2000) },
        { type: 'timer', timer: 'eot', now: 14_000 },
        { type: 'aiStarted' },
        { type: 'aiFirstAudio' },
        { type: 'aiDrained' },
      ],
      config,
    );
    expect(r.state.phase).toBe('stopped');
    expect(r.last).toEqual([{ type: 'stopped' }]);
  });

  it('停止後のイベントは無視する', () => {
    const r = run([...toListening, { type: 'stop' }]);
    expect(r.last).toContainEqual({ type: 'closeStt' });
    const r2 = run([{ type: 'partial', text: 'hello', ...timing(100) }], DEFAULT_LIVE_CONFIG, r.state);
    expect(r2.state).toBe(r.state);
    expect(r2.last).toEqual([]);
  });

  it('AIの番に届いた古い認識イベントは無視する', () => {
    const r = run([{ type: 'begin' }, { type: 'aiStarted' }, { type: 'final', text: 'late', ...timing(100) }]);
    expect(r.state.finals).toEqual([]);
    expect(r.state.phase).toBe('aiThinking');
  });
});
