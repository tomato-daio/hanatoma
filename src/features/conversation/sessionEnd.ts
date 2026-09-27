/**
 * セッション終了パイプライン（DESIGN.md §4フェーズ5, §8, §10, §12の統合点）。
 *
 * 完了した会話に対して:
 *   1. Sonnet添削レポート生成（lesson/quick/bossのみ。bite/diagnosticは対象外）
 *   2. メトリクス計算 → ★評価
 *   3. デイリークエスト進捗更新 → 完了数
 *   4. ストリーク計算（shadotoma合算・お休みチケット考慮） → XP計算 → プロファイル加算
 *   5. バッジ判定・レベル昇降格・お休みチケット付与（7日継続ごと+1、最大2）
 *   6. RewardScreen用のSessionSummaryを返す
 *
 * この関数はfinish（会話のstatus='completed'保存）後に呼ぶこと。
 *
 * M13: 会話中は発音評価をしないため、1の添削（Sonnet）と並行して「会話後の発音評価」
 * （deferredPa.ts。音声ターンを1件ずつAzureで評価）を行い、結果をターンへマージしてから
 * 2以降（メトリクス・★・クエスト・レベル）を計算する。発音評価はSonnet完了の2秒後
 * （最低でも開始から10秒、ひとくちは8秒）で打ち切り、上限30秒。採点できなかったターンは指標から外れる。
 */

import {
  addUsage,
  getAppState,
  getQuestState,
  getUsageDay,
  getUserProfile,
  listConversations,
  listExpressions,
  putConversation,
  putQuestState,
  putUserProfile,
} from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { computeLessonMetrics } from '../../lib/level/metrics';
import { applyLevelProgress, computePromoteProgress, type RecentLessonRecord } from '../../lib/level/progress';
import { evaluateBadges } from '../../lib/game/badges';
import {
  applyQuestEvent,
  getQuestDescription,
  pickDailyQuests,
  type QuestEvent,
} from '../../lib/game/quests';
import { starsFromComposite } from '../../lib/game/stars';
import { calcSessionXp } from '../../lib/game/xp';
import { DEFAULT_DAILY_CAPS, type Conversation, type CorrectionReport, type DailyCaps, type Scenario } from '../../lib/types';
import { buildStreakInfo, getIsoWeekId, loadSisterData } from '../game/homeData';
import type { SessionSummary } from '../game/sessionSummary';
import { requestCorrection, saveCorrectionReport } from '../report/generateReport';
import { assessSpeech } from '../speech/azurePaUnscripted';
import { logPaDebug } from '../speech/paDebugLog';
import { mergeDeferredPa, runDeferredPa, selectClipsForPa, type RunDeferredPaResult, type TurnClip } from './deferredPa';
import { getReviewDates } from '../review/reviewStore';
import { getScenarioById } from '../scenarios/loadScenarios';

const MAX_REST_TICKETS = 2;
const REST_TICKET_INTERVAL_DAYS = 7;
const PA_HIGH_THRESHOLD = 80;
const KEY_PHRASE_PASS = 80;

export interface SessionEndResult {
  summary: SessionSummary;
  report: CorrectionReport | null;
  /** レポート生成に失敗した場合の日本語メッセージ（会話自体の完了は妨げない）。 */
  reportError?: string;
}

/** キーフレーズ全✓判定: 各フレーズに80点以上のkeyphraseターンが存在するか。 */
function allKeyPhrasesDone(conversation: Conversation, scenario: Scenario): boolean {
  if (scenario.keyPhrases.length === 0) return false;
  return scenario.keyPhrases.every((p) =>
    conversation.turns.some(
      (t) =>
        t.phase === 'keyphrase' &&
        t.text === p.en &&
        t.pa !== undefined &&
        t.pa.pronScore >= KEY_PHRASE_PASS,
    ),
  );
}

/** 会話後の発音評価の打ち切り（DESIGN.md §6a-3）。 */
const DEFERRED_PA_GRACE_AFTER_REPORT_MS = 2_000;
const DEFERRED_PA_MIN_MS = 10_000;
const DEFERRED_PA_MIN_MS_BITE = 8_000;
const DEFERRED_PA_HARD_CAP_MS = 30_000;

export interface RunSessionEndOptions {
  /** 会話後に発音評価する音声ターン（useConversation.finish の戻り値）。 */
  clips?: TurnClip[];
  /** 発音評価の進み具合（オーバーレイ表示用）。 */
  onPaProgress?: (done: number, total: number) => void;
}

export async function runSessionEnd(
  finishedConversation: Conversation,
  modelAnswersShown: number,
  options: RunSessionEndOptions = {},
): Promise<SessionEndResult> {
  const today = learningDate(new Date());
  const scenario = await getScenarioById(finishedConversation.scenarioId);
  if (!scenario) {
    throw new Error('シナリオが見つかりません。');
  }
  const profile = await getUserProfile();
  const sisterData = await loadSisterData();

  // --- 1. 添削レポート（bite/diagnosticはSonnetを呼ばない: §4） ‖ 会話後の発音評価 ---
  const wantsReport =
    finishedConversation.mode === 'lesson' || finishedConversation.mode === 'quick' || finishedConversation.mode === 'boss';
  const startedAt = Date.now();
  const paAbort = new AbortController();
  const hardCapId = setTimeout(() => paAbort.abort(), DEFERRED_PA_HARD_CAP_MS);
  let paJob: Promise<RunDeferredPaResult> = Promise.resolve({ results: new Map(), sentSeconds: 0 });
  const clips = options.clips ?? [];
  let selectedCount = 0;
  if (clips.length > 0) {
    const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
    const usage = await getUsageDay(today);
    const selected = selectClipsForPa(clips, { capRemainingSec: caps.paMinutes * 60 - usage.paSeconds });
    selectedCount = selected.length;
    paJob = runDeferredPa(selected, {
      assess: assessSpeech,
      signal: paAbort.signal,
      ...(options.onPaProgress ? { onProgress: options.onPaProgress } : {}),
      log: logPaDebug,
    });
  }
  const correction = wantsReport
    ? await requestCorrection(
        finishedConversation,
        scenario,
        profile.level,
        sisterData?.weakPhonemes.map((w) => w.phoneme) ?? [],
      )
    : null;
  // 添削が終わったら、発音評価はもう少しだけ待って打ち切る（待たせすぎない）。
  const minMs = wantsReport ? DEFERRED_PA_MIN_MS : DEFERRED_PA_MIN_MS_BITE;
  const graceId = setTimeout(
    () => paAbort.abort(),
    Math.max(wantsReport ? DEFERRED_PA_GRACE_AFTER_REPORT_MS : 0, startedAt + minMs - Date.now()),
  );
  const pa = await paJob;
  clearTimeout(graceId);
  clearTimeout(hardCapId);
  if (pa.sentSeconds > 0) await addUsage(today, { paSeconds: pa.sentSeconds });
  if (clips.length > 0) {
    logPaDebug(
      `[会話後PA] ${pa.results.size}/${selectedCount}件採点（音声ターン${clips.length}件・${Math.round((Date.now() - startedAt) / 100) / 10}s）`,
    );
  }

  // 発音スコアをターンへ書き戻して保存（以降の集計・レポートはマージ後のターンで行う）。
  const conversation: Conversation =
    pa.results.size > 0
      ? { ...finishedConversation, turns: mergeDeferredPa(finishedConversation.turns, pa.results) }
      : finishedConversation;
  if (conversation !== finishedConversation) await putConversation(conversation);

  let report: CorrectionReport | null = null;
  let reportError: string | undefined;
  if (correction) {
    if ('error' in correction) {
      reportError = correction.error;
    } else {
      const saved = await saveCorrectionReport(correction.output, conversation);
      if ('error' in saved) reportError = saved.error;
      else report = saved;
    }
  }

  // --- 2. メトリクス・★ ---
  const metrics = computeLessonMetrics(conversation.turns, report?.grammarErrorCount ?? 0);
  const stars = starsFromComposite(metrics.composite);

  // --- 3. クエスト進捗 ---
  const sisterWeak = sisterData?.weakPhonemes.map((w) => w.phoneme) ?? [];
  const questState =
    (await getQuestState(today)) ??
    ({ date: today, quests: pickDailyQuests(today, profile.level, sisterWeak) } as const);
  const doneBefore = questState.quests.filter((q) => q.done).length;

  const paHighCount = conversation.turns.filter(
    (t) => t.role === 'user' && t.pa !== undefined && t.pa.pronScore >= PA_HIGH_THRESHOLD,
  ).length;
  const keyPhrasesAll = allKeyPhrasesDone(conversation, scenario);

  const events: QuestEvent[] = [];
  if (conversation.mode === 'lesson' || conversation.mode === 'boss') {
    events.push({ type: 'sessionDone', count: 1 });
  }
  if (conversation.mode === 'quick') events.push({ type: 'quickDone', count: 1 });
  if (paHighCount > 0) events.push({ type: 'paHighTurn', count: paHighCount });
  if (keyPhrasesAll) events.push({ type: 'keyPhrasesAllDone', count: 1 });
  if (report && report.learnedExpressions.length > 0) {
    events.push({ type: 'newExpressionsUsed', count: report.learnedExpressions.length });
  }
  // phonemeWordSpokenはPA結果から対象音素含有語を数える精密な方法が未実装（M9候補）。
  // クエストに出現しても進捗はpaHighTurn等で完了できないだけで、害はない。

  let updatedQuestState = { ...questState, quests: [...questState.quests] };
  for (const event of events) {
    updatedQuestState = applyQuestEvent(updatedQuestState, event);
  }
  // ボス勝利の記録（週次1回: §10）
  const bossWin = conversation.mode === 'boss' && stars > 0;
  if (bossWin) {
    updatedQuestState = {
      ...updatedQuestState,
      bossWeekId: getIsoWeekId(new Date()),
      bossDone: true,
    };
  }
  await putQuestState(updatedQuestState);
  const doneAfter = updatedQuestState.quests.filter((q) => q.done).length;
  const questsCompleted = Math.max(0, doneAfter - doneBefore);

  // --- 4. ストリーク → XP ---
  // 今完了したセッションを含めた練習日集合でストリークを出す
  // （サイレント復習のみの日も練習日に含める。DESIGN.md §10）
  const allConversations = await listConversations();
  const hanatomaDates = allConversations
    .filter((c) => c.status === 'completed' || c.id === conversation.id)
    .map((c) => c.date);
  if (!hanatomaDates.includes(today)) hanatomaDates.push(today);
  for (const d of await getReviewDates()) {
    if (!hanatomaDates.includes(d)) hanatomaDates.push(d);
  }
  const streakInfo = buildStreakInfo(
    hanatomaDates,
    sisterData?.practiceDates ?? [],
    profile.restTickets,
    today,
  );

  const completedTodayBefore = allConversations.filter(
    (c) => c.date === today && c.status === 'completed' && c.id !== conversation.id,
  ).length;
  const isFirstSessionToday = completedTodayBefore === 0;

  const xpResult = calcSessionXp({
    mode: conversation.mode,
    objectivesAchieved: report?.objectivesAchieved.length ?? 0,
    allKeyPhrasesDone: keyPhrasesAll,
    questsCompleted,
    bossWin,
    modelAnswersShown,
    streak: streakInfo.streak,
    isFirstSessionToday,
  });

  // --- 5. プロファイル更新（XP・バッジ・レベル・チケット） ---
  const updatedProfile = { ...profile, xp: profile.xp + xpResult.xp };

  // お休みチケット: 7日継続の節目（その日の最初のセッションのみ）で+1、上限2
  if (
    isFirstSessionToday &&
    streakInfo.streak > 0 &&
    streakInfo.streak % REST_TICKET_INTERVAL_DAYS === 0 &&
    updatedProfile.restTickets < MAX_REST_TICKETS
  ) {
    updatedProfile.restTickets += 1;
  }

  // 会話レコードへ結果を保存（バッジ・レベル判定はこの反映後の一覧で行う）
  const completedConversation: Conversation = {
    ...conversation,
    metrics,
    stars,
    xpAwarded: xpResult.xp,
  };
  await putConversation(completedConversation);

  // レベル昇降格の判定材料（本セッション含む）。applyLevelProgress は内部で
  // 「現レベル以上をフィルタ→直近5件」（昇格）／「直近5件（レベル問わず）」（降格）を行うため、
  // ここでは十分広い窓（直近20件）を渡す。5件しか渡さないと『直近5件が全て現レベル以上』でないと
  // 昇格判定が発動せず、復習で下位レベルを1回挟むだけで昇格がリセットされてしまう（DESIGN.md §8c）。
  const gradedModes = new Set(['lesson', 'quick', 'boss']);
  const recentConvs = (await listConversations())
    .filter((c) => c.status === 'completed' && gradedModes.has(c.mode) && c.metrics)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 20);
  const recentLessons: RecentLessonRecord[] = [];
  for (const c of recentConvs) {
    const s = c.scenarioId === scenario.id ? scenario : await getScenarioById(c.scenarioId);
    recentLessons.push({
      date: c.date,
      scenarioLevel: s?.level ?? profile.level,
      composite: c.metrics!.composite,
    });
  }
  const levelResult = applyLevelProgress(updatedProfile, recentLessons, today);
  if (levelResult.change) {
    updatedProfile.level = levelResult.level;
    updatedProfile.levelHistory = [
      ...updatedProfile.levelHistory,
      { date: today, level: levelResult.level, reason: levelResult.change },
    ];
  }

  // 昇格プログレス（§8d）: 更新後レベルでの「あと何回で昇格か」をRewardScreenに出す。
  // promotionEligibleは、このレッスンが昇格判定の対象（プレイ時レベル以上の難易度）だったか。
  const promoteProgress = computePromoteProgress(updatedProfile.level, recentLessons);
  const promotionEligible = scenario.level >= profile.level;

  // バッジ判定（evaluateBadgesは新規獲得idの配列を返す。earnedAtはここで付与）
  const expressions = await listExpressions();
  const conversationsAfter = await listConversations();
  const newBadgeIds = evaluateBadges(updatedProfile, conversationsAfter, expressions);
  if (newBadgeIds.length > 0) {
    const now = Date.now();
    updatedProfile.badges = [
      ...updatedProfile.badges,
      ...newBadgeIds.map((id) => ({ id, earnedAt: now })),
    ];
  }

  await putUserProfile(updatedProfile);

  // --- 6. サマリー ---
  const summary: SessionSummary = {
    xp: xpResult.xp,
    xpBreakdown: xpResult.breakdown,
    stars,
    newExpressions: (report?.learnedExpressions ?? []).map((e) => ({ en: e.en, ja: e.ja })),
    newBadgeIds,
    levelChange: levelResult.change,
    questsAfter: updatedQuestState.quests.map((q) => ({
      id: q.id,
      descriptionJa: getQuestDescription(q.id),
      progress: q.progress,
      target: q.target,
      done: q.done,
    })),
    streak: streakInfo.streak,
    graded: wantsReport,
    composite: metrics.composite,
    promotionEligible,
    promoteProgress,
  };

  return { summary, report, ...(reportError !== undefined ? { reportError } : {}) };
}
