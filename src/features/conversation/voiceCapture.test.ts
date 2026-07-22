import { describe, expect, it, vi } from 'vitest';
import { AzurePronunciationTimeoutError, type AssessSpeechResult } from '../speech/azurePaUnscripted';
import type { StreamingPaSession } from '../speech/azurePaStreaming';
import { BATCH_SKIP_MIN_AUDIO_SEC, beginVoiceCapture, shouldSkipBatch } from './voiceCapture';

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

  it('finishはセッションのfinish結果を返す（チャンクを書いた通常経路）', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000); // ゼロチャンク即断に入らないようPCMを書く
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
    const finishMock = vi.fn(async (): Promise<never> => {
      throw new Error('prosody unsupported');
    });
    const { session } = makeFakeSession({ finish: finishMock });
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.resolve(session);
    expect(await capture.finish()).toBeNull();
    expect(finishMock).toHaveBeenCalledTimes(1); // ゼロチャンク即断ではなく実際にfinishが失敗した経路
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

  it('ゼロチャンクのままfinishすると、セッション確立を待たず即null（session.finish未呼出）', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    // sessionPromiseは未解決のまま（awaitしていれば永久に返らない）
    expect(await capture.finish()).toBeNull();
    expect(session.finish).not.toHaveBeenCalled();

    // 遅れて確立してもabort済みとして破棄される
    deferred.resolve(session);
    await Promise.resolve();
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it('ゼロチャンク即断後はonAudioChunkも無視される（abort済み）', async () => {
    const { session, written } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    deferred.resolve(session);
    await Promise.resolve();

    expect(await capture.finish()).toBeNull(); // チャンク0件のまま停止
    capture.onAudioChunk(chunkOf(100), 16000);
    expect(written).toEqual([]);
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

  it('finish(signal): 事前にabort済みなら即null（session.finish未呼出・セッション破棄）', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.resolve(session);
    await Promise.resolve();

    const controller = new AbortController();
    controller.abort();
    expect(await capture.finish(controller.signal)).toBeNull();
    expect(session.finish).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it('finish(signal): セッション確立待ち中のabortでnullが返り、遅延確立後に破棄される', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);

    const controller = new AbortController();
    const finishing = capture.finish(controller.signal); // sessionPromise未解決のまま待ちに入る
    controller.abort();
    expect(await finishing).toBeNull();

    // 遅れて確立してもabort済みとして破棄される
    deferred.resolve(session);
    await Promise.resolve();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.finish).not.toHaveBeenCalled();
  });

  it('finish(signal): 確定待ち（session.finishが永久pending）中のabortでnullが返り破棄される', async () => {
    const neverFinish = vi.fn(() => new Promise<AssessSpeechResult>(() => {}));
    const { session } = makeFakeSession({ finish: neverFinish });
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.resolve(session);
    await Promise.resolve();

    const controller = new AbortController();
    const finishing = capture.finish(controller.signal);
    await Promise.resolve(); // session.finish呼び出しまで進める
    controller.abort();
    expect(await finishing).toBeNull();
    expect(neverFinish).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it('finish(signal): abortされず成功したら結果を返し、後からのabort()にも二重破棄しない', async () => {
    const { session } = makeFakeSession();
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.resolve(session);

    const controller = new AbortController();
    expect(await capture.finish(controller.signal)).toBe(FAKE_RESULT);
    controller.abort(); // リスナーは除去済みなので何も起きない
    expect(session.abort).not.toHaveBeenCalled();
  });

  it('finish(signal): abortリスナーは成功・失敗の両経路で対に除去される', async () => {
    // 成功経路
    const okSession = makeFakeSession();
    const okDeferred = makeDeferredStart();
    const okCapture = beginVoiceCapture(OPTS, { startStreamingPa: okDeferred.start });
    okCapture.onAudioChunk(chunkOf(100), 16000);
    okDeferred.resolve(okSession.session);
    const okController = new AbortController();
    const okAdd = vi.spyOn(okController.signal, 'addEventListener');
    const okRemove = vi.spyOn(okController.signal, 'removeEventListener');
    await okCapture.finish(okController.signal);
    expect(okAdd).toHaveBeenCalledTimes(1);
    expect(okRemove).toHaveBeenCalledWith('abort', okAdd.mock.calls[0][1]);

    // 失敗経路（session.finishがreject）
    const ngSession = makeFakeSession({
      finish: vi.fn(async (): Promise<never> => {
        throw new Error('boom');
      }),
    });
    const ngDeferred = makeDeferredStart();
    const ngCapture = beginVoiceCapture(OPTS, { startStreamingPa: ngDeferred.start });
    ngCapture.onAudioChunk(chunkOf(100), 16000);
    ngDeferred.resolve(ngSession.session);
    const ngController = new AbortController();
    const ngAdd = vi.spyOn(ngController.signal, 'addEventListener');
    const ngRemove = vi.spyOn(ngController.signal, 'removeEventListener');
    await ngCapture.finish(ngController.signal);
    expect(ngRemove).toHaveBeenCalledWith('abort', ngAdd.mock.calls[0][1]);
  });

  it('デッドラインabortによるnullは失敗分類しない（lastFailure=null、shouldSkipBatch非発火）', async () => {
    const neverFinish = vi.fn(() => new Promise<AssessSpeechResult>(() => {}));
    const { session } = makeFakeSession({ finish: neverFinish });
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.resolve(session);
    await Promise.resolve();

    const controller = new AbortController();
    const finishing = capture.finish(controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await finishing).toBeNull();
    expect(capture.lastFailure()).toBeNull();
  });

  it('lastFailure: 確定待ちタイムアウトは timeout、その他の失敗は other に分類される', async () => {
    // timeout
    const timeoutFinish = vi.fn(async (): Promise<never> => {
      throw new AzurePronunciationTimeoutError();
    });
    const a = makeFakeSession({ finish: timeoutFinish });
    const da = makeDeferredStart();
    const captureA = beginVoiceCapture(OPTS, { startStreamingPa: da.start });
    captureA.onAudioChunk(chunkOf(100), 16000);
    da.resolve(a.session);
    expect(captureA.lastFailure()).toBeNull(); // finish前はnull
    expect(await captureA.finish()).toBeNull();
    expect(captureA.lastFailure()).toBe('timeout');

    // other（一般エラー）
    const otherFinish = vi.fn(async (): Promise<never> => {
      throw new Error('connection died');
    });
    const b = makeFakeSession({ finish: otherFinish });
    const db = makeDeferredStart();
    const captureB = beginVoiceCapture(OPTS, { startStreamingPa: db.start });
    captureB.onAudioChunk(chunkOf(100), 16000);
    db.resolve(b.session);
    expect(await captureB.finish()).toBeNull();
    expect(captureB.lastFailure()).toBe('other');

    // other（セッション開始失敗）
    const dc = makeDeferredStart();
    const captureC = beginVoiceCapture(OPTS, { startStreamingPa: dc.start });
    captureC.onAudioChunk(chunkOf(100), 16000);
    dc.reject(new Error('key missing'));
    expect(await captureC.finish()).toBeNull();
    expect(captureC.lastFailure()).toBe('other');
  });

  it('lastFailure: ゼロチャンク即断は other（worklet不動作→batchが正当）', async () => {
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    expect(await capture.finish()).toBeNull();
    expect(capture.lastFailure()).toBe('other');
  });

  it('lastFailure: 証拠ゼロのタイムアウト（hadEvidence=false=WS沈黙死疑い）は other（batchへ行かせる）', async () => {
    const silentTimeout = vi.fn(async (): Promise<never> => {
      throw new AzurePronunciationTimeoutError(false);
    });
    const { session } = makeFakeSession({ finish: silentTimeout });
    const deferred = makeDeferredStart();
    const capture = beginVoiceCapture(OPTS, { startStreamingPa: deferred.start });
    capture.onAudioChunk(chunkOf(100), 16000);
    deferred.resolve(session);
    expect(await capture.finish()).toBeNull();
    expect(capture.lastFailure()).toBe('other');
  });
});

describe('shouldSkipBatch', () => {
  it('確定待ちタイムアウト かつ 音声が閾値超 のときだけbatchを見送る', () => {
    expect(shouldSkipBatch('timeout', BATCH_SKIP_MIN_AUDIO_SEC + 1)).toBe(true);
    expect(shouldSkipBatch('timeout', BATCH_SKIP_MIN_AUDIO_SEC)).toBe(false); // 閾値ちょうどは実行
    expect(shouldSkipBatch('timeout', 1)).toBe(false);
  });

  it('timeout以外の失敗はbatchを実行する（新規接続のbatchに正当性がある）', () => {
    expect(shouldSkipBatch('other', 100)).toBe(false);
    expect(shouldSkipBatch(null, 100)).toBe(false);
  });
});
