/**
 * ホーム画面向けデータ集約（DESIGN.md §2, §9, §10, §11）。
 *
 * profile/シナリオ/会話履歴/デイリークエスト/姉妹アプリ連携/コンビストリーク/おすすめ/週末ボスを
 * 1回のロードでまとめて返す。HomePage.tsxはこれを呼ぶだけでよい。
 *
 * 姉妹アプリ連携（src/features/sisterApp/shadotomaBridge.ts・recommend.ts）は契約シグネチャ
 * （getSisterData(): Promise<SisterData|null> / recommendScenarios(scenarios, completedIds:
 * Set<string>, level, weakPhonemes:string[]): Scenario[]）に基づき静的importする。
 * getSisterDataは仕様上いかなる場合もthrowしない契約だが、recommendScenarios呼び出し側では
 * 念のためtry/catchし、失敗時はfallbackRecommendへ落とす（統合直後の想定外の例外で
 * ホーム画面全体が壊れるのを避けるため）。
 */

import {
  getAppState,
  getQuestState,
  getUserProfile,
  listConversations,
  putQuestState,
} from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { applyRestTickets } from '../../lib/game/streakUnion';
import { pickDailyQuests } from '../../lib/game/quests';
import { loadBundledScenarios } from '../scenarios/loadScenarios';
import { getSisterData, type SisterData } from '../sisterApp/shadotomaBridge';
import { recommendScenarios } from '../sisterApp/recommend';
import type { AppLevel, Conversation, QuestState, Scenario, UserProfile } from '../../lib/types';

export type { SisterData };

export interface StreakInfo {
  streak: number;
  ticketsUsed: number;
  /** チケットで埋めた日付（today側から近い順）。カレンダー表示の🎫マーカーに使う。 */
  usedOn: string[];
}

export interface WeeklyBoss {
  scenario: Scenario;
  weekId: string;
  /** 土曜・日曜のみtrue（DESIGN.md §9: 土曜出現・日曜期限）。 */
  available: boolean;
  done: boolean;
}

export interface HomeData {
  profile: UserProfile;
  /** バンドル初期パック（public/scenarios/index.json）。生成シナリオはM9で別途扱う。 */
  scenarios: Scenario[];
  conversations: Conversation[];
  quests: QuestState;
  sisterData: SisterData | null;
  streak: StreakInfo;
  /** recommendScenariosの結果（先頭が「今日のレッスン」）。 */
  recommended: Scenario[];
  boss: WeeklyBoss | null;
  onboardingDone: boolean;
}

// ---- 姉妹アプリ連携 ----

/**
 * shadotoma連携データを取得する（getSisterDataへの薄いラッパー）。
 * getSisterData自体が「いかなる場合もthrowしない」契約のため、ここでは素通しする。
 */
export async function loadSisterData(): Promise<SisterData | null> {
  return getSisterData();
}

/**
 * recommendScenariosを呼ぶ。純関数だが統合直後の想定外の例外に備えてtry/catchし、
 * 失敗時はfallbackRecommendへ落とす（現レベルに近いシナリオを優先する素朴な並び替え）。
 */
export async function recommend(
  scenarios: Scenario[],
  completedIds: Set<string>,
  level: AppLevel,
  weakPhonemes: string[],
): Promise<Scenario[]> {
  try {
    return recommendScenarios(scenarios, completedIds, level, weakPhonemes);
  } catch {
    return fallbackRecommend(scenarios, completedIds, level);
  }
}

/** recommendScenarios失敗時の素朴な代替推薦（現レベル一致 → ±1レベル → その他の順）。 */
export function fallbackRecommend(
  scenarios: Scenario[],
  completedIds: Set<string>,
  level: AppLevel,
): Scenario[] {
  const uncompleted = scenarios.filter((s) => !completedIds.has(s.id));
  const sameLevel = uncompleted.filter((s) => s.level === level);
  const nearLevel = uncompleted.filter((s) => Math.abs(s.level - level) === 1);
  const rest = uncompleted.filter((s) => s.level !== level && Math.abs(s.level - level) !== 1);
  return [...sameLevel, ...nearLevel, ...rest];
}

// ---- 純関数（ボス選出・ストリーク組み立て。homeData.test.tsの対象） ----

/**
 * ISO 8601週番号ベースの週id（"YYYY-Www"）を返す（DESIGN.md §9: 週次ボスのシード）。
 * 標準的なISO週アルゴリズム（木曜日基準）。年またぎ（12月31日が翌年第1週等）も正しく扱う。
 */
export function getIsoWeekId(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // 月曜=0 ... 日曜=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // その週の木曜日へ
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNumber = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/** quests.tsのfnv1aと同じアルゴリズムをここでも使う（決定的選出のシード生成）。私設なので複製する。 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * その週のボスシナリオを決定的に選ぶ（DESIGN.md §9: ISO週番号シードで「現レベル+1」の
 * 未プレイbundledシナリオから選出）。現レベルが上限5の場合はレベル5のまま選ぶ。
 * 候補が無ければnull（全クリア済み・該当レベルのシナリオが無い等）。
 */
export function selectWeeklyBoss(
  weekId: string,
  level: AppLevel,
  bundledScenarios: Scenario[],
  completedScenarioIds: string[],
): Scenario | null {
  const targetLevel = Math.min(5, level + 1) as AppLevel;
  const completed = new Set(completedScenarioIds);
  const candidates = bundledScenarios
    .filter((s) => s.source === 'bundled' && s.level === targetLevel && !completed.has(s.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // id順に固定してから選ぶ(決定性の担保)
  if (candidates.length === 0) return null;
  const seed = fnv1a(weekId);
  return candidates[seed % candidates.length];
}

/** 学習日文字列(YYYY-MM-DD)の曜日が土曜(6)・日曜(0)ならtrue（DESIGN.md §9: 土曜出現・日曜期限）。 */
export function isBossWeekendWindow(learningDateStr: string): boolean {
  const [y, m, d] = learningDateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 6 || day === 0;
}

/**
 * hanatoma∪shadotomaの練習日集合にお休みチケットを適用してコンビストリークを組み立てる
 * （DESIGN.md §10・§11: streakUnion.tsのunionStreak相当の合算 + applyRestTickets）。
 */
export function buildStreakInfo(
  hanatomaDates: string[],
  shadotomaDates: string[],
  restTickets: number,
  today: string,
): StreakInfo {
  const merged = Array.from(new Set([...hanatomaDates, ...shadotomaDates]));
  const result = applyRestTickets(merged, restTickets, today);
  return { streak: result.streak, ticketsUsed: result.ticketsUsed, usedOn: result.usedOn };
}

// ---- 集約（DBアクセス+姉妹アプリ連携込みの本体） ----

export async function buildHomeData(): Promise<HomeData> {
  const today = learningDate(new Date());
  const now = new Date();

  const [profile, scenarios, conversations, onboardingDoneRaw] = await Promise.all([
    getUserProfile(),
    loadBundledScenarios(),
    listConversations(),
    getAppState<boolean>('onboardingDone'),
  ]);

  const completed = conversations.filter((c) => c.status === 'completed');
  const completedIds = completed.map((c) => c.scenarioId);
  const completedIdSet = new Set(completedIds);
  const hanatomaDates = Array.from(new Set(completed.map((c) => c.date)));

  const sisterData = await loadSisterData();
  const shadotomaDates = sisterData?.practiceDates ?? [];
  const weakPhonemeCodes = (sisterData?.weakPhonemes ?? []).map((w) => w.phoneme);

  const streak = buildStreakInfo(hanatomaDates, shadotomaDates, profile.restTickets, today);

  const weekId = getIsoWeekId(now);
  let quests = await getQuestState(today);
  if (!quests) {
    quests = {
      date: today,
      quests: pickDailyQuests(today, profile.level, weakPhonemeCodes),
      bossWeekId: weekId,
    };
    await putQuestState(quests);
  }

  const recommended = await recommend(scenarios, completedIdSet, profile.level, weakPhonemeCodes);

  const bossScenario = selectWeeklyBoss(weekId, profile.level, scenarios, completedIds);
  const boss: WeeklyBoss | null = bossScenario
    ? {
        scenario: bossScenario,
        weekId,
        available: isBossWeekendWindow(today),
        done: completed.some((c) => c.mode === 'boss' && c.scenarioId === bossScenario.id),
      }
    : null;

  return {
    profile,
    scenarios,
    conversations,
    quests,
    sisterData,
    streak,
    recommended,
    boss,
    onboardingDone: onboardingDoneRaw ?? false,
  };
}
