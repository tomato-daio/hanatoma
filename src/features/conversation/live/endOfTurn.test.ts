import { describe, expect, it } from 'vitest';
import {
  classifyCompleteness,
  computeThinkingMs,
  endOfTurnWaitMs,
  END_OF_TURN_WAIT_MS,
  parsePatience,
} from './endOfTurn';

describe('classifyCompleteness', () => {
  it('?や!で終わる文は言い終わり', () => {
    expect(classifyCompleteness('Can I have a coffee?')).toBe('complete');
    expect(classifyCompleteness('Really!')).toBe('complete');
  });

  it('Azureが付ける末尾ピリオドは手がかりにしない（言いかけ語で終わればincomplete）', () => {
    expect(classifyCompleteness('I went to the station and.')).toBe('incomplete');
    expect(classifyCompleteness('I would like to.')).toBe('incomplete');
    expect(classifyCompleteness('Because.')).toBe('incomplete');
  });

  it('カンマ・三点リーダで終わるとincomplete', () => {
    expect(classifyCompleteness('Well, I think,')).toBe('incomplete');
    expect(classifyCompleteness('I was thinking...')).toBe('incomplete');
  });

  it('フィラーで終わるとincomplete', () => {
    expect(classifyCompleteness('I want the, um.')).toBe('incomplete');
  });

  it('定型の短い返事はcomplete（言いかけ語を含んでも定型を優先）', () => {
    expect(classifyCompleteness('Yes.')).toBe('complete');
    expect(classifyCompleteness('Thank you.')).toBe('complete');
    expect(classifyCompleteness('Not really.')).toBe('complete');
    expect(classifyCompleteness('I think so.')).toBe('complete');
  });

  it('6語以上で言いかけ語で終わらなければcomplete', () => {
    expect(classifyCompleteness('I would like a cup of coffee.')).toBe('complete');
  });

  it('短い答えはneutral', () => {
    expect(classifyCompleteness('Two coffees, please.')).toBe('neutral');
    expect(classifyCompleteness('Tokyo.')).toBe('neutral');
  });

  it('空はincomplete', () => {
    expect(classifyCompleteness('   ')).toBe('incomplete');
  });
});

describe('endOfTurnWaitMs', () => {
  it('標準は分類ごとの既定値', () => {
    expect(endOfTurnWaitMs('Can I pay by card?', 'normal')).toBe(END_OF_TURN_WAIT_MS.complete);
    expect(endOfTurnWaitMs('Tokyo.', 'normal')).toBe(END_OF_TURN_WAIT_MS.neutral);
    expect(endOfTurnWaitMs('I want to.', 'normal')).toBe(END_OF_TURN_WAIT_MS.incomplete);
  });

  it('短め・長めは倍率がかかる', () => {
    expect(endOfTurnWaitMs('Tokyo.', 'short')).toBe(600);
    expect(endOfTurnWaitMs('Tokyo.', 'long')).toBe(1600);
  });

  it('手動は自動確定しない(null)', () => {
    expect(endOfTurnWaitMs('Can I pay by card?', 'manual')).toBeNull();
  });
});

describe('parsePatience', () => {
  it('正しい値はそのまま・それ以外は標準', () => {
    expect(parsePatience('long')).toBe('long');
    expect(parsePatience('manual')).toBe('manual');
    expect(parsePatience(undefined)).toBe('normal');
    expect(parsePatience(3)).toBe('normal');
  });
});

describe('computeThinkingMs', () => {
  it('聞き取り開始から話し始め（区間開始＋音声オフセット）まで', () => {
    expect(computeThinkingMs({ listenStartAt: 1000, segmentAudioStartAt: 1000, speechOffsetMs: 1800 })).toBe(1800);
  });

  it('一時停止をはさんだ後の区間でも、区間開始時刻を足して求める', () => {
    expect(computeThinkingMs({ listenStartAt: 1000, segmentAudioStartAt: 4000, speechOffsetMs: 500 })).toBe(3500);
  });

  it('負にはならない', () => {
    expect(computeThinkingMs({ listenStartAt: 5000, segmentAudioStartAt: 1000, speechOffsetMs: 0 })).toBe(0);
  });
});
