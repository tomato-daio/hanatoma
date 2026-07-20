/**
 * 「シャドとまで練習する」— 添削済み模範会話スクリプト+TTS音声(WAV)を shadotoma の
 * ローカル教材として登録する（DESIGN.md §11b・M8）。
 *
 * ⚠️ shadotoma DB への書き込みはこのファイルの「materials ストアへの1レコードput」のみが
 * 全アプリで唯一許可されている（DESIGN.md §0 絶対ルール）。他ストアへのアクセス・スキーマ
 * 変更・複数レコード書き込みを絶対に追加しないこと。
 *
 * 事前チェック（いずれか不合格なら書き込まず {ok:false, reason} を返す）:
 * - shadotoma DBが開ける（存在しない場合は空DBを作らず失敗させる）
 * - materials ストアが存在する
 * - DBバージョン ≥ 3（SHADOTOMA_MIN_DB_VERSION）
 *
 * 失敗時は呼び出し側が downloadFallback.ts（WAVダウンロード+スクリプトコピー）へ誘導する。
 * この関数は絶対にthrowしない。
 */

import type { CorrectionReport, Scenario } from '../../lib/types';
import {
  SHADOTOMA_DB_NAME,
  SHADOTOMA_EXPORT_CATEGORY,
  SHADOTOMA_MATERIALS_STORE,
  SHADOTOMA_MIN_DB_VERSION,
  type ShadotomaLocalMaterial,
  type ShadotomaLocalSentence,
} from './shadotomaMaterialContract';

export type ExportToShadotomaResult = { ok: true } | { ok: false; reason: string };

/**
 * 模範英文の配列を組み立てる（Material.sentences 用）。
 *
 * 「添削済み模範会話スクリプト」= シナリオの模範解答（steps[].modelAnswer）+ 添削で直った
 * 自分の発話（report.items[].corrected）。空文を除き、大文字小文字を無視して重複排除する。
 *
 * ⚠️ TTS音声(WAV)を合成する側（レポート画面の統合コード）も**必ずこの関数で同じ文列を
 * 作ってから合成する**こと。音声とsentencesがずれるとshadotoma側でシャドーイングできなくなる。
 */
export function buildModelSentences(report: CorrectionReport, scenario: Scenario): ShadotomaLocalSentence[] {
  const texts: string[] = [
    ...scenario.steps.map((step) => step.modelAnswer),
    ...report.items.map((item) => item.corrected),
  ];
  const seen = new Set<string>();
  const sentences: ShadotomaLocalSentence[] = [];
  for (const text of texts) {
    const en = text.trim();
    if (en === '') continue;
    const key = en.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sentences.push({ en });
  }
  return sentences;
}

/** 文配列の総語数（Material.wordCount 用。空白区切りの素朴なカウント）。 */
export function countWords(sentences: ShadotomaLocalSentence[]): number {
  return sentences.reduce((sum, s) => sum + s.en.split(/\s+/).filter((w) => w !== '').length, 0);
}

/**
 * shadotoma DBを開く。存在しない場合は新規作成せず失敗させる
 * （shadotomaBridge.ts と同じ onupgradeneeded→abort 方式。バージョン指定・upgradeでの
 * スキーマ変更は絶対にしない）。
 */
function openShadotomaDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(SHADOTOMA_DB_NAME);
      request.onupgradeneeded = () => {
        try {
          request.transaction?.abort();
        } catch {
          // abort失敗時もonerror経由でnullになる。
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

function putMaterial(db: IDBDatabase, material: ShadotomaLocalMaterial): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(SHADOTOMA_MATERIALS_STORE, 'readwrite');
      tx.objectStore(SHADOTOMA_MATERIALS_STORE).put(material);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('教材の保存に失敗しました'));
      tx.onabort = () => reject(tx.error ?? new Error('教材の保存が中断されました'));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * 添削レポート1件をshadotomaのローカル教材として書き出す（DESIGN.md §11b）。
 *
 * @param report 添削レポート（模範英文の材料）
 * @param scenario 対象シナリオ（steps[].modelAnswer の供給元）
 * @param ttsAudioWav 呼び出し側が buildModelSentences と同じ文列から合成したTTS音声（WAV）
 * @param title shadotoma側の教材一覧に表示するタイトル
 */
export async function exportConversationToShadotoma(
  report: CorrectionReport,
  scenario: Scenario,
  ttsAudioWav: Blob,
  title: string,
): Promise<ExportToShadotomaResult> {
  try {
    const sentences = buildModelSentences(report, scenario);
    if (sentences.length === 0) {
      return { ok: false, reason: '書き出せる模範英文がありません' };
    }
    if (ttsAudioWav.size === 0) {
      return { ok: false, reason: '音声データが空です' };
    }

    const db = await openShadotomaDb();
    if (!db) {
      return { ok: false, reason: 'シャドとまのデータが見つかりませんでした（同じ端末・ブラウザでシャドとまを開いたことがありますか？）' };
    }
    try {
      if (!db.objectStoreNames.contains(SHADOTOMA_MATERIALS_STORE)) {
        return { ok: false, reason: 'シャドとまの教材ストアが見つかりませんでした' };
      }
      if (db.version < SHADOTOMA_MIN_DB_VERSION) {
        return { ok: false, reason: 'シャドとまのバージョンが古いようです。シャドとまを一度開いて最新に更新してください' };
      }

      // ⚠️ 必須フィールドのみのローカル教材1レコード。optionalフィールドは書かない。
      const material: ShadotomaLocalMaterial = {
        id: `local-${crypto.randomUUID()}`,
        source: 'local',
        title: title.trim() !== '' ? title.trim() : scenario.title,
        level: 0,
        category: SHADOTOMA_EXPORT_CATEGORY,
        audioBlob: ttsAudioWav,
        sentences,
        wordCount: countWords(sentences),
        addedAt: Date.now(),
      };
      await putMaterial(db, material);
      return { ok: true };
    } finally {
      try {
        db.close();
      } catch {
        // close失敗は無視してよい。
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `教材の保存に失敗しました: ${message}` };
  }
}
