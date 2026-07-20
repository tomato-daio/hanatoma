import { describe, expect, it } from 'vitest';
import type { PaResult, Turn } from '../../lib/types';
import type { PhonemeAdviceEntry } from './phonemeAdvice';
import { aggregateWeakPhonemes, buildPronunciationComments } from './phonemeComments';

const ADVICE_DICT: Readonly<Record<string, PhonemeAdviceEntry>> = {
  R: { key: 'R', displayName: 'rの音', advice: '舌先をどこにも付けずに出します。' },
  TH: { key: 'TH', displayName: 'thの音', advice: '舌を軽く挟んで息を出します。' },
};

function makeWeakPhoneme(
  phoneme: string,
  avgScore: number,
  examples: string[],
): NonNullable<PaResult['weakPhonemes']>[number] {
  return { phoneme, avgScore, examples };
}

function makeUserTurn(weakPhonemes?: PaResult['weakPhonemes']): Turn {
  return {
    role: 'user',
    text: 'test',
    at: 0,
    phase: 'free',
    pa: {
      mode: 'unscripted',
      pronScore: 70,
      accuracyScore: 70,
      fluencyScore: 70,
      words: [],
      weakPhonemes,
    },
  };
}

describe('aggregateWeakPhonemes', () => {
  it('userターンのweakPhonemesを音素キーで集計し、平均スコアの低い順に並べる', () => {
    const turns: Turn[] = [
      makeUserTurn([makeWeakPhoneme('R', 50, ['right']), makeWeakPhoneme('TH', 40, ['think'])]),
    ];

    const result = aggregateWeakPhonemes(turns);

    expect(result.map((r) => r.phoneme)).toEqual(['TH', 'R']);
    expect(result[0].avgScore).toBe(40);
    expect(result[1].avgScore).toBe(50);
  });

  it('同じ音素が複数ターンに出現したら平均を取り、例語をターンをまたいで重複除去しながら連結する', () => {
    const turns: Turn[] = [
      makeUserTurn([makeWeakPhoneme('R', 60, ['right'])]),
      makeUserTurn([makeWeakPhoneme('R', 40, ['right', 'work'])]),
    ];

    const result = aggregateWeakPhonemes(turns);

    expect(result).toHaveLength(1);
    expect(result[0].phoneme).toBe('R');
    expect(result[0].avgScore).toBe(50); // (60+40)/2
    expect(result[0].examples).toEqual(['right', 'work']);
  });

  it('平均スコアがWEAK_SCORE_THRESHOLD(60)以上の音素は除外する', () => {
    const turns: Turn[] = [makeUserTurn([makeWeakPhoneme('R', 60, ['right']), makeWeakPhoneme('TH', 59, ['think'])])];

    const result = aggregateWeakPhonemes(turns);

    expect(result.map((r) => r.phoneme)).toEqual(['TH']);
  });

  it('aiターン・weakPhonemesが無いターン・paが無いターンは無視する', () => {
    const turns: Turn[] = [
      { role: 'ai', text: 'hi', at: 0, phase: 'free' },
      { role: 'user', text: 'hi', at: 1, phase: 'free' },
      makeUserTurn(undefined),
    ];

    expect(aggregateWeakPhonemes(turns)).toEqual([]);
  });

  it('userターンが無ければ空配列を返す', () => {
    expect(aggregateWeakPhonemes([])).toEqual([]);
  });
});

describe('buildPronunciationComments', () => {
  it('辞書にある音素はdisplayName・advice・例語を含むコメントにする', () => {
    const turns: Turn[] = [makeUserTurn([makeWeakPhoneme('R', 40, ['right', 'work'])])];

    const comments = buildPronunciationComments(turns, ADVICE_DICT);

    expect(comments).toEqual(['rの音: 舌先をどこにも付けずに出します。（例: right、work）']);
  });

  it('辞書に無い音素は記号と例語のみでコツ文を付けない', () => {
    const turns: Turn[] = [makeUserTurn([makeWeakPhoneme('Z', 30, ['zoo'])])];

    const comments = buildPronunciationComments(turns, ADVICE_DICT);

    expect(comments).toEqual(['Zの音（例: zoo）']);
  });

  it('例語が無ければ（例:...)を付けない', () => {
    const turns: Turn[] = [makeUserTurn([makeWeakPhoneme('R', 40, [])])];

    const comments = buildPronunciationComments(turns, ADVICE_DICT);

    expect(comments).toEqual(['rの音: 舌先をどこにも付けずに出します。']);
  });

  it('最大3件に絞り、例語は最大2件に絞る', () => {
    const turns: Turn[] = [
      makeUserTurn([
        makeWeakPhoneme('TH', 10, ['a', 'b', 'c']),
        makeWeakPhoneme('R', 20, ['d', 'e', 'f']),
        makeWeakPhoneme('S', 30, ['g']),
        makeWeakPhoneme('L', 40, ['h']),
      ]),
    ];

    const comments = buildPronunciationComments(turns, ADVICE_DICT);

    expect(comments).toHaveLength(3);
    expect(comments[0]).toContain('a、b');
    expect(comments[0]).not.toContain('c');
  });

  it('対象ターンが無ければ空配列を返す', () => {
    expect(buildPronunciationComments([], ADVICE_DICT)).toEqual([]);
  });
});
