import { describe, it, expect, vi } from 'vitest';
import { LLMLoop } from './loop.js';
import { ToolRegistry } from './tool-registry.js';
import type { LLMClient, LLMEvent, Message } from './client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient(turns: LLMEvent[][]): LLMClient {
  let call = 0;
  return {
    async *completeWithTools() {
      const events = turns[call++] ?? [];
      for (const e of events) yield e;
    },
  };
}

/** Drain generator and return events + the return value (updated history). */
async function drain(
  gen: AsyncGenerator<LLMEvent, Message[]>,
): Promise<{ events: LLMEvent[]; history: Message[] }> {
  const events: LLMEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, history: next.value };
}

const userMessage = (text: string): Message => ({
  role: 'user',
  content: { type: 'text', text },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLMLoop', () => {
  it('yields text events and appends assistant message to history', async () => {
    const client = makeMockClient([
      [
        { type: 'text_chunk', text: 'Hello ' },
        { type: 'text_chunk', text: 'world' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const loop = new LLMLoop(client, new ToolRegistry());

    const { events, history } = await drain(loop.run([userMessage('hi')], 'system'));

    expect(events.filter((e) => e.type === 'text_chunk')).toHaveLength(2);
    expect(history).toHaveLength(2);
    expect(history[1].role).toBe('assistant');
    const content = history[1].content;
    const textBlock = Array.isArray(content) ? content[0] : content;
    expect(textBlock.type).toBe('text');
    if (textBlock.type === 'text') expect(textBlock.text).toBe('Hello world');
  });

  it('stops without adding assistant message when LLM emits nothing', async () => {
    const client = makeMockClient([[{ type: 'stop', stopReason: 'end_turn' }]]);
    const loop = new LLMLoop(client, new ToolRegistry());

    const { history } = await drain(loop.run([userMessage('hi')], 'system'));
    // No assistant content → nothing added
    expect(history).toHaveLength(1);
  });

  it('executes a tool call and feeds result back', async () => {
    const client = makeMockClient([
      [
        { type: 'tool_call', id: 'tc1', name: 'get_data', input: { q: 'x' } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [{ type: 'text_chunk', text: 'Done' }, { type: 'stop', stopReason: 'end_turn' }],
    ]);
    const registry = new ToolRegistry();
    registry.register(
      'get_data',
      { name: 'get_data', description: '', inputSchema: {} },
      async () => 'data-result',
    );
    const loop = new LLMLoop(client, registry);

    const { events, history } = await drain(loop.run([userMessage('go')], 'system'));

    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    // [user, assistant(tool_use), user(tool_result), assistant(text)]
    expect(history).toHaveLength(4);
    const toolResultMsg = history[2];
    expect(toolResultMsg.role).toBe('user');
    const c = Array.isArray(toolResultMsg.content) ? toolResultMsg.content[0] : toolResultMsg.content;
    expect(c.type).toBe('tool_result');
    if (c.type === 'tool_result') expect(c.content).toBe('data-result');
  });

  it('handles tool error by returning error string to LLM', async () => {
    const client = makeMockClient([
      [{ type: 'tool_call', id: 'tc1', name: 'get_data', input: {} }, { type: 'stop', stopReason: 'tool_use' }],
      [{ type: 'text_chunk', text: 'Handled' }, { type: 'stop', stopReason: 'end_turn' }],
    ]);
    const registry = new ToolRegistry();
    registry.register('get_data', { name: 'get_data', description: '', inputSchema: {} }, async () => {
      throw new Error('network failure');
    });
    const loop = new LLMLoop(client, registry);

    const { history } = await drain(loop.run([userMessage('go')], 'system'));

    const toolResultMsg = history[2];
    const c = Array.isArray(toolResultMsg.content) ? toolResultMsg.content[0] : toolResultMsg.content;
    expect(c.type).toBe('tool_result');
    if (c.type === 'tool_result') expect(c.content).toContain('network failure');
  });

  it('handles multiple tool calls in one turn', async () => {
    const client = makeMockClient([
      [
        { type: 'tool_call', id: 'a', name: 'get_x', input: {} },
        { type: 'tool_call', id: 'b', name: 'get_y', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [{ type: 'text_chunk', text: 'both done' }, { type: 'stop', stopReason: 'end_turn' }],
    ]);
    const registry = new ToolRegistry();
    registry.register('get_x', { name: 'get_x', description: '', inputSchema: {} }, async () => 'x');
    registry.register('get_y', { name: 'get_y', description: '', inputSchema: {} }, async () => 'y');
    const loop = new LLMLoop(client, registry);

    const { history } = await drain(loop.run([userMessage('go')], 'system'));

    // user(tool_result) message should have 2 tool results
    const toolResultMsg = history[2];
    const content = Array.isArray(toolResultMsg.content) ? toolResultMsg.content : [toolResultMsg.content];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('tool_result');
    expect(content[1].type).toBe('tool_result');
  });

  it('preserves original messages (does not mutate input)', async () => {
    const client = makeMockClient([
      [{ type: 'text_chunk', text: 'hi' }, { type: 'stop', stopReason: 'end_turn' }],
    ]);
    const loop = new LLMLoop(client, new ToolRegistry());
    const original = [userMessage('hello')];

    const { history } = await drain(loop.run(original, 'system'));

    expect(original).toHaveLength(1); // not mutated
    expect(history).toHaveLength(2);
  });

  it('stops immediately when aborted before first turn', async () => {
    const client = makeMockClient([]);
    const loop = new LLMLoop(client, new ToolRegistry());
    const ac = new AbortController();
    ac.abort();

    const { history } = await drain(loop.run([userMessage('hi')], 'system', ac.signal));
    expect(history).toHaveLength(1); // no new messages added
  });

  it('applies tool timeout via AbortController', async () => {
    const client = makeMockClient([
      [{ type: 'tool_call', id: 'tc1', name: 'get_slow', input: {} }, { type: 'stop', stopReason: 'tool_use' }],
      [{ type: 'text_chunk', text: 'ok' }, { type: 'stop', stopReason: 'end_turn' }],
    ]);
    const registry = new ToolRegistry();
    registry.register('get_slow', { name: 'get_slow', description: '', inputSchema: {} }, (_, sig) =>
      new Promise<string>((_, reject) => {
        sig?.addEventListener('abort', () => reject(new Error('AbortError')));
      }),
    );
    const loop = new LLMLoop(client, registry, { toolTimeoutMs: 10 });

    const { history } = await drain(loop.run([userMessage('go')], 'system'));
    // Tool errored, but loop continued and LLM got the error message
    const c = Array.isArray(history[2].content) ? history[2].content[0] : history[2].content;
    expect(c.type).toBe('tool_result');
    if (c.type === 'tool_result') expect(c.content).toContain('Error');
  });
});
