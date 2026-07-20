/**
 * shadotoma IndexedDB の読み取り専用ブリッジ（DESIGN.md §11a・M8）。
 *
 * - 本番同一オリジン（tomato-daio.github.io）でのみ成立する。devのlocalhostでは
 *   shadotoma DBが存在しないため常にnull（その場合、DEVに限り設定画面で保存した
 *   モックデータ（appState 'sisterMockData'）を返す）。
 * - `indexedDB.open('shadotoma')` は**バージョン指定なし**で開く。upgradeで
 *   スキーマを触ることは絶対にしない。DBが存在しない場合のopenは新規作成に
 *   なってしまうため、onupgradeneeded（既存DBのバージョン未指定openでは発火しない＝
 *   発火した時点でDB不存在が確定）でトランザクションをabortし、空DBを作らず失敗させる。
 * - どんな失敗でも絶対にthrowせずnullを返す。呼び出し側はnullなら連携UIを静かに非表示にする。
 * - 結果は60秒メモリキャッシュ（練習日集合・弱点音素は分単位で変わるものではないため）。
 */

import { getAppState } from '../../lib/db';
import {
  SHADOTOMA_DB_NAME,
  SHADOTOMA_SESSIONS_STORE,
  SHADOTOMA_SUBMISSIONS_STORE,
} from './shadotomaMaterialContract';
import {
  collectPracticeDates,
  toSisterSubmissions,
  weakPhonemesFromSubmissions,
} from './weaknessFromSubmissions';

/** shadotoma から読み取った連携データ。 */
export interface SisterData {
  /** shadotoma の練習日集合（"YYYY-MM-DD"・昇順）。コンビストリーク（streakUnion.ts）用。 */
  practiceDates: string[];
  /** 弱点音素（時間減衰加重平均スコアの低い順・最大3件）。推薦・Sonnet添削への注入用。 */
  weakPhonemes: { phoneme: string; avgScore: number }[];
}

/** devモックの保存先appStateキー（SisterMockSection.tsx と同期。値はSisterDataのJSON文字列）。 */
export const SISTER_MOCK_DATA_APP_STATE_KEY = 'sisterMockData';

const CACHE_TTL_MS = 60_000;

let cache: { at: number; data: SisterData | null } | null = null;

/** テスト・モック保存直後用: メモリキャッシュを破棄する。 */
export function resetSisterDataCache(): void {
  cache = null;
}

/**
 * shadotoma DBを読み取り専用の意図で開く。存在しない場合・開けない場合はnull
 * （absent時のopenが空DBを作らないよう、onupgradeneededで即abortする）。
 */
function openShadotomaDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(SHADOTOMA_DB_NAME);
      request.onupgradeneeded = () => {
        // バージョン未指定openでここに来る＝DBが存在しなかった（oldVersion=0）。
        // 空のshadotoma DBを作ってしまわないよう作成トランザクションをabortする。
        try {
          request.transaction?.abort();
        } catch {
          // abort失敗時もonerror経由でnullになるだけなので握りつぶす。
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function getAllFromStore(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    try {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error(`${storeName}の読み取りに失敗しました`));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 本物のshadotoma DBからSisterDataを読む。開けない・ストアが無い・読めない場合はnull。 */
async function readRealSisterData(): Promise<SisterData | null> {
  const db = await openShadotomaDb();
  if (!db) return null;
  try {
    const names = db.objectStoreNames;
    if (!names.contains(SHADOTOMA_SUBMISSIONS_STORE) || !names.contains(SHADOTOMA_SESSIONS_STORE)) {
      return null;
    }
    const [submissionRecords, sessionRecords] = await Promise.all([
      getAllFromStore(db, SHADOTOMA_SUBMISSIONS_STORE),
      getAllFromStore(db, SHADOTOMA_SESSIONS_STORE),
    ]);
    return {
      practiceDates: collectPracticeDates(sessionRecords, submissionRecords),
      weakPhonemes: weakPhonemesFromSubmissions(toSisterSubmissions(submissionRecords)),
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // close失敗は無視してよい（接続はGCで解放される）。
    }
  }
}

/** SisterData相当のJSON文字列を安全にパースする（モック読み込み用。不正ならnull）。 */
export function parseSisterDataJson(raw: string): SisterData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.practiceDates) || !Array.isArray(obj.weakPhonemes)) return null;
    const practiceDates = obj.practiceDates.filter((d): d is string => typeof d === 'string');
    const weakPhonemes: SisterData['weakPhonemes'] = [];
    for (const item of obj.weakPhonemes) {
      if (typeof item !== 'object' || item === null) continue;
      const wp = item as Record<string, unknown>;
      if (typeof wp.phoneme !== 'string' || typeof wp.avgScore !== 'number') continue;
      weakPhonemes.push({ phoneme: wp.phoneme, avgScore: wp.avgScore });
    }
    return { practiceDates, weakPhonemes };
  } catch {
    return null;
  }
}

/** DEVのみ: 設定画面で保存したモック（appState 'sisterMockData'）を読む。無ければnull。 */
async function readMockSisterData(): Promise<SisterData | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = await getAppState<string>(SISTER_MOCK_DATA_APP_STATE_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    return parseSisterDataJson(raw);
  } catch {
    return null;
  }
}

/**
 * shadotoma の連携データを取得する（DESIGN.md §11a）。
 *
 * - 本物のDBが読めればその内容（60秒メモリキャッシュ）。
 * - 本物がnull（DB不存在・ストア不足・読み取り失敗）のとき、DEVに限りモックを返す
 *   （モックは設定画面で随時変わるためキャッシュしない）。
 * - それも無ければnull。**いかなる場合もthrowしない。**
 */
export async function getSisterData(): Promise<SisterData | null> {
  try {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return cache.data ?? (await readMockSisterData());
    }
    const real = await readRealSisterData();
    cache = { at: now, data: real };
    return real ?? (await readMockSisterData());
  } catch {
    return null;
  }
}
