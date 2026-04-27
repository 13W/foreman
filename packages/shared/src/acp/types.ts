export type { ContentBlock, StopReason, ToolCallUpdate, PermissionOption } from '@agentclientprotocol/sdk';
export type { ToolCall, ContentChunk } from '@agentclientprotocol/sdk';
export type { Plan as ACPPlan } from '@agentclientprotocol/sdk';

import type { McpServerSpec } from '../mcp.js';
export type { McpServerSpec };

import type { PermissionDecision } from '../permissions.js';
export type { PermissionDecision };

export interface SubprocessHandle {
  getId(): string;
  dispose(): Promise<void>;
}

export interface SessionHandle {
  getId(): string;
  dispose(): Promise<void>;
}

export type ACPPermissionType = 'fs.read' | 'fs.write' | 'terminal.create' | 'choice';

export interface ACPPermissionRequest {
  type: ACPPermissionType;
  /** Absolute path — present for fs.read and fs.write */
  path?: string;
  /** Basename of the command — present for terminal.create */
  command?: string;
  /** Human-readable title for the request */
  title?: string;
}

export type PromptEvent =
  | { kind: 'agent_message_chunk'; content: import('@agentclientprotocol/sdk').ContentBlock }
  | { kind: 'tool_call'; update: import('@agentclientprotocol/sdk').ToolCall }
  | { kind: 'tool_call_update'; update: import('@agentclientprotocol/sdk').ToolCallUpdate }
  | { kind: 'plan'; entries: unknown[] } // opaque ACP plan entries, forwarded as status message
  | {
      kind: 'permission_request';
      requestId: string;
      request: ACPPermissionRequest;
      respond: (decision: PermissionDecision) => Promise<void>;
    }
  | { kind: 'stop'; reason: import('@agentclientprotocol/sdk').StopReason };

/** Transport passed to listen(); 'stdio' is the standard choice for subprocess agents. */
export type ACPTransport = 'stdio' | { type: string; [key: string]: unknown };
