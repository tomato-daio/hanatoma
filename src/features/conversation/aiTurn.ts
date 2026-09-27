/**
 * AI発話1ターンの実行（DESIGN.md §5・§7a・M13。React非依存）。
 *
 * Haiku streaming → takeSpeakableChunk で区切る → TtsSession で合成 → SpeechQueue で順次再生。
 * 1文目は届いた瞬間に合成へ回し（初音を最優先）、2つ目以降は再生待ちが尽きたとき／ストリーム終了時に
 * まとめて送る（F0のTTS回数上限対策）。
 *
 * 完了の定義（done）:
 *   - 'drained'     : ストリームが終わり、かつ全音声の再生が終わった（＝ユーザーが話してよい）
 *   - 'interrupted' : interrupt() で止めた（割り込み・会話終了）。止めた時点で即座に解決する
 *   - 'failed'      : Haikuの呼び出しが失敗した
 * TTSの失敗は致命ではない（そのチャンクはテキスト表示のみ）。
 *
 * 字幕（onCaption）: 読み上げありなら、音声の進みに合わせて単語単位で出す（captionReveal.ts）。
 * 読み上げなしなら生成途中のテキストをそのまま出す。
 */

import type { AppLevel, ConversationPhase, Scenario, ScenarioStep, Turn } from '../../lib/types';
import type { Usage } from '../llm/anthropicClient';
import { nextAiTurn as defaultNextAiTurn } from '../llm/haikuPartner';
import { stripStageDirections } from '../llm/sanitizeAiText';
import type { TtsSession } from '../speech/azureTts';
import { CAPTION_LEAD_MS, joinCaption, revealWords } from './captionReveal';
import { SpeechQueue, takeSpeakableChunk, type PlayAudio } from './speechQueue';

/** 再生中チャンクの字幕を進める間隔。 */
const CAPTION_TICK_MS = 80;

export interface AiTurnParams {
  apiKey: string;
  scenario: Scenario;
  level: AppLevel;
  history: Turn[];
  phase: ConversationPhase;
  step?: ScenarioStep;
  /** nullなら読み上げなし（テキストのみ）。 */
  tts: Pick<TtsSession, 'synth' | 'reset'> | null;
  /** 表示用のAI発話（ト書き除去済み・生成途中）。 */
  onDraft?: (text: string) => void;
  /** 画面に出すAI発話の字幕（読み上げに合わせて伸びる。ストリーム終了後も再生が終わるまで呼ばれる）。 */
  onCaption?: (text: string) => void;
  onFirstText?: () => void;
  /** 最初の音が実際に鳴り始めた。 */
  onFirstAudio?: () => void;
  /** ストリームが正常に終わった（音声はまだ再生中でありうる）。履歴への追加はここで行う。 */
  onStreamEnd?: (result: { text: string; usage: Usage }) => void;
  /** 課金されたトークン（中断時は推定を含む）。ストリームの終わり方に関係なく1回だけ呼ぶ。 */
  onUsage?: (usage: Usage, generatedChars: number) => void;
  onTtsError?: (message: string) => void;
  /** テスト用の差し替え。 */
  deps?: { nextAiTurn?: typeof defaultNextAiTurn; play?: PlayAudio };
}

export interface AiTurnOutcome {
  kind: 'drained' | 'interrupted' | 'failed';
  /** 生成されたテキスト（ト書き除去済み。中断時は途中まで）。 */
  text: string;
  /** ストリームが最後まで届いたか（falseなら onStreamEnd は呼ばれていない）。 */
  streamCompleted: boolean;
  error?: string;
  timings: { requestAt: number; firstTextAt: number | null; firstAudioAt: number | null };
}

export interface AiTurnHandle {
  /** 再生を止めてストリームを中断する（冪等）。done は即 'interrupted' で解決する。 */
  interrupt(): void;
  done: Promise<AiTurnOutcome>;
}

export function startAiTurn(p: AiTurnParams): AiTurnHandle {
  const nextAiTurn = p.deps?.nextAiTurn ?? defaultNextAiTurn;
  const abort = new AbortController();
  const timings: AiTurnOutcome['timings'] = { requestAt: performance.now(), firstTextAt: null, firstAudioAt: null };
  let full = '';
  let buffer = '';
  let firstQueued = false;
  let streamCompleted = false;
  let settled = false;
  let resolveDone!: (o: AiTurnOutcome) => void;
  const done = new Promise<AiTurnOutcome>((resolve) => {
    resolveDone = resolve;
  });

  // --- 字幕（読み上げに同期） ---
  const spokenChunks: string[] = [];
  let captionTimer: ReturnType<typeof setInterval> | null = null;
  const stopCaptionTimer = () => {
    if (captionTimer !== null) clearInterval(captionTimer);
    captionTimer = null;
  };
  const emitCaption = (current: string) => {
    if (!settled) p.onCaption?.(joinCaption(spokenChunks, current));
  };
  const startChunkCaption = (text: string, durationMs: number | null) => {
    stopCaptionTimer();
    if (durationMs === null || durationMs <= 0) {
      emitCaption(text);
      return;
    }
    const startAt = performance.now();
    const tick = () => emitCaption(revealWords(text, (performance.now() - startAt + CAPTION_LEAD_MS) / durationMs));
    tick();
    captionTimer = setInterval(tick, CAPTION_TICK_MS);
  };
  const endChunkCaption = (text: string) => {
    stopCaptionTimer();
    spokenChunks.push(text);
    emitCaption('');
  };

  const settle = (kind: AiTurnOutcome['kind'], error?: string) => {
    if (settled) return;
    settled = true;
    stopCaptionTimer();
    resolveDone({
      kind,
      text: stripStageDirections(full),
      streamCompleted,
      timings,
      ...(error !== undefined ? { error } : {}),
    });
  };

  const tts = p.tts;
  const queue = tts
    ? new SpeechQueue({
        synth: (text) => tts.synth(text),
        ...(p.deps?.play ? { play: p.deps.play } : {}),
        onFirstAudioStart: () => {
          timings.firstAudioAt = performance.now();
          p.onFirstAudio?.();
        },
        onBacklogEmpty: () => pump(false),
        onDrained: () => settle('drained'),
        onError: (message) => p.onTtsError?.(message),
        onChunkStart: startChunkCaption,
        onChunkEnd: endChunkCaption,
      })
    : null;

  /** 送ってよいチャンクがあればTTSキューへ積む。 */
  function pump(streamClosed: boolean): void {
    if (!queue || settled) return;
    for (;;) {
      const { chunk, rest } = takeSpeakableChunk(buffer, {
        isFirst: !firstQueued,
        queueIdle: queue.backlogEmpty,
        streamClosed,
      });
      buffer = rest;
      if (chunk === null) break;
      // ト書き（*nods* 等）は読み上げない（§7a）。ト書きだけのチャンクは飛ばし、次を1文目扱いにする。
      const spoken = stripStageDirections(chunk);
      if (spoken) {
        queue.enqueue(spoken);
        firstQueued = true;
      }
      if (streamClosed) break;
    }
  }

  let usageReported = false;
  const reportUsage = (usage: Usage, chars: number) => {
    if (usageReported) return;
    usageReported = true;
    p.onUsage?.(usage, chars);
  };

  void nextAiTurn({
    apiKey: p.apiKey,
    scenario: p.scenario,
    level: p.level,
    history: p.history,
    phase: p.phase,
    step: p.step,
    signal: abort.signal,
    onText: (delta) => {
      if (settled) return;
      if (timings.firstTextAt === null) {
        timings.firstTextAt = performance.now();
        p.onFirstText?.();
      }
      full += delta;
      buffer += delta;
      p.onDraft?.(stripStageDirections(full));
      if (!queue) p.onCaption?.(stripStageDirections(full));
      pump(false);
    },
  }).then(
    (result) => {
      reportUsage(result.usage, result.text.length);
      if (settled || result.aborted) return;
      full = result.text;
      streamCompleted = true;
      p.onStreamEnd?.({ text: stripStageDirections(result.text), usage: result.usage });
      if (queue) {
        pump(true);
        queue.close();
      } else {
        settle('drained');
      }
    },
    (err: unknown) => {
      queue?.interrupt();
      settle('failed', err instanceof Error ? err.message : 'AIの応答生成に失敗しました。');
    },
  );

  return {
    interrupt() {
      if (settled) return;
      // まだ鳴っていない合成待ちがあるなら、その合成が次のターンの前に並ばないよう接続を作り直す。
      const hadBacklog = queue ? !queue.backlogEmpty : false;
      abort.abort();
      queue?.interrupt();
      if (hadBacklog) tts?.reset();
      settle('interrupted');
    },
    done,
  };
}
