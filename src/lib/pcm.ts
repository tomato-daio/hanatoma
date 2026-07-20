/**
 * 録音中ストリーミング発音評価向けのPCM変換純関数（DESIGN.md §5・§6a M11）。
 *
 * マイクのFloat32チャンク（デバイス既定sampleRate: 44.1k/48k等）を、Azure Speechの
 * pushStreamが要求する16kHz mono PCM16へ逐次変換する。チャンク境界をまたいでも
 * 結果が変わらないよう、リサンプラは読み位置と直前サンプルを状態として持ち越す。
 *
 * 決定性の担保: 読み位置は浮動小数ではなく整数（1/targetRate単位のposNum）で保持する。
 * 浮動小数の累積だと「一括処理」と「小分け処理」で丸めが変わりビット一致しなくなるため。
 * DOM/ブラウザAPIに依存しない純関数のみを置く（Vitest必須）。
 */

/** 線形補間リサンプラの持ち越し状態（非破壊。resampleLinearChunkが新しい状態を返す）。 */
export interface LinearResamplerState {
  readonly sourceRate: number;
  readonly targetRate: number;
  /**
   * 次に出力すべきサンプルのソース上の位置。「prevSample を位置0とした座標」を
   * 1/targetRate 単位の整数で表す（実位置 = posNum / targetRate ソースサンプル）。
   */
  readonly posNum: number;
  /** 直前チャンクの最終サンプル（チャンク境界の補間用）。 */
  readonly prevSample: number;
  readonly hasPrev: boolean;
}

export function createResamplerState(sourceRate: number, targetRate: number): LinearResamplerState {
  if (!Number.isInteger(sourceRate) || !Number.isInteger(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error('sampleRateは正の整数で指定してください。');
  }
  return { sourceRate, targetRate, posNum: 0, prevSample: 0, hasPrev: false };
}

/**
 * 入力チャンクを線形補間でリサンプルし、新しい状態と出力を返す（入力・状態とも非破壊）。
 * 次チャンクの先頭サンプルとの補間が必要な出力は生成せず、状態に持ち越す
 * （そのため同じ入力列なら、一括で渡しても任意に分割して渡しても出力はビット一致する）。
 */
export function resampleLinearChunk(
  state: LinearResamplerState,
  input: Float32Array,
): { state: LinearResamplerState; output: Float32Array } {
  if (input.length === 0) {
    return { state, output: new Float32Array(0) };
  }

  const { sourceRate, targetRate } = state;
  // 仮想バッファ: hasPrevなら [prevSample, ...input]、初回は input のみ。
  const offset = state.hasPrev ? 1 : 0;
  const maxIndex = input.length - 1 + offset;

  const sampleAt = (index: number): number =>
    index === 0 && state.hasPrev ? state.prevSample : input[index - offset];

  let posNum = state.posNum;
  const out: number[] = [];
  for (;;) {
    const index = Math.floor(posNum / targetRate);
    // 補間には index+1 のサンプルが必要。バッファ末尾を超える出力は次チャンクへ持ち越す。
    if (index + 1 > maxIndex) break;
    const frac = (posNum - index * targetRate) / targetRate;
    const s0 = sampleAt(index);
    const s1 = sampleAt(index + 1);
    out.push(s0 + (s1 - s0) * frac);
    posNum += sourceRate;
  }

  return {
    state: {
      sourceRate,
      targetRate,
      // 次チャンクでは input の最終サンプルが位置0になるため、その分を差し引いて持ち越す。
      posNum: posNum - maxIndex * targetRate,
      prevSample: input[input.length - 1],
      hasPrev: true,
    },
    output: Float32Array.from(out),
  };
}

/**
 * Float32サンプル列(-1..1)を16bit PCM(リトルエンディアン)のArrayBufferへ変換する。
 * クリップ・非有限値→0・負は×0x8000/正は×0x7fffの変換規則は wav.ts の
 * floatSampleToInt16 と同一に保つこと（batch経路とstream経路で音の解釈を揃えるため）。
 */
export function floatChunkToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    let int16: number;
    if (!Number.isFinite(sample)) {
      int16 = 0;
    } else {
      const clipped = Math.max(-1, Math.min(1, sample));
      int16 = clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff);
    }
    view.setInt16(i * 2, int16, true);
  }
  return buffer;
}
