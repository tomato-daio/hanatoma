# はなとま (hanatoma) — 設計書

AI英会話アウトプット練習PWA。**個人利用・低ランニングコスト（月500円目安）・iPhone完結**が絶対条件。
この文書が実装の正本。実装エージェントはこの仕様に従うこと。

姉妹アプリ: **シャドとま (shadotoma)** `C:\Users\tamog\dev\shadotoma`（英語シャドーイング=インプット練習）。
本アプリは**アウトプット練習**（自分で文を組み立てて話す・会話の流暢さ・表現の幅）を担当し、UI統合はせず**データレベルの連携のみ**行う（§11）。

## 0. 絶対ルール

- 個人情報（本名・実年齢・勤務先・個人メール）をコード・コメント・package.json author等に一切書かない。作者名義は `tomato-daio`。
- 学習データ・録音は**端末内(IndexedDB)のみ**。外部送信は次の3つに限る（いずれもユーザー自身のAPIキーで、送信内容は必要最小限）:
  1. **Azure Speech**: 発音評価対象の発話音声+参照テキスト、TTS用の合成テキスト
  2. **Anthropic API**: 会話トランスクリプト・添削対象テキスト・発音スコア要約（音声そのものは送らない）
  3. 上記のトークン検証等の接続テスト
- APIキーは appState（IndexedDB）に端末内保存。**バックアップのエクスポートから除外**し、リストア時も既存キーを上書きしない。
- shadotoma の IndexedDB への書き込みは §11b の「ローカル教材1レコードのput」のみ。それ以外の書き込み・スキーマ変更は絶対にしない。
- 依存は最小限。指定スタック以外のランタイム依存を勝手に追加しない（Anthropic呼び出しはSDKを使わず素のfetch）。
- コスト暴走防止: LLM呼び出しは必ず §12 の日次キャップ判定を通す。キャップ超過時はAPIを呼ばない。

## 1. 技術スタック

| 項目 | 選定 |
|---|---|
| ビルド | Vite 7 + React 18 + TypeScript (strict) |
| スタイル | Tailwind CSS v4（@tailwindcss/vite プラグイン方式、hanaパレット=オレンジ系） |
| PWA | vite-plugin-pwa（autoUpdate、オフラインキャッシュ） |
| 状態管理 | Zustand |
| 永続化 | IndexedDB（idb ライブラリ、DB名 `hanatoma`） |
| テスト | Vitest（src/lib配下の純関数は必須。UIテストは不要） |
| 音声認識+発音評価 | Azure Speech SDK（microsoft-cognitiveservices-speech-sdk、発音評価 unscripted/scripted） |
| AI音声 | Azure Neural TTS（SpeechSynthesizer、SSML） |
| 会話AI | Anthropic API 直接fetch: 会話=claude-haiku-4-5 / 添削・生成・診断=claude-sonnet-5 |

- GitHub Pages 配信のため `vite.config.ts` の `base` は `/hanatoma/`（dev時は `/`）。dev サーバは port 5174（shadotoma=5173 と同時起動可）。
- モバイル(iPhone Safari)ファースト。画面幅 375px 基準、下タブナビゲーション。HashRouter（GH Pagesリロード404回避）。
- 録音は `MediaRecorder`（iOS Safari=`audio/mp4`(aac) / Chrome・Edge=`audio/webm`(opus)。`MediaRecorder.isTypeSupported`で選択、Blobの実mimeTypeをそのまま保存）。**Azure SDK内蔵マイクは使わない**（iOSオーディオセッション管理がshadotomaで実証済みの自前管理と競合するため）。
- iOS対策はshadotomaの実証済みパターンを踏襲: 統一AudioContext、マイクトラックended/mute検知+復旧メッセージ、ジェスチャ文脈でのplay()アンロック、Screen Wake Lock（録音中・添削処理中）。

## 2. 画面構成（下タブ5つ + フルスクリーンルート）

1. **ホーム** (`/`) — 最上部に「**今日のレッスン**」1本（おすすめシナリオ・5〜10分表記）を大きく配置。コンビストリーク＋お休みチケット・デイリークエスト3件・ボス告知・「クイック会話」「ひとくち英会話」ボタン
2. **シナリオ** (`/scenarios`) — カテゴリ島マップ（★・アンロック）、レベルフィルタ、動的生成ボタン(M9)
3. **レポート** (`/reports`) — 添削レポート一覧/詳細、表現帳、「シャドとまで練習する」
4. **進捗** (`/progress`) — XP/ランク、レベル推移、バッジ棚、練習カレンダー、発音スコア推移
5. **設定** (`/settings`) — Azureキー/リージョン、Anthropicキー（いずれも接続テスト付き）、AI音声選択、日次キャップ、使用量ダッシュボード、バックアップ、開発者セクション(DEVのみ)

タブ外フルスクリーン: 会話画面 (`/talk/:conversationId`)、サイレント復習 (`/review`・§4b)、オンボーディング診断 (`/onboarding`)。

## 3. データモデル（IndexedDB: DB名 `hanatoma` v1, idbで管理）

shadotoma `src/lib/db.ts` の構成（DBSchema型 + 薄いCRUD関数 + fake-indexeddbテスト）を踏襲。

```ts
// store: scenarios（動的生成分のみ。バンドル初期パックは public/scenarios/index.json を実行時fetchで参照）
type ScenarioCategory = 'travel'|'restaurant'|'work'|'daily'|'interview'|'shopping'|'health'|'social';
interface Scenario {
  id: string;                    // bundled: "b-<category>-<連番>" (例 b-travel-001), 生成: "gen-" + crypto.randomUUID()
  source: 'bundled' | 'generated';
  title: string; titleJa: string;
  category: ScenarioCategory;
  level: 1|2|3|4|5;              // §8のアプリレベル対応（±1のレベルでもプレイ可）
  setting: string;               // 場面描写（英語。Haiku systemへそのまま注入）
  aiRole: string; userRole: string;
  goal: string; goalJa: string;
  keyPhrases: { en: string; ja: string; note?: string }[];      // 3〜5個
  steps: {                       // ガイド付き会話の骨格 3〜5ステップ
    aiIntent: string;            // このステップでAIが言うべき内容の指示（英語）
    hintJa: string;              // ヒント段階1: 日本語ヒント
    hintEn: string;              // ヒント段階2: 英語の言い出しヒント
    modelAnswer: string;         // ヒント段階3: 模範解答（TTS再生可）
  }[];
  hiddenObjectives: { id: string; descriptionJa: string; check: string }[]; // 例「過去形を2回使う」checkはSonnet添削への判定指示文
  targetPhonemes?: string[];     // ARPAbet大文字（例 "R","TH"。shadotoma弱点連携の推薦キー）
  estimatedMinutes: number;
  freeTalkPrompt: string;        // フリー会話フェーズのAI向け指示
}

// store: conversations（1レッスン=1レコード）
interface Conversation {
  id: string;
  scenarioId: string;
  mode: 'lesson' | 'quick' | 'bite' | 'diagnostic' | 'boss';
  date: string;                  // 学習日 "YYYY-MM-DD"（午前3時切替。shadotomaと同一のdates.ts）
  startedAt: number; finishedAt?: number;
  status: 'active' | 'completed' | 'abandoned';
  turns: Turn[];
  metrics?: LessonMetrics;       // §8b
  xpAwarded?: number;
  stars?: 0|1|2|3;               // composite 50/70/85 (§10)
}
interface Turn {
  role: 'user' | 'ai';
  text: string;                  // user=認識結果(または入力テキスト) / ai=生成文
  at: number;
  phase: 'keyphrase' | 'guided' | 'free';
  inputMode?: 'voice' | 'text';  // userのみ
  audioBlob?: Blob;              // userのみ・振り返り再生用（設定 saveTurnAudio=false なら保存しない）
  mimeType?: string;
  pa?: PaResult;                 // userのみ（音声入力時）
  thinkingMs?: number;           // AI発話終了→録音開始までの時間（userのみ）
}
// Azure発音評価結果（unscripted: completenessScoreなし / scripted(キーフレーズ): あり）
interface PaResult {
  mode: 'unscripted' | 'scripted';
  pronScore: number; accuracyScore: number; fluencyScore: number;
  prosodyScore?: number;         // プロソディ失敗リトライ時はundefined
  completenessScore?: number;    // scriptedのみ
  words: { word: string; accuracyScore: number; errorType: string }[];
  weakPhonemes?: { phoneme: string; avgScore: number; examples: string[] }[]; // 上位3件
  azureError?: string;           // 失敗時のみ（cancellation errorDetails先頭120字）
}

// store: correctionReports（1会話=1レポート）
interface CorrectionReport {
  id: string; conversationId: string; date: string; createdAt: number;
  items: {
    turnIndex: number;
    original: string; corrected: string;
    kind: 'grammar' | 'word-choice' | 'naturalness' | 'expression';
    explanationJa: string;
  }[];
  rephrases: { turnIndex: number; levelUp: string; native: string }[]; // CEFR段階別リフレーズ
  learnedExpressions: { en: string; ja: string; note?: string }[];     // 3〜5件（表現帳登録候補）
  objectivesAchieved: string[];  // 達成したhiddenObjectiveのid
  grammarErrorCount: number;     // 100語あたりではなく実数（rateはmetrics側で計算）
  pronunciationComments: string[]; // 音素助言マージ純関数の出力（LLM出力ではない）
  summaryJa: string;             // 総評1〜2文
}

// store: expressions（表現帳）
interface ExpressionItem {
  id: string; en: string; ja: string; note?: string;
  sourceConversationId?: string; addedAt: number;
  useCount: number; lastUsedAt?: number;  // 会話中に使えたらインクリメント（クエスト判定元）
}

// store: userProfile（key 'main' の単一レコード）
interface UserProfile {
  key: 'main';
  level: 1|2|3|4|5;
  levelHistory: { date: string; level: number; reason: 'diagnostic'|'promote'|'demote'|'manual' }[];
  xp: number;                    // 累計（ランクはxpから導出）
  restTickets: number;           // お休みチケット保有数（0〜2。§10）
  badges: { id: string; earnedAt: number }[];
  interests: string[];           // オンボーディングで選択+自由入力
  diagnostic?: { date: string; cefr: string; comment: string };
  createdAt: number;
}

// store: questState（日次1レコード, keyPath 'date'）
interface QuestState {
  date: string;
  quests: { id: string; progress: number; target: number; done: boolean }[];
  bossWeekId?: string;           // "2026-W30" 形式
  bossDone?: boolean;
}

// store: usageLog（日次1レコード, keyPath 'date'。§12）
interface UsageDay {
  date: string;
  haikuCalls: number; sonnetCalls: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  paSeconds: number; ttsChars: number;
  sessionsStarted: number;
}

// store: appState（key-value）
// keys: azureSpeechKey / azureSpeechRegion / anthropicApiKey / ttsVoice / saveTurnAudio /
//       dailyCaps({sessions,sonnetCalls,paMinutes}) / onboardingDone /
//       reviewStats(ReviewStats) / reviewDates(string[])  ← サイレント復習(§4b)。appStateは
//       スキーマレスなためDBバージョンは1のまま。バックアップにも自動的に含まれる

// サイレント復習のSRS状態（appState 'reviewStats'。types.tsに型あり）
interface ReviewCardStat {
  repetition: number;       // 連続「覚えてた」回数（「まだ」で0）
  easeFactor: number;       // 易しさ係数（初期2.5・下限1.3・「まだ」ごとに-0.2）
  intervalDays: number;     // 現在の出題間隔（日）
  dueDate: string;          // 次回出題期限の学習日 (YYYY-MM-DD)
  reviewCount: number; againCount: number;
  firstReviewedDate: string; // 初出題の学習日（新規カードの日次上限判定用）
  lastReviewedAt: number;
}
type ReviewStats = Record<string, ReviewCardStat>; // key = ReviewCard.key
```

日付ユーティリティ `src/lib/dates.ts` は **shadotoma からそのままコピー**（`learningDate` 午前3時切替・`calcStreak`）。⚠️ このファイルの日付規則を変えるとコンビストリーク(§11)が壊れる。両リポジトリで同一実装を保つこと。

## 4. レッスンフロー（Speak型5フェーズ）

**設計原則: 「1日がっつり」より「毎日少しずつ」を最優先する。** 1回の練習は5〜10分で完結させ、ホームの主導線は常に「今日のレッスン1本」。長時間連続利用を促す導線は作らない。

会話画面はフェーズウィザード。モードは3種:
- `mode:'lesson'`（フルレッスン・約10分）: 全5フェーズ
- `mode:'quick'`（クイック会話・約5分）: フェーズ3〜5のみ
- `mode:'bite'`（**ひとくち英会話**・1〜2分）: AIの一言に1回だけ音声で応答→ミニ講評1文（Haiku。Sonnet添削なし）。**忙しい日でもストリークが継続する最小単位**。ホームに常設ボタン

1. **イントロ**: シナリオカード（場面・相手役・ゴール・日本語説明・所要目安）
2. **キーフレーズ予習**: 3〜5個を順に「TTSで聞く → 自分で発音 → scripted PA採点（音素表示）」。80点以上で✓。スキップ可
3. **ガイド付き会話**: `steps` の骨格に沿ってAIと往復。各ステップにヒントボタン3段階（日本語→英語言い出し→模範解答+TTS）。模範解答を見ても進行可（ペナルティなし、ただしXP微減 §10）
4. **フリー会話**: `freeTalkPrompt` に基づき3〜8ターンの自由対話。hiddenObjectives はここで狙う
5. **フィードバック**: Sonnet添削レポート(§7b) → リワード画面(§10)

フェーズはスキップ/中断可。中断時は `status:'abandoned'`（再開はさせずやり直し。飽きない単純さ優先）。

### 4b. サイレント復習モード（めくりカード・間隔反復）`/review`（M10）

電車など**声を出せない場所**での学習手段。API呼び出し・TTS・録音・外部通信は一切使わない完全ローカル機能（importレベルでspeech/llm系に依存しないこと）。

**科学的根拠**: ①分散学習効果（Ebbinghaus忘却曲線に基づく拡張間隔反復＝忘れかけた頃の再出題が最も定着する）②想起練習効果（答えを見る前に思い出す行為自体が記憶を強化する）。

- **カード供給源**: 表現帳(ExpressionItem) ∪ 完了済みシナリオ（mode≠diagnostic）のキーフレーズ。en（trim・大小無視）重複は表現帳優先。カードは永続化しない導出型 `ReviewCard {key, en, ja, note?, source}`（key = `ex:<id>` | `kp:<scenarioId>:<en小文字>`）
- **UI**: 日本語面→「英語で言えるか思い出してから」タップで英文表示→「覚えてた/まだ」の2択自己判定。1セット `REVIEW_SET_SIZE=8` 枚（1〜2分）。途中離脱は保存しない（完走のみ記録）
- **SRS**: SM-2の2択簡略版（`src/lib/review/sm2.ts`・純関数・Vitest必須）。覚えてた→間隔 1日→3日→round(前回×EF)（EF初期2.5・上限180日）。まだ→rep=0・dueDate=today（同日再出題=セッション内再学習）・EF-0.2（下限1.3）
- **出題順**（`pickReviewCards`・学習日シードFNV-1aで決定的）: ①期限切れ(dueDate<=today)を期限が古い順 ②新規カードを日次上限 `NEW_CARDS_PER_DAY=8` 枚まで。**期限前のカードは出さない**（先取り復習なし。消化済みなら「今日の復習は完了・次の期限○月○日」を表示。やりすぎ防止も分散学習の一部）
- **記録**（`src/features/review/reviewStore.ts`。homeData.tsをimportしない葉モジュール）: セット完走で appState `reviewStats` 更新（孤児キーはprune）+ `reviewDates` に学習日を追加
- **ストリーク**: 練習日の定義は「completed会話の日付 ∪ reviewDates」（homeData.ts / sessionEnd.ts / ProgressPage の3箇所で同じunion）。**お休みチケットの付与判定は会話セッション完了時のみ**（復習のみの日は7日節目を通過しても付与されない。二重付与ガードを避けるため）。進捗カレンダーは 会話=hana-500 > 復習のみ=hana-300 > シャドとまのみ=hana-200
- **XP**: セット完走 `REVIEW_SET_XP=10`（**1日1回のみ**。ストリーク倍率・初回ボーナス・減衰の対象外。calcSessionXpは使わない）
- **導線**: ホーム（短時間モードの下・期限切れ枚数バッジ付き）と表現帳タブ上部

## 5. 1ターンの音声パイプライン

```
[録音] MediaRecorder（push-to-talk: マイク大ボタンで開始/停止）
  ↓ 停止
[変換] decodeAudioData → 16kHz mono Float32 → WAV PCM16（src/lib/wav.ts = shadotomaコピー）
  ↓
[Azure PA] pushStream一括投入 → 認識テキスト + 発音スコア（1コール。§6）
  ↓ 認識テキストを即時表示
[Claude Haiku] streaming で返答生成（§7a）。テキストは逐次表示
  ↓ 文境界ごとに
[Azure TTS] SSML合成 → ArrayBuffer → 統一AudioContextでキュー再生（§6c）
```

- 目標レイテンシ（ユーザー発話終了→AI音声開始）: 合計 ≤3.2秒。区間別目安: WAV変換≤0.3s / PA≤1.2s / Haiku初文≤1.2s / TTS初回≤0.5s。M3でコンソールに区間ログを出す
- テキスト入力切替: キーボードアイコンで入力欄表示。PAはスキップ（`pa`なし・`inputMode:'text'`）
- 録音中: 経過秒・レベルメーター（AnalyserNode）・Wake Lock取得。マイクトラックended/mute検知時は「マイクがOSに停止されました。もう一度録音開始を押してください」
- AI音声再生とマイクの iOS オーディオセッション往復が壊れる場合は、shadotoma M7 の対策（統一AudioContext・手動▶ボタン）を展開する（M2/M3実機確認項目）

## 6. Azure Speech 連携

`src/features/speech/`。キー/リージョン管理・接続テストは shadotoma `azureSpeechConfig.ts` をほぼコピー（appState keys: `azureSpeechKey`/`azureSpeechRegion`、issueTokenで検証、リージョン初期値 japaneast）。

### 6a. unscripted 発音評価（会話ターン用）`azurePaUnscripted.ts`
- `PronunciationAssessmentConfig`: referenceText=**空文字**、GradingSystem=HundredMark、Granularity=Phoneme、EnableProsodyAssessment。`speechRecognitionLanguage='en-US'`
- 音声は WAV(16kHz mono PCM16) を pushStream で投入。60秒超対応のため continuous recognition で最後まで処理し、複数結果は**音声長加重でスコア統合**（shadotoma `azurePronunciation.ts` のロジック流用）。認識テキストは連結
- **プロソディ・フォールバック**: 韻律有効で失敗したら韻律なしで1回だけ自動リトライ（japaneastで失敗実績あり）。両方失敗時のみエラー（`azureError` に errorDetails 先頭120字）
- 音素スコアを集計し `weakPhonemes`（低スコア音素トップ3: 記号・平均点・例語最大2）を保存
- PAエラー時も会話は継続する（認識テキストが取れなければ「聞き取れませんでした。もう一度どうぞ」表示。Haikuは呼ばない）
- **フレーズヒント**（認識精度向上）: `assessSpeech` は `phraseHints?: string[]` を受け取り、`PhraseListGrammar.fromRecognizer(recognizer).addPhrases()` で認識エンジンに渡す。会話ターンではシナリオのキーフレーズ英文+全stepsのmodelAnswerを `buildPhraseHints`（`src/features/conversation/phraseHints.ts`・純関数・Vitest必須）で組み立てて渡す（なまりのある発話でもシナリオ文脈に沿った聞き取りになる。スコアの水増しではなく認識の文脈補助）。ヒントは重複除去（大文字小文字無視）・空除去のうえ最大40件

### 6b. scripted 発音評価（キーフレーズ予習用）
- referenceText=キーフレーズ文。enableMiscue=true。他は6aと同じ。completenessScoreあり
- phraseHints にはキーフレーズ文そのものを1件渡す（参照文と認識のズレを減らす）

### 6c. Neural TTS `azureTts.ts`
- `SpeechSynthesizer` + `speakSsmlAsync`。**speaker直接出力はせず** audioData(ArrayBuffer) を統一AudioContextで再生（iOS再生アンロック制御のため）
- SSML: 音声名=appState `ttsVoice`（初期値 en-US-JennyNeural）、`<prosody rate>` にレベル別値(§8d)
- 利用可能音声はリージョンの voices/list REST で取得し設定画面に一覧表示+試聴（ハードコードしない。en-US Neuralのみフィルタ）
- キーフレーズ・模範解答の音声はセッション内メモリキャッシュ（同一文の再合成を避ける）

## 7. Anthropic API 連携

`src/features/llm/`。SDKは使わず素の fetch。ヘッダ: `x-api-key`（appState `anthropicApiKey`）、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`。エンドポイント `https://api.anthropic.com/v1/messages`。呼び出し前に必ず §12 のキャップ判定。レスポンスの usage を usageLog に加算。

### 7a. 会話パートナー（Haiku, streaming）`haikuPartner.ts`
- model: `claude-haiku-4-5`。max_tokens: 200。stream: true（SSE。fetch ReadableStreamでパース）
- system は2ブロック構成で **prompt caching**: [共通ルール（不変・`cache_control: {type:'ephemeral'}`）] + [シナリオ+レベルパラメータ（レッスン中不変・cache_control）]。会話履歴は messages で毎回送る
- 共通ルールの要点: あなたはシナリオのaiRoleを演じる / 返答は1〜3文・レベル語彙制約(§8d) / ユーザーの英語の誤りは**会話中は直さない**（理解できたら会話を続ける。全く理解できない時だけ聞き返す）/ ゴール達成に向けて自然に誘導 / ガイドフェーズでは現在のstepのaiIntentに従う
- 履歴が20ターンを超えたら古いターンを1行要約に畳む（コスト対策）

### 7b. 精密添削（Sonnet, tool use強制）`sonnetCorrection.ts`
- model: `claude-sonnet-5`。tool use（input_schema=CorrectionReportのJSONスキーマ相当、tool_choice指定）で構造化出力を強制
- 入力: 全トランスクリプト（role/phase付き）+ 各userターンのPA要約（総合点・低スコア語）+ シナリオ(goal/hiddenObjectives) + ユーザーレベル + 弱点音素リスト(自アプリ+shadotoma §11)
- 出力: CorrectionReport の items/rephrases/learnedExpressions/objectivesAchieved/grammarErrorCount/summaryJa
- `pronunciationComments` はLLM出力ではなく、PaResultのweakPhonemes × `phonemeAdvice.ts`（shadotomaコピー・15音素辞書）を**純関数でマージ**して生成（`src/features/report/phonemeComments.ts`・Vitest必須）
- 診断テスト採点 `sonnetDiagnostic.ts`（M6）とシナリオ動的生成 `sonnetScenarioGen.ts`（M9）も同じクライアント基盤を使う

### 7c. 接続テスト
設定画面の「接続テスト」= `claude-haiku-4-5` に max_tokens:1 の最小コール。成功/失敗と代表的エラー（401=キー不正等）を日本語表示。

## 8. レベルシステム

### 8a. 初回診断（`/onboarding`・M6）
キー設定後に5分の診断: ①自己紹介 ②場面描写 ③意見質問（各30〜60秒の自由発話、音声パイプラインは§5と同じ）。Sonnetがルーブリック（語彙幅・文法正確性・複雑さ）で採点→CEFR帯→レベル1〜5（A1/A2/B1/B2/C1）。PAスコアは発音ベースラインとして保存。スキップ時はレベル2開始。

### 8b. レッスンメトリクス（`src/lib/level/metrics.ts`・純関数・Vitest必須）
- pronScore: セッション内PA総合の平均（0–100）
- grammarErrorRate: grammarErrorCount / ユーザー総語数 × 100
- thinkingTimeMs: thinkingMsの中央値
- meanUtteranceWords: ユーザー発話の平均語数
- `composite = 0.3*pron + 0.3*grammarComponent + 0.2*fluencyComponent + 0.2*complexityComponent`（各成分の正規化式はmetrics.tsに定義しテストで固定）

### 8c. 昇降格（`src/lib/level/progress.ts`・純関数・Vitest必須）
- 現レベル以上の難易度のレッスン直近5件中4件が composite ≥ 75 → 昇格（上限5）
- 直近5件すべて composite < 50 → 降格（下限1）。昇格から3日以内は降格しない
- 降格の表示文言は「サポートを増やしました」。設定で手動オーバーライド可

### 8d. レベル別パラメータ（`src/lib/level/params.ts`・定数テーブル）

| Lv | CEFR | AI語彙指示 | TTS rate | AI文長指示 | 日本語サポート |
|---|---|---|---|---|---|
| 1 | A1 | 基礎1000語のみ | -25% | ≤8語 | AI発話に和訳を常時併記 |
| 2 | A2 | 基礎2000語 | -15% | ≤12語 | ヒント常時表示 |
| 3 | B1 | 平易だが制限緩め | -8% | 自然 | ヒントはボタン |
| 4 | B2 | 制限なし | 0% | 自然+慣用句可 | ボタンのみ |
| 5 | C1 | 制限なし・慣用的 | 0% | ネイティブ相当 | なし |

このテーブルが Haiku system と TTS SSML の両方に注入される唯一の難易度ソース。

各レベルには日本語の目安表示用フィールドも持たせる（`labelJa`=入門〜上級の短ラベル / `guideJa`=できることの一文 / `benchmarkJa`=英検・TOEIC相当 / `ttsRateLabelJa`=話速の日本語表現）。ホーム（ストリーク欄下のレベル行→進捗へのリンク）と進捗画面（レベルカードに目安・AI調整内容）に表示する。

## 9. シナリオシステム

- バンドル初期パック: `public/scenarios/index.json`（Scenario[]）。**8カテゴリ×5レベル=40本**。生成はClaude Codeセッションで行い（APIは使わない）、`scripts/validate-scenarios.mjs`（スキーマ・件数・重複id・キーフレーズ数などを検証、API不使用）を必ず通してからコミット
- targetPhonemes はキーフレーズ+modelAnswerの語をCMUdict系列で注釈した頻出音素（生成時に付与。shadotoma `scripts/annotate-phonemes.mjs` の対象15音素と同一キー体系）
- アプリは起動時に index.json を fetch してメモリ保持（IndexedDBへはコピーしない。生成シナリオのみ `scenarios` ストア）
- 週次ボス(§10): その週のシード（ISO週番号）で「現レベル+1」の未プレイbundledシナリオから決定的に選出
- 動的生成（M9・オプション）: Sonnetに興味タグ+弱点+レベルを渡しScenario JSONをtool useで生成→`scenarios`ストアへ

## 10. ゲーミフィケーション（`src/lib/game/`・全て純関数・Vitest必須）

- **XP** `xp.ts`: レッスン完了+50 / hidden objective各+10 / キーフレーズ全✓+20 / クエスト各+30 / ボス+150 / クイック会話+25 / ひとくち+10。ガイドで模範解答を見たステップは1件につき-5（下限0）。ストリーク倍率 `×(1+min(streak,25)×0.02)`（最大1.5、端数切上げ）
- **継続優遇（重要）**: その日の最初のセッションに **+30 デイリーボーナス**。同日2セッション目以降の獲得XPは**50%に減衰**（がっつり1日より毎日コツコツが得になる設計。日次キャップ§12とも整合）
- **お休みチケット（ストリーク保険）** `streakUnion.ts`: 7日継続ごとに1枚獲得（最大2枚保持、userProfileに保存）。練習しなかった日はチケットを自動消費してストリーク継続（消費日はカレンダーに「🎫」表示）。切れる恐怖ではなく「守られている安心」で継続させる。**付与判定は会話セッション完了時のみ**（サイレント復習のみの日は7日節目を通過しても付与されない。§4b）
- **ランク** : `xpForRank(n) = 50×n×(n+1)` の累積閾値。ランク名は「見習い→旅人→冒険者→…」の定数配列
- **ストリーク** `streakUnion.ts`: hanatoma単独streak + コンビストリーク（hanatoma∪shadotomaの練習日集合に対する calcStreak）。hanatomaの練習日 = **completed会話の日付 ∪ サイレント復習の完走日（reviewDates。§4b）**
- **サイレント復習XP（§4b）**: セット完走+10。**1日1回のみ**で、ストリーク倍率・デイリーボーナス・減衰の対象外（calcSessionXpを通さない固定加算）
- **デイリークエスト** `quests.ts`: 学習日文字列のFNV-1aハッシュをシードに、カタログから決定的に3件選択（レベル・弱点音素でフィルタ）。カタログ例: 1シナリオ完了 / 新しい表現を3つ使う / 発音スコア80+のターンを5回 / 苦手音素◯を含む語を3回言う / クイック会話2本 / キーフレーズ全部✓
- **バッジ** `badges.ts`: `evaluateBadges(profile, conversations, expressions)` → カテゴリ制覇（各カテゴリ5シナリオ完了）/ 音素克服（PA移動平均≥75）/ ストリーク7・30・100 / 表現帳50語 / ボス初勝利 など
- **★評価** `stars.ts`: composite 50/70/85 → ★1/2/3
- **島マップ**: カテゴリ=島。カテゴリ内★合計が閾値で次の島アンロック（表示上のロック。プレイ自体は可＝飽き対策で強制しない）
- **リワード画面**: XP加算アニメ → 新表現カード → バッジ/昇格 → クエスト進捗。会話終了後に必ず表示

## 11. shadotoma 連携（データレベル）

### 11a. 読み取り `src/features/sisterApp/shadotomaBridge.ts`
- 本番同一オリジン（tomato-daio.github.io）でのみ成立。`openDB('shadotoma')` を**バージョン指定なし**で開き（upgradeコールバックは絶対に渡さない）、読み取り専用で使う
- 存在確認: open後に objectStoreNames に `submissions`/`sessions` が無ければ即closeしてnull。**nullなら連携UIをすべて静かに非表示**（devのlocalhostでは常にnull）
- 読むもの: `submissions`（judge.azure の音素スコア → 弱点音素の時間減衰集計。集計純関数は shadotoma `src/features/insights/weakness.ts` から該当関数をコピーし `weaknessFromSubmissions.ts` として同梱。⚠️shadotoma側の型変更時は要同期 — 両DESIGN.mdに相互注記）、`sessions`+`submissions`（日付集合 → コンビストリーク）
- 用途: シナリオ推薦（targetPhonemes×弱点音素の一致スコア）、Sonnet添削への「注意音素」注入、クエスト生成
- dev用モック: 設定画面の開発者セクション（`import.meta.env.DEV` のみ表示）に shadotoma のバックアップJSONを読み込むパスを用意

### 11b. 書き出し「シャドとまで練習する」`exportToShadotoma.ts`
- レポート画面から: 添削済み模範会話スクリプト+TTS音声(WAV) を shadotoma のローカル教材として登録
- 方式: 確認ダイアログ→ shadotoma DB の `materials` ストアへ1レコード put。形は shadotoma の local Material 契約に従う: `{ id:'local-'+uuid, source:'local', title, level:0, category:'Hanatoma', audioBlob, sentences:[{en}...], wordCount, addedAt }`。**必須フィールドのみ書く。optionalは書かない。他ストアには触れない**
- 契約型は `shadotomaMaterialContract.ts` に複製し「⚠️shadotoma DESIGN.md §3 と同期必須」と注記
- 事前チェック: materialsストア存在 + DBバージョン≥3。失敗時/dev時フォールバック: 音声WAVダウンロード + スクリプトのクリップボードコピー → shadotomaの手動ローカル取り込みを案内

## 12. 使用量・コストガードレール（`src/lib/usage/`・純関数・Vitest必須）

- `caps.ts`: 日次キャップ判定。既定 `{sessions:3, sonnetCalls:8, paMinutes:30}`（appStateで変更可）。超過時はAPIを呼ばず「今日の練習上限に達しました（設定で変更できます）」
- `pricing.ts`: 単価定数（USD/Mtok: haiku in 1.0/out 5.0、sonnet in 3.0/out 15.0、cache read=inの1/10。Azureは無料枠前提で0円表示+超過注記）。為替は定数 `USD_JPY = 155`（設定で変更可）
- usageLog 加算はAPIレスポンスの usage をそのまま記録。設定画面ダッシュボード: 今月合計（呼び出し数・トークン・概算円）+ 日別ミニ表
- 会話履歴の切り詰め（§7a）と Haiku max_tokens 200 固定もコスト対策の一部

## 13. ディレクトリ構成

```
hanatoma/
  DESIGN.md
  package.json / vite.config.ts / tsconfig*.json / index.html
  .claude/launch.json（hanatoma-dev, port 5174）
  .github/workflows/deploy.yml
  scripts/{gen-icons.mjs, validate-scenarios.mjs}
  public/{robots.txt, favicon.svg, pwa-*.png, apple-touch-icon.png, scenarios/index.json}
  src/
    main.tsx / App.tsx（HashRouter+タブ）
    index.css（hanaパレット）
    components/TabLayout.tsx
    lib/
      db.ts dates.ts backup.ts wav.ts audio.ts wakeLock.ts
      level/{metrics.ts, progress.ts, params.ts}
      game/{xp.ts, quests.ts, badges.ts, stars.ts, streakUnion.ts}
      review/{sm2.ts, reviewCards.ts}（サイレント復習の純関数。§4b）
      usage/{caps.ts, pricing.ts}
    features/
      speech/（azureSpeechConfig.ts, azurePaUnscripted.ts, azureTts.ts, voiceList.ts）
      llm/（anthropicClient.ts, haikuPartner.ts, sonnetCorrection.ts, prompts/）
      recorder/（useRecorder.ts）
      conversation/（useConversation.ts=状態機械, MicButton.tsx, TurnList.tsx, HintPanel.tsx ほか）
      report/（CorrectionReportView.tsx, ExpressionNotebook.tsx, phonemeComments.ts, exportToShadotoma.ts）
      sisterApp/（shadotomaBridge.ts, shadotomaMaterialContract.ts, weaknessFromSubmissions.ts）
      review/（reviewStore.ts。§4b。homeData.tsをimportしない葉モジュール）
      diagnostic/ game/（RewardScreen.tsx, QuestList.tsx, ScenarioMap.tsx, BadgeShelf.tsx）
      settings/
    pages/{HomePage, ScenariosPage, ReportsPage, ProgressPage, SettingsPage, TalkPage, ReviewPage, OnboardingPage}.tsx
    stores/（zustand）
```

## 14. マイルストーン

- **M0** 足場: 雛形・タブ5枚・DESIGN.md・deploy.yml・アイコン。GH Pagesに空アプリ
- **M1** DBと設定: db.ts全ストア+テスト、dates.tsコピー、キー設定UI（password型・接続テスト・バックアップ除外）、backup、Anthropicキー発行手順doc
- **M2** 音声検証: recorder→WAV→unscripted PAセルフテスト画面（最大の技術リスク検証点）
- **M3** 会話最小版: 1ハードコードシナリオでPA→Haiku(stream)→TTSフルターン、テキスト切替、レイテンシログ
- **M4** 添削: Sonnet構造化添削、レポート画面、表現帳、音素助言マージ
- **M5** シナリオ: 初期パック40本+validate、5フェーズレッスン完全版、クイック会話
- **M6** 診断+レベル: オンボーディング診断、昇降格、パラメータ注入
- **M7** ゲーム: XP/ランク/クエスト/バッジ/★/マップ/リワード/ボス
- **M8** 連携: shadotomaブリッジ・コンビストリーク・弱点推薦・教材書き出し
- **M9** 仕上げ: 動的生成、使用量ダッシュボード+キャップUI、PWA磨き、最終QA
- **M10** サイレント復習: SM-2間隔反復めくりカード（§4b）、ストリーク合流、ホーム/表現帳導線

## 15. 検収基準（共通）

- `npm run build` と `npm test` がエラーゼロで通る
- PC Chrome/Edgeで動作（iPhone実機はユーザー検収）
- console.errorが出ない。TypeScript strictでany乱用しない
- src/lib 配下の純関数は必ずVitestテストを持つ
