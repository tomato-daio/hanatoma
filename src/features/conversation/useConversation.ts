/**
 * 会話の状態機械（DESIGN.md §4, §5。アプリの心臓部）。
 *
 * M13（ハンズフリー・リアルタイム会話）で役割を分けた:
 *   - このフック: 会話データ（ターン・フェーズ・ステップ）、AIターンの実行、保存、使用量、キーフレーズ予習
 *   - live/useLiveTalk: 音声の聞き取りとターン交代（話し終わりの自動検知）。submitUtterance を呼ぶ側
 *
 * 1ターンの流れ（音声）: 聞き取り（PAなしSTT）→ 話し終わりで submitUtterance
 *   → DB書き込みを待たずに即 Haiku streaming → 1文目から順にTTS → 全部再生し終えたら 'drained'
 *   → useLiveTalk が次の聞き取りを始める。発音評価は会話終了後（sessionEnd.ts / deferredPa.ts）。
 * キーフレーズ予習（lessonのみ）は従来どおりタップ録音＋scripted発音評価をその場で行う。
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
import { encodeWavPcm16, wavFromPcm16 } from '../../lib/wav';
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
  type UsageDay,
} from '../../lib/types';
import { assessSpeech, type AssessSpeechResult } from '../speech/azurePaUnscripted';
import { prewarmSpeechSdk } from '../speech/azurePaStreaming';
import { createTtsSession, type TtsSession } from '../speech/azureTts';
import { logPaDebug } from '../speech/paDebugLog';
import { getAnthropicApiKey } from '../settings/anthropicKeyConfig';
import type { RecordingResult } from '../recorder/useRecorder';
import { getScenarioById } from '../scenarios/loadScenarios';
import { startAiTurn, type AiTurnHandle } from './aiTurn';
import { createConversationWriter, type ConversationWriter } from './conversationWriter';
import type { TurnClip } from './deferredPa';
import { buildPhraseHints } from './phraseHints';
import { beginVoiceCapture, type VoiceCaptureHandle } from './voiceCapture';

export type ConversationBusy = 'idle' | 'assessing' | 'thinking' | 'speaking';

/** AIターンの進行を聞き取り側（useLiveTalk）へ知らせるイベント。 */
export type AiEvent = 'started' | 'firstAudio' | 'drained' | 'interrupted' | 'failed';

/**
 * キーフレーズ予習（scripted）の全体上限。正常系は stream確定≤4s + 短文batch（韻律あり→なし
 * 最大2回でも各1〜3秒）で収まる。予習は1フレーズ数秒の短い操作の反復なので早めに見切って再試行へ誘導する。
 */
const PA_DEADLINE_SCRIPTED_MS = 12_000;

/** 直近ターンのレイテンシ（DESIGN.md §5。M13でハンズフリー用に区間を定義し直した）。 */
export interface TurnLatency {
  /** 話し終わり→ターン確定（Azureの区切り無音＋話し終わり待ち）。テキスト入力はnull。 */
  endpointMs: number | null;
  /** ターン確定→Haikuの最初のテキスト。 */
  aiFirstTextMs: number | null;
  /** Haikuの最初のテキスト→AIの最初の音（TTS合成・デコード込み）。 */
  ttsMs: number | null;
  /** 話し終わり（テキストは送信）→AIの最初の音。 */
  totalMs: number | null;
}

/** ユーザーの発話1回（音声またはテキスト）。 */
export interface Utterance {
  text: string;
  inputMode: 'voice' | 'text';
  thinkingMs?: number | null;
  /** 会話後の発音評価用の音声（16kHz mono PCM16・発話区間）。 */
  pcm?: Uint8Array | null;
  /** 話し終わりの時刻（performance.now基準。レイテンシ計測用）。 */
  speechEndAt?: number | null;
}

/**
 * 会話の最初のAI発話を引き出すための合成userターン。
 * Anthropic APIは最初のmessageがuserである必要があるため、実際の会話履歴の先頭に
 * 常にこれを差し込む（DBには保存しない）。
 */
const SYNTHETIC_OPENER: Turn = {
  role: 'user',
  text: '(The scene starts now. Greet me in character with a short opening line, then stop and wait for my reply.)',
  at: 0,
  phase: 'guided',
};

const DEFAULT_TTS_VOICE = 'en-US-JennyNeural';

/** 会話開始時に先読みしておく設定（AI呼び出しの直前にIndexedDBを待たないため）。 */
interface PreloadedConfig {
  apiKey: string | null;
  saveTurnAudio: boolean;
  caps: DailyCaps;
}

export interface SpeechBudget {
  /** 今日の音声認識・発音評価の上限に達していないか。 */
  canListen(): boolean;
  /** Azureへ送った音声の秒数を使用量に加算する。 */
  addSeconds(seconds: number): void;
}

export interface FinishedConversation {
  conversation: Conversation;
  /** 会話後の発音評価の材料（音声ターンの音声）。 */
  clips: TurnClip[];
}

export interface UseConversationResult {
  loading: boolean;
  scenario: Scenario | null;
  conversation: Conversation | null;
  mode: ConversationMode;
  turns: Turn[];
  phase: ConversationPhase;
  /** AIとの対話が始まっているか。 */
  dialogueStarted: boolean;
  /** 対話を開始する（AIが最初に話す）。開始タップ／キーフレーズ予習の「会話をはじめる」から呼ぶ。 */
  beginDialogue: () => void;
  /** キーフレーズ予習の1回分（scripted発音評価）。結果を返しAIターンは起こさない。 */
  submitKeyPhrase: (phraseEn: string, recording: RecordingResult) => Promise<PaResult | null>;
  /** biteモードで1往復が済み、完了ボタンを出してよい状態。 */
  biteComplete: boolean;
  stepIndex: number;
  /** ガイドフェーズの現在ステップ（フリー会話ではnull）。 */
  currentStep: ScenarioStep | null;
  busy: ConversationBusy;
  /** 画面に出すAI発話の字幕（読み上げに合わせて伸びる。再生が終わるとturnsの吹き出しに置き換わる）。 */
  aiDraft: string;
  /** 履歴には入ったがまだ読み上げ中のAIターンのat（画面ではaiDraftで出すので、吹き出しは隠す）。 */
  speakingTurnAt: number | null;
  error: string | null;
  /** エラーではない案内。 */
  info: string | null;
  setInfo: (message: string | null) => void;
  /** ヒント表示段階 0=非表示 1=日本語 2=英語言い出し 3=模範解答。 */
  hintLevel: 0 | 1 | 2 | 3;
  showNextHint: () => void;
  /** 模範解答を見た回数（XP計算用・M7）。 */
  modelAnswersShown: number;
  /** キーフレーズ予習の録音開始時に呼ぶ（M11: scriptedストリーミング評価開始）。 */
  beginKeyPhrase: (phraseEn: string) => Promise<boolean>;
  /** useRecorderのonAudioChunkへ渡す（キーフレーズ録音中PCMをストリーミング評価へ流す）。 */
  handleAudioChunk: (chunk: Float32Array, sampleRate: number) => void;
  /** 録音が結果なしで終わった場合（OSによるマイク停止等）にストリーミング評価を破棄する。 */
  cancelVoiceCapture: () => void;
  /** ユーザー発話を確定してAIターンを始める（AI発話中などで受け付けられなければfalse）。 */
  submitUtterance: (utterance: Utterance) => boolean;
  submitText: (text: string) => void;
  /** AIの発話を止める（割り込み）。 */
  interruptAi: () => void;
  /** AIターンの進行イベントを購読する（戻り値で解除）。 */
  subscribeAi: (listener: (event: AiEvent) => void) => () => void;
  /** 今の文脈の音声認識フレーズヒント（§6a。ガイド中はキーフレーズ＋現在stepの模範解答）。 */
  phraseHintsNow: () => string[];
  speech: SpeechBudget;
  finish: () => Promise<FinishedConversation | null>;
  abandon: () => Promise<void>;
  latency: TurnLatency | null;
  /** ユーザーの現在のアプリレベル（ヒント表示・TTS速度の参照用）。 */
  level: AppLevel;
}

/** 会話終了時、音声ターンに会話中の音声(WAV)を添付する（saveTurnAudio=ONのとき）。 */
function attachTurnAudio(turns: Turn[], clips: TurnClip[]): Turn[] {
  if (clips.length === 0) return turns;
  const byAt = new Map(clips.map((c) => [c.at, c]));
  return turns.map((t) => {
    const clip = t.role === 'user' && t.inputMode === 'voice' ? byAt.get(t.at) : undefined;
    if (!clip) return t;
    return { ...t, audioBlob: new Blob([wavFromPcm16([clip.pcm])], { type: 'audio/wav' }), mimeType: 'audio/wav' };
  });
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
  const [speakingTurnAt, setSpeakingTurnAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3>(0);
  const [modelAnswersShown, setModelAnswersShown] = useState(0);
  const [latency, setLatency] = useState<TurnLatency | null>(null);
  const [level, setLevel] = useState<AppLevel>(2);
  const [dialogueStarted, setDialogueStarted] = useState(false);

  // レンダリングに影響しない進行中データはrefで持つ
  const turnsRef = useRef<Turn[]>([]);
  const writerRef = useRef<ConversationWriter | null>(null);
  const scenarioRef = useRef<Scenario | null>(null);
  const configRef = useRef<PreloadedConfig | null>(null);
  const phaseRef = useRef<ConversationPhase>('guided');
  const stepIndexRef = useRef(0);
  const levelRef = useRef<AppLevel>(2);
  const ttsRef = useRef<TtsSession | null>(null);
  const aiRef = useRef<AiTurnHandle | null>(null);
  /** AIターンの世代。中断・終了で進め、古いターンの遅れた完了を無視する。 */
  const genRef = useRef(0);
  const listenersRef = useRef(new Set<(event: AiEvent) => void>());
  const clipsRef = useRef<TurnClip[]>([]);
  const lastAtRef = useRef(0);
  /** 今日すでに使った音声認識・発音評価の秒数（開始時に読み込み、会話中はメモリで加算）。 */
  const speechSecondsRef = useRef(0);
  const wakeLockRef = useRef(createWakeLockController());
  const openedRef = useRef(false);
  const processingRef = useRef(false);
  const dialogueStartedRef = useRef(false);
  /** キーフレーズ録音中のストリーミング発音評価（M11）。 */
  const captureRef = useRef<VoiceCaptureHandle | null>(null);

  const emit = useCallback((event: AiEvent) => {
    for (const l of [...listenersRef.current]) l(event);
  }, []);

  const subscribeAi = useCallback((listener: (event: AiEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // --- 保存（メモリ上で即更新し、IndexedDBへは裏で順番に書く） ---
  const updateConversation = useCallback((fn: (c: Conversation) => Conversation) => {
    const writer = writerRef.current;
    if (!writer || writer.sealed) return;
    setConversation(writer.update(fn));
  }, []);

  const appendTurn = useCallback(
    (turn: Turn) => {
      turnsRef.current = [...turnsRef.current, turn];
      setTurns(turnsRef.current);
      updateConversation((c) => ({ ...c, turns: turnsRef.current }));
    },
    [updateConversation],
  );

  /** 他のターンと重ならない単調増加のTurn.at（会話後の発音評価の突き合わせキー）。 */
  const nextAt = () => {
    const at = Math.max(Date.now(), lastAtRef.current + 1);
    lastAtRef.current = at;
    return at;
  };

  const recordUsage = useCallback((partial: Parameters<typeof addUsage>[1]) => {
    void addUsage(learningDate(new Date()), partial).catch((err: unknown) =>
      console.warn('[useConversation] 使用量の記録に失敗しました。', err),
    );
  }, []);

  // --- AI発話（Haiku streaming → TTS） ---
  const runAiTurn = useCallback(
    (timing?: { commitAt: number; speechEndAt: number | null }) => {
      const sc = scenarioRef.current;
      const cfg = configRef.current;
      if (!sc || !cfg) return;
      if (!cfg.apiKey) {
        setError('Anthropic APIキーが未設定です。設定画面で登録してください。');
        emit('failed');
        return;
      }
      const gen = ++genRef.current;
      const curPhase = phaseRef.current;
      const step = curPhase === 'guided' ? sc.steps[stepIndexRef.current] : undefined;
      const commitAt = timing?.commitAt ?? performance.now();
      const speechEndAt = timing?.speechEndAt ?? null;
      const tts = ttsRef.current;

      setBusy('thinking');
      setAiDraft('');
      emit('started');

      const handle = startAiTurn({
        apiKey: cfg.apiKey,
        scenario: sc,
        level: levelRef.current,
        history: [SYNTHETIC_OPENER, ...turnsRef.current],
        phase: curPhase,
        step,
        tts,
        onCaption: (text) => {
          if (gen === genRef.current) setAiDraft(text);
        },
        onFirstAudio: () => {
          if (gen !== genRef.current) return;
          setBusy('speaking');
          emit('firstAudio');
        },
        onStreamEnd: ({ text }) => {
          if (gen !== genRef.current) return;
          // 保存もト書き除去後のテキスト（履歴に残すと以降のターンでHaikuが真似るため）。
          if (!text) return;
          const at = nextAt();
          appendTurn({ role: 'ai', text, at, phase: curPhase });
          // 読み上げ中は字幕（aiDraft）で出し続け、全文の吹き出しは再生が終わってから出す。
          if (tts) setSpeakingTurnAt(at);
          else setAiDraft('');
        },
        onUsage: (usage, chars) => {
          recordUsage({
            haikuCalls: 1,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            ttsChars: tts ? chars : 0,
          });
        },
        onTtsError: () => {
          // TTS失敗は読み上げを諦めテキスト表示のみ（DESIGN.md §6c: synthesizeはthrowする契約）
          if (gen === genRef.current) setInfo('AI音声の再生に失敗したため、テキストのみ表示しています。');
        },
      });
      aiRef.current = handle;

      void handle.done.then((outcome) => {
        if (gen !== genRef.current) return;
        aiRef.current = null;
        const t = outcome.timings;
        setLatency({
          endpointMs: speechEndAt !== null ? Math.round(commitAt - speechEndAt) : null,
          aiFirstTextMs: t.firstTextAt !== null ? Math.round(t.firstTextAt - commitAt) : null,
          ttsMs: t.firstTextAt !== null && t.firstAudioAt !== null ? Math.round(t.firstAudioAt - t.firstTextAt) : null,
          totalMs: t.firstAudioAt !== null ? Math.round(t.firstAudioAt - (speechEndAt ?? commitAt)) : null,
        });
        if (t.firstAudioAt !== null) {
          const sec = (ms: number) => (ms / 1000).toFixed(1);
          logPaDebug(
            `[会話] 発話終了→AI音声 ${sec(t.firstAudioAt - (speechEndAt ?? commitAt))}s` +
              (speechEndAt !== null ? ` 確定${sec(commitAt - speechEndAt)}` : ' (テキスト)') +
              (t.firstTextAt !== null
                ? ` AI初文${sec(t.firstTextAt - commitAt)} TTS${sec(t.firstAudioAt - t.firstTextAt)}`
                : ''),
          );
        }
        if (outcome.kind === 'interrupted' && !outcome.streamCompleted && outcome.text) {
          // 途中で止めたAI発話も履歴に残す（話の流れが途切れないように）。
          appendTurn({ role: 'ai', text: outcome.text, at: nextAt(), phase: curPhase });
        }
        setAiDraft('');
        setSpeakingTurnAt(null);
        if (outcome.kind === 'failed') setError(outcome.error ?? 'AIの応答生成に失敗しました。');
        setBusy('idle');
        emit(outcome.kind);
      });
    },
    [appendTurn, emit, recordUsage],
  );

  // --- 初期ロード ---
  // StrictModeではeffectが「実行→cleanup→再実行」されるため、cancelledフラグ方式だと
  // 1回目の実行がキャンセルされ2回目がopenedRefガードで弾かれて永久にロード中になる。
  // openedRefの一度きりガードのみ使い、キャンセルはしない（実機で問題になった実バグの修正）。
  useEffect(() => {
    if (!conversationId || openedRef.current) return;
    openedRef.current = true;
    // 初回の聞き取り時のSDK動的importコストを排除する（失敗は無視され実行時に再import）。
    prewarmSpeechSdk();
    void (async () => {
      try {
        const conv = await getConversation(conversationId);
        if (!conv) {
          setError('会話が見つかりません。ホームからやり直してください。');
          setLoading(false);
          return;
        }
        const [sc, profile, apiKey, ttsVoice, saveTurnAudio, caps, usage] = await Promise.all([
          getScenarioById(conv.scenarioId),
          getUserProfile(),
          getAnthropicApiKey(),
          getAppState<string>('ttsVoice'),
          getAppState<boolean>('saveTurnAudio'),
          getAppState<DailyCaps>('dailyCaps'),
          getUsageDay(learningDate(new Date())),
        ]);
        if (!sc) {
          setError('シナリオが見つかりません。');
          setLoading(false);
          return;
        }

        writerRef.current = createConversationWriter(conv, putConversation);
        turnsRef.current = conv.turns;
        lastAtRef.current = conv.turns.reduce((m, t) => Math.max(m, t.at), 0);
        scenarioRef.current = sc;
        configRef.current = {
          apiKey: apiKey ?? null,
          saveTurnAudio: saveTurnAudio ?? true,
          caps: caps ?? DEFAULT_DAILY_CAPS,
        };
        speechSecondsRef.current = usage.paSeconds;
        setConversation(conv);
        setScenario(sc);
        setTurns(conv.turns);
        levelRef.current = profile.level;
        setLevel(profile.level);

        // AI発話用TTSは会話中ずっと1本の接続を使い回す（M13。事前接続で初音を早める）。
        const tts = createTtsSession({
          voice: ttsVoice ?? DEFAULT_TTS_VOICE,
          rate: getLevelParams(profile.level).ttsRate,
        });
        tts.warm();
        ttsRef.current = tts;

        // 途中再開はさせない仕様（§4）だが、activeな既存レコードを開いた場合は続きから表示だけする。
        // ガイドステップの進行はキーフレーズ予習ターンを除いた対話ターン数で数える
        const dialogueUserTurns = conv.turns.filter((t) => t.role === 'user' && t.phase !== 'keyphrase').length;
        const nextStep = Math.min(dialogueUserTurns, sc.steps.length);
        stepIndexRef.current = nextStep;
        setStepIndex(nextStep);
        // biteモードはガイドを使わず最初からフリー会話（§4: 1往復だけの最小単位）
        const startPhase: ConversationPhase = conv.mode === 'bite' || nextStep >= sc.steps.length ? 'free' : 'guided';
        phaseRef.current = startPhase;
        setPhase(startPhase);

        const hasDialogue = conv.turns.some((t) => t.phase !== 'keyphrase');
        dialogueStartedRef.current = hasDialogue;
        setDialogueStarted(hasDialogue);
        // AIの開幕発話は開始タップ（beginDialogue）で始める（M13: iOSの音声再生アンロックとマイク許可のため）。
        setLoading(false);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '読み込みに失敗しました。');
        setLoading(false);
      }
    })();
  }, [conversationId]);

  // 画面離脱時の後始末
  useEffect(() => {
    const wakeLock = wakeLockRef.current;
    return () => {
      genRef.current += 1;
      aiRef.current?.interrupt();
      aiRef.current = null;
      ttsRef.current?.close();
      ttsRef.current = null;
      captureRef.current?.abort();
      captureRef.current = null;
      wakeLock.dispose();
    };
  }, []);

  // --- ユーザー発話の確定（音声・テキスト共通） ---
  const submitUtterance = useCallback(
    (u: Utterance): boolean => {
      const text = u.text.trim();
      if (!text || !writerRef.current || aiRef.current || processingRef.current) return false;
      setError(null);
      setInfo(null);
      hintLevelRef.current = 0;
      setHintLevel(0);
      const at = nextAt();
      const turn: Turn = {
        role: 'user',
        text,
        at,
        phase: phaseRef.current,
        inputMode: u.inputMode,
        ...(u.thinkingMs !== undefined && u.thinkingMs !== null ? { thinkingMs: u.thinkingMs } : {}),
      };
      appendTurn(turn);
      if (u.inputMode === 'voice' && u.pcm && u.pcm.byteLength > 0) {
        clipsRef.current.push({ at, text, pcm: u.pcm });
      }
      // ガイドフェーズのステップを進め、最後まで到達したらフリー会話へ
      const sc = scenarioRef.current;
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
      runAiTurn({ commitAt: performance.now(), speechEndAt: u.speechEndAt ?? null });
      return true;
    },
    [appendTurn, runAiTurn],
  );

  const submitText = useCallback(
    (text: string) => {
      submitUtterance({ text, inputMode: 'text' });
    },
    [submitUtterance],
  );

  const interruptAi = useCallback(() => {
    aiRef.current?.interrupt();
  }, []);

  const phraseHintsNow = useCallback((): string[] => {
    const sc = scenarioRef.current;
    // フレーズヒント（§6a）: キーフレーズ+（ガイド中のみ）現在stepの模範解答だけを渡す
    // （全stepsの長文を渡すと認識がヒントへ引っ張られるover-biasingの実害があった）
    return sc ? buildPhraseHints(sc, { phase: phaseRef.current, stepIndex: stepIndexRef.current }) : [];
  }, []);

  const speechRef = useRef<SpeechBudget>({
    canListen: () => {
      const cfg = configRef.current;
      if (!cfg) return true;
      return canRunPa({ paSeconds: speechSecondsRef.current } as UsageDay, cfg.caps);
    },
    addSeconds: (seconds: number) => {
      if (!(seconds > 0)) return;
      speechSecondsRef.current += seconds;
      void addUsage(learningDate(new Date()), { paSeconds: seconds }).catch(() => undefined);
    },
  });

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

  // --- キーフレーズ予習（lessonモード。scripted発音評価・AIターンは起こさない） ---
  const beginKeyPhrase = useCallback(async (phraseEn: string): Promise<boolean> => {
    const caps = (await getAppState<DailyCaps>('dailyCaps')) ?? DEFAULT_DAILY_CAPS;
    const usage = await getUsageDay(learningDate(new Date()));
    if (!canRunPa(usage, caps)) {
      setInfo('今日の発音評価の上限に達しました（設定で変更できます）。');
      return false;
    }
    setInfo(null);
    await wakeLockRef.current.acquire();
    captureRef.current?.abort();
    captureRef.current = beginVoiceCapture({
      mode: 'scripted',
      referenceText: phraseEn,
      phraseHints: [phraseEn],
    });
    return true;
  }, []);

  const handleAudioChunk = useCallback((chunk: Float32Array, sampleRate: number) => {
    captureRef.current?.onAudioChunk(chunk, sampleRate);
  }, []);

  const cancelVoiceCapture = useCallback(() => {
    captureRef.current?.abort();
    captureRef.current = null;
    wakeLockRef.current.release();
  }, []);

  const submitKeyPhrase = useCallback(
    async (phraseEn: string, recording: RecordingResult): Promise<PaResult | null> => {
      if (processingRef.current) return null;
      processingRef.current = true;
      setError(null);
      setInfo(null);
      const wakeLock = wakeLockRef.current;
      await wakeLock.acquire();
      // 全体デッドライン（DESIGN.md §6a-2）: stream確定待ち+batch韻律2回で「評価中」が長引かないよう上限を張る。
      const paDeadline = new AbortController();
      const deadlineId = window.setTimeout(() => paDeadline.abort(), PA_DEADLINE_SCRIPTED_MS);
      try {
        setBusy('assessing');
        const today = learningDate(new Date());

        // ストリーミング評価（M11）: beginKeyPhraseで開始済みのセッションの確定を待つ。
        const capture = captureRef.current;
        captureRef.current = null;
        let result: AssessSpeechResult | null = null;
        let paSeconds = 0;
        if (capture) {
          try {
            result = await capture.finish(paDeadline.signal);
          } finally {
            // 冪等な保険（voiceCapture内で破棄済みでも二重abortは無害）。
            if (paDeadline.signal.aborted) capture.abort();
          }
          if (result) paSeconds = Math.round(capture.audioSeconds());
        }
        if (!result && !paDeadline.signal.aborted) {
          // batchフォールバック（従来経路）。scriptedは短文でbatchも速いため見切りはしない。
          const pcm = await decodeToMono16k(recording.blob);
          const wavBlob = new Blob([encodeWavPcm16(pcm)], { type: 'audio/wav' });
          // phraseHintsに参照文自身を渡し、参照文と認識テキストのズレを減らす（§6b）
          result = await assessSpeech(wavBlob, {
            mode: 'scripted',
            referenceText: phraseEn,
            phraseHints: [phraseEn],
            signal: paDeadline.signal,
          });
          paSeconds = Math.round(pcm.length / WHISPER_SAMPLE_RATE);
        }
        speechSecondsRef.current += paSeconds;
        await addUsage(today, { paSeconds });

        if (!result || result.pa.azureError) {
          setInfo(
            paDeadline.signal.aborted
              ? '発音評価が時間内に完了しませんでした。通信状況を確認して、もう一度お試しください。'
              : `発音評価でエラーが発生しました: ${result?.pa.azureError ?? '結果を取得できませんでした'}`,
          );
          return null;
        }

        const saveAudio = configRef.current?.saveTurnAudio ?? true;
        const turn: Turn = {
          role: 'user',
          // キーフレーズターンのtextは参照文（お手本のフレーズ）を保存する。
          // どのフレーズの練習かの逆引きと「全フレーズ✓」判定（XP計算）に使う
          text: phraseEn,
          at: nextAt(),
          phase: 'keyphrase',
          inputMode: 'voice',
          ...(saveAudio ? { audioBlob: recording.blob, mimeType: recording.mimeType } : {}),
          pa: result.pa,
        };
        appendTurn(turn);
        return result.pa;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '音声の処理に失敗しました。');
        return null;
      } finally {
        window.clearTimeout(deadlineId);
        setBusy('idle');
        wakeLock.release();
        processingRef.current = false;
      }
    },
    [appendTurn],
  );

  // --- 対話開始（多重呼び出しは無視） ---
  const beginDialogue = useCallback(() => {
    if (dialogueStartedRef.current) return;
    dialogueStartedRef.current = true;
    setDialogueStarted(true);
    // 会話中は画面スリープでWebSocketが切れないよう、終了までWake Lockを保持する。
    void wakeLockRef.current.acquire();
    runAiTurn();
  }, [runAiTurn]);

  const closeSession = useCallback(async (status: 'completed' | 'abandoned'): Promise<FinishedConversation | null> => {
    genRef.current += 1;
    aiRef.current?.interrupt();
    aiRef.current = null;
    ttsRef.current?.close();
    ttsRef.current = null;
    wakeLockRef.current.release();
    const writer = writerRef.current;
    if (!writer || writer.sealed) return null;
    const clips = clipsRef.current;
    const saveAudio = configRef.current?.saveTurnAudio ?? true;
    const next = writer.update((c) => ({
      ...c,
      status,
      finishedAt: Date.now(),
      // 音声は会話中は保存せず、完了時にまとめて添付する（中断した会話は再開できないため保存しない）。
      turns: status === 'completed' && saveAudio ? attachTurnAudio(turnsRef.current, clips) : turnsRef.current,
    }));
    setConversation(next);
    await writer.flush();
    // 以降は sessionEnd.ts が唯一の書き手（遅れて完了したAIターン等による上書きを防ぐ）。
    writer.seal();
    return { conversation: writer.get(), clips };
  }, []);

  const finish = useCallback(() => closeSession('completed'), [closeSession]);

  const abandon = useCallback(async () => {
    if (writerRef.current?.get().status !== 'active') return;
    await closeSession('abandoned');
  }, [closeSession]);

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
    speakingTurnAt,
    error,
    info,
    setInfo,
    hintLevel,
    showNextHint,
    modelAnswersShown,
    beginKeyPhrase,
    handleAudioChunk,
    cancelVoiceCapture,
    submitUtterance,
    submitText,
    interruptAi,
    subscribeAi,
    phraseHintsNow,
    speech: speechRef.current,
    finish,
    abandon,
    latency,
    level,
  };
}
