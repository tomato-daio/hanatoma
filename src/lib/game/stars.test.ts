import { describe, expect, it } from 'vitest';
import { starsFromComposite } from './stars';

describe('starsFromComposite', () => {
  it('50未満は0', () => {
    expect(starsFromComposite(0)).toBe(0);
    expect(starsFromComposite(49)).toBe(0);
  });

  it('50以上70未満は1', () => {
    expect(starsFromComposite(50)).toBe(1);
    expect(starsFromComposite(69)).toBe(1);
  });

  it('70以上85未満は2', () => {
    expect(starsFromComposite(70)).toBe(2);
    expect(starsFromComposite(84)).toBe(2);
  });

  it('85以上は3', () => {
    expect(starsFromComposite(85)).toBe(3);
    expect(starsFromComposite(100)).toBe(3);
  });
});
