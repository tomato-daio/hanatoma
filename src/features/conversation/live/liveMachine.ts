/**
 * ハンズフリー会話のターン交代の状態機械（DESIGN.md §5・M13。純関数・Vitest必須）。
 *
 * reducer は (状態, イベント) → (新状態, 副作用の指示[]) を返すだけで、I/O（マイク・Azure・
 * タイマー・AI）は一切触らない。副作用の実行は liveTalkController.ts が担う。
 *
 * 流れ: AI発話(aiThinking→aiSpeaking) → 全再生完了(aiDrained) → 150msの待ち(resume)
 *   → 聞き取り(listening) → 部分認識(hearing) → 確定文(endpointing) → 待ち時間W経過で確定(commit)
 *   → AI発話 …
 * 一時停止は2種類:
 *   - holds  : 自動で戻る一時停止（ヒント音声の再生中・テキスト入力中・アプリがバックグラウンド）
 *   - paused : 「再開」タップで戻る一時停止（ユーザー操作・20秒無音・認識エラー・マイク停止・上限）
 * どちらかがある間は聞き取らない（STTを閉じる＝Azureの無料枠を消費しない・自分のTTSを拾わない）。
 */

import { computeThinkingMs, endOfTurnWaitMs, type EndOfTurnPatience } from './endOfTurn';

export type HoldReason = 'hint' | 'text' | 'background';
export type PauseReason = 'user' | 'idle' | 'error' | 'mic' | 'cap';

export type LivePhase =
  | 'off' // 対話開始前
  | 'aiThinking' // AIが返答を生成中（まだ音声なし）
  | 'aiSpeaking' // AIの音声を再生中
  | 'waiting' // 聞き取りの番だが一時停止中（holds/paused）
  | 'listening' // 聞き取り中・まだ発話なし
  | 'hearing' // ユーザーが話している（部分認識あり）
  | 'endpointing' // 確定文あり・話し終わりを待っている
  | 'committing' // 「送信」タップ後、最後の確定を待っている
  | 'stopped'; // 会話終了（ひとくちの1往復完了・終了操作）

export type LiveTimer = 'eot' | 'idle' | 'resume';

export interface LiveConfig {
  patience: EndOfTurnPatience;
  /** ユーザー発話の上限回数（ひとくち=1）。到達後、AIが話し終えたら停止する。nullは無制限。 */
  userTurnLimit: number | null;
  /** 発話がないまま聞き取りを続ける上限（Azure無料枠の節約）。 */
  idleMs: number;
  /** AIの音声が終わってから聞き取りを始めるまでの待ち（スピーカーの残響を拾わない）。 */
  resumeGuardMs: number;
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  patience: 'normal',
  userTurnLimit: null,
  idleMs: 20_000,
  resumeGuardMs: 150,
};

export interface LiveState {
  phase: LivePhase;
  holds: HoldReason[];
  paused: PauseReason | null;
  /** STTセッションを開いている（openStt発行済み・closeStt未発行）。 */
  sttOpen: boolean;
  /** このターンで確定した文（Azureの無音区切りごと）。 */
  finals: string[];
  /** 未確定の部分認識（字幕の灰色部分）。 */
  partial: string;
  /** このターンの聞き取りを始めた時刻（thinkingMsの起点）。 */
  listenStartAt: number | null;
  thinkingMs: number | null;
  /** 最後に聞こえた発話の終端（壁時計の推定。レイテンシ計測用）。 */
  speechEndAt: number | null;
  /** 確定して送ったユーザー発話の数。 */
  userTurns: number;
}

export const INITIAL_LIVE_STATE: LiveState = {
  phase: 'off',
  holds: [],
  paused: null,
  sttOpen: false,
  finals: [],
  partial: '',
  listenStartAt: null,
  thinkingMs: null,
  speechEndAt: null,
  userTurns: 0,
};

export type LiveEffect =
  | { type: 'openStt' }
  | { type: 'closeStt' }
  /** 音声の送信を締めて最後の確定を待つ（完了したら sttFinished を返すこと）。 */
  | { type: 'finishStt' }
  | { type: 'setTimer'; timer: LiveTimer; ms: number }
  | { type: 'clearTimer'; timer: LiveTimer }
  | { type: 'commit'; text: string; thinkingMs: number | null; speechEndAt: number | null }
  | { type: 'interruptAi' }
  | { type: 'stopped' };

/** 認識イベントの時刻情報。segmentAudioStartAt=このSTTセッションの音声先頭の壁時計。 */
interface RecognitionTiming {
  segmentAudioStartAt: number;
  offsetMs: number;
  durationMs: number;
}

export type LiveEvent =
  | { type: 'begin' }
  | { type: 'aiStarted' }
  | { type: 'aiFirstAudio' }
  | { type: 'aiDrained' }
  | { type: 'aiInterrupted'; now: number }
  | { type: 'aiFailed'; now: number }
  | { type: 'timer'; timer: LiveTimer; now: number }
  | ({ type: 'partial'; text: string } & RecognitionTiming)
  | ({ type: 'final'; text: string } & RecognitionTiming)
  | { type: 'sttFinished'; now: number }
  | { type: 'sttError' }
  | { type: 'sendTap' }
  | { type: 'interruptTap' }
  | { type: 'hold'; reason: HoldReason }
  | { type: 'release'; reason: HoldReason; now: number }
  | { type: 'pause'; reason: PauseReason }
  | { type: 'resumeTap'; now: number }
  | { type: 'stop' };

export interface LiveTransition {
  state: LiveState;
  effects: LiveEffect[];
}

const LISTEN_PHASES: ReadonlySet<LivePhase> = new Set(['listening', 'hearing', 'endpointing', 'committing']);
const AI_PHASES: ReadonlySet<LivePhase> = new Set(['aiThinking', 'aiSpeaking']);

export function isListeningPhase(phase: LivePhase): boolean {
  return LISTEN_PHASES.has(phase);
}

export function isAiPhase(phase: LivePhase): boolean {
  return AI_PHASES.has(phase);
}

function isBlocked(state: LiveState): boolean {
  return state.holds.length > 0 || state.paused !== null;
}

/** 字幕に出すこのターンの聞き取りテキスト（確定文＋部分認識）。 */
export function captionOf(state: Pick<LiveState, 'finals' | 'partial'>): { finals: string; partial: string } {
  return { finals: state.finals.join(' '), partial: state.partial };
}

const same = (state: LiveState): LiveTransition => ({ state, effects: [] });

/** 新しいユーザーターンの聞き取りを始める（AIが話し終えた後）。 */
function startTurn(state: LiveState, now: number, config: LiveConfig): LiveTransition {
  const fresh: LiveState = {
    ...state,
    finals: [],
    partial: '',
    listenStartAt: now,
    thinkingMs: null,
    speechEndAt: null,
  };
  if (isBlocked(fresh)) {
    return { state: { ...fresh, phase: 'waiting', sttOpen: false }, effects: [] };
  }
  return {
    state: { ...fresh, phase: 'listening', sttOpen: true },
    effects: [{ type: 'openStt' }, { type: 'setTimer', timer: 'idle', ms: config.idleMs }],
  };
}

/** 一時停止から聞き取りを再開する（このターンの確定文は引き継ぐ）。 */
function reopen(state: LiveState, now: number, config: LiveConfig): LiveTransition {
  const base: LiveState = { ...state, sttOpen: true, listenStartAt: state.listenStartAt ?? now };
  if (base.finals.length > 0) {
    const wait = endOfTurnWaitMs(base.finals.join(' '), config.patience);
    return {
      state: { ...base, phase: 'endpointing' },
      effects: [{ type: 'openStt' }, ...(wait !== null ? [{ type: 'setTimer', timer: 'eot', ms: wait } as const] : [])],
    };
  }
  return {
    state: { ...base, phase: 'listening' },
    effects: [{ type: 'openStt' }, { type: 'setTimer', timer: 'idle', ms: config.idleMs }],
  };
}

/** 聞き取りを止めて一時停止状態へ（未確定の部分認識は確定文として残す）。 */
function suspend(state: LiveState): LiveTransition {
  if (!isListeningPhase(state.phase)) return same(state);
  const finals = state.partial.trim() ? [...state.finals, state.partial.trim()] : state.finals;
  return {
    state: { ...state, phase: 'waiting', sttOpen: false, finals, partial: '' },
    effects: [
      { type: 'clearTimer', timer: 'eot' },
      { type: 'clearTimer', timer: 'idle' },
      { type: 'closeStt' },
    ],
  };
}

/** ユーザーのターンを確定してAIへ渡す。 */
function commit(state: LiveState, includePartial: boolean): LiveTransition {
  const parts = includePartial && state.partial.trim() ? [...state.finals, state.partial.trim()] : state.finals;
  const text = parts.join(' ').trim();
  const effects: LiveEffect[] = [
    { type: 'clearTimer', timer: 'eot' },
    { type: 'clearTimer', timer: 'idle' },
  ];
  if (state.sttOpen) effects.push({ type: 'closeStt' });
  effects.push({ type: 'commit', text, thinkingMs: state.thinkingMs, speechEndAt: state.speechEndAt });
  return {
    state: {
      ...state,
      phase: 'aiThinking',
      sttOpen: false,
      finals: [],
      partial: '',
      userTurns: state.userTurns + 1,
    },
    effects,
  };
}

function withTiming(state: LiveState, timing: RecognitionTiming): LiveState {
  const thinkingMs =
    state.thinkingMs ??
    (state.listenStartAt !== null
      ? computeThinkingMs({
          listenStartAt: state.listenStartAt,
          segmentAudioStartAt: timing.segmentAudioStartAt,
          speechOffsetMs: timing.offsetMs,
        })
      : null);
  return {
    ...state,
    thinkingMs,
    speechEndAt: timing.segmentAudioStartAt + timing.offsetMs + timing.durationMs,
  };
}

export function liveReducer(state: LiveState, event: LiveEvent, config: LiveConfig): LiveTransition {
  if (state.phase === 'stopped') return same(state);

  switch (event.type) {
    case 'begin':
      return state.phase === 'off' ? same({ ...state, phase: 'aiThinking' }) : same(state);

    case 'aiStarted': {
      if (isAiPhase(state.phase)) return same(state);
      // 聞き取り中にテキスト送信等でAIが始まった場合は、聞き取りを閉じてAIの番にする。
      const effects: LiveEffect[] = [
        { type: 'clearTimer', timer: 'eot' },
        { type: 'clearTimer', timer: 'idle' },
        { type: 'clearTimer', timer: 'resume' },
      ];
      if (state.sttOpen) effects.push({ type: 'closeStt' });
      return {
        state: { ...state, phase: 'aiThinking', sttOpen: false, finals: [], partial: '' },
        effects,
      };
    }

    case 'aiFirstAudio':
      return state.phase === 'aiThinking' ? same({ ...state, phase: 'aiSpeaking' }) : same(state);

    case 'aiDrained': {
      if (!isAiPhase(state.phase)) return same(state);
      if (config.userTurnLimit !== null && state.userTurns >= config.userTurnLimit) {
        return { state: { ...state, phase: 'stopped' }, effects: [{ type: 'stopped' }] };
      }
      return { state, effects: [{ type: 'setTimer', timer: 'resume', ms: config.resumeGuardMs }] };
    }

    case 'aiInterrupted':
    case 'aiFailed':
      if (!isAiPhase(state.phase)) return same(state);
      if (event.type === 'aiInterrupted' && config.userTurnLimit !== null && state.userTurns >= config.userTurnLimit) {
        return { state: { ...state, phase: 'stopped' }, effects: [{ type: 'stopped' }] };
      }
      return startTurn(state, event.now, config);

    case 'timer':
      switch (event.timer) {
        case 'resume':
          return isAiPhase(state.phase) ? startTurn(state, event.now, config) : same(state);
        case 'eot':
          return state.phase === 'endpointing' && state.finals.length > 0 ? commit(state, false) : same(state);
        case 'idle':
          if (state.phase === 'listening' && state.finals.length === 0 && !state.partial) {
            return {
              state: { ...state, phase: 'waiting', paused: 'idle', sttOpen: false },
              effects: [{ type: 'closeStt' }],
            };
          }
          // 手動送信の設定で、話した後に送信されないまま黙っている: 確定文は残して一時停止する。
          if (state.phase === 'endpointing') return suspend({ ...state, paused: 'idle' });
          return same(state);
      }
      return same(state);

    case 'partial': {
      if (!isListeningPhase(state.phase) || !event.text.trim()) return same(state);
      const next = withTiming({ ...state, partial: event.text.trim() }, event);
      if (state.phase === 'committing') return same(next);
      return {
        state: { ...next, phase: 'hearing' },
        effects: [
          { type: 'clearTimer', timer: 'eot' },
          { type: 'clearTimer', timer: 'idle' },
        ],
      };
    }

    case 'final': {
      if (!isListeningPhase(state.phase)) return same(state);
      const text = event.text.trim();
      if (!text) {
        // 雑音等で何も認識されなかった区切り。
        const cleared = { ...state, partial: '' };
        if (state.phase === 'committing') return same(cleared);
        if (cleared.finals.length === 0) {
          return {
            state: { ...cleared, phase: 'listening' },
            effects: [{ type: 'setTimer', timer: 'idle', ms: config.idleMs }],
          };
        }
        const wait = endOfTurnWaitMs(cleared.finals.join(' '), config.patience);
        return {
          state: { ...cleared, phase: 'endpointing' },
          effects: wait !== null ? [{ type: 'setTimer', timer: 'eot', ms: wait }] : [],
        };
      }
      const next = withTiming({ ...state, finals: [...state.finals, text], partial: '' }, event);
      if (state.phase === 'committing') return same(next);
      const wait = endOfTurnWaitMs(next.finals.join(' '), config.patience);
      // 手動送信（wait=null）は自動確定しない代わりに、黙ったままなら一時停止してAzureの消費を止める。
      const effects: LiveEffect[] =
        wait !== null
          ? [
              { type: 'clearTimer', timer: 'idle' },
              { type: 'setTimer', timer: 'eot', ms: wait },
            ]
          : [{ type: 'setTimer', timer: 'idle', ms: config.idleMs }];
      return { state: { ...next, phase: 'endpointing' }, effects };
    }

    case 'sttFinished': {
      if (state.phase !== 'committing') return same(state);
      if (state.finals.length > 0 || state.partial.trim()) return commit(state, true);
      // 何も聞き取れていなかった: そのまま聞き取りを続ける。
      return reopen({ ...state, sttOpen: false }, event.now, config);
    }

    case 'sttError': {
      if (!state.sttOpen) return same(state);
      if (state.phase === 'committing' && (state.finals.length > 0 || state.partial.trim())) {
        return commit(state, true);
      }
      const suspended = suspend(state);
      return {
        state: { ...suspended.state, paused: 'error', sttOpen: false },
        effects: suspended.effects,
      };
    }

    case 'sendTap':
      switch (state.phase) {
        case 'hearing':
          return {
            state: { ...state, phase: 'committing' },
            effects: [
              { type: 'clearTimer', timer: 'eot' },
              { type: 'clearTimer', timer: 'idle' },
              { type: 'finishStt' },
            ],
          };
        case 'endpointing':
          return commit(state, false);
        case 'waiting':
          return state.finals.length > 0 ? commit({ ...state, paused: null }, false) : same(state);
        default:
          return same(state);
      }

    case 'interruptTap':
      return isAiPhase(state.phase)
        ? { state, effects: [{ type: 'clearTimer', timer: 'resume' }, { type: 'interruptAi' }] }
        : same(state);

    case 'hold': {
      if (state.holds.includes(event.reason)) return same(state);
      const next = { ...state, holds: [...state.holds, event.reason] };
      return isListeningPhase(state.phase) ? suspend(next) : same(next);
    }

    case 'release': {
      if (!state.holds.includes(event.reason)) return same(state);
      const next = { ...state, holds: state.holds.filter((h) => h !== event.reason) };
      return next.phase === 'waiting' && !isBlocked(next) ? reopen(next, event.now, config) : same(next);
    }

    case 'pause': {
      const next = { ...state, paused: event.reason };
      return isListeningPhase(state.phase) ? suspend(next) : same(next);
    }

    case 'resumeTap': {
      if (state.paused === null) return same(state);
      const wasIdle = state.paused === 'idle';
      const next: LiveState = {
        ...state,
        paused: null,
        // 20秒無音で止まった後の再開は、考える時間を再開時点から数え直す。
        ...(wasIdle ? { listenStartAt: event.now, thinkingMs: null } : {}),
      };
      return next.phase === 'waiting' && !isBlocked(next) ? reopen(next, event.now, config) : same(next);
    }

    case 'stop':
      return {
        state: { ...state, phase: 'stopped', sttOpen: false },
        effects: [
          { type: 'clearTimer', timer: 'eot' },
          { type: 'clearTimer', timer: 'idle' },
          { type: 'clearTimer', timer: 'resume' },
          ...(state.sttOpen ? [{ type: 'closeStt' } as const] : []),
          { type: 'stopped' },
        ],
      };
  }
}
