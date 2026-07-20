/**
 * マイクPCMタップ用AudioWorklet（DESIGN.md §5 M11: 録音中ストリーミング発音評価）。
 *
 * micSource(MediaStreamAudioSourceNode)にぶら下げ、レンダリング量子（128フレーム）を
 * 2048フレーム（48kHzで約43ms）に束ねてからメインスレッドへtransferableでpostMessageする
 * （メッセージ頻度を約23回/秒に抑える）。録音停止時にバッファへ残る最大2048フレーム弱
 * （約43ms）は破棄されるが、ユーザーは話し終えてから停止をタップするため実害はない。
 *
 * プロセッサ本体は文字列定数+Blob URLで addModule する（viteのビルド設定を増やさず、
 * 成果物にも別ファイルを追加しないため）。iOS Safari 14.5+ / Chrome / Edge が対応。
 * 非対応・登録失敗時は呼び出し側が握りつぶし、従来のbatch評価経路のみで動作する。
 */

const PCM_TAP_PROCESSOR_NAME = 'hanatoma-pcm-tap';
const TAP_BUFFER_FRAMES = 2048;

const WORKLET_SOURCE = `
class HanatomaPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${TAP_BUFFER_FRAMES});
    this._n = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      let i = 0;
      while (i < channel.length) {
        const take = Math.min(this._buf.length - this._n, channel.length - i);
        this._buf.set(channel.subarray(i, i + take), this._n);
        this._n += take;
        i += take;
        if (this._n === this._buf.length) {
          const out = this._buf;
          this._buf = new Float32Array(${TAP_BUFFER_FRAMES});
          this._n = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor('${PCM_TAP_PROCESSOR_NAME}', HanatomaPcmTap);
`;

/** AudioWorkletが使える環境か（ノード生成前の事前チェック）。 */
export function supportsPcmTap(): boolean {
  return typeof AudioWorkletNode === 'function';
}

/**
 * AudioContextごとに1回だけworkletモジュールを登録する
 * （同名registerProcessorの二重登録は例外になるため、Promiseをメモ化する）。
 */
const moduleRegistry = new WeakMap<AudioContext, Promise<void>>();

export function ensurePcmTapModule(ctx: AudioContext): Promise<void> {
  let registered = moduleRegistry.get(ctx);
  if (!registered) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    registered = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    moduleRegistry.set(ctx, registered);
  }
  return registered;
}

/**
 * PCMタップノードを生成する（事前に ensurePcmTapModule を済ませること）。
 * onChunk はデバイス既定sampleRateのFloat32チャンク（TAP_BUFFER_FRAMESフレーム）を受け取る。
 */
export function createPcmTapNode(ctx: AudioContext, onChunk: (chunk: Float32Array) => void): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, PCM_TAP_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });
  node.port.onmessage = (e: MessageEvent) => {
    if (e.data instanceof Float32Array) onChunk(e.data);
  };
  return node;
}
