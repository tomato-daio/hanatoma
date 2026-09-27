import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateOutputTokens, parseSseChunk, streamMessages } from './anthropicClient';

describe('parseSseChunk', () => {
  it('content_block_deltaのtext_deltaをパースできる', () => {
    const chunk =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}';

    const parsed = parseSseChunk(chunk);

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('content_block_delta');
    expect(parsed?.data.delta).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('message_startのusageをパースできる', () => {
    const chunk =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":80}}}';

    const parsed = parseSseChunk(chunk);

    expect(parsed?.type).toBe('message_start');
    const message = parsed?.data.message as { usage?: { input_tokens?: number } };
    expect(message.usage?.input_tokens).toBe(120);
  });

  it('message_deltaのstop_reasonとusageをパースできる', () => {
    const chunk =
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}';

    const parsed = parseSseChunk(chunk);

    expect(parsed?.type).toBe('message_delta');
    expect(parsed?.data.usage).toEqual({ output_tokens: 42 });
    const delta = parsed?.data.delta as { stop_reason?: string };
    expect(delta.stop_reason).toBe('end_turn');
  });

  it('errorイベントをパースできる', () => {
    const chunk =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

    const parsed = parseSseChunk(chunk);

    expect(parsed?.type).toBe('error');
    const error = parsed?.data.error as { type?: string; message?: string };
    expect(error.type).toBe('overloaded_error');
    expect(error.message).toBe('Overloaded');
  });

  it('data行が無い場合はnullを返す（event行のみのチャンク・pingの空行等）', () => {
    expect(parseSseChunk('event: ping')).toBeNull();
    expect(parseSseChunk('')).toBeNull();
  });

  it('[DONE]センチネルはnullを返す', () => {
    expect(parseSseChunk('data: [DONE]')).toBeNull();
  });

  it('壊れたJSONはnullを返す', () => {
    expect(parseSseChunk('data: {not valid json')).toBeNull();
  });

  it('typeフィールドを持たないJSONはnullを返す', () => {
    expect(parseSseChunk('data: {"foo":"bar"}')).toBeNull();
  });

  it('複数行にまたがるdata:を改行で連結してから1つのJSONとしてパースする（SSE仕様準拠）', () => {
    const chunk = 'event: content_block_delta\n' + 'data: {"type":"content_block_delta",\n' + 'data: "index":0}';

    const parsed = parseSseChunk(chunk);

    expect(parsed?.type).toBe('content_block_delta');
    expect(parsed?.data.index).toBe(0);
  });
});

describe('streamMessages（中断）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('中断されたら例外にせず、途中までのテキストと推定usageを aborted で返す', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              encoder.encode(
                'data: {"type":"message_start","message":{"usage":{"input_tokens":300,"output_tokens":1}}}\n\n' +
                  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Sure, I can help with that."}}\n\n',
              ),
            );
            init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const deltas: string[] = [];
    const promise = streamMessages({
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
      signal: controller.signal,
      onText: (d) => {
        deltas.push(d);
        controller.abort();
      },
    });
    const r = await promise;
    expect(r.aborted).toBe(true);
    expect(r.text).toBe('Sure, I can help with that.');
    expect(r.usage.inputTokens).toBe(300);
    expect(r.usage.outputTokens).toBe(estimateOutputTokens('Sure, I can help with that.'));
    expect(deltas).toHaveLength(1);
  });

  it('中断以外のエラーはそのまま投げる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }), { status: 401 })),
    );
    await expect(
      streamMessages({
        apiKey: 'k',
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 10,
        onText: () => {},
      }),
    ).rejects.toThrow('bad key');
  });
});
