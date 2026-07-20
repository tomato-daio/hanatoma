/**
 * ホーム画面（DESIGN.md §2）。
 * M3時点: 「今日のレッスン」（レベルに合ったバンドルシナリオ）とクイック会話の開始導線。
 * ストリーク・クエスト・おすすめ推薦・ボスはM7/M8で追加する。
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startConversation } from '../features/conversation/startConversation';
import { loadBundledScenarios } from '../features/scenarios/loadScenarios';
import { getUserProfile, listConversations } from '../lib/db';
import type { ConversationMode, Scenario } from '../lib/types';

export function HomePage() {
  const navigate = useNavigate();
  const [todayScenario, setTodayScenario] = useState<Scenario | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [profile, scenarios, recent] = await Promise.all([
          getUserProfile(),
          loadBundledScenarios(),
          listConversations(50),
        ]);
        if (cancelled) return;
        // 今日のレッスン: 自レベルの未完了シナリオから先頭を選ぶ（弱点ベースの推薦はM8で置換）
        const completedIds = new Set(recent.filter((c) => c.status === 'completed').map((c) => c.scenarioId));
        const candidates = scenarios.filter((s) => s.level === profile.level && !completedIds.has(s.id));
        setTodayScenario(candidates[0] ?? scenarios.find((s) => s.level === profile.level) ?? scenarios[0] ?? null);
      } catch (e: unknown) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : 'シナリオの読み込みに失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const begin = async (mode: ConversationMode) => {
    if (!todayScenario || starting) return;
    setStarting(true);
    setMessage(null);
    try {
      const result = await startConversation(todayScenario.id, mode);
      if (!result.ok) {
        setMessage(result.messageJa);
        return;
      }
      navigate(`/talk/${result.conversationId}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-bold text-neutral-800">はなとま</h1>

      {/* 今日のレッスン（主導線。§4: 1日1本・5〜10分で完結） */}
      <section className="rounded-2xl border border-hana-200 bg-hana-50 p-4">
        <p className="text-xs font-semibold text-hana-700">今日のレッスン</p>
        {todayScenario ? (
          <>
            <h2 className="mt-1 text-lg font-bold text-neutral-800">{todayScenario.titleJa}</h2>
            <p className="mt-0.5 text-sm text-neutral-600">{todayScenario.goalJa}</p>
            <p className="mt-1 text-xs text-neutral-400">
              レベル{todayScenario.level} ・ 約{todayScenario.estimatedMinutes}分
            </p>
            <button
              type="button"
              onClick={() => void begin('lesson')}
              disabled={starting}
              className="mt-3 w-full rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600 disabled:bg-neutral-300"
            >
              {starting ? '準備中…' : 'はじめる'}
            </button>
          </>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">シナリオを読み込み中…</p>
        )}
      </section>

      {/* 短時間モード（§4: 忙しい日の逃げ道） */}
      <section className="flex gap-2">
        <button
          type="button"
          onClick={() => void begin('quick')}
          disabled={!todayScenario || starting}
          className="flex-1 rounded-xl border border-neutral-200 bg-white p-3 text-left disabled:opacity-50"
        >
          <p className="text-sm font-semibold text-neutral-700">⚡ クイック会話</p>
          <p className="text-xs text-neutral-400">約5分・会話だけ</p>
        </button>
        <button
          type="button"
          onClick={() => void begin('bite')}
          disabled={!todayScenario || starting}
          className="flex-1 rounded-xl border border-neutral-200 bg-white p-3 text-left disabled:opacity-50"
        >
          <p className="text-sm font-semibold text-neutral-700">🍅 ひとくち英会話</p>
          <p className="text-xs text-neutral-400">1〜2分・1往復だけ</p>
        </button>
      </section>

      {message && <p className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{message}</p>}

      <p className="text-xs text-neutral-400">
        ストリーク・デイリークエスト・おすすめシナリオはこれから追加されます（M7/M8）。
      </p>
    </div>
  );
}
