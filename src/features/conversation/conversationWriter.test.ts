import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../lib/types';
import { createConversationWriter } from './conversationWriter';

const conv = (turns = 0): Conversation =>
  ({
    id: 'c',
    scenarioId: 's',
    mode: 'quick',
    date: '2026-09-27',
    startedAt: 0,
    status: 'active',
    turns: Array.from({ length: turns }, (_, i) => ({ role: 'user', text: `t${i}`, at: i, phase: 'free' })),
  }) as Conversation;

describe('createConversationWriter', () => {
  it('連続した更新は合流し、最後の状態が保存される', async () => {
    const saved: number[] = [];
    let release!: () => void;
    const put = vi.fn(
      (c: Conversation) =>
        new Promise<void>((r) => {
          saved.push(c.turns.length);
          release = r;
        }),
    );
    const w = createConversationWriter(conv(), put);
    w.update(() => conv(1));
    w.update(() => conv(2));
    w.update(() => conv(3));
    release();
    await Promise.resolve();
    await Promise.resolve();
    release();
    await w.flush();
    expect(saved).toEqual([1, 3]);
    expect(w.get().turns).toHaveLength(3);
  });

  it('seal後の更新は無視する（終了後に遅れて来たAIターンで上書きしない）', async () => {
    const put = vi.fn(async () => {});
    const w = createConversationWriter(conv(), put);
    w.update((c) => ({ ...c, status: 'completed' }));
    await w.flush();
    w.seal();
    w.update(() => conv(9));
    await w.flush();
    expect(w.get().status).toBe('completed');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('保存に失敗しても次の更新は保存を試みる', async () => {
    const onError = vi.fn();
    const put = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    const w = createConversationWriter(conv(), put, onError);
    w.update(() => conv(1));
    await w.flush();
    w.update(() => conv(2));
    await w.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
  });
});
