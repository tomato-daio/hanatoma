import { describe, expect, it } from 'vitest';
import {
  canSalvagePartial,
  FINISH_TIMEOUT_NO_EVIDENCE_MS,
  FINISH_TIMEOUT_WITH_EVIDENCE_MS,
  finishTimeoutMs,
  nextSessionState,
  pcmBytesToSeconds,
  SALVAGE_MAX_UNCOVERED_TAIL_SEC,
  type StreamingSessionEvent,
  type StreamingSessionState,
} from './azurePaStreaming';

describe('nextSessionState', () => {
  it('connecting → connected → streaming', () => {
    expect(nextSessionState('connecting', 'connected')).toBe('streaming');
  });

  it('connecting/streamingのどちらからでもfinishRequestedでfinishingへ', () => {
    expect(nextSessionState('connecting', 'finishRequested')).toBe('finishing');
    expect(nextSessionState('streaming', 'finishRequested')).toBe('finishing');
  });

  it('settledOkはfinishingからのみdoneへ（それ以外は状態を変えない）', () => {
    expect(nextSessionState('finishing', 'settledOk')).toBe('done');
    expect(nextSessionState('streaming', 'settledOk')).toBe('streaming');
    expect(nextSessionState('connecting', 'settledOk')).toBe('connecting');
  });

  it('settledErrorはどの進行中状態からもfailedへ', () => {
    expect(nextSessionState('connecting', 'settledError')).toBe('failed');
    expect(nextSessionState('streaming', 'settledError')).toBe('failed');
    expect(nextSessionState('finishing', 'settledError')).toBe('failed');
  });

  it('abortRequestedはどの進行中状態からもabortedへ', () => {
    expect(nextSessionState('connecting', 'abortRequested')).toBe('aborted');
    expect(nextSessionState('streaming', 'abortRequested')).toBe('aborted');
    expect(nextSessionState('finishing', 'abortRequested')).toBe('aborted');
  });

  it('終端状態（done/failed/aborted）はどのイベントでも不変（abort冪等を含む）', () => {
    const terminals: StreamingSessionState[] = ['done', 'failed', 'aborted'];
    const events: StreamingSessionEvent[] = [
      'connected',
      'finishRequested',
      'settledOk',
      'settledError',
      'abortRequested',
    ];
    for (const s of terminals) {
      for (const e of events) {
        expect(nextSessionState(s, e)).toBe(s);
      }
    }
  });

  it('streamingでconnected（重複通知）は状態を変えない', () => {
    expect(nextSessionState('streaming', 'connected')).toBe('streaming');
  });
});

describe('finishTimeoutMs', () => {
  it('認識イベントの証拠があれば長く待ち、無ければ短く見切る', () => {
    expect(finishTimeoutMs(true)).toBe(FINISH_TIMEOUT_WITH_EVIDENCE_MS);
    expect(finishTimeoutMs(false)).toBe(FINISH_TIMEOUT_NO_EVIDENCE_MS);
    expect(FINISH_TIMEOUT_NO_EVIDENCE_MS).toBeLessThan(FINISH_TIMEOUT_WITH_EVIDENCE_MS);
  });

  it('タイムアウトは短縮済み（旧45秒→8秒。batchは自由会話で無力なため確定を粘って待つ）', () => {
    // 45秒は「タイムアウト待ち→batch再認識」で~70秒固まる原因だった。8秒で見切り＋サルベージ。
    expect(FINISH_TIMEOUT_WITH_EVIDENCE_MS).toBe(8_000);
    expect(FINISH_TIMEOUT_NO_EVIDENCE_MS).toBe(3_000);
    expect(FINISH_TIMEOUT_WITH_EVIDENCE_MS).toBeLessThan(45_000);
  });
});

describe('canSalvagePartial', () => {
  /** seconds → durationTicks（100ns単位=1秒あたり1e7）。 */
  const phrase = (seconds: number) => ({ durationTicks: seconds * 1e7 });

  it('フレーズ0件はサルベージ不可（batchへ）', () => {
    expect(canSalvagePartial([], 5)).toBe(false);
  });

  it('末尾の取りこぼしが閾値以内ならサルベージ可', () => {
    // 音声5.0s / カバー3.0s → 未カバー2.0s ≤ 3 → true
    expect(canSalvagePartial([phrase(1.5), phrase(1.5)], 5)).toBe(true);
  });

  it('末尾の取りこぼしが閾値超ならサルベージ不可（末尾切れの疑い→batch）', () => {
    // 音声10s / カバー2s → 未カバー8s > 3 → false
    expect(canSalvagePartial([phrase(2)], 10)).toBe(false);
  });

  it('未カバーちょうど閾値ぶんはサルベージ可（inclusive）', () => {
    // 音声5s / カバー2s → 未カバー3s == 閾値 → true
    expect(canSalvagePartial([phrase(2)], 5)).toBe(true);
    expect(SALVAGE_MAX_UNCOVERED_TAIL_SEC).toBe(3);
  });

  it('durationTicksの負値は0とみなす', () => {
    expect(canSalvagePartial([{ durationTicks: -100 }], 2)).toBe(true); // 未カバー2s ≤ 3
    expect(canSalvagePartial([{ durationTicks: -100 }], 10)).toBe(false); // 未カバー10s > 3
  });
});

describe('pcmBytesToSeconds', () => {
  it('16kHz mono PCM16は32000バイト=1秒', () => {
    expect(pcmBytesToSeconds(32000)).toBe(1);
    expect(pcmBytesToSeconds(0)).toBe(0);
    expect(pcmBytesToSeconds(48000)).toBeCloseTo(1.5, 10);
  });
});
