import { describe, expect, it } from 'vitest';
import { formatScore, scoreTextClass, scoreTier } from './scoreColor';

describe('scoreTier', () => {
  it('80以上はgood', () => {
    expect(scoreTier(80)).toBe('good');
    expect(scoreTier(100)).toBe('good');
  });

  it('60以上80未満はok', () => {
    expect(scoreTier(60)).toBe('ok');
    expect(scoreTier(79.9)).toBe('ok');
  });

  it('60未満はbad', () => {
    expect(scoreTier(59.9)).toBe('bad');
    expect(scoreTier(0)).toBe('bad');
  });
});

describe('scoreTextClass', () => {
  it('undefinedはneutral色', () => {
    expect(scoreTextClass(undefined)).toBe('text-neutral-400');
  });

  it('スコアに応じた信号色を返す', () => {
    expect(scoreTextClass(90)).toBe('text-green-700');
    expect(scoreTextClass(65)).toBe('text-yellow-700');
    expect(scoreTextClass(10)).toBe('text-red-600');
  });
});

describe('formatScore', () => {
  it('undefinedは「―」', () => {
    expect(formatScore(undefined)).toBe('―');
  });

  it('小数第1位へ丸めて表示する', () => {
    expect(formatScore(83.456)).toBe('83.5');
    expect(formatScore(0)).toBe('0.0');
  });
});
