// packages/shared/src/a2a/server.ts
import type { AgentCardMetadata, PermissionDecision, PermissionRequest, StreamEvent } from './types.js';
import type { TaskPayload, TaskResult } from '../task.js';

export type TaskHandler = (payload: TaskPayload, handle: import('./types.js').TaskHandle) => Promise<void>;

export interface A2AServer {
  /** Register the agent card advertised at /.well-known/agent-card.json */
  register(agentCard: AgentCardMetadata): void;

  /** Subscribe to incoming tasks dispatched by A2A clients */
  onTask(handler: TaskHandler): void;

  /** Push a streaming update to the client watching taskId */
  sendUpdate(taskId: string, update: StreamEvent): void | Promise<void>;

  /** Finalize taskId with a terminal result */
  completeTask(taskId: string, result: TaskResult): void | Promise<void>;

  /**
   * Register a cancel function for taskId.
   * Called immediately after session acquisition, before runPrompt.
   * The SDK's cancelTask will invoke this to cascade cancellation into ACP.
   */
  setCancelFn(taskId: string, fn: () => void): void;

  /**
   * Escalate taskId to require human input before proceeding.
   * Sends an input-required status event via the SDK bus, then blocks until
   * the operator responds (via a second execute() call from the A2A client).
   * opts.timeoutMs is required — caller reads from config.
   */
  requestInput(
    taskId: string,
    request: PermissionRequest,
    opts: { timeoutMs: number },
  ): Promise<PermissionDecision>;

  /** Start the HTTP server and begin accepting A2A connections */
  listen(bindAddr: string): Promise<void>;

  /** Stop the HTTP server */
  close(): Promise<void>;
}
