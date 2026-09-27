/**
 * Azure Neural TTS（DESIGN.md §6c）。
 *
 * SpeechSynthesizer + speakSsmlAsync で合成し、audioData(ArrayBuffer)を返す。
 * speaker直接出力はしない（AudioConfigにnullを渡す）: iOSの再生アンロック制御のため、
 * 再生は呼び出し側が統一AudioContextで行う。
 *
 * SDK本体とappState解決（azureSpeechConfig→db.ts）はsynthesize内でのみ動的importする
 * （azurePaUnscripted.tsと同じ理由: キー未設定ユーザーの初期バンドルにSDKを含めない＋
 * buildSsml/TtsCache等の純関数部分をSDK・IndexedDBなしでVitestテストできるようにする）。
 *
 * キャッシュ（DESIGN.md §6c「キーフレーズ・模範解答の音声はセッション内メモリキャッシュ」）:
 * 同一(text, voice, rate)の再合成を避けるためのMapベースLRU（上限50件）。
 * ⚠️ 呼び出し側はArrayBufferを decodeAudioData に渡すが、decodeAudioDataは渡された
 * ArrayBufferをdetach（中身を空に）するブラウザがある。キャッシュ済みバッファをそのまま
 * 返すと2回目以降が空になるため、TtsCacheは保存時・取得時ともにコピーを取り、
 * 外に出すバッファとキャッシュ内部のバッファを常に分離する。
 */

/** メモリキャッシュの上限件数（DESIGN.md §6c: Map、上限50）。 */
export const TTS_CACHE_LIMIT = 50;

/** SSMLへ埋め込む前のXMLエスケープ。テキスト・属性値の両方で必要な5文字を実体参照へ置換する。 */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 合成用SSMLを組み立てる純関数（DESIGN.md §6c）。
 * rateは§8dのレベル別TTS rate（例: '-15%', '0%'）をそのまま<prosody rate>に入れる。
 * voice/rateもユーザー設定・テーブル由来の文字列のため、テキストと同様にエスケープして
 * SSML構造を壊せないようにする。
 */
export function buildSsml(text: string, voice: string, rate: string): string {
  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
    `<voice name="${escapeXml(voice)}">` +
    `<prosody rate="${escapeXml(rate)}">${escapeXml(text)}</prosody>` +
    '</voice>' +
    '</speak>'
  );
}

/**
 * キャッシュキーを作る純関数。text/voice/rateの区切りに固定文字を使うと
 * 値側に同じ文字が現れたとき別入力同士が衝突しうるため、JSON.stringifyで一意に直列化する。
 */
export function ttsCacheKey(text: string, voice: string, rate: string): string {
  return JSON.stringify([text, voice, rate]);
}

/**
 * TTS音声のメモリキャッシュ（LRU・上限付き）。
 * Mapの挿入順を「古い順」として使い、上限超過時は先頭（最も長く使われていない）を捨てる。
 * getヒット時は再挿入して「最近使った」側へ動かす。
 * set/getともにArrayBufferのコピーを取り、外部でのdetach・書き換えから内部データを守る
 * （ファイル冒頭コメント参照）。
 */
export class TtsCache {
  private readonly map = new Map<string, ArrayBuffer>();

  constructor(private readonly limit: number = TTS_CACHE_LIMIT) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): ArrayBuffer | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // LRU: 使ったエントリを挿入順の末尾（最近側）へ動かす。
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.slice(0);
  }

  set(key: string, value: ArrayBuffer): void {
    this.map.delete(key);
    this.map.set(key, value.slice(0));
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/** モジュール共有のセッション内キャッシュ（DESIGN.md §6c）。 */
const sharedCache = new TtsCache();

export interface SynthesizeOptions {
  /** 音声名（appState ttsVoice由来。例: 'en-US-JennyNeural'）。 */
  voice: string;
  /** <prosody rate>値（§8dレベル別。例: '-15%', '0%'）。 */
  rate: string;
}

/**
 * 合成完了待ちのタイムアウト。ネットワーク断等でSDKのコールバックがどちらも呼ばれないまま
 * Promiseが永遠に解決しないと会話画面のAI発話が止まったままになるため、上限を設ける。
 */
const TTS_TIMEOUT_MS = 30_000;

type SpeechSdk = typeof import('microsoft-cognitiveservices-speech-sdk');
type Synthesizer = import('microsoft-cognitiveservices-speech-sdk').SpeechSynthesizer;

/**
 * 1回ぶんの speakSsmlAsync をPromise化する（タイムアウト付き）。成功時はMP3のArrayBuffer。
 * 失敗時は日本語メッセージのErrorを投げる。
 */
function speakSsmlOnce(
  SpeechSDK: SpeechSdk,
  synthesizer: Synthesizer,
  text: string,
  opts: SynthesizeOptions,
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    // タイムアウト・完了コールバック・エラーコールバックのどれが先に来ても最初の1回だけ確定する。
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('AI音声の合成がタイムアウトしました。通信環境を確認してください。'));
    }, TTS_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn();
    };

    synthesizer.speakSsmlAsync(
      buildSsml(text, opts.voice, opts.rate),
      (result) => {
        if (
          result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted &&
          result.audioData &&
          result.audioData.byteLength > 0
        ) {
          finish(() => resolve(result.audioData));
        } else {
          // Canceled等。errorDetailsにキー無効・リージョン不一致などの理由が入る。
          const detail = result.errorDetails ? `（${result.errorDetails}）` : '';
          finish(() => reject(new Error(`AI音声の合成に失敗しました${detail}。`)));
        }
      },
      (err) => {
        finish(() => reject(new Error(`AI音声の合成に失敗しました（${err}）。`)));
      },
    );
  });
}

/** SDKの後片付け。失敗は合成結果に影響させない（PA側と同じ後片付け方針）。 */
function closeQuietly(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[azureTts] ${label}で例外が発生しました。`, err);
  }
}

/** SDK本体・キー・リージョンを解決して SpeechConfig を作る（キー未設定はthrow）。 */
async function createSpeechConfig(): Promise<{ SpeechSDK: SpeechSdk; speechConfig: import('microsoft-cognitiveservices-speech-sdk').SpeechConfig }> {
  // SDK本体とappState解決は実際に合成するときだけ読み込む（ファイル冒頭コメント参照）。
  const [SpeechSDK, config] = await Promise.all([
    import('microsoft-cognitiveservices-speech-sdk'),
    import('./azureSpeechConfig'),
  ]);
  const apiKey = await config.getAzureSpeechKey();
  if (!apiKey) {
    throw new Error('Azure APIキーが設定されていません。設定画面で登録してください。');
  }
  const region = await config.getAzureSpeechRegion();
  const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(apiKey, region);
  speechConfig.speechSynthesisOutputFormat = SpeechSDK.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  return { SpeechSDK, speechConfig };
}

/**
 * テキストをAzure Neural TTSで合成し、音声データ(ArrayBuffer)を返す（DESIGN.md §6c）。
 * 出力はMP3（Audio24Khz48KBitRateMonoMp3）: decodeAudioDataで再生でき、
 * WAV(PCM)よりダウンロードサイズが1桁小さい。1回ごとに接続を作る単発用
 * （キーフレーズ・模範解答・設定の試聴。会話中のAI発話は createTtsSession を使う）。
 * 失敗時は日本語メッセージのErrorを投げる（TTS失敗は会話継続に必須ではないため、
 * 呼び出し側でcatchしてテキスト表示のみにフォールバックする）。
 */
export async function synthesize(text: string, opts: SynthesizeOptions): Promise<ArrayBuffer> {
  const cacheKey = ttsCacheKey(text, opts.voice, opts.rate);
  const cached = sharedCache.get(cacheKey);
  if (cached) return cached;

  const { SpeechSDK, speechConfig } = await createSpeechConfig();
  // AudioConfigにnull: audioDataだけを受け取り、SDKによるspeaker直接出力を無効化する（§6c）。
  const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, null);
  try {
    const audioData = await speakSsmlOnce(SpeechSDK, synthesizer, text, opts);
    sharedCache.set(cacheKey, audioData);
    return audioData;
  } finally {
    closeQuietly('synthesizer.close', () =>
      synthesizer.close(undefined, (err) => {
        console.warn('[azureTts] synthesizer.closeがエラーを返しました。', err);
      }),
    );
    closeQuietly('speechConfig.close', () => speechConfig.close());
  }
}

/** 会話中のAI発話用TTS（M13）。1本の接続を事前に張って使い回す。 */
export interface TtsSession {
  /** 事前接続する（会話画面を開いたときに呼ぶ。失敗は無視され、合成時に再接続される）。 */
  warm(): void;
  /** 合成する（キャッシュあり）。接続エラー時は作り直して1回だけ再試行する。 */
  synth(text: string): Promise<ArrayBuffer>;
  /** 進行中の合成を捨てて接続を作り直す（割り込みで古い文の合成が次のターンの前に並ばないように）。 */
  reset(): void;
  close(): void;
}

interface TtsHandle {
  SpeechSDK: SpeechSdk;
  speechConfig: import('microsoft-cognitiveservices-speech-sdk').SpeechConfig;
  synthesizer: Synthesizer;
  connection: import('microsoft-cognitiveservices-speech-sdk').Connection | null;
}

/**
 * 会話1回ぶんのTTSセッションを作る（M13）。
 * 文ごとに SpeechSynthesizer と WebSocket を作り直すと毎回ハンドシェイク（数百ms）が
 * AI音声の出だしに乗るため、1つのシンセサイザを Connection.openConnection で事前接続して使い回す。
 * SDKは同じシンセサイザへの要求を到着順に1件ずつ処理する（並行呼び出しは内部で順番待ち）。
 */
export function createTtsSession(opts: SynthesizeOptions): TtsSession {
  let handle: Promise<TtsHandle> | null = null;
  let generation = 0;
  let closed = false;

  const open = async (): Promise<TtsHandle> => {
    const { SpeechSDK, speechConfig } = await createSpeechConfig();
    const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, null);
    let connection: TtsHandle['connection'] = null;
    try {
      connection = SpeechSDK.Connection.fromSynthesizer(synthesizer);
      connection.openConnection();
    } catch (err) {
      console.warn('[azureTts] 事前接続に失敗しました（合成時に接続されます）。', err);
    }
    return { SpeechSDK, speechConfig, synthesizer, connection };
  };

  const get = (): Promise<TtsHandle> => {
    if (!handle) {
      const p = open();
      handle = p;
      // 開けなかった（キー未設定・SDK読込失敗）ときは次回に作り直す。
      p.catch(() => {
        if (handle === p) handle = null;
      });
    }
    return handle;
  };

  const dispose = (p: Promise<TtsHandle> | null) => {
    if (!p) return;
    void p
      .then((h) => {
        closeQuietly('connection.closeConnection', () => h.connection?.closeConnection());
        closeQuietly('connection.close', () => h.connection?.close());
        closeQuietly('synthesizer.close', () => h.synthesizer.close());
        closeQuietly('speechConfig.close', () => h.speechConfig.close());
      })
      .catch(() => undefined);
  };

  const session: TtsSession = {
    warm() {
      if (closed) return;
      void get().catch(() => undefined);
    },

    async synth(text: string) {
      if (closed) throw new Error('AI音声のセッションは終了しています。');
      const cacheKey = ttsCacheKey(text, opts.voice, opts.rate);
      const cached = sharedCache.get(cacheKey);
      if (cached) return cached;
      const gen = generation;
      let audio: ArrayBuffer;
      try {
        const h = await get();
        audio = await speakSsmlOnce(h.SpeechSDK, h.synthesizer, text, opts);
      } catch (err) {
        // 割り込み（reset）で捨てた接続の失敗や、終了後の失敗は再試行しない。
        if (closed || gen !== generation) throw err;
        // 接続切れ等: 作り直して1回だけ再試行する。
        session.reset();
        const h = await get();
        audio = await speakSsmlOnce(h.SpeechSDK, h.synthesizer, text, opts);
      }
      sharedCache.set(cacheKey, audio);
      return audio;
    },

    reset() {
      generation += 1;
      const old = handle;
      handle = null;
      dispose(old);
      if (!closed) session.warm();
    },

    close() {
      closed = true;
      generation += 1;
      const old = handle;
      handle = null;
      dispose(old);
    },
  };
  return session;
}
