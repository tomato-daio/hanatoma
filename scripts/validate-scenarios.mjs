#!/usr/bin/env node
/**
 * バンドルシナリオ検証スクリプト（DESIGN.md §9）。
 * public/scenarios/index.json を読み、スキーマ・件数・id・カテゴリ×レベル分布・
 * targetPhonemes のキー体系を検証する。API・外部依存なし（Node標準のみ）。
 *
 * 使い方: node scripts/validate-scenarios.mjs
 * 全違反を列挙して exit 1 / 問題なければ "OK: 40 scenarios valid" で exit 0。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'public', 'scenarios', 'index.json');

/** カテゴリ定義（src/lib/types.ts ScenarioCategory と同期必須） */
const CATEGORIES = [
  'travel',
  'restaurant',
  'work',
  'daily',
  'interview',
  'shopping',
  'health',
  'social',
];

const EXPECTED_COUNT = 40; // 8カテゴリ × 5レベル（DESIGN.md §9）
const LEVELS = [1, 2, 3, 4, 5];

/**
 * 対象15音素のARPAbetキー集合。
 * 出典: shadotoma/src/features/judge/phonemeAdvice.ts の PHONEME_ADVICE キー
 * （DESIGN.md §9: 「shadotoma scripts/annotate-phonemes.mjs の対象15音素と同一キー体系」）。
 * ⚠️shadotoma側で15音素の定義が変わった場合はここも同期すること。
 */
const TARGET_PHONEME_KEYS = new Set([
  'R', 'L', 'TH', 'DH', 'V', 'F', 'W', 'AE', 'AH', 'AX', 'ER', 'IH', 'IY', 'S', 'SH',
]);

const errors = [];
function err(msg) {
  errors.push(msg);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ---- 読み込み ----
let data;
try {
  data = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
} catch (e) {
  console.error(`NG: index.json を読み込めません: ${e.message}`);
  process.exit(1);
}

// ---- トップレベルの形 ----
if (data.version !== 1) err(`top-level: version が 1 ではありません (${data.version})`);
if (!isNonEmptyString(data.generatedAt)) err('top-level: generatedAt がありません');
if (!Array.isArray(data.scenarios)) {
  console.error('NG: top-level: scenarios が配列ではありません');
  process.exit(1);
}
const scenarios = data.scenarios;

// ---- (a) 件数 ----
if (scenarios.length !== EXPECTED_COUNT) {
  err(`件数: ${EXPECTED_COUNT}件であるべきところ ${scenarios.length}件です`);
}

// ---- (b) id形式・重複 / (c) 必須フィールドと型 / (d) 個数制約 / (f) targetPhonemes ----
const seenIds = new Set();
scenarios.forEach((s, i) => {
  const label = `[${i}] ${s?.id ?? '(idなし)'}`;

  // id 形式: "b-<category>-00<level>"
  if (!isNonEmptyString(s.id)) {
    err(`${label}: id がありません`);
  } else {
    if (seenIds.has(s.id)) err(`${label}: id が重複しています`);
    seenIds.add(s.id);
    const m = s.id.match(/^b-([a-z]+)-00([1-5])$/);
    if (!m) {
      err(`${label}: id が "b-<category>-00<level>" 形式ではありません`);
    } else {
      if (m[1] !== s.category) err(`${label}: id内カテゴリ "${m[1]}" と category "${s.category}" が不一致です`);
      if (Number(m[2]) !== s.level) err(`${label}: id内レベル "${m[2]}" と level ${s.level} が不一致です`);
    }
  }

  // 必須文字列フィールド
  for (const f of ['title', 'titleJa', 'setting', 'aiRole', 'userRole', 'goal', 'goalJa', 'freeTalkPrompt']) {
    if (!isNonEmptyString(s[f])) err(`${label}: ${f} が空または欠落しています`);
  }
  if (s.source !== 'bundled') err(`${label}: source が 'bundled' ではありません (${s.source})`);
  if (!CATEGORIES.includes(s.category)) err(`${label}: category "${s.category}" が不正です`);
  if (!LEVELS.includes(s.level)) err(`${label}: level ${s.level} が不正です（1〜5）`);
  if (typeof s.estimatedMinutes !== 'number' || s.estimatedMinutes < 8 || s.estimatedMinutes > 12) {
    err(`${label}: estimatedMinutes は 8〜12 の数値であるべきです (${s.estimatedMinutes})`);
  }

  // keyPhrases 3〜5個
  if (!Array.isArray(s.keyPhrases) || s.keyPhrases.length < 3 || s.keyPhrases.length > 5) {
    err(`${label}: keyPhrases は 3〜5個であるべきです (${Array.isArray(s.keyPhrases) ? s.keyPhrases.length : '配列でない'})`);
  } else {
    s.keyPhrases.forEach((kp, j) => {
      if (!isNonEmptyString(kp.en)) err(`${label}: keyPhrases[${j}].en が空です`);
      if (!isNonEmptyString(kp.ja)) err(`${label}: keyPhrases[${j}].ja が空です`);
      if (kp.note !== undefined && !isNonEmptyString(kp.note)) err(`${label}: keyPhrases[${j}].note が空文字です`);
    });
  }

  // steps 3〜5個
  if (!Array.isArray(s.steps) || s.steps.length < 3 || s.steps.length > 5) {
    err(`${label}: steps は 3〜5個であるべきです (${Array.isArray(s.steps) ? s.steps.length : '配列でない'})`);
  } else {
    s.steps.forEach((st, j) => {
      for (const f of ['aiIntent', 'hintJa', 'hintEn', 'modelAnswer']) {
        if (!isNonEmptyString(st[f])) err(`${label}: steps[${j}].${f} が空です`);
      }
    });
  }

  // hiddenObjectives 2個
  if (!Array.isArray(s.hiddenObjectives) || s.hiddenObjectives.length !== 2) {
    err(`${label}: hiddenObjectives は 2個であるべきです (${Array.isArray(s.hiddenObjectives) ? s.hiddenObjectives.length : '配列でない'})`);
  } else {
    const objIds = new Set();
    s.hiddenObjectives.forEach((o, j) => {
      for (const f of ['id', 'descriptionJa', 'check']) {
        if (!isNonEmptyString(o[f])) err(`${label}: hiddenObjectives[${j}].${f} が空です`);
      }
      if (o.id) {
        if (objIds.has(o.id)) err(`${label}: hiddenObjectives の id "${o.id}" が重複しています`);
        objIds.add(o.id);
      }
    });
  }

  // targetPhonemes: 2〜4個・15音素キー集合内
  if (!Array.isArray(s.targetPhonemes) || s.targetPhonemes.length < 2 || s.targetPhonemes.length > 4) {
    err(`${label}: targetPhonemes は 2〜4個であるべきです (${Array.isArray(s.targetPhonemes) ? s.targetPhonemes.length : '配列でない'})`);
  } else {
    s.targetPhonemes.forEach((p) => {
      if (!TARGET_PHONEME_KEYS.has(p)) {
        err(`${label}: targetPhoneme "${p}" は対象15音素（phonemeAdvice.tsのキー）にありません`);
      }
    });
  }
});

// ---- (e) レベル1〜5が各カテゴリに1本ずつ ----
for (const cat of CATEGORIES) {
  const inCat = scenarios.filter((s) => s.category === cat);
  for (const lv of LEVELS) {
    const n = inCat.filter((s) => s.level === lv).length;
    if (n !== 1) err(`分布: category "${cat}" の level ${lv} が ${n}本です（1本であるべき）`);
  }
}

// ---- 結果 ----
if (errors.length > 0) {
  console.error(`NG: ${errors.length}件の違反が見つかりました:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`OK: ${scenarios.length} scenarios valid`);
process.exit(0);
