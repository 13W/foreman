import type { ContentBlock, PermissionOption, PlanEntry, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { ACPPermissionRequest, ACPTransport } from './types.js';

export type InitializeHandler = () => void | Promise<void>;
export type SessionNewHandler = (sessionId: string, cwd: string | null) => void | Promise<void>;
export type PromptHandler = (sessionId: string, content: ContentBlock[]) => Promise<void>;
export type CancelHandler = (sessionId: string) => void | Promise<void>;

/**
 * Implemented in packages/foreman/src/acp/server.ts using AgentSideConnection from
 * @agentclientprotocol/sdk.
 *
 * Foreman is the ACP agent facing the user's editor. listen() binds to stdio (standard
 * for ACP agents started as subprocesses by an editor). sendUpdate() and
 * requestPermission() are called from within PromptHandler to push streaming content and
 * ask for human approval, respectively.
 */
export interface ACPAgentServer {
  /** Called once when the ACP connection is established and capabilities are exchanged. */
  onInitialize(handler: InitializeHandler): void;

  /** Called when the client opens a new session via session/new. */
  onSessionNew(handler: SessionNewHandler): void;

  /**
   * Called when the client sends a session/prompt.
   * Handler is responsible for driving the task to completion, calling sendUpdate() and
   * eventually returning so the SDK can send the terminal response.
   */
  onPrompt(handler: PromptHandler): void;

  /** Called when the client sends session/cancel for an active session. */
  onCancel(handler: CancelHandler): void;

  /** Push a streaming content update to the client for the given session. */
  sendUpdate(sessionId: string, content: ContentBlock[]): void | Promise<void>;

  /**
   * Send a plan update. Replaces the entire plan in the client UI.
   * Per ACP spec, the agent must send all entries with each update; the client does not merge.
   */
  sendPlan(sessionId: string, entries: PlanEntry[]): Promise<void>;

  /**
   * Send a tool_call sessionUpdate (typically when a tool call starts).
   * Caller chooses the toolCallId — must be unique within the session.
   */
  sendToolCall(sessionId: string, toolCall: ToolCall): Promise<void>;

  /**
   * Send a tool_call_update (incremental update by id).
   * Pass only fields that changed. Status/title/content/rawOutput most common.
   */
  sendToolCallUpdate(sessionId: string, update: ToolCallUpdate): Promise<void>;

  /**
   * Request a permission decision from the client for the given session.
   * Resolves with the client's PermissionOption once the user responds.
   * If options are provided, they are presented to the user instead of the default Allow/Reject.
   */
  requestPermission(
    sessionId: string,
    request: ACPPermissionRequest,
    options?: PermissionOption[],
  ): Promise<PermissionOption>;

  /** Start listening for ACP connections. Defaults to stdio transport. */
  listen(transport?: ACPTransport): Promise<void>;
}
