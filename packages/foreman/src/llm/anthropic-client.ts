import Anthropic from '@anthropic-ai/sdk';
import type { ForemanConfig } from '../config.js';
import type { LLMClient, LLMEvent, LLMToolDefinition, Message, MessageContent } from './client.js';

function toAnthropicContent(c: MessageContent): Anthropic.Messages.ContentBlockParam {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text };
    case 'tool_use':
      return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: c.tool_use_id, content: c.content };
  }
}

function toAnthropicMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map(toAnthropicContent)
      : [toAnthropicContent(m.content)],
  }));
}

export class AnthropicLLMClient implements LLMClient {
  private readonly _sdk: Anthropic;
  private readonly _model: string;
  private readonly _maxTokens: number;

  constructor(config: ForemanConfig) {
    const apiKey = process.env[config.llm.api_key_env];
    if (!apiKey) {
      throw new Error(`API key env var "${config.llm.api_key_env}" is not set`);
    }
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    this._sdk = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this._model = config.llm.model;
    this._maxTokens = config.llm.max_tokens_per_turn;
  }

  async *completeWithTools(
    messages: Message[],
    tools: LLMToolDefinition[],
    systemPrompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const stream = this._sdk.messages.stream(
      {
        model: this._model,
        max_tokens: this._maxTokens,
        system: systemPrompt,
        messages: toAnthropicMessages(messages),
        ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      },
      { signal },
    );

    let currentToolId: string | undefined;
    let currentToolName: string | undefined;
    let currentToolInputJson = '';
    let stopReason = 'end_turn';

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInputJson = '';
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_chunk', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            currentToolInputJson += event.delta.partial_json;
          }
          break;

        case 'content_block_stop':
          if (currentToolId !== undefined && currentToolName !== undefined) {
            const input = JSON.parse(currentToolInputJson || '{}') as Record<string, unknown>;
            yield { type: 'tool_call', id: currentToolId, name: currentToolName, input };
            currentToolId = undefined;
            currentToolName = undefined;
            currentToolInputJson = '';
          }
          break;

        case 'message_delta':
          if (event.delta.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          break;

        case 'message_stop':
          yield { type: 'stop', stopReason };
          break;
      }
    }
  }
}
