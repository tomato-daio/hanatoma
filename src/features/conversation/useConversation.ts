/**
 * 会話ループの状態機械（DESIGN.md §4, §5。アプリの心臓部）。
 *
 * 1ターンの流れ:
 *   録音停止 → WAV変換 → Azure unscripted PA（認識+発音採点） → 認識テキスト即表示
 *   → Haiku streaming（テキスト逐次表示） → 文境界ごとにTTS合成・順次再生
 *
 * 責務: フェーズ/ステップ進行・DB永続化・usageLog加算・日次キャップ判定・Wake Lock。
 * PA/TTS/LLMの各モジュールは呼ぶだけで、失敗時の分岐（PA=azureError、TTS=throw）はここで吸収する。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addUsage,
  getAppState,
  getConversation,
  getUsageDay,
  getUserProfile,
  putConversation,
} from '../../lib/db';
import { learningDate } from '../../lib/dates';
import { decodeToMono16k, WHISPER_SAMPLE_RATE } from '../../lib/audio';
import { encodeWavPcm16 } from '../../lib/wav';
import { createWakeLockController } from '../../lib/wakeLock';
import { getLevelParams } from '../../lib/level/params';
import { canRunPa } from '../../lib/usage/caps';
import {
  DEFAULT_DAILY_CAPS,
  type AppLevel,
  type Conversation,
  type ConversationMode,
  type ConversationPhase,
  type DailyCaps,
  type PaResult,
  type Scenario,
  type ScenarioStep,
  type Turn,
} from '../../lib/types';
import { assessSpeech } from '../speech/azurePaUnscripted';
import { getAnthropicApiKey } from '../settings/anthropicKeyConfig';
import { nextAiTurn } from '../llm/haikuPartner';
import type { RecordingResult } from '../recorder/useRecorder';
import { getScenarioById } from '../scenarios/loadScenarios';
import { SpeechQueue, splitSentences } from './speechQueue';

export type ConversationBusy = 'idle' | 'assessing' | 'thinking' | 'speaking';

/** 直近ターンのレイテンシ計測（DESIGN.md §5。M3の検収項目）。 */
export interface TurnLatency {
  wavMs: number;
  paMs: number;
  /** Haiku呼び出し開始→最初のテキスト到着。 */
  haikuFirstTextMs: number;
  /** ユーザー発話（録音停止）→AI音声の再生開始。 */
  totalToSpeechMs: number | null;
}

/**
 * 会話の最初のAI発話を引き出すための合成userターン。
 * Anthropic APIは最初のmessageがuserである必要があるため、実際の会話履歴の先頭に
 * 常にこれを差し込む（DBには保存しない）。
 */
const SYNTHETIC_OPENER: Turn = {
  role: 'user',
  text: '(The scene starts now. Greet me in character and begin the conversation according to the scenario.)',
  at: 0,
  phase: 'guided',
};

const DEFAULT_TTS_VOICE = 'en-US-JennyNeural';

export interface UseConversationResult {
  loading: boolean;
  scenario: Scenario | null;
  conversation: Conversation | null;
  mode: ConversationMode;
  turns: Turn[];
  phase: ConversationPhase;
  /** AIとの対話が始まっているか（lessonモードはキーフレーズ予習後にbeginDialogueで開始）。 */
  dialogueStarted: boolean;
  /** lessonモードでキーフレーズ予習を終えて対話を開始する（予習スキップ時も呼ぶ）。 */
  beginDialogue: () => Promise<void>;
  /** キーフレーズ予習の1回分（scripted発音評価）。結果を返しAIターンは起こさない。 */
  submitKeyPhrase: (phraseEn: string, recording: RecordingResult) => Promise<PaResult | null>;
  /** biteモードで1往復が済み、完了ボタンを出してよい状態。 */
  biteComplete: boolean;
  stepIndex: number;
  /** ガイドフェーズの現在ステップ（フリー会話ではnull）。 */
  currentStep: ScenarioStep | null;
  busy: ConversationBusy;
  /** ストリーミング中のAI発話（確定後はturnsに入る）。 */
  aiDraft: string;
  error: string | null;
  /** エラーではない案内（「聞き取れませんでした」等）。 */
  info: string | null;
  /** ヒント表示段階 0=非表示 1=日本語 2=英語言い出し 3=模範解答。 */
  hintLevel: 0 | 1 | 2 | 3;
  showNextHint: () => void;
  /** 模範解答を見た回数（XP計算用・M7）。 */
  modelAnswersShown: number;
  /** 録音開始時に呼ぶ（thinkingMs計測用）。 */
  markRecordStart: () => void;
  submitVoice: (recording: RecordingResult) => Promise<void>;
  submitText: (text: string) => Promise<void>;
  finish: () => Promise<Conversation | null>;
  abandon: () => Promise<void>;
  latency: TurnLatency | null;
  /** ユーザーの現在のアプリレベル（ヒント表示・TTS速度の参照用）。 */
  level: AppLevel;
}

export function useConversation(conversationId: string | undefined): UseConversationResult {
  const [loading, setLoading] = useState(true);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<ConversationPhase>('guided');
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState<ConversationBusy>('idle');
  const [aiDraft, setAiDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3>(0);
  const [modelAnswersShown, setModelAnswersShown] = useState(0);
  const [latency, setLatency] = useState<TurnLatency | null>(null);
  const [level, setLevel] = useState<AppLevel>(2);
  const [dialogueStarted, setDialogueStarted] = useState(false);

  // レンダリングに影響しない進行中データはrefで持つ
  const turnsRef = useRef<Turn[]>([]);
  const conversationRef = useRef<Conversation | null>(null);
  const phaseRef = useRef<ConversationPhase>('guided');
  const stepIndexRef = useRef(0);
  const lastAiSpokeAtRef = useRef<number | null>(null);
  const recordStartAtRef = useRef<number | null>(null);
  // runAiTurnはロード用effectから「初期レンダー時点のクロージャ」で呼ばれるため、
  // レベルはstateではなくrefから読む（stateはUI表示用）。
  const levelRef = useRef<AppLevel>(2);
  const queueRef = useRef<SpeechQueue | null>(null);
  const wakeLockRef = useRef(createWakeLockController());
  const openedRef = useRef(false);
  const processingRef = useRef(false);

  // --- 永続化ヘルパー ---
  const persist = useCallback(async (updates: Partial<Conversation>) => {
    const current = conversationRef.current;
    if (!current) return;
    const next: Conversation = { ...current, ...updates, turns: turnsRef.current };
    conversationRef.current = next;
    setConversation(next);
    await putConversation(next);
  }, []);

  const appendTurn = useCallback(
    async (turn: Turn) => {
      turnsRef.current = [...turnsRef.current, turn];
      setTurns(turnsRef.current);
      await persist({});
    },
    [persist],
  );

  // --- AI発話（Haiku streaming → 文単位TTS） ---
  const runAiTurn = useCallback(async (): Promise<void> => {
    const sc = scenario ?? (await getScenarioById(conversationRef.current?.scenarioId ?? ''));
    if (!sc) return;
    const apiKey = await getAnthropicApiKey();
    if (!apiKey) {
      setError('Anthropic APIキーが未設定です。設定画面で登録してください。');
      return;
    }

    const curPhase = phaseRef.current;
    const step = curPhase === 'guided' ? sc.steps[stepIndexRef.current] : undefined;
    const curLevel = levelRef.current;
    const ttsVoice = (await getAppState<string>('ttsVoice')) ?? DEFAULT_TTS_VOICE;
    const ttsRate = getLevelParams(curLevel).ttsRate;

    setBusy('thinking');
    setAiDraft('');

    const tStart = performance.now();
    let firstTextAt: number | null = null;
    let speechStartAt: number | null = null;
    let ttsFailed = false;

    // 前のキューが残っていれば止める
    queueRef.current?.stop();
    const queue = new SpeechQueue({
      voice: ttsVoice,
      rate: ttsRate,
      onAllDone: () => {
        lastAiSpokeAtRef.current = Date.now();
        setBusy('idle');
      },
      onError: () => {
        // TTS失敗は読み上げを諦めテキスト表示のみ（DESIGN.md §6c: synthesizeはthrowする契約）
        ttsFailed = true;
        setInfo('AI音声の再生に失敗したため、テキストのみ表示しています。');
      },
    });
    queueRef.current = queue;

    let sentenceBuffer = '';
    let fullText = '';
    try {
      const result = await nextAiTurn({
        apiKey,
        scenario: sc,
        level: curLevel,
        history: [SYNTHETIC_OPENER, ...turnsRef.current],
        phase: curPhase,
        step,
        onText: (delta) => {
          if (firstTextAt === null) firstTextAt = performance.now();
          fullText += delta;
          setAiDraft(fullText);
          sentenceBuffer += delta;
          const { complete, rest } = splitSentences(sentenceBuffer);
          sentenceBuffer = rest;
          for (const sentence of complete) {
            if (speechStartAt === null) speechStartAt = performance.now();
            queue.enqueue(sentence);
          }
        },
      });

      // 残りの断片も読み上げる
      if (sentenceBuffer.trim()) {
        if (speechStartAt === null) speechStartAt = performance.now();
        queue.enqueue(sentenceBuffer);
      }

      const aiTurn: Turn = {
        role: 'ai',
        text: result.text.trim(),
        at: Date.now(),
        phase: curPhase,
      };
      setAiDraft('');
      await appendTurn(aiTurn);

      const today = learningDate(new Date());
      await addUsage(today, {
        haikuCalls: 1,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        ttsChars: ttsFailed ? 0 : result.text.length,
      });

      setLatency((prev) => ({
        wavMs: prev?.wavMs ?? 0,
        paMs: prev?.paMs ?? 0,
        haikuFirstTextMs: firstTextAt !== null ? Math.round(firstTextAt - tStart) : -1,
        totalToSpeechMs: prev && speechStartAt !== null ? Math.round(speechStartAt - tStart + prev.wavMs + prev.paMs) : null,
      }));

      // 読み上げるものが無い（TTS失敗含む）ならこの場でidleへ
      if (!queue.busy) {
        lastAiSpokeAtRef.current = Date.now();
        setBusy('idle');
      } else {
        setBusy('speaking');
      }
    } catch (e: unknown) {
      queue.stop();
      setBusy('idle');
      setError(e instanceof Error ? e.message : 'AIの応答生成に失敗しました。');
    }
  }, [appendTurn, scenario]);

  // --- 初期ロード + AIの開幕発話 ---
  // StrictModeではeffectが「実行→cleanup→再実行」されるため、cancelledフラグ方式だと
  // 1回目の実行がキャンセルされ2回目がopenedRefガードで弾かれて永久にロード中になる。
  // openedRefの一度きりガードのみ使い、キャンセルはしない（実機で問題になった実バグの修正）。
  useEffect(() => {
    if (!conversationId || openedRef.current) return;
    openedRef.current = true;
    void (async () => {
      try {
        const conv = await getConversation(conversationId);
        if (!conv) {
          setError('会話が見つかりません。ホームからやり直してください。');
          setLoading(false);
          return;
        }
        const sc = await getScenarioById(conv.scenarioId);
        if (!sc) {
          setError('シナリオが見つかりません。');
          setLoading(false);
          return;
        }
        const profile = await getUserProfile();

        conversationRef.current = conv;
        turnsRef.current = conv.turns;
        setConversation(conv);
        setScenario(sc);
        setTurns(conv.turns);
        levelRef.current = profile.level;
        setLevel(profile.level);

        // 途中再開はさせない仕様（§4）だが、activeな既存レコードを開いた場合は続きから表示だけする。
        // ガイドステップの進行はキーフレーズ予習ターンを除いた対話ターン数で数える
        const dialogueUserTurns = conv.turns.filter(
          (t) => t.role === 'user' && t.phase !== 'keyphrase',
        ).length;
        const nextStep = Math.min(dialogueUserTurns, sc.steps.length);
        stepIndexRef.current = nextStep;
        setStepIndex(nextStep);
        // biteモードはガイドを使わず最初からフリー会話（§4: 1往復だけの最小単位）
        const startPhase: ConversationPhase =
          conv.mode === 'bite' || nextStep >= sc.steps.length ? 'free' : 'guided';
        phaseRef.current = startPhase;
        setPhase(startPhase);

        const hasDialogue = conv.turns.some((t) => t.phase !== 'keyphrase');
        dialogueStartedRef.current = hasDialogue;
        setDialogueStarted(hasDialogue);

        setLoading(false);

        // lessonモードはキーフレーズ予習が先（beginDialogue待ち）。quick/biteは即AIが話し始める
        if (!hasDialogue && conv.status === 'active' && conv.mode !== 'lesson') {
          dialogueStartedRef.current = true;
          setDialogueStarted(true);
          await runAiTurn();
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '読み込みに失敗しました。');
        setLoading(false);
      }
    })();
    // runAiTurnはref経由で最新stateを読むため依存に含めない（初回のみ実行したい）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // 画面離脱時の後始末
  useEffect(() => {
    const wakeLock = wakeLockRef.current;
    return () => {
      queueRef.current?.stop();
      wakeLock.dispose();
    };
  }, []);

  // --- ユーザー発話の共通処理（PA後/テキスト入力後） ---
  const acceptUserTurn = useCallback(
    async (turn: Turn) => {
      hintLevelRef.current = 0;
      setHintLevel(0);
      await appendTurn(turn);
      // ガイドフェーズのステップを進め、最後まで到達したらフリー会話へ
      const sc = scenario;
      if (phaseRef.current === 'guided' && sc) {
        const next = stepIndexRef.current + 1;
        if (next >= sc.steps.length) {
          phaseRef.current = 'free';
          setPhase('free');
        } else {
          stepIndexRef.current = next;
          setStepIndex(next);
        }
      }
      await runAiTurn();
    },
    [appendTurn, runAiTurn, scenario],
  );

  const submitVoice = useCallback(
    async (recording: RecordingResult) => {
      if (processingRef.current) return;
      processingRef.current = true;
      setError(null);
      setInfo(null);
      const wakeLock = wakeLockRef.current;
      await wakeLock.acquire();
      try {
        const tStop = performance.now();
        setBusy('assessing');

        // 日次キャップ（PA分数）チェック
        const today = learningDate(new Date());
        const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
        const usage = await getUsageDay(today);
        if (!canRunPa(usage, caps)) {
          setBusy('idle');
          setInfo('今日の発音評価の上限に達しました（設定で変更できます）。テキスト入力なら続けられます。');
          return;
        }

        // WAV変換
        const pcm = await decodeToMono16k(recording.blob);
        const wavBlob = new Blob([encodeWavPcm16(pcm)], { type: 'audio/wav' });
        const tWav = performance.now();

        // 発音評価（unscripted）。Azure失敗時は例外ではなくpa.azureErrorで返る契約
        const result = await assessSpeech(wavBlob, { mode: 'unscripted' });
        const tPa = performance.now();
        await addUsage(today, { paSeconds: Math.round(pcm.length / WHISPER_SAMPLE_RATE) });

        setLatency({
          wavMs: Math.round(tWav - tStop),
          paMs: Math.round(tPa - tWav),
          haikuFirstTextMs: -1,
          totalToSpeechMs: null,
        });

        if (!result.recognizedText.trim()) {
          setBusy('idle');
          setInfo(
            result.pa.azureError
              ? `発音評価でエラーが発生しました: ${result.pa.azureError}`
              : '聞き取れませんでした。もう一度はっきり話してみてください。',
          );
          return;
        }

        const saveAudio = (await getAppState<boolean>('saveTurnAudio')) ?? true;
        const thinkingMs =
          lastAiSpokeAtRef.current !== null && recordStartAtRef.current !== null
            ? Math.max(0, recordStartAtRef.current - lastAiSpokeAtRef.current)
            : undefined;

        const userTurn: Turn = {
          role: 'user',
          text: result.recognizedText,
          at: Date.now(),
          phase: phaseRef.current,
          inputMode: 'voice',
          ...(saveAudio ? { audioBlob: recording.blob, mimeType: recording.mimeType } : {}),
          pa: result.pa,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        };
        await acceptUserTurn(userTurn);
      } catch (e: unknown) {
        setBusy('idle');
        setError(e instanceof Error ? e.message : '音声の処理に失敗しました。');
      } finally {
        wakeLock.release();
        processingRef.current = false;
      }
    },
    [acceptUserTurn],
  );

  const submitText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || processingRef.current) return;
      processingRef.current = true;
      setError(null);
      setInfo(null);
      try {
        const userTurn: Turn = {
          role: 'user',
          text: trimmed,
          at: Date.now(),
          phase: phaseRef.current,
          inputMode: 'text',
        };
        await acceptUserTurn(userTurn);
      } catch (e: unknown) {
        setBusy('idle');
        setError(e instanceof Error ? e.message : '送信に失敗しました。');
      } finally {
        processingRef.current = false;
      }
    },
    [acceptUserTurn],
  );

  // hintLevelはrefでも追跡し、更新関数を純粋に保つ（StrictModeの二重実行で
  // modelAnswersShownが二重カウントされるのを防ぐ）。
  const hintLevelRef = useRef<0 | 1 | 2 | 3>(0);
  const showNextHint = useCallback(() => {
    const prev = hintLevelRef.current;
    const next = Math.min(3, prev + 1) as 0 | 1 | 2 | 3;
    if (next === 3 && prev !== 3) {
      setModelAnswersShown((n) => n + 1);
    }
    hintLevelRef.current = next;
    setHintLevel(next);
  }, []);

  const markRecordStart = useCallback(() => {
    recordStartAtRef.current = Date.now();
  }, []);

  // --- キーフレーズ予習（lessonモード。scripted発音評価・AIターンは起こさない） ---
  const submitKeyPhrase = useCallback(
    async (phraseEn: string, recording: RecordingResult): Promise<PaResult | null> => {
      if (processingRef.current) return null;
      processingRef.current = true;
      setError(null);
      setInfo(null);
      const wakeLock = wakeLockRef.current;
      await wakeLock.acquire();
      try {
        setBusy('assessing');
        const today = learningDate(new Date());
        const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
        const usage = await getUsageDay(today);
        if (!canRunPa(usage, caps)) {
          setInfo('今日の発音評価の上限に達しました（設定で変更できます）。');
          return null;
        }
        const pcm = await decodeToMono16k(recording.blob);
        const wavBlob = new Blob([encodeWavPcm16(pcm)], { type: 'audio/wav' });
        const result = await assessSpeech(wavBlob, { mode: 'scripted', referenceText: phraseEn });
        await addUsage(today, { paSeconds: Math.round(pcm.length / WHISPER_SAMPLE_RATE) });

        if (result.pa.azureError) {
          setInfo(`発音評価でエラーが発生しました: ${result.pa.azureError}`);
          return null;
        }

        const saveAudio = (await getAppState<boolean>('saveTurnAudio')) ?? true;
        const turn: Turn = {
          role: 'user',
          // キーフレーズターンのtextは参照文（お手本のフレーズ）を保存する。
          // どのフレーズの練習かの逆引きと「全フレーズ✓」判定（XP計算）に使う
          text: phraseEn,
          at: Date.now(),
          phase: 'keyphrase',
          inputMode: 'voice',
          ...(saveAudio ? { audioBlob: recording.blob, mimeType: recording.mimeType } : {}),
          pa: result.pa,
        };
        await appendTurn(turn);
        return result.pa;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '音声の処理に失敗しました。');
        return null;
      } finally {
        setBusy('idle');
        wakeLock.release();
        processingRef.current = false;
      }
    },
    [appendTurn],
  );

  // --- キーフレーズ予習を終えて対話開始（多重呼び出しは無視） ---
  const dialogueStartedRef = useRef(false);
  const beginDialogue = useCallback(async () => {
    if (dialogueStartedRef.current) return;
    dialogueStartedRef.current = true;
    setDialogueStarted(true);
    await runAiTurn();
  }, [runAiTurn]);

  const finish = useCallback(async (): Promise<Conversation | null> => {
    queueRef.current?.stop();
    await persist({ status: 'completed', finishedAt: Date.now() });
    // セッション終了パイプライン(sessionEnd.ts)が完了後の最新レコードを必要とするため返す
    return conversationRef.current;
  }, [persist]);

  const abandon = useCallback(async () => {
    queueRef.current?.stop();
    if (conversationRef.current?.status === 'active') {
      await persist({ status: 'abandoned', finishedAt: Date.now() });
    }
  }, [persist]);

  const mode: ConversationMode = conversation?.mode ?? 'lesson';
  const dialogueUserTurnCount = turns.filter((t) => t.role === 'user' && t.phase !== 'keyphrase').length;

  return {
    loading,
    scenario,
    conversation,
    mode,
    turns,
    phase,
    dialogueStarted,
    beginDialogue,
    submitKeyPhrase,
    biteComplete: mode === 'bite' && dialogueUserTurnCount >= 1 && busy === 'idle',
    stepIndex,
    currentStep: phase === 'guided' && scenario ? (scenario.steps[stepIndex] ?? null) : null,
    busy,
    aiDraft,
    error,
    info,
    hintLevel,
    showNextHint,
    modelAnswersShown,
    markRecordStart,
    submitVoice,
    submitText,
    finish,
    abandon,
    latency,
    level,
  };
}
