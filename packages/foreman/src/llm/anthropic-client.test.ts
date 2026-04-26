import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicLLMClient } from './anthropic-client.js';
import type { ForemanConfig } from '../config.js';
import type { Message } from './client.js';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk
// ---------------------------------------------------------------------------

const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { stream: mockStream },
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeRawStream(events: object[]) {
  for (const e of events) yield e;
}

async function collectClient(
  client: AnthropicLLMClient,
  messages: Message[] = [],
  tools: object[] = [],
) {
  const events = [];
  for await (const e of client.completeWithTools(
    messages,
    tools as any,
    'You are helpful.',
  )) {
    events.push(e);
  }
  return events;
}

const config: ForemanConfig = {
  foreman: { name: 'test', version: '0.1.0', working_dir: '/tmp' },
  llm: { backend: 'anthropic', model: 'claude-3-5-sonnet-20241022', api_key_env: 'ANTHROPIC_API_KEY', max_tokens_per_turn: 1024 },
  workers: [],
  mcps: { personal: [], injected: [] },
  runtime: {
    max_concurrent_sessions: 5,
    max_parallel_dispatches: 5,
    default_task_timeout_sec: 1800,
    worker_discovery_timeout_sec: 10,
    planner_response_timeout_sec: 300,
  },
  logging: { level: 'info', format: 'json', destination: 'stderr' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicLLMClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  });

  it('throws if API key env var is unset', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new AnthropicLLMClient(config)).toThrow('ANTHROPIC_API_KEY');
  });

  it('emits TextChunk events from text_delta stream events', async () => {
    mockStream.mockReturnValue(
      makeRawStream([
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    );

    const client = new AnthropicLLMClient(config);
    const events = await collectClient(client);

    const textEvents = events.filter((e) => e.type === 'text_chunk');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]).toEqual({ type: 'text_chunk', text: 'Hello ' });
    expect(textEvents[1]).toEqual({ type: 'text_chunk', text: 'world' });
  });

  it('emits StopSignal with correct stopReason', async () => {
    mockStream.mockReturnValue(
      makeRawStream([
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    );

    const client = new AnthropicLLMClient(config);
    const events = await collectClient(client);

    const stop = events.find((e) => e.type === 'stop');
    expect(stop).toEqual({ type: 'stop', stopReason: 'end_turn' });
  });

  it('emits ToolCallEvent from tool_use content block stream events', async () => {
    mockStream.mockReturnValue(
      makeRawStream([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'get_data', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q"' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"hello"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]),
    );

    const client = new AnthropicLLMClient(config);
    const events = await collectClient(client);

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toEqual({
      type: 'tool_call',
      id: 'toolu_abc',
      name: 'get_data',
      input: { q: 'hello' },
    });

    const stop = events.find((e) => e.type === 'stop');
    expect(stop).toEqual({ type: 'stop', stopReason: 'tool_use' });
  });

  it('handles multiple tool calls in one turn', async () => {
    mockStream.mockReturnValue(
      makeRawStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'id1', name: 'get_x', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'id2', name: 'get_y', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"n":1}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]),
    );

    const client = new AnthropicLLMClient(config);
    const events = await collectClient(client);

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ name: 'get_x', id: 'id1' });
    expect(toolCalls[1]).toMatchObject({ name: 'get_y', id: 'id2', input: { n: 1 } });
  });

  it('ignores content_block_stop when no tool is in progress', async () => {
    mockStream.mockReturnValue(
      makeRawStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 0 }, // text block stop — no tool emit expected
        { type: 'message_stop' },
      ]),
    );

    const client = new AnthropicLLMClient(config);
    const events = await collectClient(client);

    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'text_chunk')).toHaveLength(1);
  });

  it('does not pass tools parameter when tool list is empty', async () => {
    mockStream.mockReturnValue(makeRawStream([{ type: 'message_stop' }]));

    const client = new AnthropicLLMClient(config);
    await collectClient(client, [], []);

    const [params] = mockStream.mock.calls[0];
    expect(params.tools).toBeUndefined();
  });

  it('passes tools when tool list is non-empty', async () => {
    mockStream.mockReturnValue(makeRawStream([{ type: 'message_stop' }]));

    const client = new AnthropicLLMClient(config);
    await collectClient(
      client,
      [],
      [{ name: 'get_data', description: 'gets data', inputSchema: { type: 'object', properties: {} } }],
    );

    const [params] = mockStream.mock.calls[0];
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe('get_data');
  });

  it('maps Message[] to Anthropic format', async () => {
    mockStream.mockReturnValue(makeRawStream([{ type: 'message_stop' }]));

    const client = new AnthropicLLMClient(config);
    const messages: Message[] = [
      { role: 'user', content: { type: 'text', text: 'hello' } },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'get_data', input: { q: 1 } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'result' }],
      },
    ];
    await collectClient(client, messages);

    const [params] = mockStream.mock.calls[0];
    expect(params.messages).toHaveLength(3);
    expect(params.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(params.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'tc1' });
    expect(params.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tc1' });
  });
});
