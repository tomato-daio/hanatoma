import { describe, expect, it } from 'vitest';
import { appendToRingBuffer, formatPaDebugLine, PA_DEBUG_LOG_LIMIT } from './paDebugLog';

describe('formatPaDebugLine', () => {
  it('HH:MM:SSを0埋めして先頭に付ける', () => {
    const d = new Date(2026, 6, 21, 9, 5, 3);
    expect(formatPaDebugLine(d, '[stream] 開始')).toBe('09:05:03 [stream] 開始');
  });
});

describe('appendToRingBuffer', () => {
  it('末尾に追記し、追記順を保つ', () => {
    expect(appendToRingBuffer(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('limitを超えたら古い行から捨てる', () => {
    const existing = Array.from({ length: PA_DEBUG_LOG_LIMIT }, (_, i) => `line${i}`);
    const next = appendToRingBuffer(existing, 'new');
    expect(next).toHaveLength(PA_DEBUG_LOG_LIMIT);
    expect(next[0]).toBe('line1');
    expect(next[next.length - 1]).toBe('new');
  });

  it('既存値が破損（未定義・文字列・混在配列）でも安全に扱う', () => {
    expect(appendToRingBuffer(undefined, 'x')).toEqual(['x']);
    expect(appendToRingBuffer('broken', 'x')).toEqual(['x']);
    expect(appendToRingBuffer(['ok', 42, null, 'ok2'], 'x')).toEqual(['ok', 'ok2', 'x']);
  });

  it('limit引数を変えられる', () => {
    expect(appendToRingBuffer(['a', 'b', 'c'], 'd', 2)).toEqual(['c', 'd']);
  });
});
