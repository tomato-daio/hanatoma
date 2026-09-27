/**
 * ハンズフリー会話の実行役（DESIGN.md §5・M13。React非依存）。
 *
 * liveMachine（純関数の状態機械）が出す副作用の指示を、マイク・Azure STT・タイマー・
 * 会話フック（useConversation）への呼び出しに変換して実行する。
 *
 * 音声の流れ: マイク(Float32) → 16kHzへリサンプル → PCM16 → 送信ゲート → STT
 *   - ゲートは聞き取りの番（STTセグメントがある間）だけ開く＝AI発話中の音は送らない（半二重）
 *   - STTの接続完了前に届いた音声はバッファし、完了後に到着順で流す（話し始めの取りこぼし防止）
 *   - 送った音声はターンごとに保持し、確定時に発話区間へ切り詰めて会話後の発音評価用に渡す
 * STTセッションは常に最大1本（Azure F0は同時認識1本）。確定・一時停止のたびに閉じる。
 */

import { createResamplerState, floatChunkToPcm16, resampleLinearChunk, type LinearResamplerState } from '../../../lib/pcm';
import { trimPcm16 } from '../../../lib/wav';
import { getSharedAudioContext } from '../../recorder/useRecorder';
import { openMicSession, type MicMode, type MicSession, type OpenMicOptions } from '../../recorder/micSession';
import { truncateDetail } from '../../speech/azurePaUnscripted';
import { DEFAULT_STT_SEGMENTATION, startLiveStt, type LiveSttOptions, type LiveSttSession, type SttSegmentation } from '../../speech/azureStt';
import type { AiEvent, SpeechBudget, Utterance } from '../useConversation';
import type { EndOfTurnPatience } from './endOfTurn';
import {
  captionOf,
  DEFAULT_LIVE_CONFIG,
  INITIAL_LIVE_STATE,
  liveReducer,
  type HoldReason,
  type LiveConfig,
  type LiveEffect,
  type LiveEvent,
  type LivePhase,
  type LiveState,
  type LiveTimer,
  type PauseReason,
} from './liveMachine';

/** 会話フック側の窓口（useConversation の戻り値の一部）。 */
export interface LiveHost {
  beginDialogue(): void;
  submitUtterance(u: Utterance): boolean;
  interruptAi(): void;
  subscribeAi(listener: (event: AiEvent) => void): () => void;
  phraseHintsNow(): string[];
  speech: SpeechBudget;
  /** ユーザーへの案内（エラーではない）。nullで消す。 */
  notify(message: string | null): void;
}

export interface LiveSettings {
  patience: EndOfTurnPatience;
  micMode: MicMode;
  /** ひとくち=1。nullは無制限。 */
  userTurnLimit: number | null;
  segmentation: SttSegmentation;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  patience: 'normal',
  micMode: 'perTurn',
  userTurnLimit: null,
  segmentation: DEFAULT_STT_SEGMENTATION,
};

export interface LiveDeps {
  openMic: (opts: OpenMicOptions) => Promise<MicSession>;
  startStt: (opts: LiveSttOptions) => Promise<LiveSttSession>;
  now: () => number;
  /** 開始タップの文脈でAudioContextをresumeする（iOSの再生アンロック）。 */
  unlockAudio: () => void;
}

const defaultDeps: LiveDeps = {
  openMic: openMicSession,
  startStt: startLiveStt,
  now: () => performance.now(),
  unlockAudio: () => {
    try {
      void getSharedAudioContext().resume().catch(() => undefined);
    } catch {
      // Web Audio非対応はTTS側でエラー表示される
    }
  },
};

export interface LiveView {
  phase: LivePhase;
  paused: PauseReason | null;
  holds: HoldReason[];
  /** 字幕: このターンで確定した文。 */
  finals: string;
  /** 字幕: 話している途中の部分認識。 */
  partial: string;
  /** 0〜1の入力レベル（聞き取り中のみ意味がある）。 */
  level: number;
  /** STTの接続が完了し、音声を送っている。 */
  sttReady: boolean;
  started: boolean;
  /** 設定「話し終わりの待ち時間」が手動（送信ボタンでのみ確定）。 */
  manualSend: boolean;
}

export interface LiveTalkController {
  /** 開始タップで呼ぶ（音声アンロック・マイク許可・AIの開幕発話）。 */
  start(): void;
  /** 「送信」: 話し終わり待ちを飛ばして今すぐ確定する。 */
  sendNow(): void;
  /** AIの発話を止めて聞き取りへ。 */
  interrupt(): void;
  pause(): void;
  resume(): void;
  hold(reason: HoldReason): void;
  release(reason: HoldReason): void;
  /** 会話終了・画面離脱。マイクとSTTを閉じる。 */
  stop(): void;
  updateSettings(partial: Partial<LiveSettings>): void;
  subscribe(listener: () => void): () => void;
  getView(): LiveView;
}

/** 16kHz PCM16 は1msあたり32バイト。 */
const BYTES_PER_MS = 32;
/** 「送信」タップ後、最後の確定を待つ上限。 */
const FINISH_GRACE_MS = 600;
/** レベル表示の更新間隔（再描画を抑える）。 */
const LEVEL_PUBLISH_INTERVAL_MS = 80;

/** 音声認識エラーの案内文（Azure系のエラーは日本語メッセージを持つ）。 */
function describeSttError(err: unknown): string {
  return truncateDetail(err instanceof Error ? err.message : String(err));
}

/**
 * 音声認識が使えなかったときの案内文の純関数。1006（WebSocketのハンドシェイク拒否）は
 * キー・リージョンの誤り、今月の無料枠の使い切り、通信の遮断のどれかであることが多い。
 */
export function sttFailureNotice(err: unknown): string {
  const detail = describeSttError(err);
  if (/1006/.test(detail)) {
    return `Azure Speechに接続できませんでした。設定のAzureキーとリージョン、今月の無料枠（月5時間）、通信状況を確認して「再開」をタップしてください（${detail}）。`;
  }
  return `音声認識でエラーが発生しました（${detail}）。「再開」をタップしてください。`;
}

/** Float32チャンクのRMSから0〜1の表示レベルを求める純関数。 */
export function levelFromChunk(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.min(1, Math.sqrt(sum / chunk.length) * 4);
}

interface Segment {
  id: number;
  ready: Promise<LiveSttSession | null>;
  stt: LiveSttSession | null;
  pending: ArrayBuffer[];
  /** このセグメントの音声先頭の壁時計（Azureのoffsetの起点）。 */
  startAt: number | null;
  /** 発話バッファ内でのこのセグメントの開始位置（バイト）。 */
  byteStart: number;
  bytes: number;
  resampler: LinearResamplerState | null;
  finishing: boolean;
  closed: boolean;
  /** 認識結果（部分・確定）を1件でも受け取ったか。 */
  sawEvent: boolean;
  /** 接続失敗後の自動再接続を済ませたか（1回だけ）。 */
  retried: boolean;
}

interface UtteranceAudio {
  chunks: Uint8Array[];
  bytes: number;
  speechStartByte: number | null;
  speechEndByte: number | null;
}

const emptyUtterance = (): UtteranceAudio => ({ chunks: [], bytes: 0, speechStartByte: null, speechEndByte: null });

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function createLiveTalkController(
  host: LiveHost,
  initialSettings: Partial<LiveSettings> = {},
  deps: LiveDeps = defaultDeps,
): LiveTalkController {
  let settings: LiveSettings = { ...DEFAULT_LIVE_SETTINGS, ...initialSettings };
  let state: LiveState = INITIAL_LIVE_STATE;
  let started = false;
  let disposed = false;
  let segSeq = 0;
  let current: Segment | null = null;
  let utter = emptyUtterance();
  let mic: MicSession | null = null;
  let micOpening: Promise<void> | null = null;
  let level = 0;
  let lastLevelPublish = 0;
  let unsubscribeAi: (() => void) | null = null;
  const timers = new Map<LiveTimer, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let view: LiveView = buildView();

  const config = (): LiveConfig => ({
    ...DEFAULT_LIVE_CONFIG,
    patience: settings.patience,
    userTurnLimit: settings.userTurnLimit,
  });

  function buildView(): LiveView {
    const caption = captionOf(state);
    return {
      phase: state.phase,
      paused: state.paused,
      holds: state.holds,
      finals: caption.finals,
      partial: caption.partial,
      level,
      sttReady: current?.stt != null,
      started,
      manualSend: settings.patience === 'manual',
    };
  }

  function publish(): void {
    view = buildView();
    for (const l of [...listeners]) l();
  }

  // --- dispatch（副作用中に発生したイベントは現在の処理が終わってから順に処理する） ---
  const queue: LiveEvent[] = [];
  let dispatching = false;
  function dispatch(event: LiveEvent): void {
    if (disposed) return;
    queue.push(event);
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length > 0) {
        const e = queue.shift()!;
        const t = liveReducer(state, e, config());
        state = t.state;
        for (const eff of t.effects) runEffect(eff);
      }
    } finally {
      dispatching = false;
    }
    publish();
  }

  function runEffect(eff: LiveEffect): void {
    switch (eff.type) {
      case 'openStt':
        openSegment();
        break;
      case 'closeStt':
        closeSegment();
        break;
      case 'finishStt':
        finishSegment();
        break;
      case 'setTimer': {
        clearTimer(eff.timer);
        const name = eff.timer;
        timers.set(
          name,
          setTimeout(() => {
            timers.delete(name);
            dispatch({ type: 'timer', timer: name, now: deps.now() });
          }, eff.ms),
        );
        break;
      }
      case 'clearTimer':
        clearTimer(eff.timer);
        break;
      case 'commit':
        commitUtterance(eff.text, eff.thinkingMs, eff.speechEndAt);
        break;
      case 'interruptAi':
        host.interruptAi();
        break;
      case 'stopped':
        teardown();
        break;
    }
  }

  function clearTimer(name: LiveTimer): void {
    const id = timers.get(name);
    if (id !== undefined) clearTimeout(id);
    timers.delete(name);
  }

  // --- マイク ---
  function wantMic(): boolean {
    if (!started || disposed || state.phase === 'stopped') return false;
    return settings.micMode === 'keepOpen' || current !== null;
  }

  function ensureMic(): void {
    if (mic || micOpening) return;
    micOpening = deps
      .openMic({
        onChunk: onMicChunk,
        onMuteChange: (muted) => {
          if (muted) {
            host.notify('マイクが一時的に止められました。「再開」をタップしてください。');
            dispatch({ type: 'pause', reason: 'mic' });
          }
        },
        onEnded: () => {
          closeMic();
          host.notify('マイクがOSに停止されました。「再開」をタップしてください。');
          dispatch({ type: 'pause', reason: 'mic' });
        },
        ...(settings.micMode === 'keepOpen' ? { audioSessionType: 'play-and-record' as const } : {}),
      })
      .then(
        (m) => {
          if (wantMic()) {
            mic = m;
          } else {
            m.close();
          }
        },
        (err: unknown) => {
          host.notify(`マイクを使えませんでした（${err instanceof Error ? err.message : String(err)}）。`);
          dispatch({ type: 'pause', reason: 'mic' });
        },
      )
      .finally(() => {
        micOpening = null;
      });
  }

  function closeMic(): void {
    mic?.close();
    mic = null;
  }

  function onMicChunk(chunk: Float32Array, sampleRate: number): void {
    const now = deps.now();
    level = levelFromChunk(chunk);
    if (now - lastLevelPublish >= LEVEL_PUBLISH_INTERVAL_MS) {
      lastLevelPublish = now;
      publish();
    }
    const seg = current;
    if (!seg || seg.finishing || seg.closed || chunk.length === 0) return;
    if (!seg.resampler) seg.resampler = createResamplerState(sampleRate, 16000);
    const r = resampleLinearChunk(seg.resampler, chunk);
    seg.resampler = r.state;
    if (r.output.length === 0) return;
    const pcm16 = floatChunkToPcm16(r.output);
    // このチャンクはおよそ「今」までの音声。先頭の時刻はチャンク長ぶん前。
    if (seg.startAt === null) seg.startAt = now - (chunk.length / sampleRate) * 1000;
    seg.bytes += pcm16.byteLength;
    utter.chunks.push(new Uint8Array(pcm16.slice(0)));
    utter.bytes += pcm16.byteLength;
    if (seg.stt) seg.stt.writeChunk(pcm16);
    else seg.pending.push(pcm16);
  }

  // --- STTセグメント ---
  function openSegment(): void {
    if (!host.speech.canListen()) {
      host.notify('今日の音声認識・発音評価の上限に達しました（設定で変更できます）。テキスト入力なら続けられます。');
      dispatch({ type: 'pause', reason: 'cap' });
      return;
    }
    const seg: Segment = {
      id: ++segSeq,
      ready: Promise.resolve(null),
      stt: null,
      pending: [],
      startAt: null,
      byteStart: utter.bytes,
      bytes: 0,
      resampler: null,
      finishing: false,
      closed: false,
      sawEvent: false,
      retried: false,
    };
    current = seg;
    ensureMic();
    connectStt(seg);
  }

  /** このセグメントでここまでに録った音声（再接続時に最初から送り直す）。 */
  function segmentAudioSoFar(seg: Segment): ArrayBuffer {
    const all = concatBytes(utter.chunks, utter.bytes);
    return all.slice(seg.byteStart).buffer;
  }

  /**
   * STTへの接続が、認識結果を1件も返す前に失敗した: 1回だけ自動で張り直し、ここまでの音声を送り直す
   * （区切り指定が拒否された場合は azureStt 側が区切りなしに切り替える）。2回目の失敗は一時停止＋案内。
   */
  function onSttFailure(seg: Segment, err: unknown): void {
    if (seg.closed || current !== seg) return;
    if (!seg.sawEvent && !seg.retried && !seg.finishing) {
      seg.retried = true;
      seg.stt?.abort();
      seg.stt = null;
      const replay = segmentAudioSoFar(seg);
      seg.pending = replay.byteLength > 0 ? [replay] : [];
      connectStt(seg);
      return;
    }
    host.notify(sttFailureNotice(err));
    dispatch({ type: 'sttError' });
  }

  function connectStt(seg: Segment): void {
    const onRecognition = (kind: 'partial' | 'final', text: string, offsetMs: number, durationMs: number) => {
      if (seg.closed || current !== seg) return;
      seg.sawEvent = true;
      if (text.trim()) {
        const start = seg.byteStart + offsetMs * BYTES_PER_MS;
        const end = seg.byteStart + (offsetMs + durationMs) * BYTES_PER_MS;
        utter.speechStartByte = utter.speechStartByte === null ? start : Math.min(utter.speechStartByte, start);
        utter.speechEndByte = utter.speechEndByte === null ? end : Math.max(utter.speechEndByte, end);
      }
      dispatch({ type: kind, text, segmentAudioStartAt: seg.startAt ?? deps.now(), offsetMs, durationMs });
    };
    let session: LiveSttSession | null = null;
    // 1回の接続で「開始失敗」と「開始中のキャンセル」の両方が届きうるため、失敗の処理は1回だけにする。
    let attemptFailed = false;
    const failOnce = (err: unknown) => {
      if (attemptFailed) return;
      attemptFailed = true;
      onSttFailure(seg, err);
    };
    seg.ready = deps
      .startStt({
        phraseHints: host.phraseHintsNow(),
        segmentation: settings.segmentation,
        onPartial: (t, o, d) => onRecognition('partial', t, o, d),
        onFinal: (t, o, d) => onRecognition('final', t, o, d),
        onError: (err) => {
          // 再接続後に古い接続から届いたエラーは無視する。
          if (session === null || seg.stt === session) failOnce(err);
        },
      })
      .then(
        (stt) => {
          session = stt;
          if (seg.closed) {
            stt.abort();
            return null;
          }
          seg.stt = stt;
          for (const buf of seg.pending) stt.writeChunk(buf);
          seg.pending = [];
          publish();
          return stt;
        },
        (err: unknown) => {
          failOnce(err);
          return null;
        },
      );
  }

  function closeSegment(): void {
    const seg = current;
    if (!seg) return;
    current = null;
    seg.closed = true;
    seg.pending = [];
    host.speech.addSeconds(seg.bytes / (BYTES_PER_MS * 1000));
    seg.stt?.abort();
    // まだ何も話していなければ、ためた無音は捨てる（次に話したときのバッファを小さく保つ）。
    if (utter.speechStartByte === null) utter = emptyUtterance();
    if (settings.micMode === 'perTurn') closeMic();
  }

  function finishSegment(): void {
    const seg = current;
    if (!seg) {
      dispatch({ type: 'sttFinished', now: deps.now() });
      return;
    }
    seg.finishing = true;
    void (async () => {
      try {
        const stt = await seg.ready;
        if (stt && !seg.closed) await stt.finish(FINISH_GRACE_MS);
      } catch {
        // 確定待ちの失敗は、ここまでの確定文・部分認識で送る
      }
      if (current === seg) dispatch({ type: 'sttFinished', now: deps.now() });
    })();
  }

  function commitUtterance(text: string, thinkingMs: number | null, speechEndAt: number | null): void {
    let pcm: Uint8Array | null = null;
    if (utter.speechStartByte !== null && utter.speechEndByte !== null) {
      const all = concatBytes(utter.chunks, utter.bytes);
      pcm = trimPcm16(all, utter.speechStartByte / BYTES_PER_MS, utter.speechEndByte / BYTES_PER_MS, { padMs: 300 });
    }
    utter = emptyUtterance();
    host.notify(null);
    const ok = host.submitUtterance({ text, inputMode: 'voice', thinkingMs, pcm, speechEndAt });
    // 受け付けられなかった（空テキスト等）ときは聞き取りに戻す。
    if (!ok) dispatch({ type: 'aiFailed', now: deps.now() });
  }

  function onAiEvent(event: AiEvent): void {
    const now = deps.now();
    switch (event) {
      case 'started':
        utter = emptyUtterance();
        dispatch({ type: 'aiStarted' });
        break;
      case 'firstAudio':
        dispatch({ type: 'aiFirstAudio' });
        break;
      case 'drained':
        dispatch({ type: 'aiDrained' });
        break;
      case 'interrupted':
        dispatch({ type: 'aiInterrupted', now });
        break;
      case 'failed':
        dispatch({ type: 'aiFailed', now });
        break;
    }
  }

  function teardown(): void {
    for (const name of [...timers.keys()]) clearTimer(name);
    closeSegment();
    closeMic();
    unsubscribeAi?.();
    unsubscribeAi = null;
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      deps.unlockAudio();
      unsubscribeAi = host.subscribeAi(onAiEvent);
      if (settings.micMode === 'keepOpen') {
        ensureMic();
      } else {
        // マイク許可のダイアログを開始タップの直後に出しておく（話したいときに待たされないように）。
        deps.openMic({ onChunk: () => {} }).then(
          (m) => m.close(),
          (err: unknown) =>
            host.notify(`マイクを使えませんでした（${err instanceof Error ? err.message : String(err)}）。`),
        );
      }
      dispatch({ type: 'begin' });
      host.beginDialogue();
    },
    sendNow() {
      dispatch({ type: 'sendTap' });
    },
    interrupt() {
      dispatch({ type: 'interruptTap' });
    },
    pause() {
      dispatch({ type: 'pause', reason: 'user' });
    },
    resume() {
      host.notify(null);
      dispatch({ type: 'resumeTap', now: deps.now() });
    },
    hold(reason) {
      dispatch({ type: 'hold', reason });
    },
    release(reason) {
      dispatch({ type: 'release', reason, now: deps.now() });
    },
    stop() {
      if (disposed) return;
      dispatch({ type: 'stop' });
      teardown();
      disposed = true;
    },
    updateSettings(partial) {
      settings = { ...settings, ...partial };
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getView() {
      return view;
    },
  };
}
