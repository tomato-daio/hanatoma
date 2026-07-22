import { describe, expect, it } from 'vitest';
import { stripStageDirections } from './sanitizeAiText';

describe('stripStageDirections', () => {
  it('冒頭の複数語ト書きを除去する（報告のあった典型パターン）', () => {
    expect(stripStageDirections('*nods with a smile* Hello! What would you like to order?')).toBe(
      'Hello! What would you like to order?',
    );
  });

  it('文中・文末のト書きも除去する', () => {
    expect(stripStageDirections('Sure! *gestures to the menu* Here you go.')).toBe('Sure! Here you go.');
    expect(stripStageDirections('That sounds great! *smiles warmly*')).toBe('That sounds great!');
  });

  it('1語でも既知の仕草語は除去する', () => {
    expect(stripStageDirections('*laughs* That is so funny!')).toBe('That is so funny!');
    expect(stripStageDirections('*nods* I see.')).toBe('I see.');
  });

  it('1語の強調（仕草語以外）は語を残してアスタリスクだけ外す', () => {
    expect(stripStageDirections("That's *really* good.")).toBe("That's really good.");
  });

  it('末尾の未閉鎖 *...（ストリーミング途中）は伏せる', () => {
    expect(stripStageDirections('Hello there! *nods wi')).toBe('Hello there!');
  });

  it('ト書きだけの入力は空文字列になる（読み上げスキップの判定に使う）', () => {
    expect(stripStageDirections('*nods with a smile*')).toBe('');
    expect(stripStageDirections('*smiles*')).toBe('');
  });

  it('マーカーの無い普通の文はそのまま（trim以外変更しない）', () => {
    expect(stripStageDirections('  Welcome! What can I get for you today?  ')).toBe(
      'Welcome! What can I get for you today?',
    );
    // 語としてのnods等は誤除去しない
    expect(stripStageDirections('She nods when she agrees.')).toBe('She nods when she agrees.');
  });

  it('除去後の余分な空白・句読点前の空白を整える', () => {
    expect(stripStageDirections('Of course *bows politely* , right away!')).toBe('Of course, right away!');
    expect(stripStageDirections('Hello *waves* *smiles* there!')).toBe('Hello there!');
  });
});
