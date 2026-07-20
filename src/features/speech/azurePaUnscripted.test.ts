import { describe, expect, it, vi } from 'vitest';
import {
  AzurePronunciationAuthError,
  AzurePronunciationNetworkError,
  AzurePronunciationNoResultError,
  AzurePronunciationTimeoutError,
  AzureSpeechKeyMissingError,
  aggregatePhraseAssessments,
  computeWeakPhonemes,
  describeAzureError,
  makeFailurePaResult,
  normalizePhonemeKey,
  resolveRecognitionOutcome,
  shouldSkipProsody,
  toPhraseAssessment,
  truncateDetail,
  type AzureDetailResultLike,
  type PhonemeScoreEntry,
  type PhraseAssessment,
} from './azurePaUnscripted';

function makeDetail(overrides: Partial<AzureDetailResultLike> = {}): AzureDetailResultLike {
  return {
    Words: [
      { Word: 'hello', PronunciationAssessment: { AccuracyScore: 90, ErrorType: 'None' } },
      { Word: 'world', PronunciationAssessment: { AccuracyScore: 70, ErrorType: 'Mispronunciation' } },
    ],
    PronunciationAssessment: {
      AccuracyScore: 80,
      FluencyScore: 85,
      CompletenessScore: 100,
      PronScore: 82,
      ProsodyScore: 75,
    },
    ...overrides,
  };
}

function makePhrase(overrides: Partial<PhraseAssessment> = {}): PhraseAssessment {
  return {
    durationTicks: 10_000_000, // 1秒相当(100ns単位)
    text: 'hello world',
    pronScore: 80,
    accuracyScore: 80,
    fluencyScore: 80,
    completenessScore: 80,
    prosodyScore: 80,
    words: [],
    phonemeScores: [],
    ...overrides,
  };
}

/**
 * Microsoft Learn「Use pronunciation assessment」記載のJSONサンプルを参考にした、
 * Phoneme granularity有効時の語ぶんのフィクスチャ。実際のAzure応答ではPhoneme値は
 * SAPI表記（既定・ARPAbet相当の大文字）で返る前提（実装ファイル冒頭コメント参照）。
 */
function makeSampleDetailWithPhonemes(): AzureDetailResultLike {
  return {
    Words: [
      {
        Word: 'think',
        PronunciationAssessment: { AccuracyScore: 55, ErrorType: 'Mispronunciation' },
        Phonemes: [
          { Phoneme: 'TH', PronunciationAssessment: { AccuracyScore: 40 } },
          { Phoneme: 'IH1', PronunciationAssessment: { AccuracyScore: 80 } },
          { Phoneme: 'NG', PronunciationAssessment: { AccuracyScore: 90 } },
          { Phoneme: 'K', PronunciationAssessment: { AccuracyScore: 95 } },
        ],
      },
      {
        Word: 'about',
        PronunciationAssessment: { AccuracyScore: 100, ErrorType: 'None' },
        Phonemes: [
          { Phoneme: 'AH0', PronunciationAssessment: { AccuracyScore: 100 } },
          { Phoneme: 'B', PronunciationAssessment: { AccuracyScore: 100 } },
          { Phoneme: 'AW1', PronunciationAssessment: { AccuracyScore: 100 } },
          { Phoneme: 'T', PronunciationAssessment: { AccuracyScore: 100 } },
        ],
      },
    ],
    PronunciationAssessment: {
      AccuracyScore: 78,
      FluencyScore: 65,
      CompletenessScore: 100,
      PronScore: 70,
      ProsodyScore: 60,
    },
  };
}

describe('toPhraseAssessment', () => {
  it('detailResultをPhraseAssessmentへ変換する（認識テキスト付き）', () => {
    const result = toPhraseAssessment(makeDetail(), 20_000_000, 'Hello world.');
    expect(result).toEqual({
      durationTicks: 20_000_000,
      text: 'Hello world.',
      pronScore: 82,
      accuracyScore: 80,
      fluencyScore: 85,
      completenessScore: 100,
      prosodyScore: 75,
      words: [
        { word: 'hello', accuracyScore: 90, errorType: 'None' },
        { word: 'world', accuracyScore: 70, errorType: 'Mispronunciation' },
      ],
      phonemeScores: [],
    });
  });

  it('PronunciationAssessmentが欠けている場合は0を既定値にする', () => {
    const result = toPhraseAssessment({}, 1000, '');
    expect(result.pronScore).toBe(0);
    expect(result.accuracyScore).toBe(0);
    expect(result.fluencyScore).toBe(0);
    expect(result.completenessScore).toBe(0);
    expect(result.prosodyScore).toBe(0);
    expect(result.words).toEqual([]);
    expect(result.phonemeScores).toEqual([]);
  });

  it('負のdurationは0にクリップする', () => {
    const result = toPhraseAssessment(makeDetail(), -5, 'x');
    expect(result.durationTicks).toBe(0);
  });

  it("単語ごとのPronunciationAssessmentが無い場合はaccuracyScore 0・errorType 'None'にする（PaResultのerrorTypeは必須のstring）", () => {
    const result = toPhraseAssessment({ Words: [{ Word: 'foo' }] }, 100, 'foo');
    expect(result.words).toEqual([{ word: 'foo', accuracyScore: 0, errorType: 'None' }]);
  });

  it('Words[].Phonemesを大文字ARPAbetキーに正規化してphonemeScoresへ集める', () => {
    const result = toPhraseAssessment(makeSampleDetailWithPhonemes(), 1000, 'think about');
    expect(result.phonemeScores).toEqual([
      { phoneme: 'TH', accuracyScore: 40, word: 'think' },
      { phoneme: 'IH', accuracyScore: 80, word: 'think' }, // "IH1" -> 強勢番号を除去
      { phoneme: 'NG', accuracyScore: 90, word: 'think' },
      { phoneme: 'K', accuracyScore: 95, word: 'think' },
      { phoneme: 'AH', accuracyScore: 100, word: 'about' },
      { phoneme: 'B', accuracyScore: 100, word: 'about' },
      { phoneme: 'AW', accuracyScore: 100, word: 'about' },
      { phoneme: 'T', accuracyScore: 100, word: 'about' },
    ]);
  });

  it('Phoneme値やAccuracyScoreが欠けている音素は除外する', () => {
    const detail: AzureDetailResultLike = {
      Words: [
        {
          Word: 'x',
          Phonemes: [
            { Phoneme: '', PronunciationAssessment: { AccuracyScore: 50 } },
            { Phoneme: 'S' },
            { Phoneme: 'Z', PronunciationAssessment: { AccuracyScore: 60 } },
          ],
        },
      ],
    };
    const result = toPhraseAssessment(detail, 1000, 'x');
    expect(result.phonemeScores).toEqual([{ phoneme: 'Z', accuracyScore: 60, word: 'x' }]);
  });
});

describe('normalizePhonemeKey', () => {
  it('大文字化する', () => {
    expect(normalizePhonemeKey('r')).toBe('R');
  });

  it('末尾の強勢番号（0/1/2）を取り除く', () => {
    expect(normalizePhonemeKey('AH0')).toBe('AH');
    expect(normalizePhonemeKey('IH1')).toBe('IH');
    expect(normalizePhonemeKey('AW2')).toBe('AW');
  });

  it('強勢番号の無い子音はそのまま', () => {
    expect(normalizePhonemeKey('TH')).toBe('TH');
  });

  it('前後の空白を除く', () => {
    expect(normalizePhonemeKey('  R  ')).toBe('R');
  });
});

describe('computeWeakPhonemes', () => {
  function entry(phoneme: string, accuracyScore: number, word: string): PhonemeScoreEntry {
    return { phoneme, accuracyScore, word };
  }

  it('同一音素の複数出現は平均スコアに集約する', () => {
    const result = computeWeakPhonemes([entry('R', 40, 'red'), entry('R', 60, 'run')]);
    expect(result).toEqual([{ phoneme: 'R', avgScore: 50, examples: ['red', 'run'] }]);
  });

  it('平均スコアが低い順（苦手順）に並べ、上位limit件に絞る', () => {
    const result = computeWeakPhonemes(
      [entry('R', 40, 'red'), entry('TH', 70, 'think'), entry('AE', 90, 'cat'), entry('S', 20, 'sun')],
      2,
    );
    expect(result.map((r) => r.phoneme)).toEqual(['S', 'R']);
  });

  it('既定は上位3件（DESIGN.md §6a: weakPhonemes上位3件）', () => {
    const result = computeWeakPhonemes([
      entry('R', 40, 'red'),
      entry('TH', 70, 'think'),
      entry('AE', 90, 'cat'),
      entry('S', 20, 'sun'),
    ]);
    expect(result.map((r) => r.phoneme)).toEqual(['S', 'R', 'TH']);
  });

  it('例語はスコアが低い出現を優先し、重複語を除いて最大exampleLimit件にする', () => {
    const result = computeWeakPhonemes([
      entry('R', 80, 'red'),
      entry('R', 20, 'run'),
      entry('R', 20, 'run'), // 同じ語の重複出現は1件にまとめる
      entry('R', 50, 'rain'),
    ]);
    expect(result[0].examples).toEqual(['run', 'rain']);
  });

  it('データが無ければ空配列', () => {
    expect(computeWeakPhonemes([])).toEqual([]);
  });

  it('exampleLimit引数で例語件数を変えられる', () => {
    const result = computeWeakPhonemes([entry('R', 40, 'red'), entry('R', 30, 'run'), entry('R', 20, 'rain')], 3, 1);
    expect(result[0].examples).toHaveLength(1);
  });
});

describe('aggregatePhraseAssessments', () => {
  const unscripted = { mode: 'unscripted', usedProsody: true } as const;

  it('フレーズが0件ならnullを返す', () => {
    expect(aggregatePhraseAssessments([], unscripted)).toBeNull();
  });

  it('1件だけならそのままの値になる', () => {
    const result = aggregatePhraseAssessments([makePhrase({ pronScore: 77 })], unscripted);
    expect(result?.pa.pronScore).toBe(77);
  });

  it('modeがPaResultにそのまま入る', () => {
    expect(aggregatePhraseAssessments([makePhrase()], unscripted)?.pa.mode).toBe('unscripted');
    expect(
      aggregatePhraseAssessments([makePhrase()], { mode: 'scripted', usedProsody: true })?.pa.mode,
    ).toBe('scripted');
  });

  it('音声長で加重平均する（長い方の影響が大きい）', () => {
    const short = makePhrase({ durationTicks: 1000, pronScore: 100 });
    const long = makePhrase({ durationTicks: 9000, pronScore: 0 });
    const result = aggregatePhraseAssessments([short, long], unscripted);
    // (100*1000 + 0*9000) / 10000 = 10
    expect(result?.pa.pronScore).toBe(10);
  });

  it('durationが全て0のときは等重み（単純平均）にフォールバックする', () => {
    const a = makePhrase({ durationTicks: 0, pronScore: 60 });
    const b = makePhrase({ durationTicks: 0, pronScore: 80 });
    const result = aggregatePhraseAssessments([a, b], unscripted);
    expect(result?.pa.pronScore).toBe(70);
  });

  it('全フレーズのwordsを結合する', () => {
    const a = makePhrase({ words: [{ word: 'a', accuracyScore: 90, errorType: 'None' }] });
    const b = makePhrase({ words: [{ word: 'b', accuracyScore: 50, errorType: 'Omission' }] });
    const result = aggregatePhraseAssessments([a, b], unscripted);
    expect(result?.pa.words).toEqual([
      { word: 'a', accuracyScore: 90, errorType: 'None' },
      { word: 'b', accuracyScore: 50, errorType: 'Omission' },
    ]);
  });

  it('認識テキストは複数フレーズをスペースで連結する（DESIGN.md §6a）', () => {
    const a = makePhrase({ text: 'I went to Kyoto.' });
    const b = makePhrase({ text: 'It was great.' });
    const result = aggregatePhraseAssessments([a, b], unscripted);
    expect(result?.recognizedText).toBe('I went to Kyoto. It was great.');
  });

  it('空テキストのフレーズは連結から除外する（余分なスペースを作らない）', () => {
    const a = makePhrase({ text: 'Hello.' });
    const b = makePhrase({ text: '  ' });
    const c = makePhrase({ text: 'Bye.' });
    const result = aggregatePhraseAssessments([a, b, c], unscripted);
    expect(result?.recognizedText).toBe('Hello. Bye.');
  });

  it('pron/accuracy/fluencyは各項目独立して加重平均する', () => {
    const a = makePhrase({ durationTicks: 1, pronScore: 10, accuracyScore: 20, fluencyScore: 30 });
    const result = aggregatePhraseAssessments([a], unscripted);
    expect(result?.pa).toMatchObject({ pronScore: 10, accuracyScore: 20, fluencyScore: 30 });
  });

  it('usedProsody=trueならprosodyScoreを加重平均で入れる', () => {
    const a = makePhrase({ durationTicks: 1000, prosodyScore: 100 });
    const b = makePhrase({ durationTicks: 3000, prosodyScore: 60 });
    const result = aggregatePhraseAssessments([a, b], unscripted);
    // (100*1000 + 60*3000) / 4000 = 70
    expect(result?.pa.prosodyScore).toBe(70);
  });

  it('usedProsody=false（韻律なしフォールバック）ならprosodyScoreはundefined', () => {
    const result = aggregatePhraseAssessments([makePhrase({ prosodyScore: 80 })], {
      mode: 'unscripted',
      usedProsody: false,
    });
    expect(result?.pa.prosodyScore).toBeUndefined();
  });

  it('unscriptedではcompletenessScoreはundefined（DESIGN.md §3: scriptedのみ）', () => {
    const result = aggregatePhraseAssessments([makePhrase({ completenessScore: 100 })], unscripted);
    expect(result?.pa.completenessScore).toBeUndefined();
  });

  it('scriptedではcompletenessScoreを加重平均で入れる', () => {
    const a = makePhrase({ durationTicks: 1000, completenessScore: 100 });
    const b = makePhrase({ durationTicks: 1000, completenessScore: 50 });
    const result = aggregatePhraseAssessments([a, b], { mode: 'scripted', usedProsody: true });
    expect(result?.pa.completenessScore).toBe(75);
  });

  it('全フレーズのphonemeScoresを合わせて低スコア音素トップ3をweakPhonemesに入れる', () => {
    const a = makePhrase({ phonemeScores: [{ phoneme: 'R', accuracyScore: 30, word: 'red' }] });
    const b = makePhrase({ phonemeScores: [{ phoneme: 'TH', accuracyScore: 50, word: 'think' }] });
    const result = aggregatePhraseAssessments([a, b], unscripted);
    expect(result?.pa.weakPhonemes?.map((w) => w.phoneme)).toEqual(['R', 'TH']);
  });

  it('どのフレーズにも音素データが無ければweakPhonemesはundefined', () => {
    const result = aggregatePhraseAssessments([makePhrase(), makePhrase()], unscripted);
    expect(result?.pa.weakPhonemes).toBeUndefined();
  });

  it('成功時はazureErrorを持たない', () => {
    const result = aggregatePhraseAssessments([makePhrase()], unscripted);
    expect(result?.pa.azureError).toBeUndefined();
  });
});

describe('describeAzureError', () => {
  it('AzurePronunciationTimeoutErrorのメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzurePronunciationTimeoutError())).toBe('発音スコアの取得がタイムアウトしました。');
  });

  it('AzurePronunciationNoResultErrorのメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzurePronunciationNoResultError())).toContain('認識結果が得られませんでした');
  });

  it('AzurePronunciationAuthErrorのメッセージをそのまま返す(キー無効/401系)', () => {
    expect(describeAzureError(new AzurePronunciationAuthError())).toContain('APIキーが無効です');
  });

  it('AzurePronunciationNetworkErrorのメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzurePronunciationNetworkError('offline'))).toContain('接続に失敗しました');
  });

  it('AzureSpeechKeyMissingError（キー未設定）のメッセージをそのまま返す', () => {
    expect(describeAzureError(new AzureSpeechKeyMissingError())).toContain('APIキーが設定されていません');
  });

  it('未知のErrorは一行の日本語メッセージに包む', () => {
    const message = describeAzureError(new Error('boom'));
    expect(message).toBe('発音スコアの取得に失敗しました: boom');
  });

  it('Error以外（文字列等）が投げられても壊れない', () => {
    const message = describeAzureError('plain string error');
    expect(message).toBe('発音スコアの取得に失敗しました: plain string error');
  });

  it('長いエラー詳細は120字に切り詰めて含める（DESIGN.md §6a: errorDetails先頭120字）', () => {
    const longDetail = 'x'.repeat(200);
    const message = describeAzureError(new Error(longDetail));
    // 「発音スコアの取得に失敗しました: 」+ 120字 + '…'
    expect(message.startsWith('発音スコアの取得に失敗しました: ')).toBe(true);
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(150);
  });

  it('AzurePronunciationNetworkErrorの詳細も切り詰められる（メッセージが長すぎて1行表示を壊さないように）', () => {
    const longDetail = 'y'.repeat(300);
    const err = new AzurePronunciationNetworkError(longDetail);
    expect(err.message).toContain('…');
    expect(err.message.length).toBeLessThan(200);
  });
});

describe('makeFailurePaResult', () => {
  it('mode・空スコア・azureError入りのPaResultを作る（会話継続用）', () => {
    const pa = makeFailurePaResult('unscripted', new AzurePronunciationTimeoutError());
    expect(pa).toEqual({
      mode: 'unscripted',
      pronScore: 0,
      accuracyScore: 0,
      fluencyScore: 0,
      words: [],
      azureError: '発音スコアの取得がタイムアウトしました。',
    });
  });

  it('scriptedモードも保持する', () => {
    const pa = makeFailurePaResult('scripted', new Error('boom'));
    expect(pa.mode).toBe('scripted');
    expect(pa.azureError).toBe('発音スコアの取得に失敗しました: boom');
  });

  it('azureErrorは120字程度に収まる（一行表示を壊さない）', () => {
    const pa = makeFailurePaResult('unscripted', new Error('z'.repeat(500)));
    expect(pa.azureError).toBeDefined();
    expect(pa.azureError!.length).toBeLessThan(150);
  });
});

describe('resolveRecognitionOutcome', () => {
  // iOS Safari(WebKit)のSDK後片付けバグで実際に観測されたエラー文言。
  const teardownError = new Error(
    "undefined is not an object (evaluating 'this.privSource.turnOff().then')",
  );

  it('フレーズ1件以上・エラーなしなら、そのままフレーズを返す', () => {
    const phrases = [makePhrase()];
    expect(resolveRecognitionOutcome(phrases, null)).toBe(phrases);
  });

  it('フレーズ1件以上なら、後片付け例外が記録されていても成功として返す（iOS Safari対策）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const phrases = [makePhrase({ pronScore: 88 })];
      const result = resolveRecognitionOutcome(phrases, teardownError);
      expect(result).toBe(phrases);
      // 無視したエラーはconsole.warnに残す
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][1]).toBe(teardownError);
    } finally {
      warn.mockRestore();
    }
  });

  it('フレーズ0件・エラーありなら、そのエラーを投げる（別原因の切り分け用）', () => {
    expect(() => resolveRecognitionOutcome([], teardownError)).toThrow(teardownError);
  });

  it('フレーズ0件・エラーありのとき、Azure固有エラー型もそのまま投げる', () => {
    const authError = new AzurePronunciationAuthError();
    expect(() => resolveRecognitionOutcome([], authError)).toThrow(authError);
  });

  it('フレーズ0件・エラーなしなら空配列を返す（呼び出し側が結果ゼロとして扱う）', () => {
    expect(resolveRecognitionOutcome([], null)).toEqual([]);
  });
});

describe('truncateDetail', () => {
  it('maxLength以下ならそのまま返す', () => {
    expect(truncateDetail('short text')).toBe('short text');
  });

  it('前後の空白を取り除く', () => {
    expect(truncateDetail('  short text  ')).toBe('short text');
  });

  it('既定(120字)を超える場合は120字+…に切り詰める', () => {
    const detail = 'a'.repeat(150);
    const result = truncateDetail(detail);
    expect(result).toBe(`${'a'.repeat(120)}…`);
  });

  it('maxLength引数で切り詰め長を指定できる', () => {
    expect(truncateDetail('abcdefghij', 5)).toBe('abcde…');
  });

  it('ちょうどmaxLengthの長さなら…を付けない', () => {
    const detail = 'a'.repeat(120);
    expect(truncateDetail(detail)).toBe(detail);
  });
});

describe('shouldSkipProsody', () => {
  const REGION = 'japaneast';
  const TODAY = '2026-07-20';

  it('regionとdateが両方一致すればtrue（韻律なしで直行してよい）', () => {
    expect(shouldSkipProsody({ region: REGION, date: TODAY }, REGION, TODAY)).toBe(true);
  });

  it('dateが違えばfalse（日替わりで再プローブする）', () => {
    expect(shouldSkipProsody({ region: REGION, date: '2026-07-19' }, REGION, TODAY)).toBe(false);
  });

  it('regionが違えばfalse（リージョン変更で自然に再プローブする）', () => {
    expect(shouldSkipProsody({ region: 'eastus', date: TODAY }, REGION, TODAY)).toBe(false);
  });

  it('undefined・null・文字列・数値・フィールド欠落オブジェクトはfalse（appState破損耐性）', () => {
    expect(shouldSkipProsody(undefined, REGION, TODAY)).toBe(false);
    expect(shouldSkipProsody(null, REGION, TODAY)).toBe(false);
    expect(shouldSkipProsody('japaneast', REGION, TODAY)).toBe(false);
    expect(shouldSkipProsody(42, REGION, TODAY)).toBe(false);
    expect(shouldSkipProsody({}, REGION, TODAY)).toBe(false);
    expect(shouldSkipProsody({ region: REGION }, REGION, TODAY)).toBe(false);
    expect(shouldSkipProsody({ date: TODAY }, REGION, TODAY)).toBe(false);
  });
});
