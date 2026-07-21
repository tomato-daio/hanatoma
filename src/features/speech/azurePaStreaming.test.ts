import { describe, expect, it } from 'vitest';
import {
  FINISH_TIMEOUT_NO_EVIDENCE_MS,
  FINISH_TIMEOUT_WITH_EVIDENCE_MS,
  finishTimeoutMs,
  nextSessionState,
  pcmBytesToSeconds,
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
});

describe('pcmBytesToSeconds', () => {
  it('16kHz mono PCM16は32000バイト=1秒', () => {
    expect(pcmBytesToSeconds(32000)).toBe(1);
    expect(pcmBytesToSeconds(0)).toBe(0);
    expect(pcmBytesToSeconds(48000)).toBeCloseTo(1.5, 10);
  });
});
