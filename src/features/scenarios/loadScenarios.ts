/**
 * シナリオの読み込み（DESIGN.md §9）。
 * - bundled: public/scenarios/index.json を実行時fetchしメモリ保持（IndexedDBへはコピーしない）
 * - generated: IndexedDBの scenarios ストア
 */

import { getScenario as getGeneratedScenario } from '../../lib/db';
import type { Scenario } from '../../lib/types';

interface ScenarioIndexFile {
  version: number;
  scenarios: Scenario[];
}

let bundledCache: Scenario[] | null = null;
let inflight: Promise<Scenario[]> | null = null;

/** バンドルシナリオ一覧を取得する（初回のみfetch、以降メモリキャッシュ）。 */
export async function loadBundledScenarios(): Promise<Scenario[]> {
  if (bundledCache) return bundledCache;
  if (!inflight) {
    inflight = (async () => {
      const url = `${import.meta.env.BASE_URL}scenarios/index.json`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`シナリオ一覧の取得に失敗しました (HTTP ${res.status})`);
      }
      const data = (await res.json()) as ScenarioIndexFile;
      bundledCache = data.scenarios;
      return bundledCache;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** id からシナリオを取得する（bundled優先→generated）。見つからなければundefined。 */
export async function getScenarioById(id: string): Promise<Scenario | undefined> {
  if (id.startsWith('b-')) {
    const bundled = await loadBundledScenarios();
    return bundled.find((s) => s.id === id);
  }
  return getGeneratedScenario(id);
}

/** テスト用: メモリキャッシュを破棄する。 */
export function clearScenarioCache(): void {
  bundledCache = null;
  inflight = null;
}
