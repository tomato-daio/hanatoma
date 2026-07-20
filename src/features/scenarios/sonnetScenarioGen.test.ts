import { describe, expect, it } from 'vitest';
import { TARGET_PHONEME_KEYS } from '../report/phonemeAdvice';
import {
  buildScenarioGenSystem,
  buildScenarioGenTool,
  buildScenarioGenUserContent,
  parseScenarioGenToolResult,
  SCENARIO_GEN_TOOL_CHOICE,
  type GenerateScenarioOptions,
} from './sonnetScenarioGen';

const TOOL_NAME = 'submit_generated_scenario';

function makeOpts(overrides: Partial<GenerateScenarioOptions> = {}): GenerateScenarioOptions {
  return {
    interests: [],
    weakPhonemes: [],
    level: 2,
    existingTitles: [],
    ...overrides,
  };
}

/** parseScenarioGenToolResult向けの妥当なtool_use.input（level=2）。 */
function makeValidInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Returning a Library Book',
    titleJa: '図書館の本を返す',
    category: 'daily',
    level: 2,
    setting: 'A quiet public library counter in the afternoon.',
    aiRole: 'A friendly librarian',
    userRole: 'A visitor returning a borrowed book',
    goal: 'Return the book and ask about renewing your library card.',
    goalJa: '本を返却し、図書館カードの更新について聞く。',
    keyPhrases: [
      { en: "I'd like to return this book.", ja: 'この本を返却したいです。' },
      { en: 'Is it overdue?', ja: '延滞していますか？' },
      { en: 'How do I renew my card?', ja: 'カードはどうやって更新しますか？' },
    ],
    steps: [
      { aiIntent: 'Greet the visitor and ask how you can help.', hintJa: 'あいさつする', hintEn: "I'd like to", modelAnswer: "I'd like to return this book." },
      { aiIntent: 'Thank them and check the due date.', hintJa: '延滞していないか聞く', hintEn: 'Is it', modelAnswer: 'Is it overdue?' },
      { aiIntent: 'Answer and offer to help with the library card.', hintJa: '更新方法を聞く', hintEn: 'How do I', modelAnswer: 'How do I renew my card?' },
    ],
    hiddenObjectives: [
      { id: 'say-thanks', descriptionJa: 'お礼を言う', check: "The user said 'thank you' at least once." },
      { id: 'ask-question', descriptionJa: '質問を1つする', check: 'The user asked at least one question.' },
    ],
    targetPhonemes: ['R', 'L'],
    estimatedMinutes: 8,
    freeTalkPrompt: 'Chat briefly about what kind of books the visitor likes to read.',
    ...overrides,
  };
}

function wrapToolUse(input: Record<string, unknown>, name: string = TOOL_NAME): unknown[] {
  return [{ type: 'tool_use', id: 'toolu_1', name, input }];
}

describe('buildScenarioGenSystem', () => {
  it('品質基準（keyPhrases3-5・steps3-5・hiddenObjectives2固定）とtool名を含む固定systemを1ブロック返す', () => {
    const system = buildScenarioGenSystem();
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');
    expect(system[0].text).toContain('3 to 5');
    expect(system[0].text).toContain('exactly 2 objectives');
    expect(system[0].text).toContain(TOOL_NAME);
  });

  it('対象15音素キー(TARGET_PHONEME_KEYS)をすべて本文に埋め込む', () => {
    const text = buildScenarioGenSystem()[0].text;
    for (const key of TARGET_PHONEME_KEYS) {
      expect(text).toContain(key);
    }
  });
});

describe('buildScenarioGenUserContent', () => {
  it('レベルのCEFRとアプリレベルを含める', () => {
    const content = buildScenarioGenUserContent(makeOpts({ level: 3 }));
    expect(content).toContain('B1');
    expect(content).toContain('app level 3');
  });

  it('興味タグを含める。空なら「未指定」の注記を入れる', () => {
    const withInterests = buildScenarioGenUserContent(makeOpts({ interests: ['cooking', 'travel'] }));
    expect(withInterests).toContain('cooking, travel');

    const withoutInterests = buildScenarioGenUserContent(makeOpts({ interests: [] }));
    expect(withoutInterests).toContain('none specified');
  });

  it('弱点音素を含める。空なら「未記録」の注記を入れる', () => {
    const withPhonemes = buildScenarioGenUserContent(makeOpts({ weakPhonemes: ['R', 'TH'] }));
    expect(withPhonemes).toContain('R, TH');

    const withoutPhonemes = buildScenarioGenUserContent(makeOpts({ weakPhonemes: [] }));
    expect(withoutPhonemes).toContain('none recorded yet');
  });

  it('既存タイトル一覧を重複回避の指示とともに含める。空なら「まだ無い」の注記を入れる', () => {
    const withTitles = buildScenarioGenUserContent(makeOpts({ existingTitles: ['Hotel Check-in', 'Ordering Coffee'] }));
    expect(withTitles).toContain('- Hotel Check-in');
    expect(withTitles).toContain('- Ordering Coffee');
    expect(withTitles).toContain('do not repeat');

    const withoutTitles = buildScenarioGenUserContent(makeOpts({ existingTitles: [] }));
    expect(withoutTitles).toContain('none yet');
  });
});

describe('buildScenarioGenTool / SCENARIO_GEN_TOOL_CHOICE', () => {
  it('levelをenumで指定値のみに固定する', () => {
    const tool = buildScenarioGenTool(4);
    expect(tool.input_schema.properties.level.enum).toEqual([4]);
  });

  it('keyPhrases/steps/hiddenObjectives/targetPhonemesの個数制約が品質基準通り', () => {
    const tool = buildScenarioGenTool(2);
    expect(tool.input_schema.properties.keyPhrases.minItems).toBe(3);
    expect(tool.input_schema.properties.keyPhrases.maxItems).toBe(5);
    expect(tool.input_schema.properties.steps.minItems).toBe(3);
    expect(tool.input_schema.properties.steps.maxItems).toBe(5);
    expect(tool.input_schema.properties.hiddenObjectives.minItems).toBe(2);
    expect(tool.input_schema.properties.hiddenObjectives.maxItems).toBe(2);
    expect(tool.input_schema.properties.targetPhonemes.minItems).toBe(2);
    expect(tool.input_schema.properties.targetPhonemes.maxItems).toBe(4);
  });

  it('targetPhonemesのitemsはTARGET_PHONEME_KEYSのenumのみ', () => {
    const tool = buildScenarioGenTool(2);
    expect(tool.input_schema.properties.targetPhonemes.items.enum).toEqual(TARGET_PHONEME_KEYS);
  });

  it('必須プロパティにidとsourceを含まない（LLMには生成させない）', () => {
    const tool = buildScenarioGenTool(2);
    expect(tool.input_schema.required).not.toContain('id');
    expect(tool.input_schema.required).not.toContain('source');
    expect(tool.input_schema.required).toContain('title');
    expect(tool.input_schema.required).toContain('targetPhonemes');
  });

  it('SCENARIO_GEN_TOOL_CHOICEはtool名を強制指定する', () => {
    expect(SCENARIO_GEN_TOOL_CHOICE).toEqual({ type: 'tool', name: TOOL_NAME });
  });
});

describe('parseScenarioGenToolResult', () => {
  it('妥当なtool_useブロックから全フィールドを取り出し、id/sourceは含めない', () => {
    const parsed = parseScenarioGenToolResult(wrapToolUse(makeValidInput()), 2);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('source');
    expect(parsed?.title).toBe('Returning a Library Book');
    expect(parsed?.keyPhrases).toHaveLength(3);
    expect(parsed?.hiddenObjectives).toHaveLength(2);
  });

  it('textブロックなど他のブロックは無視して該当tool_useを探す', () => {
    const content = [{ type: 'text', text: 'thinking...' }, ...wrapToolUse(makeValidInput())];
    expect(parseScenarioGenToolResult(content, 2)).not.toBeNull();
  });

  it('別ツール名のtool_useは無視してnullを返す', () => {
    const content = wrapToolUse(makeValidInput(), 'other_tool');
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('levelが指定値と不一致ならnullを返す', () => {
    const content = wrapToolUse(makeValidInput({ level: 3 }));
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('categoryが不正な値ならnullを返す', () => {
    const content = wrapToolUse(makeValidInput({ category: 'unknown-category' }));
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('必須文字列フィールドが空ならnullを返す', () => {
    const content = wrapToolUse(makeValidInput({ goal: '   ' }));
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('keyPhrasesが2個（3個未満）ならnullを返す', () => {
    const input = makeValidInput();
    const content = wrapToolUse({ ...input, keyPhrases: (input.keyPhrases as unknown[]).slice(0, 2) });
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('keyPhrasesが6個（5個超）ならnullを返す', () => {
    const input = makeValidInput();
    const base = input.keyPhrases as { en: string; ja: string }[];
    const content = wrapToolUse({ ...input, keyPhrases: [...base, ...base, ...base] });
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('stepsが2個（3個未満）ならnullを返す', () => {
    const input = makeValidInput();
    const content = wrapToolUse({ ...input, steps: (input.steps as unknown[]).slice(0, 2) });
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('hiddenObjectivesが1個や3個（2個固定でない）ならnullを返す', () => {
    const input = makeValidInput();
    const objectives = input.hiddenObjectives as unknown[];
    expect(parseScenarioGenToolResult(wrapToolUse({ ...input, hiddenObjectives: objectives.slice(0, 1) }), 2)).toBeNull();
    expect(
      parseScenarioGenToolResult(wrapToolUse({ ...input, hiddenObjectives: [...objectives, objectives[0]] }), 2),
    ).toBeNull();
  });

  it('targetPhonemesが15音素キー集合外の値を含むならnullを返す', () => {
    const content = wrapToolUse(makeValidInput({ targetPhonemes: ['R', 'ZZ'] }));
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('targetPhonemesが1個（2個未満）ならnullを返す', () => {
    const content = wrapToolUse(makeValidInput({ targetPhonemes: ['R'] }));
    expect(parseScenarioGenToolResult(content, 2)).toBeNull();
  });

  it('estimatedMinutesが範囲外ならnullを返す', () => {
    expect(parseScenarioGenToolResult(wrapToolUse(makeValidInput({ estimatedMinutes: 1 })), 2)).toBeNull();
    expect(parseScenarioGenToolResult(wrapToolUse(makeValidInput({ estimatedMinutes: 30 })), 2)).toBeNull();
  });

  it('tool_useブロックが無ければnullを返す', () => {
    expect(parseScenarioGenToolResult([{ type: 'text', text: 'no tool call' }], 2)).toBeNull();
  });

  it('空配列ならnullを返す', () => {
    expect(parseScenarioGenToolResult([], 2)).toBeNull();
  });
});
