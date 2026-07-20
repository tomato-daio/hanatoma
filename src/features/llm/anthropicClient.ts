/**
 * Anthropic Messages API 直接fetchクライアント（DESIGN.md §7）。
 * SDKは使わず素のfetchで https://api.anthropic.com/v1/messages を叩く。
 * ヘッダ: x-api-key（呼び出し側がappStateから解決して渡す。ここではdbをimportしない）、
 * anthropic-version: 2023-06-01、anthropic-dangerous-direct-browser-access: true。
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** システムプロンプトの1ブロック。cache_controlでprompt cachingに対応する（DESIGN.md §7a）。 */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** messages配列に載せるコンテンツブロック（tool use往復にも使えるよう最小限の型で表現）。 */
export type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    };

export interface Msg {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** usageLog（DESIGN.md §3 UsageDay）に加算する形に正規化したトークン使用量。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface CallMessagesOptions {
  apiKey: string;
  model: string;
  system?: SystemBlock[];
  messages: Msg[];
  maxTokens: number;
  tools?: unknown[];
  toolChoice?: unknown;
}

export interface CallMessagesResult {
  content: unknown[];
  usage: Usage;
  stopReason: string;
}

export interface StreamMessagesOptions extends CallMessagesOptions {
  /** テキストのdeltaが届くたびに呼ばれる（逐次表示用）。 */
  onText: (delta: string) => void;
}

export interface StreamMessagesResult {
  text: string;
  usage: Usage;
}

export interface ConnectionTestResult {
  ok: boolean;
  messageJa: string;
}

/** Anthropic APIが返すエラーレスポンス（wireフォーマット）の必要最小限の型。 */
interface ApiErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ApiMessageResponse {
  content?: unknown[];
  usage?: ApiUsage;
  stop_reason?: string | null;
}

/** callMessages/streamMessagesが投げる例外。HTTPステータスとAPI側のerror.typeを保持する。 */
export class AnthropicApiError extends Error {
  readonly status: number;
  readonly errorType?: string;

  constructor(status: number, message: string, errorType?: string) {
    super(message);
    this.name = 'AnthropicApiError';
    this.status = status;
    this.errorType = errorType;
  }
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

interface ApiRequestBody {
  model: string;
  max_tokens: number;
  messages: Msg[];
  system?: SystemBlock[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
}

function buildRequestBody(opts: CallMessagesOptions, stream: boolean): ApiRequestBody {
  const body: ApiRequestBody = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
  if (stream) body.stream = true;
  return body;
}

function toUsage(raw: ApiUsage | undefined): Usage {
  return {
    inputTokens: typeof raw?.input_tokens === 'number' ? raw.input_tokens : 0,
    outputTokens: typeof raw?.output_tokens === 'number' ? raw.output_tokens : 0,
    cacheReadTokens: typeof raw?.cache_read_input_tokens === 'number' ? raw.cache_read_input_tokens : 0,
  };
}

/** 既存のUsageに、raw usageで定義されているフィールドだけ上書きする（ストリーム中の逐次更新用）。 */
function mergeUsage(current: Usage, raw: ApiUsage | undefined): Usage {
  if (!raw) return current;
  return {
    inputTokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : current.inputTokens,
    outputTokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : current.outputTokens,
    cacheReadTokens:
      typeof raw.cache_read_input_tokens === 'number' ? raw.cache_read_input_tokens : current.cacheReadTokens,
  };
}

/** HTTPエラーレスポンスからAnthropicApiErrorを組み立てる。JSON以外のボディでも既定メッセージにフォールバックする。 */
async function buildApiError(res: Response): Promise<AnthropicApiError> {
  let message = `Anthropic APIエラー（HTTP ${res.status}）`;
  let errorType: string | undefined;
  try {
    const json = (await res.json()) as ApiErrorBody;
    if (json.error?.message) message = json.error.message;
    errorType = json.error?.type;
  } catch {
    // JSON以外のレスポンス等は無視し、既定メッセージのみ使う
  }
  return new AnthropicApiError(res.status, message, errorType);
}

/**
 * 非streamingの1コール。tool use強制などSonnet添削(§7b)からも使う想定のため
 * tools/toolChoiceはunknownのまま素通しする。
 */
export async function callMessages(opts: CallMessagesOptions): Promise<CallMessagesResult> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: buildHeaders(opts.apiKey),
    body: JSON.stringify(buildRequestBody(opts, false)),
  });
  if (!res.ok) {
    throw await buildApiError(res);
  }
  const json = (await res.json()) as ApiMessageResponse;
  return {
    content: Array.isArray(json.content) ? json.content : [],
    usage: toUsage(json.usage),
    stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : 'end_turn',
  };
}

/** SSEの1イベント分（`event:`/`data:`行のまとまり）をJSONまで剥がした結果。data行が無ければnull。 */
export interface ParsedSseEvent {
  /** イベント種別。data JSONの`type`フィールドをそのまま使う（`event:`ヘッダ行と常に一致するためこちらを正とする）。 */
  type: string;
  data: Record<string, unknown>;
}

/**
 * SSEの1イベント分のテキスト（`\n\n`区切りの1ブロック）をパースする純関数。
 * [DONE]センチネルや空データ・JSONとして壊れているデータはnullを返し、呼び出し側は無視すればよい。
 */
export function parseSseChunk(chunk: string): ParsedSseEvent | null {
  const lines = chunk.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]' || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  if (!type) return null;
  return { type, data: obj };
}

/** バッファから完成済みのSSEイベント（`\n\n`区切り）を取り出し、未完成の残りをrestとして返す。 */
function extractSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { events: parts, rest };
}

/**
 * streamingで1コール。fetchのReadableStreamをSSEとして逐次パースし、
 * text_deltaが届くたびにonTextを呼ぶ（DESIGN.md §7a）。
 */
export async function streamMessages(opts: StreamMessagesOptions): Promise<StreamMessagesResult> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: buildHeaders(opts.apiKey),
    body: JSON.stringify(buildRequestBody(opts, true)),
  });
  if (!res.ok || !res.body) {
    throw await buildApiError(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = extractSseEvents(buffer);
    buffer = rest;

    for (const raw of events) {
      const parsed = parseSseChunk(raw);
      if (!parsed) continue;

      if (parsed.type === 'error') {
        const errData = parsed.data.error as { type?: string; message?: string } | undefined;
        throw new AnthropicApiError(0, errData?.message ?? 'Anthropic APIでエラーが発生しました', errData?.type);
      }
      if (parsed.type === 'message_start') {
        const message = parsed.data.message as { usage?: ApiUsage } | undefined;
        usage = mergeUsage(usage, message?.usage);
      } else if (parsed.type === 'content_block_delta') {
        const delta = parsed.data.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text;
          opts.onText(delta.text);
        }
      } else if (parsed.type === 'message_delta') {
        usage = mergeUsage(usage, parsed.data.usage as ApiUsage | undefined);
      }
    }
  }

  return { text, usage };
}

/**
 * 設定画面の「接続テスト」（DESIGN.md §7c）。claude-haiku-4-5にmax_tokens:1の最小コールを投げ、
 * 成功/失敗と代表的なエラーを日本語文言にして返す。
 */
export async function testConnection(apiKey: string): Promise<ConnectionTestResult> {
  if (!apiKey.trim()) {
    return { ok: false, messageJa: 'APIキーを入力してください。' };
  }
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    if (res.ok) {
      return { ok: true, messageJa: '接続に成功しました。' };
    }
    if (res.status === 401) {
      return { ok: false, messageJa: 'APIキーが無効です。キーを確認してください。' };
    }
    if (res.status === 403) {
      return { ok: false, messageJa: 'このAPIキーには権限がありません。' };
    }
    if (res.status === 429) {
      return { ok: false, messageJa: 'レート制限に達しました。しばらく待って再試行してください。' };
    }
    if (res.status === 529) {
      return { ok: false, messageJa: 'Anthropic APIが混雑しています。しばらく待って再試行してください。' };
    }
    if (res.status >= 500) {
      return { ok: false, messageJa: `Anthropicサーバーでエラーが発生しました（HTTP ${res.status}）。` };
    }
    const err = await buildApiError(res);
    return { ok: false, messageJa: `接続に失敗しました（HTTP ${res.status}）：${err.message}` };
  } catch (err) {
    return {
      ok: false,
      messageJa: `ネットワークエラーが発生しました（${err instanceof Error ? err.message : String(err)}）。`,
    };
  }
}
