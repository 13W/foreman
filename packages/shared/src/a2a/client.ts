import type { AgentCardMetadata, PermissionDecision, StreamEvent } from './types.js';
import type { TaskPayload } from '../task.js';

/**
 * Implemented in packages/foreman/src/a2a/client.ts using @a2a-js/sdk client-side APIs.
 *
 * respondToPermission() hides A2A v0.3 SDK specifics: the protocol implements permission responses
 * as a sendMessage call using the same contextId as the original task. Implementations
 * must map PermissionDecision to the correct SDK sendMessage payload.
 */
export interface A2AClient {
  /** Fetch and validate the agent card from /.well-known/agent.json */
  fetchAgentCard(url: string): Promise<AgentCardMetadata>;

  /**
   * Dispatch a task to the agent at url.
   * Returns the taskId assigned by the remote agent.
   * Immediately starts a background pump that drains the stream and emits events
   * via subscribe(). No consumer needs to be attached for the pump to run.
   */
  dispatchTask(url: string, payload: TaskPayload): Promise<string>;

  /**
   * Subscribe to streaming events for taskId. The listener is called synchronously
   * for each event emitted by the background pump.
   * Returns an unsubscribe function. Call it to stop receiving events.
   */
  subscribe(taskId: string, listener: (event: StreamEvent) => void): () => void;

  /**
   * Resolves when the background pump for taskId exits cleanly (terminal event seen
   * or stream ended). Rejects if the pump errors out.
   */
  waitForDone(taskId: string): Promise<void>;

  /**
   * Fallback polling via tasks/get for agents that do not support SSE.
   * Returns the latest known StreamEvent for taskId.
   */
  pollTask(taskId: string): Promise<StreamEvent>;

  /** Request cancellation of taskId */
  cancelTask(taskId: string): Promise<void>;

  /**
   * Respond to a pending permission-required escalation.
   * Implemented via SDK sendMessage with the task's contextId (A2A v0.3 convention).
   */
  respondToPermission(taskId: string, decision: PermissionDecision): Promise<void>;

  /**
   * Send a follow-up message on an existing task (same contextId).
   * Used for multi-turn exchanges on tasks in input-required state.
   * `parts` are A2A message parts, e.g. [{kind:'text',text:'...'} or {kind:'data',data:{...}}].
   */
  sendFollowUp(taskId: string, parts: unknown[]): Promise<void>;
}
