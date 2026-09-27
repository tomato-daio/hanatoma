/**
 * ハンズフリー会話のReactフック（DESIGN.md §5・M13）。
 * liveTalkController を画面の寿命に合わせて作成・破棄し、表示用の状態（LiveView）を返す。
 * 設定（話し終わりの待ち時間・マイク方式）は appState から読み込んで反映する。
 */

import { useEffect, useRef, useState } from 'react';
import { getAppState } from '../../../lib/db';
import { MIC_MODE_APP_STATE_KEY, parseMicMode } from '../../recorder/micSession';
import type { UseConversationResult } from '../useConversation';
import { END_OF_TURN_PATIENCE_APP_STATE_KEY, parsePatience } from './endOfTurn';
import type { HoldReason } from './liveMachine';
import { createLiveTalkController, type LiveHost, type LiveTalkController, type LiveView } from './liveTalkController';

const INITIAL_VIEW: LiveView = {
  phase: 'off',
  paused: null,
  holds: [],
  finals: '',
  partial: '',
  level: 0,
  sttReady: false,
  started: false,
  manualSend: false,
};

export interface LiveTalkActions {
  start(): void;
  sendNow(): void;
  interrupt(): void;
  pause(): void;
  resume(): void;
  hold(reason: HoldReason): void;
  release(reason: HoldReason): void;
  stop(): void;
}

export function useLiveTalk(conv: UseConversationResult): { view: LiveView; actions: LiveTalkActions } {
  const [view, setView] = useState<LiveView>(INITIAL_VIEW);
  const controllerRef = useRef<LiveTalkController | null>(null);
  // コントローラからは常に最新の会話フックの関数を呼ぶ（再生成で古いクロージャを掴まないように）。
  const convRef = useRef(conv);
  convRef.current = conv;

  useEffect(() => {
    const host: LiveHost = {
      beginDialogue: () => convRef.current.beginDialogue(),
      submitUtterance: (u) => convRef.current.submitUtterance(u),
      interruptAi: () => convRef.current.interruptAi(),
      subscribeAi: (l) => convRef.current.subscribeAi(l),
      phraseHintsNow: () => convRef.current.phraseHintsNow(),
      speech: {
        canListen: () => convRef.current.speech.canListen(),
        addSeconds: (s) => convRef.current.speech.addSeconds(s),
      },
      notify: (m) => convRef.current.setInfo(m),
    };
    const controller = createLiveTalkController(host);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(() => setView(controller.getView()));
    setView(controller.getView());

    void Promise.all([getAppState(END_OF_TURN_PATIENCE_APP_STATE_KEY), getAppState(MIC_MODE_APP_STATE_KEY)]).then(
      ([patience, micMode]) => {
        controller.updateSettings({ patience: parsePatience(patience), micMode: parseMicMode(micMode) });
      },
    );

    // アプリが裏に回ったら聞き取りを止める（iOSはバックグラウンドでマイクを止めるため）。
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') controller.hold('background');
      else controller.release('background');
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  // ひとくち英会話は1往復で止める。
  const mode = conv.mode;
  useEffect(() => {
    controllerRef.current?.updateSettings({ userTurnLimit: mode === 'bite' ? 1 : null });
  }, [mode, view.started]);

  const actionsRef = useRef<LiveTalkActions>({
    start: () => controllerRef.current?.start(),
    sendNow: () => controllerRef.current?.sendNow(),
    interrupt: () => controllerRef.current?.interrupt(),
    pause: () => controllerRef.current?.pause(),
    resume: () => controllerRef.current?.resume(),
    hold: (r) => controllerRef.current?.hold(r),
    release: (r) => controllerRef.current?.release(r),
    stop: () => controllerRef.current?.stop(),
  });

  return { view, actions: actionsRef.current };
}
