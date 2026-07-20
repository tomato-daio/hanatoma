import { describe, expect, it } from 'vitest';
import {
  collectPracticeDates,
  toSisterSubmissions,
  weakPhonemesFromSubmissions,
  type SisterSubmissionLike,
} from './weaknessFromSubmissions';

function makeSubmission(
  createdAt: number,
  weakPhonemes: { phoneme: string; avgScore: number }[],
  date?: string,
): SisterSubmissionLike {
  return {
    createdAt,
    ...(date !== undefined ? { date } : {}),
    ...(weakPhonemes.length > 0 ? { judge: { azure: { weakPhonemes } } } : {}),
  };
}

describe('weakPhonemesFromSubmissions', () => {
  it('提出が無ければ空配列', () => {
    expect(weakPhonemesFromSubmissions([])).toEqual([]);
  });

  it('weakPhonemesを持たない提出だけなら空配列', () => {
    const submissions = [makeSubmission(1000, []), makeSubmission(2000, [])];
    expect(weakPhonemesFromSubmissions(submissions)).toEqual([]);
  });

  it('1件だけの出現はそのavgScoreがそのまま返る', () => {
    const submissions = [makeSubmission(1000, [{ phoneme: 'R', avgScore: 42 }])];
    const result = weakPhonemesFromSubmissions(submissions);
    expect(result).toHaveLength(1);
    expect(result[0].phoneme).toBe('R');
    expect(result[0].avgScore).toBeCloseTo(42, 10);
  });

  it('半減期10提出の時間減衰: rank0とrank10の出現は重み1:0.5で平均される', () => {
    // 11件のAzure付き提出。'R'は最新(rank0, 40点)と最古(rank10, 100点)にのみ出現。
    // 中間のrank1..9は別音素'TH'で埋めてrankを進める。
    const submissions: SisterSubmissionLike[] = [];
    submissions.push(makeSubmission(11_000, [{ phoneme: 'R', avgScore: 40 }])); // rank0
    for (let i = 1; i <= 9; i++) {
      submissions.push(makeSubmission(11_000 - i * 1000, [{ phoneme: 'TH', avgScore: 50 }])); // rank1..9
    }
    submissions.push(makeSubmission(0, [{ phoneme: 'R', avgScore: 100 }])); // rank10

    const result = weakPhonemesFromSubmissions(submissions);
    const r = result.find((e) => e.phoneme === 'R');
    expect(r).toBeDefined();
    // (40*1 + 100*0.5) / (1 + 0.5) = 60
    expect(r?.avgScore).toBeCloseTo(60, 10);
  });

  it('createdAtの新しい順で重み付けする（配列の並び順には依存しない）', () => {
    // 配列上は古い方が先。新しい方(40点)が重み1、古い方(80点)が重み0.5^(1/10)。
    const older = makeSubmission(1000, [{ phoneme: 'AE', avgScore: 80 }]);
    const newer = makeSubmission(2000, [{ phoneme: 'AE', avgScore: 40 }]);
    const result = weakPhonemesFromSubmissions([older, newer]);
    const w = 0.5 ** (1 / 10);
    const expected = (40 * 1 + 80 * w) / (1 + w);
    expect(result[0].avgScore).toBeCloseTo(expected, 10);
    expect(result[0].avgScore).toBeLessThan(60); // 単純平均(60)より新しい低スコア側に寄る
  });

  it('直近3件の平均が75以上の音素は「克服」扱いで返さない', () => {
    // 'V': 新しい順に 80, 80, 70 → 直近平均76.67 ≥ 75 → 除外（古い40点があっても）。
    const submissions = [
      makeSubmission(4000, [{ phoneme: 'V', avgScore: 80 }]),
      makeSubmission(3000, [{ phoneme: 'V', avgScore: 80 }]),
      makeSubmission(2000, [{ phoneme: 'V', avgScore: 70 }]),
      makeSubmission(1000, [{ phoneme: 'V', avgScore: 40 }]),
    ];
    expect(weakPhonemesFromSubmissions(submissions)).toEqual([]);
  });

  it('スコアの低い順に最大3件へ絞る', () => {
    const submissions = [
      makeSubmission(1000, [
        { phoneme: 'R', avgScore: 30 },
        { phoneme: 'L', avgScore: 50 },
        { phoneme: 'TH', avgScore: 40 },
        { phoneme: 'W', avgScore: 60 },
      ]),
    ];
    const result = weakPhonemesFromSubmissions(submissions);
    expect(result.map((e) => e.phoneme)).toEqual(['R', 'TH', 'L']); // 30, 40, 50。60の'W'は落ちる
  });
});

describe('toSisterSubmissions', () => {
  it('壊れたレコードを黙って捨て、正しいものだけ変換する', () => {
    const records: unknown[] = [
      null,
      42,
      'submission',
      { date: '2026-07-19' }, // createdAtなし → 捨てる
      { createdAt: Number.NaN }, // 非有限 → 捨てる
      { createdAt: 1000, date: '2026-07-19' },
      {
        createdAt: 2000,
        date: 'invalid-date',
        judge: { azure: { weakPhonemes: [{ phoneme: 'R', avgScore: 55 }] } },
      },
    ];
    const result = toSisterSubmissions(records);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ createdAt: 1000, date: '2026-07-19' });
    expect(result[1].date).toBeUndefined(); // 不正な日付は落とす
    expect(result[1].judge?.azure?.weakPhonemes).toEqual([{ phoneme: 'R', avgScore: 55 }]);
  });

  it('weakPhonemesの不正エントリを除外し、全滅ならjudgeを付けない', () => {
    const records: unknown[] = [
      {
        createdAt: 1000,
        judge: {
          azure: {
            weakPhonemes: [
              { phoneme: 'R', avgScore: 40 },
              { phoneme: '', avgScore: 50 }, // 空文字 → 除外
              { phoneme: 'L', avgScore: 'bad' }, // 数値でない → 除外
              { phoneme: 'TH' }, // avgScoreなし → 除外
            ],
          },
        },
      },
      { createdAt: 2000, judge: { azure: { weakPhonemes: [{ phoneme: 'X', avgScore: Number.NaN }] } } },
    ];
    const result = toSisterSubmissions(records);
    expect(result[0].judge?.azure?.weakPhonemes).toEqual([{ phoneme: 'R', avgScore: 40 }]);
    expect(result[1].judge).toBeUndefined();
  });
});

describe('collectPracticeDates', () => {
  it('sessionsとsubmissionsの日付を統合し重複除去・昇順ソートする', () => {
    const sessions: unknown[] = [
      { date: '2026-07-19' },
      { date: '2026-07-17' },
      { date: '2026-07-19' }, // 重複
    ];
    const submissions: unknown[] = [{ date: '2026-07-18' }, { date: '2026-07-17' }];
    expect(collectPracticeDates(sessions, submissions)).toEqual(['2026-07-17', '2026-07-18', '2026-07-19']);
  });

  it('不正なレコード・不正な日付は無視する', () => {
    const sessions: unknown[] = [null, { date: 123 }, { date: 'not-a-date' }, { noDate: true }];
    const submissions: unknown[] = [{ date: '2026-07-20' }];
    expect(collectPracticeDates(sessions, submissions)).toEqual(['2026-07-20']);
  });

  it('両方空なら空配列', () => {
    expect(collectPracticeDates([], [])).toEqual([]);
  });
});
