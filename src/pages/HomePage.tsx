/**
 * ホーム画面（DESIGN.md §2, §10）。
 * 上から: コンビストリーク → 今日のレッスン(大カード) → クイック会話/ひとくち英会話 →
 * デイリークエスト3件 → 週末ボス告知(土日のみ) → オンボーディング誘導バナー(未診断時)。
 * データは features/game/homeData.ts の buildHomeData() に集約されている。
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { startConversation } from '../features/conversation/startConversation';
import { buildHomeData, type HomeData } from '../features/game/homeData';
import { QuestList } from '../features/game/QuestList';
import { getQuestDescription } from '../lib/game/quests';
import { getLevelParams } from '../lib/level/params';
import type { ConversationMode } from '../lib/types';

export function HomePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<HomeData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await buildHomeData();
        if (!cancelled) setData(result);
      } catch (e: unknown) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : 'ホームデータの読み込みに失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const begin = async (mode: ConversationMode, scenarioId: string | undefined) => {
    if (!scenarioId || starting) return;
    setStarting(true);
    setMessage(null);
    try {
      const result = await startConversation(scenarioId, mode);
      if (!result.ok) {
        setMessage(result.messageJa);
        return;
      }
      navigate(`/talk/${result.conversationId}`);
    } finally {
      setStarting(false);
    }
  };

  if (!data) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-xl font-bold text-neutral-800">はなとま</h1>
        {message ? (
          <p className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{message}</p>
        ) : (
          <p className="text-sm text-neutral-400">読み込み中…</p>
        )}
      </div>
    );
  }

  const todayScenario = data.recommended[0] ?? null;
  const boss = data.boss;
  const questsWithDescription = data.quests.quests.map((q) => ({
    ...q,
    descriptionJa: getQuestDescription(q.id),
  }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-bold text-neutral-800">はなとま</h1>

      {/* コンビストリーク（DESIGN.md §10・§11: hanatoma∪shadotoma + お休みチケット）と現在レベル（§8d） */}
      <section className="rounded-2xl bg-neutral-50 px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-neutral-700">🔥 {data.streak.streak}日継続中</p>
          <p className="text-xs text-neutral-400">🎫 お休みチケット {data.profile.restTickets}枚</p>
        </div>
        <Link
          to="/progress"
          className="mt-2 flex items-center justify-between border-t border-neutral-200 pt-2"
        >
          <p className="text-xs font-semibold text-neutral-600">
            📊 レベル{data.profile.level} {getLevelParams(data.profile.level).labelJa}（CEFR{' '}
            {getLevelParams(data.profile.level).cefr}相当）
          </p>
          <p className="text-xs text-neutral-400">目安をみる →</p>
        </Link>
      </section>

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
              onClick={() => void begin('lesson', todayScenario.id)}
              disabled={starting}
              className="mt-3 w-full rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600 disabled:bg-neutral-300"
            >
              {starting ? '準備中…' : 'はじめる'}
            </button>
          </>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">おすすめできるシナリオが見つかりませんでした。</p>
        )}
      </section>

      {/* 短時間モード（§4: 忙しい日の逃げ道） */}
      <section className="flex gap-2">
        <button
          type="button"
          onClick={() => void begin('quick', todayScenario?.id)}
          disabled={!todayScenario || starting}
          className="flex-1 rounded-xl border border-neutral-200 bg-white p-3 text-left disabled:opacity-50"
        >
          <p className="text-sm font-semibold text-neutral-700">⚡ クイック会話</p>
          <p className="text-xs text-neutral-400">約5分・会話だけ</p>
        </button>
        <button
          type="button"
          onClick={() => void begin('bite', todayScenario?.id)}
          disabled={!todayScenario || starting}
          className="flex-1 rounded-xl border border-neutral-200 bg-white p-3 text-left disabled:opacity-50"
        >
          <p className="text-sm font-semibold text-neutral-700">🍅 ひとくち英会話</p>
          <p className="text-xs text-neutral-400">1〜2分・1往復だけ</p>
        </button>
      </section>

      {/* サイレント復習（DESIGN.md §4b: 声を出せない場所向け・間隔反復） */}
      <Link to="/review" className="rounded-xl border border-neutral-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-neutral-700">🤫 サイレント復習</p>
          {data.review.due > 0 ? (
            <span className="rounded-full bg-hana-100 px-2 py-0.5 text-xs font-bold text-hana-700">
              期限がきたカード {data.review.due}枚
            </span>
          ) : data.review.fresh > 0 ? (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-500">
              新しいカード {data.review.fresh}枚
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-neutral-400">1〜2分・声を出さずにカードで復習（電車でもOK）</p>
      </Link>

      {/* デイリークエスト */}
      <section>
        <p className="mb-2 text-sm font-bold text-neutral-800">デイリークエスト</p>
        <QuestList quests={questsWithDescription} />
      </section>

      {/* 週末ボス告知（DESIGN.md §9: 土曜出現・日曜期限） */}
      {boss && boss.available && (
        <section className="rounded-2xl border border-hana-300 bg-hana-100 p-4">
          <p className="text-xs font-semibold text-hana-700">👑 週末ボス（日曜まで）</p>
          <h2 className="mt-1 text-base font-bold text-neutral-800">{boss.scenario.titleJa}</h2>
          <p className="mt-0.5 text-xs text-neutral-500">レベル{boss.scenario.level}</p>
          {boss.done ? (
            <p className="mt-2 text-xs font-semibold text-hana-700">挑戦済みです。お疲れさまでした！</p>
          ) : (
            <button
              type="button"
              onClick={() => void begin('boss', boss.scenario.id)}
              disabled={starting}
              className="mt-3 w-full rounded-full bg-hana-600 py-3 text-sm font-bold text-white active:bg-hana-700 disabled:bg-neutral-300"
            >
              ボスに挑戦する
            </button>
          )}
        </section>
      )}

      {/* オンボーディング誘導（診断未実施のみ） */}
      {!data.onboardingDone && (
        <Link
          to="/onboarding"
          className="rounded-xl border border-hana-200 bg-white p-3 text-sm text-hana-700 underline"
        >
          レベル診断テストを受けて、自分にぴったりの難易度から始めましょう →
        </Link>
      )}

      {message && <p className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">{message}</p>}
    </div>
  );
}
