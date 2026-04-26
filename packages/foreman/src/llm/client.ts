export interface TextChunk {
  type: 'text_chunk';
  text: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StopSignal {
  type: 'stop';
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
}

export type LLMEvent = TextChunk | ToolCallEvent | StopSignal;

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type MessageContent = TextContent | ToolUseContent | ToolResultContent;

export interface Message {
  role: 'user' | 'assistant';
  content: MessageContent | MessageContent[];
}

export interface LLMClient {
  completeWithTools(
    messages: Message[],
    tools: LLMToolDefinition[],
    systemPrompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent>;
}
