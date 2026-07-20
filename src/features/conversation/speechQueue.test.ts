import { describe, expect, it } from 'vitest';
import { splitSentences } from './speechQueue';

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
