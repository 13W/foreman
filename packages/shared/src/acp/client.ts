import type { ContentBlock, PermissionOption } from '@agentclientprotocol/sdk';
import type { McpServerSpec } from '../mcp.js';
import type { ACPPermissionRequest, PromptResult, SessionHandle, SubprocessHandle } from './types.js';

export type PermissionHandler = (request: ACPPermissionRequest) => Promise<PermissionOption>;
export type FsPermissionHandler = (path: string) => Promise<PermissionOption>;
export type TerminalPermissionHandler = (command: string) => Promise<PermissionOption>;

/**
 * Implemented in packages/proxy/src/acp/client.ts using ClientSideConnection from
 * @agentclientprotocol/sdk.
 *
 * Proxy is the ACP client for the wrapped agent subprocess. Subprocess lifetime is managed
 * independently from sessions: one subprocess can host multiple sessions (up to
 * max_sessions_per_subprocess). Permission handlers are registered per-session so proxy
 * can apply its layered policy (section 6.5 of proxy-spec) before escalating to A2A.
 */
export interface ACPClientManager {
  /**
   * Spawn a new agent subprocess. Returns a handle that uniquely identifies the process.
   * env is merged on top of the current process environment.
   */
  spawnSubprocess(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<SubprocessHandle>;

  /**
   * Open an ACP session inside subprocess via session/new.
   * mcpServers are forwarded verbatim to the session/new payload.
   */
  createSession(
    subprocess: SubprocessHandle,
    cwd: string,
    mcpServers: McpServerSpec[],
  ): Promise<SessionHandle>;

  /**
   * Send a session/prompt and stream back updates.
   * PromptResult.updates yields ToolCallUpdate values until the session concludes.
   * PromptResult.stopReason resolves with the terminal StopReason from the response.
   */
  sendPrompt(session: SessionHandle, content: ContentBlock[]): PromptResult;

  /** Send session/cancel for the given session. */
  cancelSession(session: SessionHandle): Promise<void>;

  /**
   * Register a catch-all permission handler for any permission type.
   * More specific handlers (onFsRead, onFsWrite, onTerminalCreate) take precedence
   * when registered; this handler is called only for types without a specific handler.
   */
  onPermissionRequest(session: SessionHandle, handler: PermissionHandler): void;

  /** Handle fs.read permission requests for this session. */
  onFsRead(session: SessionHandle, handler: FsPermissionHandler): void;

  /** Handle fs.write permission requests for this session. */
  onFsWrite(session: SessionHandle, handler: FsPermissionHandler): void;

  /** Handle terminal.create permission requests for this session. */
  onTerminalCreate(session: SessionHandle, handler: TerminalPermissionHandler): void;
}
