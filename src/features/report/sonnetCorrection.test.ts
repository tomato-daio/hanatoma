import { describe, expect, it } from 'vitest';
import type { Conversation, PaResult, Scenario, Turn } from '../../lib/types';
import { buildCorrectionPrompt } from './sonnetCorrection';

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'b-restaurant-001',
    source: 'bundled',
    title: 'Ordering coffee',
    titleJa: 'コーヒーを注文する',
    category: 'restaurant',
    level: 2,
    setting: 'A small cafe.',
    aiRole: 'barista',
    userRole: 'customer',
    goal: 'Order a drink and pay for it.',
    goalJa: '飲み物を注文して支払う。',
    keyPhrases: [{ en: 'Can I get a latte?', ja: 'ラテをください。' }],
    steps: [{ aiIntent: 'greet the customer', hintJa: '挨拶する', hintEn: 'Hi,', modelAnswer: 'Hi there!' }],
    hiddenObjectives: [
      { id: 'past-tense', descriptionJa: '過去形を2回使う', check: 'The user used past tense verbs at least twice.' },
    ],
    estimatedMinutes: 8,
    freeTalkPrompt: 'Chat about your day.',
    ...overrides,
  };
}

function makeConversation(turns: Turn[], overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    scenarioId: 'b-restaurant-001',
    mode: 'lesson',
    date: '2026-07-18',
    startedAt: 1000,
    status: 'completed',
    turns,
    ...overrides,
  };
}

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

describe('buildCorrectionPrompt', () => {
  it('シナリオのgoal・レベルCEFR・hiddenObjectivesのcheckをsystemまたはmessagesに含める', () => {
    const scenario = makeScenario();
    const conversation = makeConversation([]);

    const { messages } = buildCorrectionPrompt(conversation, scenario, 3, []);

    const content = messages[0].content as string;
    expect(content).toContain('Order a drink and pay for it.');
    expect(content).toContain('B1');
    expect(content).toContain('app level 3');
    expect(content).toContain('id="past-tense"');
    expect(content).toContain('The user used past tense verbs at least twice.');
  });

  it('各ターンをturnIndex付きの1行に整形し、role/phase/textを含める', () => {
    const turns: Turn[] = [
      { role: 'ai', text: 'Hi! What can I get you?', at: 0, phase: 'guided' },
      { role: 'user', text: 'I want a coffee.', at: 1, phase: 'guided', inputMode: 'voice' },
    ];
    const { messages } = buildCorrectionPrompt(makeConversation(turns), makeScenario(), 2, []);

    const content = messages[0].content as string;
    expect(content).toContain('[0] ai (guided): "Hi! What can I get you?"');
    expect(content).toContain('[1] user (guided): "I want a coffee."');
  });

  it('userターンにpaがあれば低スコア語上位を含む発音サマリを付与する', () => {
    const pa = makePa({
      pronScore: 61,
      words: [
        { word: 'the', accuracyScore: 30, errorType: 'None' },
        { word: 'coffee', accuracyScore: 90, errorType: 'None' },
        { word: 'right', accuracyScore: 45, errorType: 'None' },
        { word: 'thing', accuracyScore: 50, errorType: 'None' },
        { word: 'very', accuracyScore: 55, errorType: 'None' },
      ],
    });
    const turns: Turn[] = [{ role: 'user', text: 'Give me the right thing.', at: 0, phase: 'free', pa }];

    const { messages } = buildCorrectionPrompt(makeConversation(turns), makeScenario(), 2, []);

    const content = messages[0].content as string;
    expect(content).toContain('pronScore=61');
    // 低スコア語上位3件（the=30, right=45, thing=50）が閾値70未満から選ばれる。veryは4件目のため含まれない。
    expect(content).toContain('low-score words: the, right, thing');
    expect(content).not.toContain('very,');
  });

  it('pa.azureErrorがある場合は発音サマリを付与しない', () => {
    const pa = makePa({ azureError: '聞き取れませんでした' });
    const turns: Turn[] = [{ role: 'user', text: 'Hmm.', at: 0, phase: 'free', pa }];

    const { messages } = buildCorrectionPrompt(makeConversation(turns), makeScenario(), 2, []);

    const content = messages[0].content as string;
    expect(content).toContain('[0] user (free): "Hmm."');
    expect(content).not.toContain('pronunciation:');
  });

  it('aiターンのpaは無視する（userのみ発音情報を持つ契約のため通常は付かないが念のため）', () => {
    const pa = makePa({ pronScore: 40 });
    const turns: Turn[] = [{ role: 'ai', text: 'Sure thing.', at: 0, phase: 'free', pa }];

    const { messages } = buildCorrectionPrompt(makeConversation(turns), makeScenario(), 2, []);

    const content = messages[0].content as string;
    expect(content).not.toContain('pronunciation:');
  });

  it('hiddenObjectivesが空なら「none」を明示する', () => {
    const scenario = makeScenario({ hiddenObjectives: [] });
    const { messages } = buildCorrectionPrompt(makeConversation([]), scenario, 2, []);

    expect(messages[0].content as string).toContain('Hidden objectives to check for: none.');
  });

  it('sisterWeakPhonemesを注意音素として含め、空なら未記録と明示する', () => {
    const withPhonemes = buildCorrectionPrompt(makeConversation([]), makeScenario(), 2, ['R', 'TH']);
    expect(withPhonemes.messages[0].content as string).toContain(
      'Phonemes this learner should pay particular attention to (ARPAbet): R, TH',
    );

    const withoutPhonemes = buildCorrectionPrompt(makeConversation([]), makeScenario(), 2, []);
    expect(withoutPhonemes.messages[0].content as string).toContain('none recorded yet');
  });

  it('systemは1ブロックでツール使用を指示する文言を含む', () => {
    const { system } = buildCorrectionPrompt(makeConversation([]), makeScenario(), 2, []);
    expect(system).toHaveLength(1);
    expect(system[0].text).toContain('call the provided tool exactly once');
  });
});
