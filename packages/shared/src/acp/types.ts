export type { ContentBlock, StopReason, ToolCallUpdate, PermissionOption } from '@agentclientprotocol/sdk';

import type { McpServerSpec } from '../mcp.js';
export type { McpServerSpec };

export interface SubprocessHandle {
  getId(): string;
  dispose(): Promise<void>;
}

export interface SessionHandle {
  getId(): string;
  dispose(): Promise<void>;
}

export type ACPPermissionType = 'fs.read' | 'fs.write' | 'terminal.create';

export interface ACPPermissionRequest {
  type: ACPPermissionType;
  /** Absolute path — present for fs.read and fs.write */
  path?: string;
  /** Basename of the command — present for terminal.create */
  command?: string;
}

export interface PromptResult {
  updates: AsyncIterableIterator<import('@agentclientprotocol/sdk').ToolCallUpdate>;
  stopReason: Promise<import('@agentclientprotocol/sdk').StopReason>;
}

/** Transport passed to listen(); 'stdio' is the standard choice for subprocess agents. */
export type ACPTransport = 'stdio' | { type: string; [key: string]: unknown };
