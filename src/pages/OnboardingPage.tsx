/**
 * オンボーディング診断（DESIGN.md §2「タブ外フルスクリーン: オンボーディング診断」・§8a・M6）。
 *
 * フロー: ようこそ → 興味タグ選択 → キー設定確認 → 診断3問（各: 指示表示→録音→PA→次へ）
 *   → Sonnet採点 → 結果表示 → userProfile保存(level・diagnostic・levelHistory)
 *   → appState 'onboardingDone'=true → ホームへ。
 *
 * 録音まわり（useRecorderベースのMicButton→decodeToMono16k→encodeWavPcm16→assessSpeech）は
 * useConversation.tsを使わずこの画面で直接組む（M6の担当範囲・useConversation.ts/TalkPage.tsxは編集禁止）。
 * 全ステップで「戻る」と「スキップ（レベル2のままonboardingDone=trueにして終了）」ができる。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MicButton } from '../features/conversation/MicButton';
import type { RecordingResult } from '../features/recorder/useRecorder';
import { DIAGNOSTIC_QUESTIONS } from '../features/diagnostic/diagnosticQuestions';
import { scoreDiagnostic, type DiagnosticAnswer, type DiagnosticScore } from '../features/diagnostic/sonnetDiagnostic';
import { getAnthropicApiKey } from '../features/settings/anthropicKeyConfig';
import { assessSpeech } from '../features/speech/azurePaUnscripted';
import { getAzureSpeechKey } from '../features/speech/azureSpeechConfig';
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from '../lib/audio';
import { addUsage, getAppState, getUsageDay, getUserProfile, putUserProfile, setAppState } from '../lib/db';
import { learningDate } from '../lib/dates';
import { canRunPa } from '../lib/usage/caps';
import { DEFAULT_DAILY_CAPS, type DailyCaps, type ScenarioCategory, type UserProfile } from '../lib/types';
import { createWakeLockController } from '../lib/wakeLock';
import { encodeWavPcm16 } from '../lib/wav';

type Step = 'welcome' | 'interests' | 'keys' | 'diagnostic' | 'scoring' | 'result';

interface InterestCategoryOption {
  id: ScenarioCategory;
  labelJa: string;
}

/** 興味タグの8カテゴリ（DESIGN.md §3 ScenarioCategoryをそのまま流用）。 */
const INTEREST_CATEGORIES: InterestCategoryOption[] = [
  { id: 'travel', labelJa: '旅行' },
  { id: 'restaurant', labelJa: 'レストラン・食事' },
  { id: 'work', labelJa: '仕事' },
  { id: 'daily', labelJa: '日常生活' },
  { id: 'interview', labelJa: '面接' },
  { id: 'shopping', labelJa: '買い物' },
  { id: 'health', labelJa: '健康' },
  { id: 'social', labelJa: '交流・雑談' },
];

interface AnswerPreview {
  transcript: string;
  pronScore?: number;
}

export function OnboardingPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('welcome');
  const [pageError, setPageError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);

  // --- 興味タグ ---
  const [selectedTags, setSelectedTags] = useState<Set<ScenarioCategory>>(new Set());
  const [customInterestInput, setCustomInterestInput] = useState('');
  const [customInterests, setCustomInterests] = useState<string[]>([]);

  // --- キー設定確認 ---
  const [checkingKeys, setCheckingKeys] = useState(false);
  const [azureConfigured, setAzureConfigured] = useState<boolean | null>(null);
  const [anthropicConfigured, setAnthropicConfigured] = useState<boolean | null>(null);

  // --- 診断3問 ---
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<DiagnosticAnswer[]>([]);
  const [answerPreview, setAnswerPreview] = useState<AnswerPreview | null>(null);
  const [processingAnswer, setProcessingAnswer] = useState(false);

  // --- 採点・結果 ---
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosticScore | null>(null);

  const wakeLockRef = useRef(createWakeLockController());
  useEffect(() => {
    const wakeLock = wakeLockRef.current;
    return () => wakeLock.dispose();
  }, []);

  useEffect(() => {
    if (step !== 'keys') return;
    let cancelled = false;
    setCheckingKeys(true);
    void Promise.all([getAzureSpeechKey(), getAnthropicApiKey()]).then(([azureKey, anthropicKey]) => {
      if (cancelled) return;
      setAzureConfigured(Boolean(azureKey));
      setAnthropicConfigured(Boolean(anthropicKey));
      setCheckingKeys(false);
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const currentInterests = (): string[] => [...selectedTags, ...customInterests];

  const toggleTag = (id: ScenarioCategory) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const addCustomInterest = () => {
    const trimmed = customInterestInput.trim();
    if (!trimmed) return;
    setCustomInterests((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setCustomInterestInput('');
  };

  const removeCustomInterest = (value: string) => {
    setCustomInterests((prev) => prev.filter((v) => v !== value));
  };

  /** 「スキップ」: レベルは変更せず（新規プロファイルはlevel:2のまま）、興味タグだけ保存して終える。 */
  const handleSkip = async () => {
    if (skipping) return;
    setSkipping(true);
    setPageError(null);
    try {
      const profile = await getUserProfile();
      const updated: UserProfile = { ...profile, interests: currentInterests() };
      await putUserProfile(updated);
      await setAppState('onboardingDone', true);
      navigate('/');
    } catch (e: unknown) {
      setPageError(e instanceof Error ? e.message : '保存に失敗しました。');
    } finally {
      setSkipping(false);
    }
  };

  const goToQuestion = (index: number) => {
    setQuestionIndex(index);
    const existing = answers[index];
    setAnswerPreview(existing ? { transcript: existing.transcript, pronScore: existing.pa?.pronScore } : null);
    setPageError(null);
  };

  const startDiagnostic = () => {
    setAnswers([]);
    setPageError(null);
    goToQuestion(0);
    setStep('diagnostic');
  };

  const handleDiagnosticBack = () => {
    if (questionIndex === 0) {
      setStep('keys');
      return;
    }
    goToQuestion(questionIndex - 1);
  };

  /** 録音開始（MicButtonのonRecordStart）。iOSでの画面ロック対策にWake Lockを取得する（DESIGN.md §5）。 */
  const handleRecordStart = () => {
    void wakeLockRef.current.acquire();
  };

  /** 録音停止後の1問ぶんの処理: WAV変換→PA日次キャップ判定→unscripted発音評価（DESIGN.md §5, §8a）。 */
  const handleRecordResult = async (recording: RecordingResult) => {
    setProcessingAnswer(true);
    setPageError(null);
    try {
      const today = learningDate(new Date());
      const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
      const usage = await getUsageDay(today);
      if (!canRunPa(usage, caps)) {
        setPageError('今日の発音評価の上限に達しました（設定で変更できます）。');
        return;
      }

      const pcm = await decodeToMono16k(recording.blob);
      const wavBlob = new Blob([encodeWavPcm16(pcm)], { type: 'audio/wav' });
      const assessment = await assessSpeech(wavBlob, { mode: 'unscripted' });
      await addUsage(today, { paSeconds: Math.round(pcm.length / WHISPER_SAMPLE_RATE) });

      if (!assessment.recognizedText.trim()) {
        setPageError(
          assessment.pa.azureError
            ? `発音評価でエラーが発生しました: ${assessment.pa.azureError}`
            : '聞き取れませんでした。もう一度はっきり話してみてください。',
        );
        return;
      }

      const question = DIAGNOSTIC_QUESTIONS[questionIndex];
      const answer: DiagnosticAnswer = {
        question: question.instructionEn,
        transcript: assessment.recognizedText,
        pa: assessment.pa,
      };
      setAnswers((prev) => {
        const next = [...prev];
        next[questionIndex] = answer;
        return next;
      });
      setAnswerPreview({ transcript: assessment.recognizedText, pronScore: assessment.pa.pronScore });
    } catch (e: unknown) {
      setPageError(e instanceof Error ? e.message : '音声の処理に失敗しました。');
    } finally {
      setProcessingAnswer(false);
      wakeLockRef.current.release();
    }
  };

  /** 採点結果に基づいてuserProfileへ保存する（DESIGN.md §8a・levelHistory('diagnostic')）。 */
  const finalizeWithDiagnostic = async (score: DiagnosticScore) => {
    const today = learningDate(new Date());
    const profile = await getUserProfile();
    const updated: UserProfile = {
      ...profile,
      level: score.level,
      interests: currentInterests(),
      diagnostic: { date: today, cefr: score.cefr, comment: score.commentJa },
      levelHistory: [...profile.levelHistory, { date: today, level: score.level, reason: 'diagnostic' }],
    };
    await putUserProfile(updated);
    await setAppState('onboardingDone', true);
  };

  const handleScore = async () => {
    setStep('scoring');
    setScoreError(null);
    const finalAnswers: DiagnosticAnswer[] = DIAGNOSTIC_QUESTIONS.map(
      (q, i) => answers[i] ?? { question: q.instructionEn, transcript: '' },
    );
    const scored = await scoreDiagnostic(finalAnswers);
    if ('error' in scored) {
      setScoreError(scored.error);
      return;
    }
    try {
      await finalizeWithDiagnostic(scored);
      setResult(scored);
      setStep('result');
    } catch (e: unknown) {
      setScoreError(e instanceof Error ? e.message : '結果の保存に失敗しました。');
    }
  };

  const handleDiagnosticNext = () => {
    if (questionIndex < DIAGNOSTIC_QUESTIONS.length - 1) {
      goToQuestion(questionIndex + 1);
      return;
    }
    void handleScore();
  };

  const question = DIAGNOSTIC_QUESTIONS[questionIndex];
  const showFooterSkip = step === 'welcome' || step === 'interests' || step === 'keys' || step === 'diagnostic';
  const bothKeysConfigured = azureConfigured === true && anthropicConfigured === true;

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white">
      <header className="border-b border-neutral-200 px-4 py-3">
        <h1 className="text-lg font-bold text-neutral-800">はじめまして！</h1>
        <p className="mt-0.5 text-xs text-neutral-400">
          {step === 'welcome' && 'ようこそ'}
          {step === 'interests' && '興味のあるジャンルを教えてください'}
          {step === 'keys' && 'APIキーの確認'}
          {step === 'diagnostic' && `レベル診断 ${questionIndex + 1}/${DIAGNOSTIC_QUESTIONS.length}`}
          {step === 'scoring' && 'レベル診断'}
          {step === 'result' && '診断結果'}
        </p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {pageError && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{pageError}</p>
        )}

        {step === 'welcome' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-neutral-600">
              「はなとま」はAIと話しながら英会話をアウトプットで鍛える練習アプリです。
              まず簡単な設定と、5分ほどのレベル診断（任意）を行います。
            </p>
            <p className="text-sm text-neutral-600">
              診断ではAIがあなたの話す英語を聞いて、ちょうどよい難易度から練習を始められるようにします。
              APIキー未設定の場合や急いでいる場合は、あとからいつでも設定できます。
            </p>
            <button
              type="button"
              onClick={() => setStep('interests')}
              className="mt-2 w-full rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
            >
              はじめる
            </button>
          </div>
        )}

        {step === 'interests' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-neutral-600">
              興味のあるジャンルを選んでください（複数可）。シナリオのおすすめに使います。
            </p>
            <div className="flex flex-wrap gap-2">
              {INTEREST_CATEGORIES.map((cat) => {
                const active = selectedTags.has(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => toggleTag(cat.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm ${
                      active
                        ? 'border-hana-500 bg-hana-500 text-white'
                        : 'border-neutral-300 bg-white text-neutral-600'
                    }`}
                  >
                    {cat.labelJa}
                  </button>
                );
              })}
            </div>

            <label className="mt-2 flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">その他（自由入力）</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customInterestInput}
                  onChange={(e) => setCustomInterestInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustomInterest();
                    }
                  }}
                  placeholder="例: 映画、料理"
                  className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={addCustomInterest}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600"
                >
                  追加
                </button>
              </div>
            </label>

            {customInterests.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {customInterests.map((v) => (
                  <span
                    key={v}
                    className="flex items-center gap-1 rounded-full bg-hana-100 px-3 py-1 text-xs text-hana-700"
                  >
                    {v}
                    <button
                      type="button"
                      onClick={() => removeCustomInterest(v)}
                      aria-label={`${v}を削除`}
                      className="text-hana-500"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setStep('welcome')}
                className="flex-1 rounded-full border border-neutral-300 py-3 text-sm text-neutral-600"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={() => setStep('keys')}
                className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
              >
                次へ
              </button>
            </div>
          </div>
        )}

        {step === 'keys' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-neutral-600">
              レベル診断にはAzure Speech（発音の聞き取り）とAnthropic（採点AI）の両方のAPIキーが必要です。
            </p>

            {checkingKeys ? (
              <p className="text-sm text-neutral-400">確認中…</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                <li className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2">
                  <span className="text-neutral-700">Azure Speech</span>
                  <span className={azureConfigured ? 'text-green-700' : 'text-red-600'}>
                    {azureConfigured ? '✓ 設定済み' : '未設定'}
                  </span>
                </li>
                <li className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2">
                  <span className="text-neutral-700">Anthropic API</span>
                  <span className={anthropicConfigured ? 'text-green-700' : 'text-red-600'}>
                    {anthropicConfigured ? '✓ 設定済み' : '未設定'}
                  </span>
                </li>
              </ul>
            )}

            {!checkingKeys && !bothKeysConfigured && (
              <div className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                未設定のキーがあるため、レベル診断はスキップされます。設定画面でキーを登録すると、あとから
                「設定」タブの手順でいつでも診断をやり直せます。
              </div>
            )}

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setStep('interests')}
                className="flex-1 rounded-full border border-neutral-300 py-3 text-sm text-neutral-600"
              >
                戻る
              </button>
              {bothKeysConfigured ? (
                <button
                  type="button"
                  onClick={startDiagnostic}
                  className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
                >
                  診断へ進む
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/settings')}
                  disabled={checkingKeys}
                  className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white disabled:opacity-50"
                >
                  設定画面へ
                </button>
              )}
            </div>
          </div>
        )}

        {step === 'diagnostic' && (
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-hana-200 bg-hana-50 p-4">
              <p className="whitespace-pre-line text-sm text-neutral-800">{question.instructionJa}</p>
              <p className="mt-1 text-xs text-neutral-400">
                目安: {question.minSeconds}〜{question.maxSeconds}秒
              </p>
            </div>

            <div className="flex flex-col items-center gap-2 py-2">
              <MicButton
                disabled={processingAnswer}
                onRecordStart={handleRecordStart}
                onResult={(recording) => void handleRecordResult(recording)}
              />
              {processingAnswer && <p className="text-xs text-neutral-400">聞き取り中…</p>}
            </div>

            {answerPreview && (
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
                <p className="text-xs font-semibold text-neutral-500">認識結果</p>
                <p className="mt-1 text-neutral-700">{answerPreview.transcript}</p>
                {answerPreview.pronScore !== undefined && (
                  <p className="mt-1 text-xs text-neutral-400">
                    発音スコア: {Math.round(answerPreview.pronScore)}/100
                  </p>
                )}
                <p className="mt-1 text-xs text-neutral-400">やり直したい場合はもう一度録音してください。</p>
              </div>
            )}

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={handleDiagnosticBack}
                disabled={processingAnswer}
                className="flex-1 rounded-full border border-neutral-300 py-3 text-sm text-neutral-600 disabled:opacity-50"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={handleDiagnosticNext}
                disabled={processingAnswer || !answerPreview}
                className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {questionIndex < DIAGNOSTIC_QUESTIONS.length - 1 ? '次へ' : '診断結果を見る'}
              </button>
            </div>
          </div>
        )}

        {step === 'scoring' && (
          <div className="flex flex-col items-center gap-4 py-10">
            {scoreError ? (
              <>
                <p className="text-center text-sm text-red-600">{scoreError}</p>
                <div className="flex w-full gap-2">
                  <button
                    type="button"
                    onClick={() => void handleScore()}
                    className="flex-1 rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
                  >
                    もう一度採点する
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSkip()}
                  disabled={skipping}
                  className="text-xs text-neutral-400 underline disabled:opacity-50"
                >
                  {skipping ? '保存中…' : 'スキップしてレベル2ではじめる'}
                </button>
              </>
            ) : (
              <p className="text-sm text-neutral-500">採点中です…しばらくお待ちください。</p>
            )}
          </div>
        )}

        {step === 'result' && result && (
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl border border-hana-200 bg-hana-50 p-4 text-center">
              <p className="text-xs font-semibold text-hana-700">診断結果</p>
              <p className="mt-1 text-3xl font-bold text-neutral-800">{result.cefr}</p>
              <p className="mt-1 text-sm text-neutral-500">アプリレベル {result.level}</p>
            </div>
            <p className="text-sm text-neutral-700">{result.commentJa}</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-2 w-full rounded-full bg-hana-500 py-3 text-sm font-bold text-white active:bg-hana-600"
            >
              ホームへ
            </button>
          </div>
        )}
      </main>

      {showFooterSkip && (
        <footer className="border-t border-neutral-200 p-3">
          <button
            type="button"
            onClick={() => void handleSkip()}
            disabled={skipping || processingAnswer}
            className="w-full text-center text-xs text-neutral-400 underline disabled:opacity-50"
          >
            {skipping ? '保存中…' : 'スキップしてレベル2ではじめる'}
          </button>
        </footer>
      )}
    </div>
  );
}
