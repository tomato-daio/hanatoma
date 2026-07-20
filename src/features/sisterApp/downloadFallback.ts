/**
 * 「シャドとまで練習する」のフォールバック（DESIGN.md §11b・M8）。
 *
 * exportConversationToShadotoma が失敗した場合や dev環境（localhostではshadotoma DBが
 * 存在しない）で使う: TTS音声(WAV)をファイルとしてダウンロードし、模範英文スクリプトを
 * クリップボードへコピーする。ユーザーにはshadotomaの「ローカル取り込み」での手動登録を
 * 案内する。外部送信は一切しない。
 */

import type { CorrectionReport, Scenario } from '../../lib/types';
import { buildModelSentences } from './exportToShadotoma';
import type { ShadotomaLocalSentence } from './shadotomaMaterialContract';

export interface DownloadFallbackResult {
  /** WAVのダウンロードを開始できたか。 */
  downloaded: boolean;
  /** スクリプトをクリップボードへコピーできたか（権限拒否等でfalseになりうる）。 */
  clipboardCopied: boolean;
  /** downloaded=false のときの理由（UI表示用）。 */
  reason?: string;
}

/** ファイル名に使えない文字・空白を'-'に置き換える（Windows/macOS/iOSの共通NG文字）。 */
export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned !== '' ? cleaned : 'script';
}

/** クリップボードへコピーするスクリプト本文（1行1文）。 */
export function buildScriptText(sentences: ShadotomaLocalSentence[]): string {
  return sentences.map((s) => s.en).join('\n');
}

/** Blobをアンカー経由でダウンロードさせる（BackupSection.tsxと同じ方式）。 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * WAVダウンロード + スクリプトのクリップボードコピーを実行する。絶対にthrowしない。
 *
 * スクリプトは exportConversationToShadotoma と同じ buildModelSentences で組み立てるため、
 * 手動取り込みでも自動書き出しと同一の教材内容になる。
 */
export async function downloadToShadotomaFallback(
  report: CorrectionReport,
  scenario: Scenario,
  ttsAudioWav: Blob,
  title: string,
): Promise<DownloadFallbackResult> {
  const sentences = buildModelSentences(report, scenario);
  if (sentences.length === 0) {
    return { downloaded: false, clipboardCopied: false, reason: '書き出せる模範英文がありません' };
  }
  if (ttsAudioWav.size === 0) {
    return { downloaded: false, clipboardCopied: false, reason: '音声データが空です' };
  }

  let downloaded = false;
  try {
    downloadBlob(ttsAudioWav, `hanatoma-${sanitizeFileName(title)}.wav`);
    downloaded = true;
  } catch {
    // ダウンロード開始に失敗してもクリップボードコピーは試みる。
  }

  const clipboardCopied = await copyToClipboard(buildScriptText(sentences));

  return {
    downloaded,
    clipboardCopied,
    ...(downloaded ? {} : { reason: 'ダウンロードを開始できませんでした' }),
  };
}
