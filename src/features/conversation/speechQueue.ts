/**
 * AI発話のTTS再生キュー（DESIGN.md §5・§6c）。
 * Haikuのストリーミング出力を区切り、チャンクごとにAzure TTSへ投げて順番に再生することで
 * 「全文生成を待ってから読み上げ」より体感レイテンシを縮める。
 *
 * M13: 読み上げの区切り方を takeSpeakableChunk に集約した（1文目は最短で即合成、2つ目以降は
 * 再生待ちが尽きそうなときにまとめて1リクエスト）。F0のTTSは約20回/分の上限があるため、
 * 1ターンのリクエスト数を2〜3回に抑える。
 * キューは close()（これ以上足さない）後に全再生が終わったときだけ onDrained を呼ぶ
 * （旧実装は文の合間に一瞬空になると「終了」扱いになり、マイクが有効化されるバグがあった）。
 *
 * 再生は既定で getSharedAudioContext()（useRecorder.tsと同一のAudioContext）を使う。
 * iOSで再生用と録音用のオーディオセッションを行き来するとマイクが停止されるため（§1）。
 */

import { getSharedAudioContext } from '../recorder/useRecorder';

/**
 * ストリーミングテキストから「読み上げてよい完成文」を切り出す純関数（旧方式。テスト互換のため残す）。
 * 文末記号（. ! ?）+空白/終端で区切る。短すぎる断片（Mr.等の略語誤検知対策）は次の文とまとめる。
 */
export function splitSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let rest = buffer;
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
      searchFrom = end;
      if (searchFrom >= rest.length) break;
    }
  }
  return { complete, rest };
}

/** 文末の「.」で文を切ってはいけない略語（小文字・末尾ピリオド込み）。 */
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'jr.', 'sr.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'a.m.', 'p.m.',
  'u.s.', 'u.k.', 'no.', 'prof.', 'mt.', 'approx.', 'dept.',
]);

/** 1文目として即読み上げてよい最短文字数（"Oh, nice!" "Sure." 程度の短い相づちを通す）。 */
const FIRST_CHUNK_MIN_CHARS = 3;
/** 2つ目以降の区切りの最短文字数（旧splitSentencesと同じ。略語での誤分割を減らす）。 */
const LATER_CHUNK_MIN_CHARS = 12;

/** bufferの中で「ここまでを1文として切ってよい」終端位置の一覧（昇順）。 */
function sentenceBoundaries(buffer: string, minChars: number, allowEnd: boolean): number[] {
  const re = allowEnd ? /[.!?]["')\]]?(?=\s|$)/g : /[.!?]["')\]]?(?=\s)/g;
  const ends: number[] = [];
  let start = 0;
  for (let m = re.exec(buffer); m !== null; m = re.exec(buffer)) {
    const end = m.index + m[0].length;
    if (m[0].startsWith('.')) {
      const token = (buffer.slice(0, m.index + 1).match(/(\S+)$/)?.[1] ?? '').toLowerCase().replace(/^["'(\[]+/, '');
      // 略語と、1文字の頭文字（"J. Smith"）では切らない。
      if (ABBREVIATIONS.has(token) || /^[a-z]\.$/.test(token)) continue;
    }
    if (buffer.slice(start, end).trim().length >= minChars) {
      ends.push(end);
      start = end;
    }
  }
  return ends;
}

/**
 * ストリーミング中のAI発話バッファから、今TTSへ送るべきチャンクを取り出す純関数（M13）。
 * - streamClosed: 残り全部を1チャンクで送る
 * - isFirst: 最初の文を最短で切り出す（初音までの時間を最優先）
 * - それ以外: 再生待ちが尽きた（queueIdle）ときだけ、そこまでの完成文をまとめて1チャンクにする
 * ストリーミング中は文末記号の直後に空白が来てから切る（"3." の後に "50" が続く等の誤分割を防ぐ）。
 */
export function takeSpeakableChunk(
  buffer: string,
  opts: { isFirst: boolean; queueIdle: boolean; streamClosed: boolean },
): { chunk: string | null; rest: string } {
  if (opts.streamClosed) {
    const all = buffer.trim();
    return { chunk: all.length > 0 ? all : null, rest: '' };
  }
  if (!opts.isFirst && !opts.queueIdle) return { chunk: null, rest: buffer };
  const ends = sentenceBoundaries(buffer, opts.isFirst ? FIRST_CHUNK_MIN_CHARS : LATER_CHUNK_MIN_CHARS, false);
  if (ends.length === 0) return { chunk: null, rest: buffer };
  const end = opts.isFirst ? ends[0] : ends[ends.length - 1];
  const chunk = buffer.slice(0, end).trim();
  return { chunk: chunk.length > 0 ? chunk : null, rest: buffer.slice(end).replace(/^\s+/, '') };
}

/** 再生1回ぶん。onStartは実際に音が出始めた瞬間（分かれば音声の長さms付き）、stopは割り込み用。 */
export type PlayAudio = (
  audio: ArrayBuffer,
  hooks: { onStart: (durationMs?: number) => void; setStopper: (stop: () => void) => void },
) => Promise<void>;

/** 統一AudioContextでデコード→再生する既定のプレイヤー。 */
export const playWithSharedContext: PlayAudio = async (audio, hooks) => {
  const ctx = getSharedAudioContext();
  if (ctx.state === 'suspended') {
    // ユーザージェスチャ起点で resume 済みのはずだが、念のため
    await ctx.resume().catch(() => undefined);
  }
  // decodeAudioDataはArrayBufferをdetachするため、TTSキャッシュ保護のためコピーを渡す
  const audioBuffer = await ctx.decodeAudioData(audio.slice(0));
  await new Promise<void>((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => resolve();
    hooks.setStopper(() => {
      try {
        source.stop();
      } catch {
        // 既に停止済みなら無視
      }
      resolve();
    });
    source.start();
    hooks.onStart(audioBuffer.duration * 1000);
  });
};

export interface SpeechQueueOptions {
  /** チャンクを音声データにする（会話中は TtsSession.synth）。 */
  synth: (text: string) => Promise<ArrayBuffer>;
  play?: PlayAudio;
  /** 最初の音が実際に鳴り始めたとき1回だけ。 */
  onFirstAudioStart?: () => void;
  /** 再生待ち（合成中・再生待ちの項目）が尽きたとき（=次のチャンクを足すべきタイミング）。 */
  onBacklogEmpty?: () => void;
  /** close()後、すべての再生が終わったとき1回だけ（interrupt時は呼ばない）。 */
  onDrained?: () => void;
  /** 合成/再生エラー時（そのチャンクは読み上げを諦める。テキスト表示は続く）。 */
  onError?: (message: string) => void;
  /** チャンクの音が鳴り始めた（字幕の同期用。durationMsは分からなければnull）。 */
  onChunkStart?: (text: string, durationMs: number | null) => void;
  /** チャンクの再生が終わった（失敗・スキップを含む。interrupt後は呼ばない）。 */
  onChunkEnd?: (text: string) => void;
}

/**
 * チャンク単位のTTS合成・順次再生キュー。
 * enqueueは即返り、合成は並行で始め、再生はchainで直列化する。
 */
export class SpeechQueue {
  private readonly opts: SpeechQueueOptions;
  private readonly play: PlayAudio;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  /** まだ再生が始まっていない項目数（合成中・順番待ち）。 */
  private waiting = 0;
  private closed = false;
  private interrupted = false;
  private drainedFired = false;
  private firstAudioFired = false;
  private stopper: (() => void) | null = null;

  constructor(opts: SpeechQueueOptions) {
    this.opts = opts;
    this.play = opts.play ?? playWithSharedContext;
  }

  /** 合成中・再生待ち・再生中の項目が残っているか。 */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** まだ鳴り始めていない項目がないか（takeSpeakableChunkのqueueIdle）。 */
  get backlogEmpty(): boolean {
    return this.waiting === 0;
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed || this.interrupted) return;
    this.pending += 1;
    this.waiting += 1;
    const audioPromise = this.opts.synth(trimmed);
    // 未処理rejectionの警告を避ける（エラーは下のchainで扱う）。
    audioPromise.catch(() => undefined);
    let started = false;
    const markStarted = () => {
      if (started) return;
      started = true;
      this.waiting -= 1;
      if (this.waiting === 0 && !this.interrupted) this.opts.onBacklogEmpty?.();
    };
    this.chain = this.chain
      .then(async () => {
        if (this.interrupted) return;
        const audio = await audioPromise;
        if (this.interrupted) return;
        await this.play(audio, {
          onStart: (durationMs) => {
            markStarted();
            if (!this.interrupted) this.opts.onChunkStart?.(trimmed, durationMs ?? null);
            if (!this.firstAudioFired && !this.interrupted) {
              this.firstAudioFired = true;
              this.opts.onFirstAudioStart?.();
            }
          },
          setStopper: (stop) => {
            this.stopper = stop;
          },
        });
        this.stopper = null;
      })
      .catch((e: unknown) => {
        if (!this.interrupted) this.opts.onError?.(e instanceof Error ? e.message : '音声の再生に失敗しました。');
      })
      .finally(() => {
        markStarted();
        if (!this.interrupted) this.opts.onChunkEnd?.(trimmed);
        this.pending -= 1;
        this.maybeDrained();
      });
  }

  /** これ以上足さない。残りの再生が終わったら onDrained。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 何も積まれていなければ即終了（呼び出し側の同期処理が終わってから通知する）。
    queueMicrotask(() => this.maybeDrained());
  }

  /** 再生中の音を止め、残りを捨てる（onDrainedは呼ばない）。割り込み・画面離脱・会話終了時。 */
  interrupt(): void {
    this.interrupted = true;
    this.closed = true;
    const stop = this.stopper;
    this.stopper = null;
    stop?.();
  }

  /** 旧API互換（interruptと同じ）。 */
  stop(): void {
    this.interrupt();
  }

  private maybeDrained(): void {
    if (this.drainedFired || this.interrupted || !this.closed || this.pending > 0) return;
    this.drainedFired = true;
    this.opts.onDrained?.();
  }
}
