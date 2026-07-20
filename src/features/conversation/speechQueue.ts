/**
 * AI発話のTTS再生キュー（DESIGN.md §5）。
 * Haikuのストリーミング出力を文境界で切り出し、文ごとにAzure TTSへ投げて
 * 順番に再生することで「全文生成を待ってから読み上げ」より体感レイテンシを縮める。
 *
 * 再生は必ず getSharedAudioContext()（useRecorder.tsと同一のAudioContext）を使う。
 * iOSで再生用と録音用のオーディオセッションを行き来するとマイクが停止されるため（§1）。
 */

import { getSharedAudioContext } from '../recorder/useRecorder';
import { synthesize } from '../speech/azureTts';

/**
 * ストリーミングテキストから「読み上げてよい完成文」を切り出す純関数。
 * 文末記号（. ! ?）+空白/終端で区切る。短すぎる断片（Mr.等の略語誤検知対策）は
 * 次の文とまとめるため保留する。
 */
export function splitSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let rest = buffer;
  // 文末記号の直後に空白または引用符閉じがあるところで切る。
  // 最低12文字たまってから切ることで "Mr." "U.S." のような略語での誤分割を減らす。
  const re = /[.!?]["')\]]?(?=\s|$)/g;
  let searchFrom = 0;
  for (;;) {
    re.lastIndex = searchFrom;
    const m = re.exec(rest);
    if (!m) break;
    const end = m.index + m[0].length;
    const candidate = rest.slice(0, end).trim();
    if (candidate.length >= 12) {
      complete.push(candidate);
      rest = rest.slice(end).replace(/^\s+/, '');
      searchFrom = 0;
    } else {
      // 短すぎる: この区切りは無視して次の文末記号を探す
      searchFrom = end;
      if (searchFrom >= rest.length) break;
    }
  }
  return { complete, rest };
}

export interface SpeechQueueOptions {
  voice: string;
  rate: string;
  /** キューが空になり最後の再生が終わったときに毎回呼ばれる。 */
  onAllDone?: () => void;
  /** 合成/再生エラー時（読み上げは諦めてテキスト表示のみになる）。 */
  onError?: (message: string) => void;
}

/**
 * 文単位のTTS合成・順次再生キュー。
 * enqueueは即返り、内部で「合成→デコード→前の文の再生完了を待って再生」を直列化する。
 */
export class SpeechQueue {
  private opts: SpeechQueueOptions;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private currentSource: AudioBufferSourceNode | null = null;

  constructor(opts: SpeechQueueOptions) {
    this.opts = opts;
  }

  /** キュー済み・再生中の文が残っているか。 */
  get busy(): boolean {
    return this.pending > 0;
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.stopped) return;
    this.pending += 1;
    // 合成は並行で始めてよいが、再生はchainで直列化する。
    const audioPromise = synthesize(trimmed, { voice: this.opts.voice, rate: this.opts.rate });
    this.chain = this.chain
      .then(async () => {
        if (this.stopped) return;
        const arrayBuffer = await audioPromise;
        if (this.stopped) return;
        await this.play(arrayBuffer);
      })
      .catch((e: unknown) => {
        this.opts.onError?.(e instanceof Error ? e.message : '音声の再生に失敗しました。');
      })
      .finally(() => {
        this.pending -= 1;
        if (this.pending === 0 && !this.stopped) {
          this.opts.onAllDone?.();
        }
      });
  }

  /** 以降のenqueueを無視し、再生中の音を止める（画面離脱・会話終了時）。 */
  stop(): void {
    this.stopped = true;
    try {
      this.currentSource?.stop();
    } catch {
      // 既に停止済みなら無視
    }
    this.currentSource = null;
  }

  private async play(arrayBuffer: ArrayBuffer): Promise<void> {
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      // ユーザージェスチャ起点で resume 済みのはずだが、念のため
      await ctx.resume().catch(() => undefined);
    }
    // decodeAudioDataはArrayBufferをdetachするため、TTSキャッシュ保護のためコピーを渡す
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.currentSource === source) this.currentSource = null;
        resolve();
      };
      this.currentSource = source;
      source.start();
    });
  }
}
