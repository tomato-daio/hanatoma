/**
 * shadotoma のローカル教材（local Material）契約型の複製（DESIGN.md §11b・M8）。
 *
 * ⚠️ shadotoma DESIGN.md §3 および shadotoma src/lib/db.ts の Material 型と同期必須。
 * shadotoma 側で local Material の必須フィールド・DB名・ストア名・バージョンが変わったら
 * このファイルを必ず追従させること（両DESIGN.mdに相互注記あり）。
 *
 * hanatoma から shadotoma DB へ書いてよいのはこの契約に従う materials への1レコードputのみ
 * （DESIGN.md §0 絶対ルール）。optionalフィールド（audioUrl/durationSec/articleId/part/
 * partCount/phonemeCounts、sentences[].ja/vocab など）は**書かない**ため、この契約型には
 * 必須フィールドだけを載せている。
 */

/** shadotoma の IndexedDB 名（shadotoma src/lib/db.ts の DB_NAME と同期必須）。 */
export const SHADOTOMA_DB_NAME = 'shadotoma';

/**
 * 書き出し前チェックに使う最低DBバージョン（DESIGN.md §11b「DBバージョン≥3」）。
 * shadotoma src/lib/db.ts の DB_VERSION は v3（quizResults追加+自己修復）。これ未満のDBは
 * 古いshadotomaが動いている可能性があるため書き込まない。
 */
export const SHADOTOMA_MIN_DB_VERSION = 3;

/** 書き出し先ストア名（shadotoma src/lib/db.ts の materials ストアと同期必須）。 */
export const SHADOTOMA_MATERIALS_STORE = 'materials';

/** 読み取りブリッジ（shadotomaBridge.ts）が存在確認するストア名。 */
export const SHADOTOMA_SUBMISSIONS_STORE = 'submissions';
export const SHADOTOMA_SESSIONS_STORE = 'sessions';

/** ローカル教材の文1件。shadotoma の Sentence は ja/vocab がoptionalだが、書き出しでは en のみ書く。 */
export interface ShadotomaLocalSentence {
  en: string;
}

/**
 * hanatoma が shadotoma materials ストアへ put するローカル教材レコードの契約
 * （DESIGN.md §11b: `{ id:'local-'+uuid, source:'local', title, level:0, category:'Hanatoma',
 * audioBlob, sentences:[{en}...], wordCount, addedAt }`）。
 */
export interface ShadotomaLocalMaterial {
  /** 'local-' + crypto.randomUUID()（shadotoma のローカル教材ID規則と同一）。 */
  id: string;
  source: 'local';
  title: string;
  /** shadotoma の規則で 0 = 不明(ローカル教材)。 */
  level: 0;
  /** hanatoma 由来教材の目印カテゴリ（DESIGN.md §11b で固定）。 */
  category: 'Hanatoma';
  /** TTSで合成した模範会話音声（WAV）。 */
  audioBlob: Blob;
  sentences: ShadotomaLocalSentence[];
  wordCount: number;
  /** epoch ms。 */
  addedAt: number;
}

/** DESIGN.md §11b で固定のカテゴリ値。 */
export const SHADOTOMA_EXPORT_CATEGORY = 'Hanatoma' as const;
