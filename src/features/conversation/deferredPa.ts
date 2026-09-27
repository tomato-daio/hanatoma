/**
 * 会話後の発音評価（DESIGN.md §5・§6a-3・M13）。
 *
 * 会話中は発音評価(PA)をせず音声認識だけで返答を速くし、各ターンの音声（会話中にAzureへ
 * 流した16kHz PCM16を発話区間に切り詰めたもの）を会話終了後にまとめて評価する。
 * Azure F0は同時認識1本のため、会話中のSTTとは重ねず、終了後に1件ずつ直列で実行する。
 *
 * 評価方式は既定で scripted（参照文＝会話中に認識したテキスト）: 採点される単語が画面の
 * テキストと一致し、短文では確定が速い実績がある。unscripted（参照文なし）へは定数で切替可能。
 * 韻律は切る（長めの発話を短時間で処理するため）。
 */

import type { PaResult, Turn } from '../../lib/types';
import { wavFromPcm16 } from '../../lib/wav';
import type { AssessSpeechOptions, AssessSpeechResult } from '../speech/azurePaUnscripted';

/** 1ターンぶんの音声（会話後の評価材料）。 */
export interface TurnClip {
  /** 対応する Turn.at（ユーザーの音声ターン）。 */
  at: number;
  /** 会話中に認識したテキスト（scripted評価の参照文）。 */
  text: string;
  /** 16kHz mono PCM16（発話区間＋前後の余白）。 */
  pcm: Uint8Array;
}

export type DeferredPaMode = 'scripted' | 'unscripted';
/** 会話後評価の方式（M13。所要時間は診断ログで比較できる）。 */
export const DEFERRED_PA_MODE: DeferredPaMode = 'scripted';

/** 1セッションで評価する音声の合計上限（秒）。Azure無料枠の消費を抑える。 */
export const DEFERRED_PA_BUDGET_SEC = 60;
/** 短すぎるターン（Yes. 等）は発音の情報が少ないので評価しない。 */
export const DEFERRED_PA_MIN_CLIP_SEC = 1;
/** 長すぎるターンは確定に時間がかかり他のターンを評価できなくなるため見送る。 */
export const DEFERRED_PA_MAX_CLIP_SEC = 20;

export function clipSeconds(clip: Pick<TurnClip, 'pcm'>): number {
  return clip.pcm.byteLength / 32000;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * 評価するターンを選ぶ純関数。語数の多いターン（発音の情報が多い）を優先し、
 * 残りの日次上限と1セッションの予算に収まるだけ選ぶ。返り値は評価する順（優先度順）。
 */
export function selectClipsForPa(
  clips: TurnClip[],
  opts: { capRemainingSec: number; budgetSec?: number; minSec?: number; maxSec?: number },
): TurnClip[] {
  const minSec = opts.minSec ?? DEFERRED_PA_MIN_CLIP_SEC;
  const maxSec = opts.maxSec ?? DEFERRED_PA_MAX_CLIP_SEC;
  const limit = Math.min(Math.max(0, opts.capRemainingSec), opts.budgetSec ?? DEFERRED_PA_BUDGET_SEC);
  const candidates = clips
    .filter((c) => wordCount(c.text) > 0)
    .filter((c) => {
      const sec = clipSeconds(c);
      return sec >= minSec && sec <= maxSec;
    })
    .sort((a, b) => wordCount(b.text) - wordCount(a.text) || a.at - b.at);
  const picked: TurnClip[] = [];
  let total = 0;
  for (const c of candidates) {
    const sec = clipSeconds(c);
    if (total + sec > limit) continue;
    picked.push(c);
    total += sec;
  }
  return picked;
}

/**
 * 評価結果をターンへ書き戻す純関数。ユーザーの音声ターンのうち Turn.at が一致するものだけに付ける。
 * 失敗（azureError付き）の結果は付けない（スコアなしのターンとして扱い、指標から自然に外れる）。
 */
export function mergeDeferredPa(turns: Turn[], results: ReadonlyMap<number, PaResult>): Turn[] {
  return turns.map((t) => {
    if (t.role !== 'user' || t.inputMode !== 'voice' || t.phase === 'keyphrase') return t;
    const pa = results.get(t.at);
    return pa && !pa.azureError ? { ...t, pa } : t;
  });
}

export interface RunDeferredPaOptions {
  assess: (wav: Blob, opts: AssessSpeechOptions) => Promise<AssessSpeechResult>;
  signal?: AbortSignal;
  mode?: DeferredPaMode;
  onProgress?: (done: number, total: number) => void;
  log?: (message: string) => void;
}

export interface RunDeferredPaResult {
  results: Map<number, PaResult>;
  /** Azureへ送った音声の秒数（使用量に加算する）。 */
  sentSeconds: number;
}

/** 選んだターンを1件ずつ評価する（例外は投げない。中断されたら残りは評価しない）。 */
export async function runDeferredPa(clips: TurnClip[], opts: RunDeferredPaOptions): Promise<RunDeferredPaResult> {
  const mode = opts.mode ?? DEFERRED_PA_MODE;
  const results = new Map<number, PaResult>();
  let sentSeconds = 0;
  let done = 0;
  opts.onProgress?.(0, clips.length);
  for (const clip of clips) {
    if (opts.signal?.aborted) break;
    const wav = new Blob([wavFromPcm16([clip.pcm])], { type: 'audio/wav' });
    const sec = clipSeconds(clip);
    const t0 = Date.now();
    try {
      const r = await opts.assess(
        wav,
        mode === 'scripted'
          ? { mode: 'scripted', referenceText: clip.text, prosody: false, signal: opts.signal }
          : { mode: 'unscripted', signal: opts.signal },
      );
      sentSeconds += sec;
      if (!r.pa.azureError) results.set(clip.at, r.pa);
      opts.log?.(
        `[会話後PA] ${mode} 音声${sec.toFixed(1)}s → ${Date.now() - t0}ms ${r.pa.azureError ? `失敗(${r.pa.azureError})` : `発音${Math.round(r.pa.pronScore)}`}`,
      );
    } catch (err) {
      // assessSpeechは原則throwしないが、契約違反の例外でも残りのターンは続ける。
      opts.log?.(`[会話後PA] 例外 ${err instanceof Error ? err.message : String(err)}`);
    }
    done += 1;
    opts.onProgress?.(done, clips.length);
  }
  return { results, sentSeconds };
}
