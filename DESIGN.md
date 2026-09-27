# はなとま (hanatoma) — 設計書

AI英会話アウトプット練習PWA。**個人利用・低ランニングコスト（月500円目安）・iPhone完結**が絶対条件。
この文書が実装の正本。実装エージェントはこの仕様に従うこと。

姉妹アプリ: **シャドとま (shadotoma)** `C:\Users\tamog\dev\shadotoma`（英語シャドーイング=インプット練習）。
本アプリは**アウトプット練習**（自分で文を組み立てて話す・会話の流暢さ・表現の幅）を担当し、UI統合はせず**データレベルの連携のみ**行う（§11）。

## 0. 絶対ルール

- 個人情報（本名・実年齢・勤務先・個人メール）をコード・コメント・package.json author等に一切書かない。作者名義は `tomato-daio`。
- 学習データ・録音は**端末内(IndexedDB)のみ**。外部送信は次の3つに限る（いずれもユーザー自身のAPIキーで、送信内容は必要最小限）:
  1. **Azure Speech**: 会話中の発話音声（音声認識。M13）、発音評価対象の発話音声+参照テキスト、TTS用の合成テキスト
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
- 録音は `MediaRecorder`（iOS Safari=`audio/mp4`(aac) / Chrome・Edge=`audio/webm`(opus)。`MediaRecorder.isTypeSupported`で選択、Blobの実mimeTypeをそのまま保存）。※M13以降、会話ターンはMediaRecorderを使わず、Azureへ流した16kHz PCM16をWAVにして保存する（MediaRecorderはキーフレーズ予習・オンボーディング・セルフテストのみ）。**Azure SDK内蔵マイクは使わない**（iOSオーディオセッション管理がshadotomaで実証済みの自前管理と競合するため）。
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
                                 // M13: 会話ターンは会話完了時に 16kHz WAV（発話区間）を一括添付。キーフレーズは従来の録音Blob
  mimeType?: string;
  pa?: PaResult;                 // userのみ（音声入力時）。M13: 会話ターンは会話終了後に付与（採点できなかったターンは無し）
  thinkingMs?: number;           // userのみ。M13: 聞き取り開始（AIの発話終了）→実際に話し始めるまで
                                 // （認識結果の音声オフセット基準。旧定義は「→録音ボタンを押すまで」で、新旧は厳密には比較できない）
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
//       paProsodyFallback({region,date}) ← 韻律非対応リージョンの当日キャッシュ(§6a)
//       paDebugLog(string[]・「HH:MM:SS [tag] 行」最新30件リングバッファ) ← PA診断ログ(§6a-2)。M13で会話の速さ([会話])・STT・会話後PAも記録
//       endOfTurnPatience('short'|'normal'|'long'|'manual') ← 話し終わりの待ち時間(§5・M13)
//       micMode('perTurn'|'keepOpen') ← 会話中のマイク方式(§5・M13)

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
- `mode:'quick'`（クイック会話・約5分）: フェーズ3〜5のみ（**予習なし・添削あり**。題材はレッスンと同じおすすめシナリオ）。M13: 会話画面で「タップして会話をはじめる」を押してからAIが話し始める（iOSの音声再生アンロックとマイク許可のため。biteも同じ。lessonはキーフレーズ予習の「会話をはじめる」が兼ねる）
- `mode:'bite'`（**ひとくち英会話**・1〜2分）: AIの一言に1回だけ音声で応答→ミニ講評1文（Haiku。Sonnet添削なし）。**忙しい日でもストリークが継続する最小単位**。ホームに常設ボタン
- ホームの各モードカードには「予習の有無 / 添削の有無 / 所要時間」の差を明記する（ユーザーがモードの違いを認知できる3軸）

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

## 5. 1ターンの音声パイプライン（M13: ハンズフリー・リアルタイム会話）

**原則: 会話中は発音評価(PA)をしない。** 旧パイプライン（🎤タップ→話す→⏹タップ→PA確定待ち→Haiku→TTS）は、
unscripted PAの確定が発話長に比例して遅れ（S0でも改善せず・§16a）、返答まで数秒〜15秒かかって会話にならなかった。
M13で「PAなしの音声認識（§6d）でテキストだけ取り、話し終わりを自動検知して即AIへ」に作り替え、PAは会話終了後（§6a-3）に回した。

```
[聞き取り] マイク(worklet) → 16kHz PCM16 → 送信ゲート → Azure STT（PAなし・無音500msで1フレーズ確定）
   recognizing＝字幕に薄く表示 / recognized＝確定文をためる
   最後が確定文 かつ 待ち時間Wのあいだ新しい発話なし → ターン確定（「送信」タップで即確定も可）
   W（live/endOfTurn.ts）: 言い終わった形 500ms / 普通 800〜1000ms / 言いかけ(and, because, to, the, um…)で終わる 2500ms
       × 設定「話し終わりの待ち時間」短め0.6・標準1・長め1.6、手動=送信タップのみ
[確定] STTを閉じる（F0の同時認識1本を空ける）→ DB書き込みを待たずに即 Haiku streaming（設定は会話開始時に先読み）
   → 1文目は3文字以上で即TTS（会話中1本の事前接続シンセサイザ §6c）→ 2つ目以降は再生待ちが尽きたとき/終了時にまとめて1リクエスト
[AI発話中] マイク音声はSTTへ送らない（半二重）。「割り込む」タップ＝TTS停止＋Haiku中断→即聞き取りへ（声での割り込みは非対応）
   全チャンクの再生完了（ストリーム終了かつ再生キュー空）→ 150ms待って自動で聞き取り再開
[一時停止] 20秒話さなければ自動停止（Azure無料枠の節約）→「再開」タップ。ヒント音声の再生中・テキスト入力中・バックグラウンド中は自動で止めて自動で戻る
[会話終了] 聞き取りを閉じる → 会話後PA（§6a-3）‖ Sonnet添削 → PA結果をターンへマージ → 指標・★・XP・レベル
```

- 構成（`src/features/conversation/`）: `live/endOfTurn.ts`（話し終わり判定・純関数）/ `live/liveMachine.ts`（ターン交代の状態機械・純関数reducer）/ `live/liveTalkController.ts`（副作用の実行: マイク・STT・タイマー・会話フック。STTは常に最大1本）/ `live/useLiveTalk.ts`（React）/ `LiveTalkBar.tsx`（UI）/ `aiTurn.ts`（Haiku→区切り→TTS→再生の1ターン）/ `conversationWriter.ts`（DB書き込みの直列化・合流・終了後のseal）/ `useConversation.ts`（会話データ・AIターン・キーフレーズ予習）
- 目標レイテンシ（話し終わり→AIの最初の音）: **約2秒**。内訳目安: 区切り無音0.5s+確定の遅れ〜0.2s+待ち時間W 0.5s / Haiku初文0.4〜0.8s / TTS初回（事前接続済み）0.2〜0.4s。フッターに `発話終了→AI音声 1.9s | 確定0.9・AI初文0.6・TTS0.3` を表示し、同じ内容を診断ログ（[会話]）に記録する（発話終了＝最後の確定文の音声オフセット＋長さ、AI音声＝実際の再生開始）
- 状態（liveMachine）: off → aiThinking → aiSpeaking →（drained+150ms）→ listening → hearing（部分認識あり）→ endpointing（確定文あり）→ commit → aiThinking…。一時停止は2種: holds（hint/text/background。自動で戻る）と paused（user/idle/error/mic/cap。「再開」タップで戻る）。確定文は一時停止をはさんでも同じターンに引き継ぐ
- マイク方式（設定 `micMode`）: **既定 `perTurn`**＝聞き取りの間だけ getUserMedia し、AIが話す間は閉じる（iPhoneで実績のある動き。マイク使用中はiOSが通話用の経路に切り替えてAI音声が小さくなることがあるため）。`keepOpen`（実験）＝会話中ずっと開いたまま・`navigator.audioSession.type='play-and-record'`。トラックの mute は一時停止（mic）、ended はマイク停止として再開タップへ
- 開始タップ: 開始時にAudioContextをresume（iOSの再生アンロック）し、マイク許可を先に取っておく（perTurnは一度開いてすぐ閉じる）
- **AI発話の字幕は読み上げに同期**（`captionReveal.ts`）: Haikuの文字は音声より数秒早く届くため、生成途中のテキストは出さず、鳴っているチャンクを音声の長さに比例して単語単位で出す（声より250ms先行）。ストリーム終了で履歴には入れるが、吹き出しは再生が終わるまで字幕のまま（`speakingTurnAt`）。割り込み時は全文の吹き出しに切り替える。TTSなし・合成失敗のチャンクはそのまま全文を出す
- テキスト入力: キーボードアイコンで切替（聞き取りは自動で止まる）。PAなし（`inputMode:'text'`）
- ひとくち（bite）: 1往復したらAIの返答が終わった時点で聞き取りを止め、完了ボタンを出す
- 使用量: STTへ送った音声秒と会話後PAの音声秒を `paSeconds` に加算し、日次キャップ `paMinutes`（表示名「音声認識・発音評価（分）」）で判定。超過時は聞き取らずテキスト入力へ案内
- キーフレーズ予習（lesson）は従来どおりタップ録音＋録音中ストリーミングscripted PA（§6a-2・§6b）でその場で採点する（短文で確定が速いため）

## 6. Azure Speech 連携

`src/features/speech/`。キー/リージョン管理・接続テストは shadotoma `azureSpeechConfig.ts` をほぼコピー（appState keys: `azureSpeechKey`/`azureSpeechRegion`、issueTokenで検証、リージョン初期値 japaneast）。

### 6a. unscripted 発音評価（会話ターン用）`azurePaUnscripted.ts`
- `PronunciationAssessmentConfig`: referenceText=**空文字**、GradingSystem=HundredMark、Granularity=Phoneme、EnableProsodyAssessment。`speechRecognitionLanguage='en-US'`
- 音声は WAV(16kHz mono PCM16) を pushStream で投入。60秒超対応のため continuous recognition で最後まで処理し、複数結果は**音声長加重でスコア統合**（shadotoma `azurePronunciation.ts` のロジック流用）。認識テキストは連結
- **プロソディ・フォールバック**: 韻律有効で失敗したら韻律なしで1回だけ自動リトライ（japaneastで失敗実績あり）。両方失敗時のみエラー（`azureError` に errorDetails 先頭120字）
- **韻律非対応の当日キャッシュ**（レイテンシ対策）: フォールバック成功時に appState `paProsodyFallback` = `{region, date(学習日)}` を記録し、**同日・同リージョンなら最初から韻律なし1回で実行**（毎ターン2回認識になるのを防ぐ）。学習日が変わると自動で再プローブ（Azureが韻律対応した際の自己回復。1日の最初のターンだけ2回になりうる）。1回目の失敗が一時障害系（`isTransientPaError`: ネットワーク/認証/タイムアウト）のときは書かない（誤学習防止）。韻律あり成功時はキャッシュ削除。キャッシュ読み書き（azureSpeechConfig.tsのget/set/clearヘルパー）は決してthrowせず評価の成否に影響させない
- **セッション内韻律ガード**（M11補修）: 韻律あり試行の失敗（結果ゼロ除く）を1回でも観測したら、同一アプリセッション中は stream/batch とも韻律なしで直行する（当日キャッシュが書かれない一時障害分類の失敗でも二重試行の連鎖を防ぐ第二の防衛線）。リロードでリセット・韻律あり成功で解除。selftest診断パネルで現在値の確認とリセットが可能。**全体デッドラインabort由来の失敗ではガードを立てず、韻律なしリトライも行わない**（純関数 `classifyProsodyFirstFailure`: signal.aborted時はリトライしても即中断されるだけ。非abortのタイムアウトもNoResult同様ガード対象外——タイムアウトは韻律非対応の証拠にならない、というstream側と同方針。M12補修）
- 音素スコアを集計し `weakPhonemes`（低スコア音素トップ3: 記号・平均点・例語最大2）を保存
- PAエラー時も会話は継続する（認識テキストが取れなければ「聞き取れませんでした。もう一度どうぞ」表示。Haikuは呼ばない）
- **フレーズヒント**（認識精度向上）: `assessSpeech` は `phraseHints?: string[]` を受け取り、`PhraseListGrammar.fromRecognizer(recognizer).addPhrases()` で認識エンジンに渡す。会話ターンでは `buildPhraseHints(scenario, ctx: {phase, stepIndex})`（`src/features/conversation/phraseHints.ts`・純関数・Vitest必須）で**文脈に絞って**組み立てる: ガイド中=キーフレーズ英文+現在stepのmodelAnswerのみ、それ以外（フリー会話等）=キーフレーズ英文のみ。⚠️全stepsの模範解答（長文8〜10件）を一括で渡すと認識がヒント文へ引っ張られる over-biasing の実害があったため、範囲を広げないこと。ヒントは重複除去（大文字小文字無視）・空除去のうえ最大40件

- **送信スロットルの無効化**: SDKは既定で先頭5秒を超えた分を実時間の2倍速にペーシングする（ServiceRecognizerBase.sendAudio）。録音済み音声の一括投入に実時間ペースは不要なため、stream/batch両経路で `speechConfig.setProperty('SPEECH-TransmitLengthBeforThrottleMs','300000')` を設定する

### 6a-2. ストリーミング発音評価（M11）`azurePaStreaming.ts`

> M13以降、会話ターンでは使わない（会話中はPAなしのSTT §6d、PAは会話後 §6a-3）。現在の利用者はキーフレーズ予習（scripted）とセルフテストのみ。以下は当時の設計と実測の記録。
- **録音開始時に** SDK import（useConversationマウント時にprewarmSpeechSdkで事前ロード済み）→ WS事前接続（Connection.openConnection）→ continuous認識開始まで済ませ、マイクの16k PCM16（`lib/pcm.ts` の決定的リサンプラ+`recorder/pcmTapWorklet.ts` のAudioWorkletで生成）を逐次push。停止時は close→確定待ちのみ
- **マイクタップ二重張りの防止（M12補修・重要）**: `useRecorder.start()` の多重起動ガードは **state（isRecording）ではなく `streamRef`（ref）** で行う。stateで判定すると、録音ボタン連打時に「2回目のタップの開始処理」が再レンダリング前のクロージャ（isRecording=false）を通ってしまい、**2本目のマイクストリームとPCMタップが張られる**。1本目はrefを上書きされて解放されず**ページ生存中ずっと残留**し、以降すべてのターンで同じ声が二重に流れる（実測: バイト数から算出した音声秒数が実測の約2倍。Azureへ送る音声も43ms単位で二重化して認識が破綻し、`canSalvagePartial` の未カバー末尾も常に閾値超になってサルベージが全滅した）。MicButton / KeyPhrasePanel 側にもタップ連打ガード（ref）を置き、`beginVoiceTurn`/`beginKeyPhrase` の二重呼び出し（評価セッションの二重張り）も防ぐ。診断ログの `音声 X.Xs(実時間 Y.Ys)` はこの種の異常の検出用（実時間をわずかに下回るのが正常）
- **失敗契約**: このモジュールは内部層としてthrowする。呼び出し側（`conversation/voiceCapture.ts`→useConversation）が録音Blobからbatch(assessSpeech)へ自動フォールバックし、「throwせずazureErrorで返す」PaResult契約はbatchが最終保証する
- **韻律**: 当日キャッシュ+セッション内ガード（§6a）で事前判定。ストリーミング内での韻律なしリトライはしない（音声を再送できない）。**韻律起因（非一時障害・非結果ゼロ）の失敗時はthrow前に当日キャッシュをawaitで書き込み**、直後のbatchフォールバックを韻律なし1回にする（「stream失敗+batch2回」の三重連鎖を断つ。M11補修）
- **後片付け（M11補修）**: WebSocketを実際に切るのは `Connection.closeConnection()`（`close()`はラッパー破棄のみ）。closeAllは closeConnection→connection.close→recognizer.close→audioConfig→speechConfig の順（iOS teardownバグでrecognizer.closeが不完全でもWSを残留させず、F0無料枠の同時接続を塞がない）。**認識開始失敗時もcloseAllを必ず呼ぶ**（呼ばないと事前openしたWSがリークし後続ターンを遅くする）。**batch側 `recognizeOnce` のfinallyも同順のテアダウンを実施**（M12補修。従来はrecognizer.closeのみで、iOSのteardownバグ時に失敗batchのWSが残留し次ターンの失敗連鎖を招いていた）
- **認識開始タイムアウト（M12補修）**: `startContinuousRecognitionAsync` は WSハンドシェイクがハングすると成功・失敗どちらのコールバックも呼ばれない。`START_TIMEOUT_MS=10秒` でrace し、超過時は closeAll→throw（voiceCapture の sessionPromise 待ちが無期限化して「評価中」がハングする根を断つ）
- **韻律はscriptedのみ（M12・実測対応）**: F0無料枠では**unscripted（自由会話・長音声）の韻律採点でclose→確定が音声長ぶん7〜16秒**に膨らむ（scriptedの短文は<0.4sで確定）。会話ターン（unscripted）は `enableProsodyAssessment=false` に固定して確定を高速化する（pron/accuracy/fluencyは維持、prosodyScoreはundefined）。キーフレーズ予習（scripted）は従来どおり韻律あり。batch側も同様。※**S0でも遅い（M12補修・実測で確認）**: japaneast S0 に切り替えても unscripted の `初回認識` 3.6〜8.3秒／`close→確定` 2.4〜8.0秒で、F0との差が見られなかった。「遅さの主因はF0のスループット上限」という当初の見立ては誤り。切り分けのため診断ログに `無音除く遅れ`（純関数 `recognitionLagSeconds`: 初回認識の壁時計 − Azureが返すoffset＝その発話が音声の何秒目か）を追加した。0.5秒前後ならストリーミングは健全（`初回認識` の大部分は「マイクを押してから話し出すまでの無音」）、数秒あれば送信経路かサービス側が実時間に追いついていない
- **適応finishタイムアウト＋部分結果サルベージ（M12）**: 純関数 `finishTimeoutMs(mode, hasEvidence, audioSeconds)` — 証拠（recognizing/recognized）ありで unscripted は**音声長連動（下限8秒 FINISH_TIMEOUT_WITH_EVIDENCE_MS 〜 上限13秒 FINISH_TIMEOUT_MAX_MS）** / scripted 4秒・無しで3秒（旧45/10秒は最大~70秒固まる原因だった。scriptedは短文で確定<0.4s・batchも速いため8秒粘る理由がなく短縮）。音声長連動の根拠（M12補修・実測）: F0の確定遅延はほぼ音声長に比例する（音声3.4s→close→確定3.4s／音声12.7sは8秒でも末尾5.3sが未確定でエラー化）。batchフォールバックはF0の自由会話では実質無力なので、長い発話は見切らず待つ側に寄せる（全体は submitVoiceの15秒デッドラインで頭打ち）。タイムアウトしても**録音中に集めたフレーズを捨てずサルベージ**する（純関数 `canSalvagePartial`: 未カバー末尾がSALVAGE_MAX_UNCOVERED_TAIL_SEC=3秒以内ならOK）。close後NUDGE_AFTER_CLOSE_MS=2秒で `stopContinuousRecognitionAsync` を能動的に叩き、ストールしたsessionStoppedを引き出す（nudge）。**nudgeのstop成功時、収集済みフレーズでcanSalvagePartialを満たせば即settle**し、タイムアウト満了を待たない（M12補修。ストール時8秒→約2〜3秒）。タイムアウトは韻律の是非と無関係なので韻律ガードは立てない
- **部分テキスト最終サルベージ（M12補修・unscriptedのみ）**: `recognizing` の部分認識テキスト（最終確定以降の未確定の尻尾）を保持し、結果の組み立ては純関数 `resolveFinishSalvage` で3段階判定する。(a)確定フレーズあり・末尾カバー良好→従来のスコア付きサルベージ (b)確定フレーズあり・末尾3秒超欠け→**新鮮な部分テキストがあれば**スコアは確定分の実測のまま認識テキストだけ尻尾を連結／無ければ `throw-timeout`（no-resultではなくtimeout種別で返し、後段の `shouldSkipBatch` に間に合わないbatchを見送らせる。M12補修） (c)**確定フレーズ0件のタイムアウト→部分テキストだけを `pa.azureError` 入り（スコア欠損）で返し、会話を継続させる**（従来はbatch→15秒デッドライン超過→エラー・ターン破棄で言い直しだった）。部分テキストの鮮度（カバー末尾が総音声秒数−3秒以上）を満たさない場合は使わない（不完全発話へのAI返信事故防止）。scriptedはスコアが成果物のため(b)(c)とも対象外。スコア欠損ターンは TurnList で「スコアなし」チップ表示・`metrics.ts` のpron平均から除外（azureError付きpaは集計しない）
- **batch見切り（M12補修・unscriptedのみ）**: 純関数 `shouldSkipBatch(failure, audioSeconds)`（voiceCapture.ts）— streamの失敗種別が確定待ちタイムアウト（`lastFailure()==='timeout'`）かつ音声がBATCH_SKIP_MIN_AUDIO_SEC=4秒超なら、F0ではbatchもデッドライン内に完了する見込みが薄いため試みず即エラー表示（「7秒無駄に待って同じエラー」を「即言い直し」に変える）。セッション開始失敗・WS死亡・ゼロチャンク等（'other'）は従来どおりbatchへ。タイムアウトの分類は `AzurePronunciationTimeoutError.hadEvidence`（認識イベントを1件でも観測していたか）で行い、**証拠ゼロ（WS沈黙死の疑い・3秒タイムアウト）はhadEvidence=false→'other'** として新規接続のbatchを妨げない
- **全体デッドライン（M12）**: submitVoice側で PA_DEADLINE_UNSCRIPTED_MS=15秒、**submitKeyPhrase側で PA_DEADLINE_SCRIPTED_MS=12秒**（M12補修。従来scriptedは上限なしで最悪48秒級だった）の AbortController を張り、streaming確定+batchの合計が長引いたら in-flight 認識を abort。signalは **`capture.finish(signal)`（voiceCapture層でセッション確立待ち・確定待ちの両方とrace。従来はfinishが返るまで中断できなかった）** と batch `AssessSpeechOptions.signal`→recognizeOnce の両方へ貫通する。race敗者放置でF0のWSを掴み続け失敗連鎖になるのを防ぐ。batch側 `RECOGNITION_TIMEOUT_MS` も120→20秒に短縮
- **PA診断ログ**: 主要イベント（開始・接続/初回認識/確定ms・失敗理由・batch各試行）を `paDebugLog.ts` 経由で appState `paDebugLog` に記録し、selftest「6. 直近のPA診断ログ」で閲覧・コピー・クリアできる（iPhoneでのconsole代替・障害報告の一次情報）
- iOS teardownバグ対策（swallowTeardownError）・resolveRecognitionOutcome・aggregatePhraseAssessments は azurePaUnscripted.ts と共有
- セッション状態遷移は純関数 nextSessionState（Vitest）。usageLog加算はstream/batchどちらか一方のみ

### 6a-3. 会話後の発音評価（M13）`conversation/deferredPa.ts`
- 会話中にSTTへ流した16kHz PCM16をターンごとに保持し、確定時に発話区間（認識結果の offset/duration）±300msへ切り詰めて `TurnClip {at, text, pcm}` にする（`live/liveTalkController.ts`）
- 会話終了時（`sessionEnd.ts`）、聞き取りを閉じてから（F0の同時認識1本）、`selectClipsForPa` で評価するターンを選ぶ: 語数の多い順・1〜20秒のターン・合計は日次キャップの残りと1セッション60秒の小さい方まで
- `runDeferredPa` が1件ずつ直列に `assessSpeech` を実行。既定は **scripted（参照文＝会話中の認識テキスト・韻律なし `prosody:false`）**: 採点語が画面のテキストと一致し、短文では確定が速い実績がある。`DEFERRED_PA_MODE` で unscripted に切替可。1件ごとの所要時間は診断ログ `[会話後PA]` に記録
- **Sonnet添削と並行**に走らせ、Sonnet完了の2秒後（最低でも開始10秒・ひとくちは8秒）で打ち切り、上限30秒。打ち切られた・失敗したターンは `pa` なし（`metrics.ts` はpaなしを平均から除外・全ターンなしなら発音の重みを他へ配分）
- 結果は `mergeDeferredPa`（`Turn.at` で突き合わせ。Turn.at は会話内で単調増加・一意）でターンへ書き戻して保存し、以降の音素コメント・メトリクス・★・クエスト・レベルは**マージ後のターン**で計算する。終了オーバーレイに「発音 n/m」を表示
- 添削は `generateReport.ts` を `requestCorrection`（キャップ判定・Sonnet・usage加算）と `saveCorrectionReport`（音素コメント合成・保存・表現帳）に分割した。Sonnetへの発音注記は会話後PAを待たないため付かない（`formatTurnLine` はpa欠損を許容）

### 6d. 会話中の音声認識（PAなし・M13）`speech/azureStt.ts`
- 素の `SpeechRecognizer`（PronunciationAssessmentConfigなし・en-US）に16kHz PCM16をpush。`recognizing` を部分認識、`recognized` を確定（NoMatchは空文字）として逐次コールバック
- 区切り: `Speech_SegmentationSilenceTimeoutMs=500`（既定）。SDKでは無音指定を入れると `Speech_SegmentationStrategy=Semantic` が無効化される（排他）ため、どちらか一方だけを設定する。Semanticはセルフテスト「7. 会話の音声認識」で比較用に選べる（アプリ本体は無音500ms）
- `azurePaStreaming.ts` と同じ流儀: SDK事前ロード（prewarmSpeechSdk）・WS事前接続（openConnection）・開始タイムアウト10秒・送信スロットル無効化・フレーズヒント（buildPhraseHints）・closeConnection先の後片付け。接続完了前の音声はコントローラがバッファし、完了後に到着順で流す（話し始めの取りこぼし防止）
- 送信タップ時は `finish(600ms)`: 送信を締めて残りの確定を最大600ms待つ。確定が来なければ部分認識のテキストで送る
- 開始失敗・開始後のエラーは一時停止（error）＋案内。「再開」で新しいセッションを張る
- **接続失敗の自動回復（M13補修・iPhone実測）**: 初回実機で `Unable to contact server. StatusCode: 1006`（WebSocketのハンドシェイク拒否）が発生。区切りの指定は URL パラメータ `segmentationSilenceTimeoutMs` にも載るため、これが拒否された疑いがある。対策: ①認識結果を1件も受け取る前の接続エラーは、コントローラが1回だけ自動で張り直し、そのセグメントで録った音声を最初から送り直す ②区切り指定付きの接続がそう失敗したら、以降そのアプリセッション中は区切りを指定しない（SDK既定の区切り。`shouldDropSegmentation`）。張り直しも失敗したら（キー・リージョン誤り、今月の無料枠の使い切り、通信遮断の疑い）その旨を案内して一時停止。診断ログの `[STT]` 行に「区切り指定あり/なし」を記録する

### 6b. scripted 発音評価（キーフレーズ予習用）
- referenceText=キーフレーズ文。enableMiscue=true。他は6aと同じ。completenessScoreあり
- phraseHints にはキーフレーズ文そのものを1件渡す（参照文と認識のズレを減らす）

### 6c. Neural TTS `azureTts.ts`
- `SpeechSynthesizer` + `speakSsmlAsync`。**speaker直接出力はせず** audioData(ArrayBuffer) を統一AudioContextで再生（iOS再生アンロック制御のため）
- SSML: 音声名=appState `ttsVoice`（初期値 en-US-JennyNeural）、`<prosody rate>` にレベル別値(§8d)
- 利用可能音声はリージョンの voices/list REST で取得し設定画面に一覧表示+試聴（ハードコードしない。en-US Neuralのみフィルタ）
- キーフレーズ・模範解答の音声はセッション内メモリキャッシュ（同一文の再合成を避ける）
- **会話中のAI発話は `createTtsSession`（M13）**: 1つの `SpeechSynthesizer` を `Connection.fromSynthesizer().openConnection()` で会話画面を開いた時点から事前接続し、使い回す（文ごとに接続を作るとハンドシェイク数百msが毎回初音に乗るため）。同じシンセサイザへの要求はSDKが到着順に処理する。失敗時は作り直して1回だけ再試行。割り込み時に合成待ちが残っていれば接続を作り直す（古い文の合成が次のターンの前に並ばないように）
- F0のTTSは約20回/分の上限があるため、会話中は1ターン2〜3リクエストに抑える（§5の区切り方）。単発の `synthesize()` はヒント・キーフレーズ・試聴用

## 7. Anthropic API 連携

`src/features/llm/`。SDKは使わず素の fetch。ヘッダ: `x-api-key`（appState `anthropicApiKey`）、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`。エンドポイント `https://api.anthropic.com/v1/messages`。呼び出し前に必ず §12 のキャップ判定。レスポンスの usage を usageLog に加算。

### 7a. 会話パートナー（Haiku, streaming）`haikuPartner.ts`
- model: `claude-haiku-4-5`。max_tokens: 200。stream: true（SSE。fetch ReadableStreamでパース）
- system は2ブロック構成で **prompt caching**: [共通ルール（不変・`cache_control: {type:'ephemeral'}`）] + [シナリオ+レベルパラメータ（レッスン中不変・cache_control）]。会話履歴は messages で毎回送る
- 共通ルールの要点: あなたはシナリオのaiRoleを演じる / **発話のみ（ト書き・仕草・表情の描写・絵文字・アスタリスク禁止）** / 返答は1〜3文・レベル語彙制約(§8d) / ユーザーの英語の誤りは**会話中は直さない**（理解できたら会話を続ける。全く理解できない時だけ聞き返す）/ ゴール達成に向けて自然に誘導 / ガイドフェーズでは現在のstepのaiIntentに従う
- **ト書き除去の防御層**: プロンプト禁止にもかかわらず混入した `*nods with a smile*` 等の演技描写は、純関数 `stripStageDirections`（`sanitizeAiText.ts`・Vitest）で表示(aiDraft)・TTS読み上げ・Turn保存の全経路から除去する（履歴に残すと以降のターンでHaikuが真似るため保存前に落とす）。複数語の`*...*`と既知の仕草1語（smiles等）は除去、それ以外の1語は強調とみなし語だけ残す。マーカー無しの裸のト書きはプロンプト側で抑止
- 履歴が20ターンを超えたら古いターンを1行要約に畳む（コスト対策）
- M13: 共通ルールに「返答の冒頭は2〜5語の自然な相づち（Oh, nice! / I see. 等・毎回変える）」を追加（1文目が短いほど初音が早い）。`streamMessages` は `signal` で中断でき、中断時は例外にせず途中までのテキストと推定usage（出力≒文字数/4）を返す（usage加算は必ず行う）。割り込まれたAI発話も途中までのテキストで履歴に残す

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
- **pron欠損時の再重み付け（M12）**: 音声スコアが1件も無いセッション（テキスト入力のみ・発音評価スキップ等）は、pron=0を0.3で足すとcompositeが70で頭打ちになり昇格ライン75へ永久に届かない。pronの重みを残り3成分へ比例配分して再正規化する（grammar/fluency/complexity=0.3/0.2/0.2を合計1へ）

### 8c. 昇降格（`src/lib/level/progress.ts`・純関数・Vitest必須）
- 現レベル以上の難易度のレッスン直近5件中4件が composite ≥ 75 → 昇格（上限5）
- 直近5件すべて composite < 50 → 降格（下限1）。昇格から3日以内は降格しない
- **判定材料の窓（M12）**: `applyLevelProgress` は内部で「現レベル以上をフィルタ→直近5件」（昇格）／「直近5件（レベル問わず）」（降格）を行うため、呼び出し側 `sessionEnd.ts` は十分広い窓（**直近20件**）を渡す。5件しか渡さないと『直近5件が全て現レベル以上』でないと昇格判定が発動せず、復習で下位レベルを1回挟むだけで昇格がリセットされてしまう
- **昇格プログレスの可視化（M12・§8d）**: 純関数 `computePromoteProgress`（現レベル以上・直近5件のうち≥75の件数／あと何回）を Home・進捗・RewardScreen に表示（`LevelUpProgress`）。RewardScreenでは採点付きセッションのみ、このレッスンのcomposite・75ラインとの位置・昇格判定の対象/対象外も出す
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
- **島マップ**: カテゴリ=島。カテゴリ内★合計が閾値で次の島アンロック（表示上のロック。プレイ自体は可＝飽き対策で強制しない。推薦・開始経路にゲートは置かない）。**プレイ実績（★または完了）のある島にはロックを表示しない**（「解放されていないのに進捗がある」矛盾表示の防止）。ロック中キャプションは「前の島で★3ためると解放（先にプレイも可）」
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
- M13: `paMinutes` は「音声認識・発音評価（分）」＝会話中のSTTへ送った音声秒＋会話後PAの音声秒の合計で判定する（どちらもAzure Speechの無料枠 月5時間を消費する。shadotomaと共用）
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
      pcm.ts（M11: 決定的リサンプラ+PCM16変換の純関数）
      usage/{caps.ts, pricing.ts}
    features/
      speech/（azureSpeechConfig.ts, azurePaUnscripted.ts, azurePaStreaming.ts(M11), azureStt.ts(M13), azureTts.ts, voiceList.ts）
      llm/（anthropicClient.ts, haikuPartner.ts, sonnetCorrection.ts, prompts/）
      recorder/（useRecorder.ts, pcmTapWorklet.ts(M11), micSession.ts(M13)）
      conversation/（useConversation.ts=会話データ・AIターン, live/(M13: endOfTurn・liveMachine・liveTalkController・useLiveTalk),
                     aiTurn.ts, conversationWriter.ts, deferredPa.ts, LiveTalkBar.tsx, voiceCapture.ts(M11・キーフレーズ用),
                     MicButton.tsx(オンボーディング), TurnList.tsx, HintPanel.tsx ほか）
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
- **M11** ストリーミングPA: 録音中逐次評価（worklet→16k PCM16→push・WS事前接続・SDK事前warm）、batch自動フォールバック、送信スロットル無効化、selftest検証パネル
- **M13** ハンズフリー・リアルタイム会話（2026-09-27）: 会話中はPAなしSTT（§6d）＋話し終わり自動検知（§5）、AI側の高速化（DB待ち撤廃・TTS事前接続・1文目即読み上げ・割り込み）、会話後PA（§6a-3）、設定「話し終わりの待ち時間」「会話中のマイク」、selftest「7. 会話の音声認識」

## 15. 検収基準（共通）

- `npm run build` と `npm test` がエラーゼロで通る
- PC Chrome/Edgeで動作（iPhone実機はユーザー検収）
- console.errorが出ない。TypeScript strictでany乱用しない
- src/lib 配下の純関数は必ずVitestテストを持つ

## 16. 未決の検討事項（バックログ）

### 16a. 自由会話PAの遅延（S0でも解消せず。2026-07-25時点・保留中）

> **M13（2026-09-27）で会話の遅さとしては解消**: 会話中はPAをせず（§5・§6d）、PAは会話後にまとめて行う（§6a-3）ようにした。PA自体の遅延の原因（端末・回線側かサービス側か）は未判明のまま。会話後PAで採点できるターン数が少なすぎる場合は、下記「次の実験」と Granularity=Word 案を再検討する。

**症状**: 発話が長いほど遅れが累積し、長い発話ほど確定しない。iPhone実機・japaneast S0での実測:

| 音声長 | 無音除く遅れ（初回認識） | 結果 |
| --- | --- | --- |
| 3.4〜7.9秒 | — | すべて確定（close→確定 2.4〜8.0秒） |
| 16.7秒 | 1.5秒 | 13秒（FINISH_TIMEOUT_MAX_MS）待って scores-with-tail で救済 |
| 22.7秒 | 5.6秒 | 13秒待っても末尾15.3秒が未処理 → timeout → batch見送り → エラー |

**判明していること**:
- **F0/S0の差ではない**（S0へ切り替えて実測。当初の「F0のスループット上限が主因」という見立ては誤り）
- マイクタップ二重張り（§6a-2）は解消済み。診断ログの `音声` と `実時間` は一致している
- 「マイクを押してから話し出すまでの無音」ではない（`無音除く遅れ` = `recognitionLagSeconds` で差し引き済み）
- 10秒以内の発話は安定して成功する

**未判明**: 端末・回線側（音声の送信が実時間に追いつかない）か、Azure側（発音評価の計算が実時間より遅い）か。

**次の実験**: `Connection.messageSent`（JS SDKの `Connection` に存在）で音声メッセージの送信時刻を記録し、`pushStream` への書き込み量とのズレを診断ログに出す。ズレが録音中に増えていくなら端末・回線側、ズレが無いのに認識だけ遅れるならサービス側。

**サービス側だった場合の手**: unscripted のみ `PronunciationAssessmentGranularity` を Phoneme → Word に落として処理量を減らす。ただし音素スコア（`weakPhonemes`）が取れなくなるため、弱点音素の集計はscripted（キーフレーズ予習）限定になる。§8b metrics と §11 shadotoma連携への影響を確認してから決めること。

**当面の運用**: 1発話は10秒以内。長い発話でもサルベージ（`scores-with-tail` / `text-only`）で会話自体は継続する。

**課金メモ**: S0リソース `hanatoma-speech`（japaneast）は残置（未使用なら0円）。**速度目的でS0に戻す価値はない**ため、戻す判断は「無料枠 月5時間をshadotomaと共用して足りるか」だけで行う。
