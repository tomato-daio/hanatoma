import { describe, expect, it } from 'vitest';
import { shouldDropSegmentation } from './azureStt';

describe('shouldDropSegmentation', () => {
  it('区切り指定付きで、認識結果の前に接続エラーなら区切り指定をやめる', () => {
    expect(shouldDropSegmentation({ usedCustomSegmentation: true, sawRecognitionEvent: false, connectionError: true })).toBe(true);
  });

  it('認識結果を受け取った後のエラー・区切り指定なし・接続以外のエラーではやめない', () => {
    expect(shouldDropSegmentation({ usedCustomSegmentation: true, sawRecognitionEvent: true, connectionError: true })).toBe(false);
    expect(shouldDropSegmentation({ usedCustomSegmentation: false, sawRecognitionEvent: false, connectionError: true })).toBe(false);
    expect(shouldDropSegmentation({ usedCustomSegmentation: true, sawRecognitionEvent: false, connectionError: false })).toBe(false);
  });
});
