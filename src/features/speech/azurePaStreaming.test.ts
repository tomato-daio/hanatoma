import { describe, expect, it } from 'vitest';
import {
  canSalvagePartial,
  FINISH_TIMEOUT_MAX_MS,
  FINISH_TIMEOUT_NO_EVIDENCE_MS,
  FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS,
  FINISH_TIMEOUT_WITH_EVIDENCE_MS,
  finishTimeoutMs,
  nextSessionState,
  NUDGE_AFTER_CLOSE_MS,
  pcmBytesToSeconds,
  resolveFinishSalvage,
  SALVAGE_MAX_UNCOVERED_TAIL_SEC,
  START_TIMEOUT_MS,
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
  it('認識イベントの証拠があれば長く待ち、無ければモードによらず短く見切る', () => {
    expect(finishTimeoutMs('unscripted', true)).toBe(FINISH_TIMEOUT_WITH_EVIDENCE_MS);
    expect(finishTimeoutMs('scripted', true)).toBe(FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS);
    expect(finishTimeoutMs('unscripted', false)).toBe(FINISH_TIMEOUT_NO_EVIDENCE_MS);
    expect(finishTimeoutMs('scripted', false)).toBe(FINISH_TIMEOUT_NO_EVIDENCE_MS);
    expect(FINISH_TIMEOUT_NO_EVIDENCE_MS).toBeLessThan(FINISH_TIMEOUT_WITH_EVIDENCE_MS);
  });

  it('タイムアウトは短縮済み（旧45秒→8秒。batchは自由会話で無力なため確定を粘って待つ）', () => {
    // 45秒は「タイムアウト待ち→batch再認識」で~70秒固まる原因だった。8秒で見切り＋サルベージ。
    expect(FINISH_TIMEOUT_WITH_EVIDENCE_MS).toBe(8_000);
    expect(FINISH_TIMEOUT_NO_EVIDENCE_MS).toBe(3_000);
    expect(FINISH_TIMEOUT_WITH_EVIDENCE_MS).toBeLessThan(45_000);
  });

  it('unscriptedは音声長に連動して待つ（8秒下限・13秒上限。F0の確定遅延は音声長に比例）', () => {
    expect(finishTimeoutMs('unscripted', true, 3.4)).toBe(FINISH_TIMEOUT_WITH_EVIDENCE_MS);
    expect(finishTimeoutMs('unscripted', true, 12.7)).toBe(12_700);
    expect(finishTimeoutMs('unscripted', true, 40)).toBe(FINISH_TIMEOUT_MAX_MS);
    // 全体デッドライン（submitVoiceの15秒）を超えない上限であること
    expect(FINISH_TIMEOUT_MAX_MS).toBeLessThan(15_000);
    // scriptedは音声長に関係なく短い上限のまま（スコアが成果物・batchも短文なら実用的）
    expect(finishTimeoutMs('scripted', true, 12.7)).toBe(FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS);
    // 証拠なし（WS沈黙死の疑い）は音声長に関係なく即見切る
    expect(finishTimeoutMs('unscripted', false, 12.7)).toBe(FINISH_TIMEOUT_NO_EVIDENCE_MS);
  });

  it('scriptedはunscriptedより短い（短文で確定が速く、batchフォールバックも実用的なため）', () => {
    expect(FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS).toBe(4_000);
    expect(FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS).toBeLessThan(FINISH_TIMEOUT_WITH_EVIDENCE_MS);
  });

  it('nudge（close後の能動stop）はscriptedの確定待ちより前に発火する（不変条件）', () => {
    expect(NUDGE_AFTER_CLOSE_MS).toBeLessThan(FINISH_TIMEOUT_SCRIPTED_WITH_EVIDENCE_MS);
  });

  it('認識開始タイムアウトはsessionPromiseの無期限化を防ぐ有限値', () => {
    expect(START_TIMEOUT_MS).toBe(10_000);
  });
});

describe('resolveFinishSalvage', () => {
  const phrase = (seconds: number) => ({ durationTicks: seconds * 1e7 });
  const base = {
    mode: 'unscripted' as const,
    timedOut: true,
    phrases: [] as { durationTicks: number }[],
    audioSeconds: 6,
    lastPartialText: '',
    lastPartialEndSec: 0,
  };

  it('非タイムアウト・フレーズあり → scores（従来の正常確定）', () => {
    expect(resolveFinishSalvage({ ...base, timedOut: false, phrases: [phrase(5)] })).toEqual({
      kind: 'scores',
    });
  });

  it('非タイムアウト・フレーズ0件 → throw-no-result（無音等）', () => {
    expect(resolveFinishSalvage({ ...base, timedOut: false })).toEqual({ kind: 'throw-no-result' });
  });

  it('タイムアウト・フレーズ0件・新鮮な部分テキストあり → text-only（会話継続の最終サルベージ）', () => {
    expect(
      resolveFinishSalvage({ ...base, lastPartialText: ' hello there ', lastPartialEndSec: 5.5 }),
    ).toEqual({ kind: 'text-only', text: 'hello there' });
  });

  it('タイムアウト・フレーズ0件・部分テキストなし → throw-timeout（従来どおりbatchへ）', () => {
    expect(resolveFinishSalvage(base)).toEqual({ kind: 'throw-timeout' });
  });

  it('部分テキストの鮮度切れ（末尾が閾値超に欠落）→ text-onlyにしない（不完全発話への返信事故防止）', () => {
    // 音声10s・部分テキストのカバー末尾5s → 尻尾5s > SALVAGE_MAX_UNCOVERED_TAIL_SEC(3s)
    expect(
      resolveFinishSalvage({
        ...base,
        audioSeconds: 10,
        lastPartialText: 'stale text',
        lastPartialEndSec: 5,
      }),
    ).toEqual({ kind: 'throw-timeout' });
  });

  it('未カバー末尾ちょうど閾値ぶんは新鮮扱い（inclusive・canSalvagePartialと対称）', () => {
    // 音声6s・カバー末尾3s → 尻尾3s == SALVAGE_MAX_UNCOVERED_TAIL_SEC → fresh
    expect(
      resolveFinishSalvage({ ...base, lastPartialText: 'boundary text', lastPartialEndSec: 3 }),
    ).toEqual({ kind: 'text-only', text: 'boundary text' });
  });

  it('空白のみの部分テキストは無いものとして扱う（throw-timeout）', () => {
    expect(resolveFinishSalvage({ ...base, lastPartialText: '   ', lastPartialEndSec: 5.8 })).toEqual({
      kind: 'throw-timeout',
    });
  });

  it('scriptedはフレーズあり・末尾大欠けでもscores-with-tailに昇格しない（timeoutで返す。短文なのでbatchは走る）', () => {
    expect(
      resolveFinishSalvage({
        ...base,
        mode: 'scripted',
        audioSeconds: 10,
        phrases: [phrase(2)],
        lastPartialText: 'fresh tail',
        lastPartialEndSec: 9.5,
      }),
    ).toEqual({ kind: 'throw-timeout' });
  });

  it('scriptedは部分テキストがあっても救済しない（スコアが成果物）', () => {
    expect(
      resolveFinishSalvage({
        ...base,
        mode: 'scripted',
        lastPartialText: 'the key phrase',
        lastPartialEndSec: 5.8,
      }),
    ).toEqual({ kind: 'throw-timeout' });
  });

  it('タイムアウト・フレーズあり・末尾カバー良好 → scores（従来のスコア付きサルベージ）', () => {
    expect(resolveFinishSalvage({ ...base, phrases: [phrase(4)] })).toEqual({ kind: 'scores' });
  });

  it('タイムアウト・フレーズあり・末尾大欠け・新鮮な部分テキストあり → scores-with-tail（尻尾を補完）', () => {
    // 音声10s / フレーズカバー2s → 未カバー8s > 3s。部分テキストは末尾9.5sまでカバー → 新鮮
    expect(
      resolveFinishSalvage({
        ...base,
        audioSeconds: 10,
        phrases: [phrase(2)],
        lastPartialText: ' and the tail ',
        lastPartialEndSec: 9.5,
      }),
    ).toEqual({ kind: 'scores-with-tail', tailText: 'and the tail' });
  });

  it('タイムアウト・フレーズあり・末尾大欠け・部分テキストなし → throw-timeout（batchも間に合わないので見送らせる）', () => {
    // Azureが末尾を処理中のまま時間切れ。同じ音声を送り直すbatchは残り時間で完了しない実測のため、
    // no-result（=batchへ）ではなくtimeout種別で返し、shouldSkipBatchでbatchを飛ばさせる。
    expect(resolveFinishSalvage({ ...base, audioSeconds: 10, phrases: [phrase(2)] })).toEqual({
      kind: 'throw-timeout',
    });
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
