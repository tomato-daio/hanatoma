/**
 * シナリオ一覧画面（DESIGN.md §2, §9, §10）。
 * 上部にカテゴリ島マップ、島をタップするとそのカテゴリの5シナリオ（レベル1〜5）を表示し、
 * タップでレッスンを開始する。動的生成ボタンはM9で追加。
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startConversation } from '../features/conversation/startConversation';
import { ScenarioMap } from '../features/game/ScenarioMap';
import { loadBundledScenarios } from '../features/scenarios/loadScenarios';
import { getUserProfile, listConversations, listGeneratedScenarios } from '../lib/db';
import type { Conversation, Scenario, ScenarioCategory } from '../lib/types';

const CATEGORY_LABEL: Record<ScenarioCategory, string> = {
  travel: '旅行',
  restaurant: '飲食',
  work: '仕事',
  daily: '日常',
  interview: '面接',
  shopping: '買い物',
  health: '健康',
  social: '交流',
};

export function ScenariosPage() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [userLevel, setUserLevel] = useState(2);
  const [selectedCategory, setSelectedCategory] = useState<ScenarioCategory | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [bundled, generated, convs, profile] = await Promise.all([
          loadBundledScenarios(),
          listGeneratedScenarios(),
          listConversations(),
          getUserProfile(),
        ]);
        if (cancelled) return;
        setScenarios([...bundled, ...generated]);
        setConversations(convs);
        setUserLevel(profile.level);
      } catch (e: unknown) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : 'シナリオの読み込みに失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const begin = async (scenario: Scenario) => {
    if (starting) return;
    setStarting(true);
    setMessage(null);
    try {
      const result = await startConversation(scenario.id, 'lesson');
      if (!result.ok) {
        setMessage(result.messageJa);
        return;
      }
      navigate(`/talk/${result.conversationId}`);
    } finally {
      setStarting(false);
    }
  };

  const bestStars = (scenarioId: string): number | null => {
    const played = conversations.filter(
      (c) => c.scenarioId === scenarioId && c.status === 'completed' && c.stars !== undefined,
    );
    if (played.length === 0) return null;
    return Math.max(...played.map((c) => c.stars ?? 0));
  };

  const categoryScenarios = selectedCategory
    ? scenarios.filter((s) => s.category === selectedCategory).sort((a, b) => a.level - b.level)
    : [];

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      <h1 className="text-xl font-bold text-neutral-800">シナリオ</h1>

      {message && <p className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{message}</p>}

      <ScenarioMap
        scenarios={scenarios}
        conversations={conversations}
        onSelectCategory={(c) => setSelectedCategory(selectedCategory === c ? null : c)}
      />

      {selectedCategory && (
        <section className="rounded-2xl border border-neutral-200 p-3">
          <p className="text-sm font-bold text-neutral-800">{CATEGORY_LABEL[selectedCategory]}の島</p>
          <div className="mt-2 flex flex-col gap-2">
            {categoryScenarios.map((s) => {
              const stars = bestStars(s.id);
              const levelGap = Math.abs(s.level - userLevel);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => void begin(s)}
                  disabled={starting}
                  className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white p-3 text-left active:border-hana-400 disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neutral-800">{s.titleJa}</p>
                    <p className="mt-0.5 text-xs text-neutral-400">
                      レベル{s.level}
                      {levelGap === 0 && ' ・ あなたにぴったり'}
                      {levelGap >= 2 && ` ・ 現在のレベル${userLevel}と離れています`}
                      {' ・ 約'}
                      {s.estimatedMinutes}分
                    </p>
                  </div>
                  <span className="ml-2 shrink-0 text-xs font-bold text-hana-500">
                    {stars !== null ? '★'.repeat(Math.max(stars, 0)) || '―' : '未挑戦'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <p className="text-xs text-neutral-400">
        島をタップするとシナリオ一覧が開きます。★はこれまでのベスト評価です。
      </p>
    </div>
  );
}
