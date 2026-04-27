import type { LLMClient, LLMEvent, Message, MessageContent, ToolResultContent } from './client.js';
import type { ToolRegistry } from './tool-registry.js';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface LLMLoopOptions {
  toolTimeoutMs?: number;
}

export class LLMLoop {
  constructor(
    private readonly _client: LLMClient,
    private readonly _registry: ToolRegistry,
    private readonly _opts: LLMLoopOptions = {},
  ) {}

  /**
   * Stateless turn runner. Yields LLMEvents as they arrive; returns the full
   * updated conversation history (original messages + all new turns) as the
   * generator return value.
   */
  async *run(
    messages: Message[],
    systemPrompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent, Message[]> {
    const history: Message[] = [...messages];
    const toolTimeoutMs = this._opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

    while (true) {
      if (signal?.aborted) break;

      const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      let assistantText = '';
      let stopReason = 'end_turn';

      for await (const event of this._client.completeWithTools(
        history,
        this._registry.listTools(),
        systemPrompt,
        signal,
      )) {
        yield event;
        if (event.type === 'text_chunk') {
          assistantText += event.text;
        } else if (event.type === 'tool_call') {
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
        } else if (event.type === 'stop') {
          stopReason = event.stopReason;
        }
      }

      // Build assistant message from this turn
      const assistantContent: MessageContent[] = [];
      if (assistantText) assistantContent.push({ type: 'text', text: assistantText });
      for (const tc of toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      if (assistantContent.length > 0) {
        history.push({ role: 'assistant', content: assistantContent });
      }

      // Stop if LLM finished naturally or made no tool calls
      if (toolCalls.length === 0 || stopReason !== 'tool_use') break;

      // Execute tools in parallel
      const toolResults: ToolResultContent[] = await Promise.all(
        toolCalls.map(async (tc) => {
          if (signal?.aborted) {
            return { type: 'tool_result' as const, tool_use_id: tc.id, content: 'Cancelled' };
          }

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), toolTimeoutMs);
          const toolSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal;

          try {
            const result = await this._registry.invoke(tc.name, tc.input, toolSignal);
            return { type: 'tool_result' as const, tool_use_id: tc.id, content: result };
          } catch (err) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tc.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            };
          } finally {
            clearTimeout(timeout);
          }
        }),
      );

      history.push({ role: 'user', content: toolResults });
    }

    return history;
  }
}
