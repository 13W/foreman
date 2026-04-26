import { describe, it, expect, afterEach } from 'vitest';
import { MockAnthropicServer } from './mock-anthropic-server.js';
import { cleanupAll } from './cleanup.js';
import Anthropic from '@anthropic-ai/sdk';

describe('MockAnthropicServer', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it('should stream a text response compatible with Anthropic SDK', async () => {
    const server = new MockAnthropicServer([
      {
        matcher: (req) => req.messages.some(m => {
          if (typeof m.content === 'string') return m.content.includes('Hello');
          if (Array.isArray(m.content)) return m.content.some((c: any) => c.text === 'Hello');
          return false;
        }),
        response: { kind: 'text', text: 'World' }
      }
    ]);

    const { url } = await server.start();
    const anthropic = new Anthropic({
      apiKey: 'fake-key',
      baseURL: url
    });

    const stream = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true
    });

    let receivedText = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        receivedText += event.delta.text;
      }
    }

    expect(receivedText).toBe('World');
    expect(server.getRequestLog().length).toBe(1);
    const firstMsgContent = server.getRequestLog()[0].messages[0].content;
    const text = typeof firstMsgContent === 'string' ? firstMsgContent : firstMsgContent[0].text;
    expect(text).toBe('Hello');
  });

  it('should stream a tool_use response compatible with Anthropic SDK', async () => {
    const server = new MockAnthropicServer([
      {
        matcher: () => true,
        response: {
          kind: 'tool_use',
          toolName: 'get_weather',
          toolInput: { location: 'San Francisco' },
          toolId: 'toolu_test_123'
        }
      }
    ]);

    const { url } = await server.start();
    const anthropic = new Anthropic({
      apiKey: 'fake-key',
      baseURL: url
    });

    const stream = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { location: { type: 'string' } } }
      }],
      stream: true
    });

    let toolUse: any = null;
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolUse = event.content_block;
      } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        // In our mock, we send the full JSON in one delta for simplicity
        toolUse.input = JSON.parse(event.delta.partial_json);
      }
    }

    expect(toolUse).toBeDefined();
    expect(toolUse.name).toBe('get_weather');
    expect(toolUse.input.location).toBe('San Francisco');
    expect(toolUse.id).toBe('toolu_test_123');
  });
});
