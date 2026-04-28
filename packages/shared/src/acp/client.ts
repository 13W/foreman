import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { McpServerSpec } from '../mcp.js';
import type { ACPPermissionRequest, PromptEvent, SessionHandle, SubprocessHandle } from './types.js';

/**
 * Implemented in packages/proxy/src/acp/client.ts using ClientSideConnection from
 * @agentclientprotocol/sdk.
 *
 * Proxy is the ACP client for the wrapped agent subprocess. sendPrompt streams all
 * ACP session events as a typed PromptEvent iterator; permission handling is embedded
 * inline via the permission_request event's respond() callback.
 */

export interface SessionOptions {
  /** Tools to block in the wrapped agent's Claude session via _meta.claudeCode.options.disallowedTools. */
  disallowedTools?: string[];
}

export interface ACPClientManager {
  spawnSubprocess(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<SubprocessHandle>;

  createSession(
    subprocess: SubprocessHandle,
    cwd: string,
    mcpServers: McpServerSpec[],
    options?: SessionOptions,
  ): Promise<SessionHandle>;

  /**
   * Send a session/prompt and stream back all events as PromptEvent values.
   * The iterator ends after emitting { kind: 'stop' }.
   * Permission requests embed a respond() callback — calling it unblocks the ACP subprocess.
   */
  sendPrompt(session: SessionHandle, content: ContentBlock[]): AsyncIterableIterator<PromptEvent>;

  /** Send session/cancel for the given session. */
  cancelSession(session: SessionHandle): Promise<void>;
}
