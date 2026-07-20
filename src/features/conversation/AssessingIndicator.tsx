/**
 * 発音評価中の進行インジケータ（DESIGN.md §5）。小スピナー＋経過秒表示。
 * 経過秒はstateのインクリメントではなく Date.now() - startedAt の絶対時刻差から導出する
 * （useRecorderの経過秒と同じパターン。StrictModeの mount→cleanup→再mount でも
 * intervalは確実にclearされ、カウンタが飛んだり二重に進んだりしない）。
 * busyが'assessing'を離れるとアンマウントされるため、ターンごとに自動で0秒から始まる。
 */

import { useEffect, useState } from 'react';

export function AssessingIndicator({
  label = '発音を評価中',
  className = '',
}: {
  label?: string;
  className?: string;
}) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={`flex items-center gap-2 text-xs text-neutral-400 ${className}`}>
      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-hana-500" />
      <span>
        {label}… {elapsedSec}秒
      </span>
    </div>
  );
}
