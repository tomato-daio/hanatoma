import { describe, expect, it, vi } from 'vitest';
import { SpeechQueue, splitSentences, takeSpeakableChunk, type PlayAudio } from './speechQueue';

describe('splitSentences', () => {
  it('完成した文を切り出し、途中の断片はrestに残す', () => {
    const r = splitSentences('Hello, welcome to our cafe! What can I');
    expect(r.complete).toEqual(['Hello, welcome to our cafe!']);
    expect(r.rest).toBe('What can I');
  });

  it('複数文を順に切り出す', () => {
    const r = splitSentences('That sounds great. Would you like anything else? I can');
    expect(r.complete).toEqual(['That sounds great.', 'Would you like anything else?']);
    expect(r.rest).toBe('I can');
  });

  it('文末が引用符で閉じられていても切れる', () => {
    const r = splitSentences('She said "hello there." Then she left.');
    expect(r.complete[0]).toBe('She said "hello there."');
  });

  it('12文字未満の断片では切らない（略語対策）', () => {
    const r = splitSentences('Mr. Tanaka is here now! Yes');
    expect(r.complete).toEqual(['Mr. Tanaka is here now!']);
    expect(r.rest).toBe('Yes');
  });

  it('文末記号がなければ全てrest', () => {
    const r = splitSentences('Well, let me think');
    expect(r.complete).toEqual([]);
    expect(r.rest).toBe('Well, let me think');
  });

  it('空文字は空を返す', () => {
    const r = splitSentences('');
    expect(r.complete).toEqual([]);
    expect(r.rest).toBe('');
  });
});

describe('takeSpeakableChunk', () => {
  it('1文目は短い相づちでも即切り出す', () => {
    const r = takeSpeakableChunk('Oh, nice! What kind of', { isFirst: true, queueIdle: false, streamClosed: false });
    expect(r.chunk).toBe('Oh, nice!');
    expect(r.rest).toBe('What kind of');
  });

  it('ストリーミング中は文末記号の直後に空白が来るまで切らない（3.50 等の誤分割防止）', () => {
    const r = takeSpeakableChunk('It costs 3.', { isFirst: true, queueIdle: true, streamClosed: false });
    expect(r.chunk).toBeNull();
  });

  it('略語・頭文字では切らない', () => {
    const r = takeSpeakableChunk('Mr. Smith will see you at 9 a.m. tomorrow. Then', {
      isFirst: true,
      queueIdle: false,
      streamClosed: false,
    });
    expect(r.chunk).toBe('Mr. Smith will see you at 9 a.m. tomorrow.');
    const r2 = takeSpeakableChunk('Ask J. Brown. He knows', { isFirst: true, queueIdle: false, streamClosed: false });
    expect(r2.chunk).toBe('Ask J. Brown.');
  });

  it('2つ目以降は再生待ちが尽きるまで溜め、尽きたら完成文をまとめて1チャンクにする', () => {
    const buf = 'I can recommend the pasta. It is very popular here. And';
    expect(takeSpeakableChunk(buf, { isFirst: false, queueIdle: false, streamClosed: false }).chunk).toBeNull();
    const r = takeSpeakableChunk(buf, { isFirst: false, queueIdle: true, streamClosed: false });
    expect(r.chunk).toBe('I can recommend the pasta. It is very popular here.');
    expect(r.rest).toBe('And');
  });

  it('ストリーム終了時は残りを全部送る（空なら null）', () => {
    expect(takeSpeakableChunk(' Enjoy', { isFirst: false, queueIdle: false, streamClosed: true })).toEqual({
      chunk: 'Enjoy',
      rest: '',
    });
    expect(takeSpeakableChunk('  ', { isFirst: false, queueIdle: false, streamClosed: true }).chunk).toBeNull();
  });
});

/** 合成・再生を手動で進められる偽物（再生は finishPlay を呼ぶまで終わらない）。 */
function fakeAudio() {
  const plays: { text: string; finish: () => void }[] = [];
  const synth = (text: string) => Promise.resolve(new TextEncoder().encode(text).buffer as ArrayBuffer);
  const play: PlayAudio = (audio, hooks) =>
    new Promise<void>((resolve) => {
      const text = new TextDecoder().decode(audio);
      hooks.setStopper(resolve);
      hooks.onStart();
      plays.push({ text, finish: resolve });
    });
  return { plays, synth, play };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SpeechQueue', () => {
  it('close後に全再生が終わったときだけ onDrained（文の合間に空になっても終わらない）', async () => {
    const a = fakeAudio();
    const drained = vi.fn();
    const first = vi.fn();
    const q = new SpeechQueue({ synth: a.synth, play: a.play, onDrained: drained, onFirstAudioStart: first });
    q.enqueue('Hello there.');
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    a.plays[0].finish();
    await flush();
    expect(drained).not.toHaveBeenCalled(); // まだcloseしていない
    q.enqueue('How are you?');
    q.close();
    await flush();
    a.plays[1].finish();
    await flush();
    expect(drained).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('何も積まずにcloseしても onDrained が呼ばれる', async () => {
    const a = fakeAudio();
    const drained = vi.fn();
    const q = new SpeechQueue({ synth: a.synth, play: a.play, onDrained: drained });
    q.close();
    await flush();
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it('interrupt は再生を止め、残りを捨て、onDrained を呼ばない', async () => {
    const a = fakeAudio();
    const drained = vi.fn();
    const q = new SpeechQueue({ synth: a.synth, play: a.play, onDrained: drained });
    q.enqueue('One sentence here.');
    q.enqueue('Another sentence here.');
    q.close();
    await flush();
    q.interrupt();
    await flush();
    await flush();
    expect(a.plays.map((p) => p.text)).toEqual(['One sentence here.']);
    expect(drained).not.toHaveBeenCalled();
    expect(q.busy).toBe(false);
  });

  it('再生待ちが尽きたら onBacklogEmpty（次のチャンクを足す合図）', async () => {
    const a = fakeAudio();
    const backlogEmpty = vi.fn();
    const q = new SpeechQueue({ synth: a.synth, play: a.play, onBacklogEmpty: backlogEmpty });
    q.enqueue('First chunk.');
    expect(q.backlogEmpty).toBe(false);
    await flush();
    expect(q.backlogEmpty).toBe(true);
    expect(backlogEmpty).toHaveBeenCalledTimes(1);
  });

  it('合成に失敗したチャンクは飛ばして続行し onError を呼ぶ', async () => {
    const a = fakeAudio();
    const onError = vi.fn();
    const drained = vi.fn();
    const q = new SpeechQueue({
      synth: (t) => (t.startsWith('Bad') ? Promise.reject(new Error('tts down')) : a.synth(t)),
      play: a.play,
      onError,
      onDrained: drained,
    });
    q.enqueue('Bad chunk.');
    q.enqueue('Good chunk.');
    q.close();
    await flush();
    await flush();
    a.plays[0].finish();
    await flush();
    expect(onError).toHaveBeenCalledWith('tts down');
    expect(a.plays.map((p) => p.text)).toEqual(['Good chunk.']);
    expect(drained).toHaveBeenCalledTimes(1);
  });
});
