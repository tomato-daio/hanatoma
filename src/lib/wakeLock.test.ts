import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWakeLockController } from './wakeLock';

/** documentのvisibilityStateを変更し、visibilitychangeイベントを発火する。 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * navigator.wakeLock.request のモックを作る。requestは常に同じsentinelを解決し、
 * emitRelease()でブラウザ側の自動解放（'release'イベント）を模擬できる。
 */
function createMockRequest() {
  const releaseListeners: Array<() => void> = [];
  const release = vi.fn(async () => {
    releaseListeners.forEach((cb) => cb());
  });
  const sentinel = {
    released: false,
    type: 'screen',
    onrelease: null,
    release,
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'release') releaseListeners.push(cb);
    },
    removeEventListener: vi.fn(),
  } as unknown as WakeLockSentinel;
  const emitRelease = () => releaseListeners.forEach((cb) => cb());
  const request = vi.fn(async () => sentinel);
  return { request, sentinel, release, emitRelease };
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWakeLockController: 非対応環境', () => {
  it('navigator.wakeLockが無い環境ではacquire/release/disposeを呼んでも例外にならない', async () => {
    vi.stubGlobal('navigator', {});
    const controller = createWakeLockController();

    await expect(controller.acquire()).resolves.toBeUndefined();
    expect(() => controller.release()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });
});

describe('createWakeLockController: acquire/release', () => {
  it('acquireでnavigator.wakeLock.request("screen")を呼ぶ', async () => {
    const { request } = createMockRequest();
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await controller.acquire();

    expect(request).toHaveBeenCalledWith('screen');
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('保持中に重ねてacquireしても2重にrequestしない', async () => {
    const { request } = createMockRequest();
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await controller.acquire();
    await controller.acquire();

    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('releaseで取得済みのロックをsentinel.release()で解放する', async () => {
    const { request, release } = createMockRequest();
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await controller.acquire();
    controller.release();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('未取得状態でreleaseしても例外にならない（冪等）', () => {
    vi.stubGlobal('navigator', { wakeLock: { request: vi.fn() } });
    const controller = createWakeLockController();

    expect(() => controller.release()).not.toThrow();
    expect(() => controller.release()).not.toThrow();
  });

  it('request()が失敗（reject）しても例外を投げず、機能に影響させない', async () => {
    const request = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await expect(controller.acquire()).resolves.toBeUndefined();
    controller.dispose();
  });

  it('acquireのrequest解決待ち中にreleaseされた場合、解決後のロックはすぐ手放す', async () => {
    let resolveRequest: (sentinel: WakeLockSentinel) => void = () => {};
    const release = vi.fn(async () => {});
    const sentinel = {
      released: false,
      type: 'screen',
      onrelease: null,
      release,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as WakeLockSentinel;
    const request = vi.fn(
      () =>
        new Promise<WakeLockSentinel>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    const acquiring = controller.acquire();
    controller.release(); // request()解決前にreleaseされるケース
    resolveRequest(sentinel);
    await acquiring;

    expect(release).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe('createWakeLockController: visibilitychangeでの再取得', () => {
  it('保持中にタブが非表示→表示に戻ると、ブラウザが自動解放したロックを再取得する', async () => {
    const { request, emitRelease } = createMockRequest();
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await controller.acquire();
    expect(request).toHaveBeenCalledTimes(1);

    // ブラウザがタブ非表示等の理由でロックを自動解放したケースを模す
    emitRelease();

    setVisibility('hidden');
    expect(request).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('release済み（保持を望んでいない）状態ではvisibilitychangeで再取得しない', async () => {
    const { request } = createMockRequest();
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await controller.acquire();
    controller.release();
    expect(request).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('disposeするとreleaseし、以後visibilitychangeが来ても再取得しない', async () => {
    const { request, release } = createMockRequest();
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const controller = createWakeLockController();
    await controller.acquire();
    controller.dispose();

    expect(release).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });
});
