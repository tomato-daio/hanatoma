/**
 * 画面スリープ防止ユーティリティ（DESIGN.md §6 M11）。
 * iPhone Safariは画面が自動ロックされると録音・添削処理が止まってしまうため、
 * 録音中および提出の添削処理中はScreen Wake Lock API (`navigator.wakeLock.request('screen')`)
 * で画面の自動ロックを防ぐ。
 *
 * TypeScript 5.9のlib.dom.d.ts自体はWakeLock/WakeLockSentinel型を持つが、
 * navigator.wakeLockは実行時に存在しない場合がある（Android旧ブラウザ等）ため、
 * `'wakeLock' in navigator` で機能の有無を確認し、非対応環境では常に何もしない
 * （エラーを出さず、録音・添削自体には一切影響させない）。
 */

export interface WakeLockController {
  /**
   * ロックの保持を開始する（既に保持中なら何もしない）。
   * 非対応環境や取得失敗（NotAllowedError等）時も例外を投げず静かに諦める。
   */
  acquire: () => Promise<void>;
  /** ロックの保持をやめる（未保持なら何もしない）。冪等。 */
  release: () => void;
  /** 後始末。visibilitychangeの監視を止め、保持中なら解放する。以後acquireしても何もしない。 */
  dispose: () => void;
}

/**
 * WakeLockControllerを1つ生成する。呼び出し元（フック・ページ）が保持したい区間の
 * 開始/終了でacquire()/release()を呼ぶ。ブラウザはタブが非表示になると自動でロックを
 * 解放してしまうため、visibilitychangeで「保持したい状態(wanted)」であれば再取得する。
 */
export function createWakeLockController(): WakeLockController {
  let sentinel: WakeLockSentinel | null = null;
  // acquire()が呼ばれてrelease()/dispose()されていない間はtrue（visibilitychange再取得の判定用）。
  let wanted = false;
  let disposed = false;

  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  const acquire = async (): Promise<void> => {
    if (disposed) return;
    wanted = true;
    if (!supported || sentinel) return;
    try {
      const s = await navigator.wakeLock.request('screen');
      if (!wanted || disposed) {
        // request()待ち中にrelease()/dispose()された。取得できたロックはすぐ手放す。
        void s.release().catch(() => {});
        return;
      }
      sentinel = s;
      // OS側の事情（低電力モード等）でブラウザが勝手に解放することがあるため、参照だけ外しておく。
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null;
      });
    } catch {
      // NotAllowedError等は無視する。画面スリープ防止はあくまで付加的な機能で、
      // 録音・添削処理自体を失敗させてはならない。
    }
  };

  const release = (): void => {
    wanted = false;
    const current = sentinel;
    sentinel = null;
    if (current) {
      void current.release().catch(() => {
        // 既に解放済み等は無視する
      });
    }
  };

  const handleVisibilityChange = (): void => {
    if (wanted && !disposed && document.visibilityState === 'visible') {
      void acquire();
    }
  };

  if (supported) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  const dispose = (): void => {
    disposed = true;
    if (supported) {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    release();
  };

  return { acquire, release, dispose };
}
