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
   */
  dispatchTask(url: string, payload: TaskPayload): Promise<string>;

  /**
   * Stream updates for taskId via SSE.
   * Yields StreamEvent values until the task reaches a terminal state.
   */
  streamTask(taskId: string): AsyncIterableIterator<StreamEvent>;

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
}
