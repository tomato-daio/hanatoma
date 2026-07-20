import { describe, expect, it } from 'vitest';
import type { Turn } from '../../lib/types';
import { truncateHistory, turnsToMessages } from './haikuPartner';

function makeTurn(role: Turn['role'], text: string, at: number): Turn {
  return { role, text, at, phase: 'free' };
}

describe('truncateHistory', () => {
  it('20ターン以下ならそのまま返す', () => {
    const history: Turn[] = Array.from({ length: 20 }, (_, i) => makeTurn(i % 2 === 0 ? 'user' : 'ai', `t${i}`, i));

    const result = truncateHistory(history, 'ordering food');

    expect(result).toEqual(history);
  });

  it('20ターンを超えたら古い分を1行要約に畳み、直近20件はそのまま残す', () => {
    const history: Turn[] = Array.from({ length: 25 }, (_, i) => makeTurn(i % 2 === 0 ? 'user' : 'ai', `t${i}`, i));

    const result = truncateHistory(history, 'ordering food');

    // 要約1件 + 直近20件 = 21件
    expect(result).toHaveLength(21);
    // 先頭は要約ターン（aiロール・件数とtopicを含む）
    expect(result[0].role).toBe('ai');
    expect(result[0].text).toContain('ordering food');
    expect(result[0].text).toContain('5 turns');
    // 直近20件はhistoryの末尾20件と一致する
    expect(result.slice(1)).toEqual(history.slice(5));
  });

  it('要約ターンのatは畳まれた古い分の最後のターンのatを引き継ぐ', () => {
    const history: Turn[] = Array.from({ length: 22 }, (_, i) => makeTurn('user', `t${i}`, i * 1000));

    const result = truncateHistory(history, 'topic');

    // older = history[0..1] (2件)。最後の要素のat = 1*1000 = 1000
    expect(result[0].at).toBe(1000);
  });
});

describe('turnsToMessages', () => {
  it('userロールはuser、aiロールはassistantへ写像する', () => {
    const turns: Turn[] = [makeTurn('user', 'Hello', 0), makeTurn('ai', 'Hi there', 1), makeTurn('user', 'Bye', 2)];

    const messages = turnsToMessages(turns);

    expect(messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Bye' },
    ]);
  });

  it('空配列は空配列を返す', () => {
    expect(turnsToMessages([])).toEqual([]);
  });
});
