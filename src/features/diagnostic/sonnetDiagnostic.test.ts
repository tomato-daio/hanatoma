import { describe, expect, it } from 'vitest';
import type { PaResult } from '../../lib/types';
import {
  buildDiagnosticSystem,
  buildDiagnosticUserContent,
  DIAGNOSTIC_TOOL,
  DIAGNOSTIC_TOOL_CHOICE,
  parseDiagnosticToolResult,
  type DiagnosticAnswer,
} from './sonnetDiagnostic';

function makePa(overrides: Partial<PaResult> = {}): PaResult {
  return {
    mode: 'unscripted',
    pronScore: 82.4,
    accuracyScore: 80,
    fluencyScore: 85,
    words: [],
    ...overrides,
  };
}

describe('buildDiagnosticSystem', () => {
  it('ルーブリック（語彙幅・文法正確性・複雑さ）とtool名を含む固定systemを1ブロック返す', () => {
    const system = buildDiagnosticSystem();
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');
    expect(system[0].text).toContain('Vocabulary range');
    expect(system[0].text).toContain('Grammatical accuracy');
    expect(system[0].text).toContain('Complexity');
    expect(system[0].text).toContain(DIAGNOSTIC_TOOL.name);
  });

  it('CEFR帯とアプリレベルの対応をすべて明記する', () => {
    const text = buildDiagnosticSystem()[0].text;
    expect(text).toContain('A1 -> level 1');
    expect(text).toContain('A2 -> level 2');
    expect(text).toContain('B1 -> level 3');
    expect(text).toContain('B2 -> level 4');
    expect(text).toContain('C1 -> level 5');
  });
});

describe('buildDiagnosticUserContent', () => {
  it('各設問の指示・答案・発音スコアを含める', () => {
    const answers: DiagnosticAnswer[] = [
      { question: 'Introduce yourself.', transcript: 'Hi, I am Taro.', pa: makePa({ pronScore: 90 }) },
    ];

    const content = buildDiagnosticUserContent(answers);

    expect(content).toContain('Q1 instruction: Introduce yourself.');
    expect(content).toContain("Learner's answer: Hi, I am Taro.");
    expect(content).toContain('pronunciation score 90/100');
  });

  it('答案が空文字なら「認識なし」の注記を入れる', () => {
    const answers: DiagnosticAnswer[] = [{ question: 'Q', transcript: '   ' }];

    const content = buildDiagnosticUserContent(answers);

    expect(content).toContain('(no speech recognized for this answer)');
  });

  it('PA未指定なら「PAスコアなし」の注記を入れる', () => {
    const answers: DiagnosticAnswer[] = [{ question: 'Q', transcript: 'some answer' }];

    const content = buildDiagnosticUserContent(answers);

    expect(content).toContain('(no pronunciation score available for this answer)');
  });

  it('PAがazureErrorを持つ場合はエラー内容を注記する', () => {
    const answers: DiagnosticAnswer[] = [
      { question: 'Q', transcript: 'some answer', pa: makePa({ azureError: 'timeout' }) },
    ];

    const content = buildDiagnosticUserContent(answers);

    expect(content).toContain('(pronunciation assessment failed for this answer: timeout)');
  });

  it('複数答案は空行区切りで連結する', () => {
    const answers: DiagnosticAnswer[] = [
      { question: 'Q1', transcript: 'A1' },
      { question: 'Q2', transcript: 'A2' },
    ];

    const content = buildDiagnosticUserContent(answers);

    expect(content.split('\n\n')).toHaveLength(2);
  });
});

describe('DIAGNOSTIC_TOOL / DIAGNOSTIC_TOOL_CHOICE', () => {
  it('input_schemaがcefr/level/commentJaを必須プロパティとして持つ', () => {
    expect(DIAGNOSTIC_TOOL.input_schema.required).toEqual(['cefr', 'level', 'commentJa']);
    expect(DIAGNOSTIC_TOOL.input_schema.properties.cefr.enum).toEqual(['A1', 'A2', 'B1', 'B2', 'C1']);
    expect(DIAGNOSTIC_TOOL.input_schema.properties.level.enum).toEqual([1, 2, 3, 4, 5]);
  });

  it('tool_choiceはDIAGNOSTIC_TOOLの名前を強制指定する', () => {
    expect(DIAGNOSTIC_TOOL_CHOICE).toEqual({ type: 'tool', name: DIAGNOSTIC_TOOL.name });
  });
});

describe('parseDiagnosticToolResult', () => {
  it('正しいtool_useブロックからcefr/level/commentJaを取り出す', () => {
    const content = [
      { type: 'tool_use', id: 'toolu_1', name: DIAGNOSTIC_TOOL.name, input: { cefr: 'B1', level: 3, commentJa: '良い調子です。' } },
    ];

    expect(parseDiagnosticToolResult(content)).toEqual({ cefr: 'B1', level: 3, commentJa: '良い調子です。' });
  });

  it('textブロックなど他のブロックは無視して該当tool_useを探す', () => {
    const content = [
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'toolu_1', name: DIAGNOSTIC_TOOL.name, input: { cefr: 'A2', level: 2, commentJa: 'OK' } },
    ];

    expect(parseDiagnosticToolResult(content)).toEqual({ cefr: 'A2', level: 2, commentJa: 'OK' });
  });

  it('別ツール名のtool_useは無視する', () => {
    const content = [{ type: 'tool_use', id: 'toolu_1', name: 'other_tool', input: { cefr: 'A2', level: 2, commentJa: 'OK' } }];

    expect(parseDiagnosticToolResult(content)).toBeNull();
  });

  it('cefrが不正な値ならnullを返す', () => {
    const content = [
      { type: 'tool_use', name: DIAGNOSTIC_TOOL.name, input: { cefr: 'Z9', level: 2, commentJa: 'OK' } },
    ];

    expect(parseDiagnosticToolResult(content)).toBeNull();
  });

  it('levelが範囲外・非整数ならnullを返す', () => {
    const outOfRange = [
      { type: 'tool_use', name: DIAGNOSTIC_TOOL.name, input: { cefr: 'A2', level: 6, commentJa: 'OK' } },
    ];
    const nonInteger = [
      { type: 'tool_use', name: DIAGNOSTIC_TOOL.name, input: { cefr: 'A2', level: 2.5, commentJa: 'OK' } },
    ];

    expect(parseDiagnosticToolResult(outOfRange)).toBeNull();
    expect(parseDiagnosticToolResult(nonInteger)).toBeNull();
  });

  it('commentJaが空文字ならnullを返す', () => {
    const content = [
      { type: 'tool_use', name: DIAGNOSTIC_TOOL.name, input: { cefr: 'A2', level: 2, commentJa: '   ' } },
    ];

    expect(parseDiagnosticToolResult(content)).toBeNull();
  });

  it('tool_useブロックが無ければnullを返す', () => {
    expect(parseDiagnosticToolResult([{ type: 'text', text: 'no tool call' }])).toBeNull();
  });

  it('空配列ならnullを返す', () => {
    expect(parseDiagnosticToolResult([])).toBeNull();
  });
});
