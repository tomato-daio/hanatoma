/**
 * シナリオ一覧画面（DESIGN.md §2, §9, §10）。
 * 上部にカテゴリ島マップ、島をタップするとそのカテゴリの5シナリオ（レベル1〜5）を表示し、
 * タップでレッスンを開始する。
 * ページ末尾の「✨ 新しいシナリオを作る」ボタンで動的生成（DESIGN.md §9最終項・M9）を行う。
 * 生成シナリオ（source:'generated'）はscenarios stateに混ざって表示され、
 * カテゴリ詳細の行に削除ボタンが付く。
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startConversation } from '../features/conversation/startConversation';
import { ScenarioMap } from '../features/game/ScenarioMap';
import { loadSisterData } from '../features/game/homeData';
import { loadBundledScenarios } from '../features/scenarios/loadScenarios';
import { generateScenario } from '../features/scenarios/sonnetScenarioGen';
import {
  deleteScenario,
  getUserProfile,
  listConversations,
  listGeneratedScenarios,
  putScenario,
} from '../lib/db';
import type { AppLevel, Conversation, Scenario, ScenarioCategory, UserProfile } from '../lib/types';

/** シナリオ一覧・会話履歴・ユーザープロフィールをまとめて取得する（初回ロード・再読込の両方で使う）。 */
async function fetchScenarioPageData(): Promise<{
  scenarios: Scenario[];
  conversations: Conversation[];
  profile: UserProfile;
}> {
  const [bundled, generated, convs, profile] = await Promise.all([
    loadBundledScenarios(),
    listGeneratedScenarios(),
    listConversations(),
    getUserProfile(),
  ]);
  return { scenarios: [...bundled, ...generated], conversations: convs, profile };
}

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
  const [userLevel, setUserLevel] = useState<AppLevel>(2);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<ScenarioCategory | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchScenarioPageData();
        if (cancelled) return;
        setScenarios(data.scenarios);
        setConversations(data.conversations);
        setUserLevel(data.profile.level);
        setProfile(data.profile);
      } catch (e: unknown) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : 'シナリオの読み込みに失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = async () => {
    const data = await fetchScenarioPageData();
    setScenarios(data.scenarios);
    setConversations(data.conversations);
    setUserLevel(data.profile.level);
    setProfile(data.profile);
  };

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

  const handleGenerate = async () => {
    if (generating) return;
    const confirmed = window.confirm(
      'Sonnet APIを1回使用して、あなた向けの新しいシナリオを作成します（費用の目安は数円程度です）。よろしいですか？',
    );
    if (!confirmed) return;

    setGenerating(true);
    setMessage(null);
    try {
      const sisterData = await loadSisterData();
      const weakPhonemes = (sisterData?.weakPhonemes ?? []).map((w) => w.phoneme);
      const existingTitles = scenarios.filter((s) => s.source === 'generated').map((s) => s.title);

      const result = await generateScenario({
        interests: profile?.interests ?? [],
        weakPhonemes,
        level: profile?.level ?? userLevel,
        existingTitles,
      });
      if ('error' in result) {
        setMessage(result.error);
        return;
      }

      await putScenario(result);
      await reload();
      setMessage(`新しいシナリオ「${result.titleJa}」を作成しました。`);
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : 'シナリオの生成に失敗しました。');
    } finally {
      setGenerating(false);
    }
  };

  const handleDeleteGenerated = async (scenario: Scenario) => {
    if (!window.confirm(`「${scenario.titleJa}」を削除します。よろしいですか？`)) return;
    try {
      await deleteScenario(scenario.id);
      await reload();
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : 'シナリオの削除に失敗しました。');
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
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-white p-3"
                >
                  <button
                    type="button"
                    onClick={() => void begin(s)}
                    disabled={starting}
                    className="flex min-w-0 flex-1 items-center justify-between text-left active:opacity-70 disabled:opacity-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neutral-800">
                        {s.titleJa}
                        {s.source === 'generated' && (
                          <span className="ml-1 text-[10px] font-normal text-hana-500">✨生成</span>
                        )}
                      </p>
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
                  {s.source === 'generated' && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteGenerated(s)}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 active:bg-neutral-100"
                      aria-label={`${s.titleJa}を削除`}
                    >
                      削除
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <p className="text-xs text-neutral-400">
        島をタップするとシナリオ一覧が開きます。★はこれまでのベスト評価です。
      </p>

      <section className="rounded-2xl border border-dashed border-hana-300 p-4 text-center">
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={generating}
          className="inline-flex items-center gap-2 rounded-xl bg-hana-500 px-4 py-2 text-sm font-bold text-white active:bg-hana-600 disabled:opacity-50"
        >
          {generating && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {generating ? '生成中…' : '✨ 新しいシナリオを作る'}
        </button>
        <p className="mt-2 text-xs text-neutral-400">
          Sonnet APIを1回使って、あなたの興味・レベルに合わせた新しいシナリオを作成します。
        </p>
      </section>
    </div>
  );
}
