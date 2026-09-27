import { describe, expect, it } from 'vitest';
import { joinCaption, revealWords } from './captionReveal';

describe('revealWords', () => {
  const text = 'What would you like to drink?';
  it('0以下なら何も出さず、1以上なら全部出す', () => {
    expect(revealWords(text, 0)).toBe('');
    expect(revealWords(text, 1)).toBe(text);
    expect(revealWords(text, 1.5)).toBe(text);
  });
  it('進み具合に応じて単語の切れ目まで出す（途中の単語は出し切る）', () => {
    expect(revealWords(text, 0.1)).toBe('What');
    expect(revealWords(text, 0.5)).toBe('What would you');
    expect(revealWords(text, 0.95)).toBe(text);
  });
  it('進むほど出る量は減らない', () => {
    let prev = 0;
    for (let f = 0; f <= 1; f += 0.05) {
      const n = revealWords(text, f).length;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe('joinCaption', () => {
  it('読み上げ済みと再生中をスペースでつなぎ、空は飛ばす', () => {
    expect(joinCaption(['Oh, nice!'], 'What')).toBe('Oh, nice! What');
    expect(joinCaption(['Oh, nice!'], '')).toBe('Oh, nice!');
    expect(joinCaption([], '')).toBe('');
  });
});
