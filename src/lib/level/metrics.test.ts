import { describe, expect, it } from 'vitest';
import { computeLessonMetrics } from './metrics';
import type { PaResult, Turn } from '../types';

function makePa(pronScore: number): PaResult {
  return {
    mode: 'unscripted',
    pronScore,
    accuracyScore: pronScore,
    fluencyScore: pronScore,
    words: [],
  };
}

function userTurn(text: string, opts: { pa?: PaResult; thinkingMs?: number } = {}): Turn {
  return {
    role: 'user',
    text,
    at: 0,
    phase: 'free',
    inputMode: opts.pa ? 'voice' : 'text',
    pa: opts.pa,
    thinkingMs: opts.thinkingMs,
  };
}

function aiTurn(text: string): Turn {
  return { role: 'ai', text, at: 0, phase: 'free' };
}

describe('computeLessonMetrics', () => {
  it('典型的なレッスンでcompositeを加重通りに算出する', () => {
    // pron平均=80, grammarErrorRate=10/20*100=50→grammarComponent=max(0,100-500)=0,
    // thinkingTimeMs中央値=6000→fluency=50, meanUtteranceWords=(4+4+4+4+4)/5=4
    //   →complexity = linearScore(4,2,0,12,100) = (4-2)/10*100 = 20
    // composite = 0.3*80 + 0.3*0 + 0.2*50 + 0.2*20 = 24 + 0 + 10 + 4 = 38
    const turns: Turn[] = [
      userTurn('one two three four', { pa: makePa(90), thinkingMs: 2000 }),
      aiTurn('ok go on'),
      userTurn('one two three four', { pa: makePa(70), thinkingMs: 6000 }),
      aiTurn('ok go on'),
      userTurn('one two three four', { pa: makePa(80), thinkingMs: 10000 }),
      userTurn('one two three four', { pa: makePa(85), thinkingMs: 6000 }),
      userTurn('one two three four', { pa: makePa(75), thinkingMs: 6000 }),
    ];
    const metrics = computeLessonMetrics(turns, 10);
    expect(metrics.pronScore).toBeCloseTo(80, 5);
    expect(metrics.grammarErrorRate).toBeCloseTo(50, 5);
    expect(metrics.thinkingTimeMs).toBe(6000);
    expect(metrics.meanUtteranceWords).toBe(4);
    expect(metrics.composite).toBeCloseTo(38, 5);
  });

  it('ユーザーターンが0件でも例外・NaNを出さない', () => {
    const turns: Turn[] = [aiTurn('hello there')];
    const metrics = computeLessonMetrics(turns, 0);
    expect(metrics.pronScore).toBe(0);
    expect(metrics.grammarErrorRate).toBe(0);
    expect(metrics.thinkingTimeMs).toBe(0);
    expect(metrics.meanUtteranceWords).toBe(0);
    expect(Number.isFinite(metrics.composite)).toBe(true);
    expect(metrics.composite).toBeCloseTo(50, 5); // grammar満点(100)*0.3 + fluency満点(100)*0.2
  });

  it('turns配列が空でも安全に動く', () => {
    const metrics = computeLessonMetrics([], 0);
    expect(metrics.composite).toBeCloseTo(50, 5);
  });

  it('ユーザー総語数0（空文字テキストのみ）ならgrammarErrorRateは0', () => {
    const turns: Turn[] = [userTurn('')];
    const metrics = computeLessonMetrics(turns, 5);
    expect(metrics.grammarErrorRate).toBe(0);
  });

  it('テキスト入力ターン（paなし）はpronScore平均に含まれない', () => {
    const turns: Turn[] = [userTurn('hello there', { pa: makePa(60) }), userTurn('hi again')];
    const metrics = computeLessonMetrics(turns, 0);
    expect(metrics.pronScore).toBe(60);
  });

  it('thinkingMs未定義のターンは中央値計算から除外される', () => {
    const turns: Turn[] = [
      userTurn('a b', { thinkingMs: 4000 }),
      userTurn('a b'), // thinkingMsなし
      userTurn('a b', { thinkingMs: 8000 }),
    ];
    const metrics = computeLessonMetrics(turns, 0);
    expect(metrics.thinkingTimeMs).toBe(6000);
  });

  it('fluencyComponent: 思考時間2000ms以下は満点(100)', () => {
    const turns: Turn[] = [userTurn('a b c d e f g h i j k l', { thinkingMs: 1000 })];
    const metrics = computeLessonMetrics(turns, 0);
    // complexity満点(12語) + fluency満点(100) → composite = 0.2*100 + 0.2*100 + grammar0.3*100 = 20+20+30=70
    expect(metrics.composite).toBeCloseTo(70, 5);
  });

  it('fluencyComponent: 思考時間10000ms以上は0点', () => {
    const turns: Turn[] = [userTurn('a', { thinkingMs: 15000 })];
    const metrics = computeLessonMetrics(turns, 0);
    // meanUtteranceWords=1語→complexity=0, thinkingTimeMs=15000→fluency=0
    // composite = 0.3*0(pron) + 0.3*100(grammar) + 0.2*0(fluency) + 0.2*0(complexity) = 30
    expect(metrics.composite).toBeCloseTo(30, 5);
  });

  it('complexityComponent: 平均語数2語以下は0点、12語以上は満点', () => {
    const low = computeLessonMetrics([userTurn('a b', { thinkingMs: 2000 })], 0);
    const high = computeLessonMetrics([userTurn('a b c d e f g h i j k l m', { thinkingMs: 2000 })], 0);
    expect(low.composite).toBeCloseTo(0.3 * 100 + 0.2 * 100 + 0.2 * 0, 5); // grammar100+fluency100+complexity0
    expect(high.composite).toBeCloseTo(0.3 * 100 + 0.2 * 100 + 0.2 * 100, 5);
  });

  it('中央値は偶数件でも正しく計算する', () => {
    const turns: Turn[] = [
      userTurn('a', { thinkingMs: 1000 }),
      userTurn('a', { thinkingMs: 2000 }),
      userTurn('a', { thinkingMs: 3000 }),
      userTurn('a', { thinkingMs: 4000 }),
    ];
    const metrics = computeLessonMetrics(turns, 0);
    expect(metrics.thinkingTimeMs).toBe(2500);
  });
});
