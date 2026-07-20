/**
 * shadotoma の提出データ（submissions）から弱点音素を時間減衰集計する純関数（DESIGN.md §11a・M8）。
 *
 * ⚠️ shadotoma src/features/insights/weakness.ts と同期必須。
 * 集計本体（weakPhonemesFromSubmissions）は shadotoma weakness.ts の buildPhonemeStats
 * （半減期10提出の時間減衰加重平均・直近3件平均75以上で「克服」扱い・低スコア順トップ3）を
 * コピーしたもの。shadotoma 側でアルゴリズム・定数が変わったらこのファイルを必ず追従させること
 * （両DESIGN.mdに相互注記あり）。
 *
 * hanatoma は shadotoma の型を import できないため、IndexedDB から読んだ生レコードを
 * 構造的な最小型（SisterSubmissionLike）として受け取る。DOM/ブラウザAPIには依存しない
 * （Vitestでテストする）。
 */

/** SisterData.weakPhonemes の1件（phoneme は ARPAbet 大文字キー。例 'R','TH'）。 */
export interface SisterWeakPhonemeEntry {
  phoneme: string;
  /** 時間減衰加重平均スコア（半減期10提出）。低いほど苦手。 */
  avgScore: number;
}

/** shadotoma Submission のうち、弱点集計に必要な部分だけの構造型。 */
export interface SisterSubmissionLike {
  createdAt: number;
  /** 学習日 "YYYY-MM-DD"（practiceDates 集計用。壊れたレコードでは undefined）。 */
  date?: string;
  judge?: {
    azure?: {
      weakPhonemes?: { phoneme: string; avgScore: number }[];
    };
  };
}

// ---- 以下の定数・集計ロジックは shadotoma weakness.ts のコピー（⚠️同期必須） ----

/** 半減期10提出。weight = 0.5^(rank/half-life)。rank=0が最新のAzure付き提出。 */
const PHONEME_HALF_LIFE = 10;
/** 直近平均がこの値以上になったら「克服」扱い（集計結果から除外する）。 */
const OVERCOME_THRESHOLD = 75;
/** 「直近平均」を計算する際に使う、直近何件の出現を見るか。 */
const RECENT_WINDOW = 3;
/** 返す弱点音素の上限（shadotoma の WEAK_PHONEME_TOP_LIMIT と同じ）。 */
const WEAK_PHONEME_TOP_LIMIT = 3;

interface PhonemeOccurrence {
  rank: number; // 0=最新のAzure付き提出
  avgScore: number;
}

/**
 * shadotoma の提出一覧から弱点音素（時間減衰加重平均スコアの低い順・最大3件）を求める。
 * 並び順は問わない（内部で createdAt の新しい順に並べ直す）。
 * judge.azure.weakPhonemes を持たない提出は rank 付与の対象にも含めない
 * （shadotoma buildWeaknessProfile と同じ前処理）。
 *
 * shadotoma 版との差分: hanatoma 側では trend（improving/stagnant）を使わないため出力から
 * 省いている。集計式（重み・克服判定・並び順）は同一。
 */
export function weakPhonemesFromSubmissions(
  submissions: SisterSubmissionLike[],
): SisterWeakPhonemeEntry[] {
  const azureSubmissionsDesc = submissions
    .filter((s) => (s.judge?.azure?.weakPhonemes?.length ?? 0) > 0)
    .sort((a, b) => b.createdAt - a.createdAt);

  const byPhoneme = new Map<string, PhonemeOccurrence[]>();
  azureSubmissionsDesc.forEach((submission, rank) => {
    for (const wp of submission.judge?.azure?.weakPhonemes ?? []) {
      const list = byPhoneme.get(wp.phoneme) ?? [];
      list.push({ rank, avgScore: wp.avgScore });
      byPhoneme.set(wp.phoneme, list);
    }
  });

  const weakPhonemes: SisterWeakPhonemeEntry[] = [];

  for (const [phoneme, occurrencesUnsorted] of byPhoneme) {
    // rank昇順(新しい順)に揃える。
    const occurrences = [...occurrencesUnsorted].sort((a, b) => a.rank - b.rank);

    const weightOf = (rank: number) => 0.5 ** (rank / PHONEME_HALF_LIFE);
    const weightSum = occurrences.reduce((sum, o) => sum + weightOf(o.rank), 0);
    const score = occurrences.reduce((sum, o) => sum + o.avgScore * weightOf(o.rank), 0) / weightSum;

    const recentWindow = occurrences.slice(0, RECENT_WINDOW);
    const recentAvg = recentWindow.reduce((sum, o) => sum + o.avgScore, 0) / recentWindow.length;
    if (recentAvg >= OVERCOME_THRESHOLD) continue; // 克服済みは弱点として返さない

    weakPhonemes.push({ phoneme, avgScore: score });
  }

  weakPhonemes.sort((a, b) => a.avgScore - b.avgScore);
  return weakPhonemes.slice(0, WEAK_PHONEME_TOP_LIMIT);
}

// ---- 以下は hanatoma 固有の入力検証ヘルパー（shadotoma との同期対象外） ----

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function extractWeakPhonemes(v: unknown): { phoneme: string; avgScore: number }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const result: { phoneme: string; avgScore: number }[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    if (typeof item.phoneme !== 'string' || item.phoneme === '') continue;
    if (typeof item.avgScore !== 'number' || !Number.isFinite(item.avgScore)) continue;
    result.push({ phoneme: item.phoneme, avgScore: item.avgScore });
  }
  return result.length > 0 ? result : undefined;
}

/**
 * IndexedDB（または shadotoma バックアップJSON）から読んだ生レコード配列を、
 * 弱点集計に必要な最小型へ安全に変換する。壊れたレコードは黙って捨てる
 * （ブリッジは絶対にthrowしない方針のため、ここで防御的に落とす）。
 */
export function toSisterSubmissions(records: unknown[]): SisterSubmissionLike[] {
  const result: SisterSubmissionLike[] = [];
  for (const record of records) {
    if (!isRecord(record)) continue;
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) continue;
    const submission: SisterSubmissionLike = { createdAt: record.createdAt };
    if (typeof record.date === 'string' && DATE_RE.test(record.date)) {
      submission.date = record.date;
    }
    const judge = record.judge;
    if (isRecord(judge) && isRecord(judge.azure)) {
      const weakPhonemes = extractWeakPhonemes(judge.azure.weakPhonemes);
      if (weakPhonemes) {
        submission.judge = { azure: { weakPhonemes } };
      }
    }
    result.push(submission);
  }
  return result;
}

/**
 * sessions + submissions の生レコードから練習日（"YYYY-MM-DD"）の集合を作る
 * （DESIGN.md §11a: コンビストリーク用の日付集合）。重複除去・昇順ソート。
 * date が不正なレコードは無視する。
 */
export function collectPracticeDates(sessionRecords: unknown[], submissionRecords: unknown[]): string[] {
  const dates = new Set<string>();
  for (const record of [...sessionRecords, ...submissionRecords]) {
    if (!isRecord(record)) continue;
    if (typeof record.date === 'string' && DATE_RE.test(record.date)) {
      dates.add(record.date);
    }
  }
  return [...dates].sort();
}
