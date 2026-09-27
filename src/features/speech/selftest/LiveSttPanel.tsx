/**
 * 会話中の音声認識（発音評価なし）の検証パネル（DESIGN.md §6d・M13・セルフテスト画面用）。
 *
 * 会話ループとは独立に openMicSession + startLiveStt を直接使い、iPhone実機で
 * 「話し終わってから確定（recognized）が届くまで」を区切り方式ごとに比べるためのもの。
 * 各イベントの「遅れ」= 届いた時刻 −（その発話の音声上の終端）。0.5〜0.8秒程度なら健全。
 */

import { useRef, useState } from 'react';
import { createResamplerState, floatChunkToPcm16, resampleLinearChunk, type LinearResamplerState } from '../../../lib/pcm';
import { openMicSession, type MicSession } from '../../recorder/micSession';
import { startLiveStt, type LiveSttSession, type SttSegmentation } from '../azureStt';

const SEGMENTATIONS: { label: string; value: SttSegmentation }[] = [
  { label: '無音300ms', value: { strategy: 'time', silenceMs: 300 } },
  { label: '無音500ms（既定）', value: { strategy: 'time', silenceMs: 500 } },
  { label: '無音800ms', value: { strategy: 'time', silenceMs: 800 } },
  { label: 'Semantic（AIで区切る）', value: { strategy: 'semantic' } },
];

interface EventLine {
  kind: '部分' | '確定';
  text: string;
  lagMs: number;
}

export function LiveSttPanel() {
  const [segIndex, setSegIndex] = useState(1);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<EventLine[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const micRef = useRef<MicSession | null>(null);
  const sttRef = useRef<LiveSttSession | null>(null);
  const pendingRef = useRef<ArrayBuffer[]>([]);
  const resamplerRef = useRef<LinearResamplerState | null>(null);
  const audioStartRef = useRef<number | null>(null);

  const record = (kind: EventLine['kind'], text: string, offsetMs: number, durationMs: number) => {
    const start = audioStartRef.current ?? performance.now();
    const lagMs = Math.round(performance.now() - (start + offsetMs + durationMs));
    setLines((prev) => [...prev.slice(-30), { kind, text: text || '（認識なし）', lagMs }]);
  };

  const stop = () => {
    sttRef.current?.abort();
    sttRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    setRunning(false);
  };

  const start = async () => {
    setLines([]);
    setMessage(null);
    pendingRef.current = [];
    resamplerRef.current = null;
    audioStartRef.current = null;
    setRunning(true);
    try {
      micRef.current = await openMicSession({
        onChunk: (chunk, sampleRate) => {
          if (!resamplerRef.current) resamplerRef.current = createResamplerState(sampleRate, 16000);
          const r = resampleLinearChunk(resamplerRef.current, chunk);
          resamplerRef.current = r.state;
          if (r.output.length === 0) return;
          if (audioStartRef.current === null) audioStartRef.current = performance.now() - (chunk.length / sampleRate) * 1000;
          const pcm16 = floatChunkToPcm16(r.output);
          if (sttRef.current) sttRef.current.writeChunk(pcm16);
          else pendingRef.current.push(pcm16);
        },
      });
      const stt = await startLiveStt({
        segmentation: SEGMENTATIONS[segIndex].value,
        onPartial: (t, o, d) => record('部分', t, o, d),
        onFinal: (t, o, d) => record('確定', t, o, d),
        onError: (err) => setMessage(`エラー: ${err.message}`),
      });
      for (const buf of pendingRef.current) stt.writeChunk(buf);
      pendingRef.current = [];
      sttRef.current = stt;
    } catch (err) {
      setMessage(`開始できませんでした: ${err instanceof Error ? err.message : String(err)}`);
      stop();
    }
  };

  return (
    <section className="rounded-xl border border-neutral-200 p-3">
      <h2 className="text-sm font-bold text-neutral-800">7. 会話の音声認識（発音評価なし・M13）</h2>
      <p className="mt-1 text-xs text-neutral-500">
        話して止まると「確定」が届きます。「遅れ」は話し終わってから届くまでの秒数です（0.5〜0.8秒なら健全）。
      </p>
      <div className="mt-2 flex items-center gap-2">
        <select
          value={segIndex}
          onChange={(e) => setSegIndex(Number(e.target.value))}
          disabled={running}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
        >
          {SEGMENTATIONS.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => (running ? stop() : void start())}
          className={`rounded-full px-3 py-1 text-xs font-semibold text-white ${running ? 'bg-red-500' : 'bg-hana-500'}`}
        >
          {running ? '停止' : '開始'}
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-red-600">{message}</p>}
      <ul className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] text-neutral-600">
        {lines.map((l, i) => (
          <li key={i} className={l.kind === '確定' ? 'text-neutral-800' : 'text-neutral-400'}>
            [{l.kind}] 遅れ{(l.lagMs / 1000).toFixed(1)}s {l.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
