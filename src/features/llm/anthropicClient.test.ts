import { describe, expect, it } from 'vitest';
import { parseSseChunk } from './anthropicClient';

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
