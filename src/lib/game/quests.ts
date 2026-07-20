/**
 * デイリークエスト（DESIGN.md §10）。
 *
 * QuestState['quests']の各要素は types.ts で {id, progress, target, done} に固定されている
 * （説明文やレベル条件を持てない）ため、それらは QUEST_CATALOG 側に持たせ、id を鍵に引く。
 * 苦手音素クエストだけは対象音素ごとに別クエスト扱いにしたいので、
 * 生成時に `${カタログid}:${音素}` という合成idを発行する（applyQuestEventもこの形式を前提に照合する）。
 *
 * 選択はFNV-1aハッシュ+線形合同法(mulberry32)による決定的シャッフルのみで行う。
 * Math.random等の非決定要素は一切使わない（同日同引数なら常に同じ3件になることがテスト要件）。
 */

import type { AppLevel, QuestState } from '../types';

export type QuestEventType =
  | 'sessionDone'
  | 'newExpressionsUsed'
  | 'paHighTurn'
  | 'phonemeWordSpoken'
  | 'quickDone'
  | 'keyPhrasesAllDone';

export interface QuestEvent {
  type: QuestEventType;
  count?: number;
  phoneme?: string;
}

interface QuestCatalogEntry {
  id: string;
  kind: QuestEventType;
  descriptionJa: string; // phonemeWordSpokenのみ「{phoneme}」を実際の音素記号で置換して使う
  target: number;
  minLevel?: AppLevel;
  requiresWeakPhoneme?: boolean; // trueならweakPhonemesが空の日は候補から除外
}

/** クエストカタログ（DESIGN.md §10の例6種 + レベル別バリエーション）。 */
export const QUEST_CATALOG: readonly QuestCatalogEntry[] = [
  { id: 'quest-scenario-complete', kind: 'sessionDone', descriptionJa: '今日のレッスンを1本完了する', target: 1 },
  { id: 'quest-new-expressions-3', kind: 'newExpressionsUsed', descriptionJa: '新しい表現を3つ使う', target: 3 },
  { id: 'quest-pa-high-5', kind: 'paHighTurn', descriptionJa: '発音スコア80点以上のターンを5回とる', target: 5 },
  {
    id: 'quest-phoneme-word',
    kind: 'phonemeWordSpoken',
    descriptionJa: '苦手な{phoneme}の音を含む単語を3回発音する',
    target: 3,
    requiresWeakPhoneme: true,
  },
  { id: 'quest-quick-2', kind: 'quickDone', descriptionJa: 'クイック会話を2本行う', target: 2 },
  { id: 'quest-keyphrases-all', kind: 'keyPhrasesAllDone', descriptionJa: 'キーフレーズを全部✓にする', target: 1 },
  {
    id: 'quest-new-expressions-5',
    kind: 'newExpressionsUsed',
    descriptionJa: '新しい表現を5つ使う',
    target: 5,
    minLevel: 3,
  },
  {
    id: 'quest-pa-high-8',
    kind: 'paHighTurn',
    descriptionJa: '発音スコア80点以上のターンを8回とる',
    target: 8,
    minLevel: 4,
  },
];

const DAILY_QUEST_COUNT = 3;

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: シード1個から[0,1)の擬似乱数列を作る決定的PRNG。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 学習日文字列のハッシュをシードに、カタログからレベル・弱点音素でフィルタした上で3件を決定的に選ぶ。
 * 同じ(date, level, weakPhonemes)なら常に同じ結果になる。
 */
export function pickDailyQuests(
  date: string,
  level: AppLevel,
  weakPhonemes: string[],
): QuestState['quests'] {
  const pool = QUEST_CATALOG.filter((entry) => {
    if (entry.minLevel !== undefined && level < entry.minLevel) return false;
    if (entry.requiresWeakPhoneme && weakPhonemes.length === 0) return false;
    return true;
  });

  const seed = fnv1a(date);
  const picked = seededShuffle(pool, seed).slice(0, DAILY_QUEST_COUNT);

  return picked.map((entry) => {
    if (entry.kind === 'phonemeWordSpoken') {
      const phoneme = weakPhonemes[seed % weakPhonemes.length];
      return { id: `${entry.id}:${phoneme}`, progress: 0, target: entry.target, done: false };
    }
    return { id: entry.id, progress: 0, target: entry.target, done: false };
  });
}

/** 合成id（`カタログid:音素`）からカタログ本体のidだけを取り出す。 */
function baseIdOf(questId: string): string {
  const i = questId.indexOf(':');
  return i === -1 ? questId : questId.slice(0, i);
}

/** クエストidから表示用の説明文を引く（phonemeWordSpokenは{phoneme}を実音素に置換）。 */
export function getQuestDescription(questId: string): string {
  const baseId = baseIdOf(questId);
  const entry = QUEST_CATALOG.find((e) => e.id === baseId);
  if (!entry) return '';
  if (entry.kind === 'phonemeWordSpoken') {
    const phoneme = questId.includes(':') ? questId.slice(questId.indexOf(':') + 1) : '';
    return entry.descriptionJa.replace('{phoneme}', phoneme);
  }
  return entry.descriptionJa;
}

/**
 * イベントに応じてクエスト進捗を更新する。達成済みクエストは変更しない（後戻りしない）。
 * phonemeWordSpokenはevent.phonemeが合成idの音素と一致した場合のみ進捗が進む。
 */
export function applyQuestEvent(state: QuestState, event: QuestEvent): QuestState {
  const quests = state.quests.map((quest) => {
    if (quest.done) return quest;

    const baseId = baseIdOf(quest.id);
    const entry = QUEST_CATALOG.find((e) => e.id === baseId);
    if (!entry || entry.kind !== event.type) return quest;

    if (entry.kind === 'phonemeWordSpoken') {
      const questPhoneme = quest.id.slice(quest.id.indexOf(':') + 1);
      if (!event.phoneme || event.phoneme !== questPhoneme) return quest;
    }

    const increment = event.count ?? 1;
    const progress = Math.min(quest.target, quest.progress + increment);
    return { ...quest, progress, done: progress >= quest.target };
  });

  return { ...state, quests };
}
