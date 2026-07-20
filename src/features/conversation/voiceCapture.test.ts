import { describe, expect, it, vi } from 'vitest';
import type { AssessSpeechResult } from '../speech/azurePaUnscripted';
import type { StreamingPaSession } from '../speech/azurePaStreaming';
import { beginVoiceCapture } from './voiceCapture';

const FAKE_RESULT: AssessSpeechResult = {
  recognizedText: 'hello world',
  pa: { mode: 'unscripted', pronScore: 80, accuracyScore: 80, fluencyScore: 80, words: [] },
};

/** writeChunkの到着を記録するfakeセッション。 */
function makeFakeSession(overrides: Partial<StreamingPaSession> = {}) {
  const written: number[] = [];
  const session: StreamingPaSession = {
    writeChunk: (buf) => written.push(buf.byteLength),
    audioSeconds: () => 0,
    finish: vi.fn(async () => FAKE_RESULT),
    abort: vi.fn(),
    ...overrides,
  };
  return { session, written };
}

/** 解決タイミングを手動制御できるstartStreamingPaのfake。 */
function makeDeferredStart() {
  let resolve!: (s: StreamingPaSession) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<StreamingPaSession>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { start: vi.fn(() => promise), resolve, reject };
}

const OPTS = { mode: 'unscripted' as const };

function chunkOf(samples: number): Float32Array {
  return new Float32Array(samples).fill(0.5);
}

describe('beginVoiceCapture', () => {
  it('セッション確立前のチャンクはバッファされ、確立後に到着順でflushされる', async () => {
    const { session, written } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });

    // 16k→16k（同一レート）で分かりやすくする。100サンプル→補間持ち越しで99サンプル=198バイト
    capture.onAudioChunk(chunkOf(100), 16000);
    capture.onAudioChunk(chunkOf(50), 16000);
    expect(written).toEqual([]); // まだ確立していない

    deferred.resolve(session);
    await Promise.resolve(); // then実行
    expect(written.length).toBe(2); // バッファ2件がflushされた

    capture.onAudioChunk(chunkOf(10), 16000);
    expect(written.length).toBe(3); // 確立後は直結
  });

  it('finishはセッションのfinish結果を返す', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    deferred.resolve(session);
    expect(await capture.finish()).toBe(FAKE_RESULT);
  });

  it('セッション開始が失敗したらfinishはnull（batchフォールバック合図）', async () => {
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.reject(new Error('key missing'));
    expect(await capture.finish()).toBeNull();
    // 失敗後のチャンクは無視される（例外にならない）
    capture.onAudioChunk(chunkOf(100), 16000);
  });

  it('セッションのfinishがthrowしてもnullを返す', async () => {
    const { session } = makeFakeSession({
      finish: vi.fn(async () => {
        throw new Error('prosody unsupported');
      }),
    });
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    deferred.resolve(session);
    expect(await capture.finish()).toBeNull();
  });

  it('abort後はonAudioChunk・finishとも何もしない（冪等）', async () => {
    const { session, written } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    deferred.resolve(session);
    await Promise.resolve();

    capture.abort();
    capture.abort(); // 冪等
    expect(session.abort).toHaveBeenCalledTimes(1);

    capture.onAudioChunk(chunkOf(100), 16000);
    expect(written).toEqual([]);
    expect(await capture.finish()).toBeNull();
    expect(session.finish).not.toHaveBeenCalled();
  });

  it('確立前にabortすると、確立し次第セッションが破棄される', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.abort();
    deferred.resolve(session);
    await Promise.resolve();
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it('audioSecondsは変換済みPCMの秒数を返す（バッファ済み分を含む）', () => {
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    // 16k→16kで16000サンプル入力→15999サンプル出力（持ち越し1）≒1.0秒
    capture.onAudioChunk(chunkOf(16001), 16000);
    expect(capture.audioSeconds()).toBeCloseTo(1.0, 2);
  });

  it('44.1kHz入力でも16kへリサンプルして流す', async () => {
    const { session, written } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    deferred.resolve(session);
    await Promise.resolve();

    capture.onAudioChunk(chunkOf(4410), 44100); // 0.1秒 → 約1600サンプル=3200バイト
    expect(written.length).toBe(1);
    expect(written[0]).toBeGreaterThan(3100);
    expect(written[0]).toBeLessThan(3300);
  });
});
