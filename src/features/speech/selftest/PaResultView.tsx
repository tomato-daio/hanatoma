import type { AssessSpeechResult } from '../azurePaUnscripted';
import { formatScore, scoreTextClass } from './scoreColor';

export interface PaResultViewProps {
  result: AssessSpeechResult;
  mode: 'unscripted' | 'scripted';
}

/**
 * PA（発音評価）結果の表示（DESIGN.md M2手順2・3）。
 * 総合/正確/流暢/韻律スコア（scriptedのみ完全性も）・単語別スコア表・weakPhonemes・azureErrorを表示する。
 * スコアの色分けは80+緑/60-79黄/60未満赤（scoreColor.ts）。
 */
export function PaResultView({ result, mode }: PaResultViewProps) {
  const { pa, recognizedText } = result;
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="text-neutral-700">
        認識テキスト: <span className="font-medium">{recognizedText || '（なし）'}</span>
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <ScoreItem label="総合" score={pa.pronScore} />
        <ScoreItem label="正確" score={pa.accuracyScore} />
        <ScoreItem label="流暢" score={pa.fluencyScore} />
        <ScoreItem label="韻律" score={pa.prosodyScore} />
        {mode === 'scripted' ? <ScoreItem label="完全性" score={pa.completenessScore} /> : null}
      </div>
      {pa.words.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] text-left text-xs">
            <thead>
              <tr className="text-neutral-400">
                <th className="py-1 pr-2">単語</th>
                <th className="py-1 pr-2">スコア</th>
                <th className="py-1">種別</th>
              </tr>
            </thead>
            <tbody>
              {pa.words.map((w, i) => (
                <tr key={`${w.word}-${i}`} className="border-t border-neutral-100">
                  <td className="py-1 pr-2">{w.word}</td>
                  <td className={`py-1 pr-2 font-semibold ${scoreTextClass(w.accuracyScore)}`}>
                    {formatScore(w.accuracyScore)}
                  </td>
                  <td className="py-1 text-neutral-500">{w.errorType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {pa.weakPhonemes && pa.weakPhonemes.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-neutral-600">弱点音素</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {pa.weakPhonemes.map((wp) => (
              <li key={wp.phoneme} className="rounded bg-neutral-100 px-2 py-1 text-xs">
                {wp.phoneme}: {wp.avgScore.toFixed(1)}
                {wp.examples.length > 0 ? `（${wp.examples.join(', ')}）` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pa.azureError ? <p className="text-xs text-red-600">Azureエラー: {pa.azureError}</p> : null}
    </div>
  );
}

function ScoreItem({ label, score }: { label: string; score: number | undefined }) {
  return (
    <p>
      <span className="text-neutral-400">{label}</span>{' '}
      <span className={`font-semibold ${scoreTextClass(score)}`}>{formatScore(score)}</span>
    </p>
  );
}
