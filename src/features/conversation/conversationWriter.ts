/**
 * 会話レコードのIndexedDB書き込みを直列化・合流させる（M13。React非依存）。
 *
 * 会話中はターン追加のたびにレコード全体を put する。M13でAI呼び出しの前にDB書き込みを
 * 待たなくなったため、書き込みは「メモリ上の最新状態を裏で順番に保存する」形にする:
 *   - update(): メモリ上のレコードを同期で更新し、保存を予約する（連続した更新は1回の保存に合流）
 *   - flush():  予約済みの保存がすべて終わるまで待つ
 *   - seal():   以降の update を無視する（会話終了後、遅れて完了したAIターン等が
 *               終了処理の保存を古い内容で上書きする競合を防ぐ）
 */

import type { Conversation } from '../../lib/types';

export interface ConversationWriter {
  get(): Conversation;
  update(fn: (current: Conversation) => Conversation): Conversation;
  flush(): Promise<void>;
  seal(): void;
  readonly sealed: boolean;
}

export function createConversationWriter(
  initial: Conversation,
  put: (conversation: Conversation) => Promise<void>,
  onError: (err: unknown) => void = (err) => console.error('[conversationWriter] 会話の保存に失敗しました。', err),
): ConversationWriter {
  let current = initial;
  let dirty = false;
  let sealed = false;
  let running: Promise<void> | null = null;

  const drain = async () => {
    while (dirty) {
      dirty = false;
      try {
        await put(current);
      } catch (err) {
        onError(err);
      }
    }
    running = null;
  };

  const schedule = () => {
    dirty = true;
    if (!running) running = drain();
  };

  return {
    get: () => current,
    update(fn) {
      if (sealed) return current;
      current = fn(current);
      schedule();
      return current;
    },
    async flush() {
      while (running) await running;
    },
    seal() {
      sealed = true;
    },
    get sealed() {
      return sealed;
    },
  };
}
