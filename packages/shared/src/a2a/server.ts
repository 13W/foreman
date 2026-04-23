import type { AgentCardMetadata, PermissionRequest, StreamEvent, TaskHandle } from './types.js';
import type { TaskPayload, TaskResult } from '../task.js';

export type TaskHandler = (payload: TaskPayload, handle: TaskHandle) => Promise<void>;

/**
 * Implemented in packages/proxy/src/a2a/server.ts using @a2a-js/sdk server-side APIs.
 *
 * Streaming is delivered via sendUpdate(); the SDK's AgentExecutor context is hidden
 * behind completeTask() and requestInput(). Implementation must map these calls to the
 * appropriate SDK TaskContext methods.
 */
export interface A2AServer {
  /** Register the agent card advertised at /.well-known/agent.json */
  register(agentCard: AgentCardMetadata): void;

  /** Subscribe to incoming tasks dispatched by A2A clients */
  onTask(handler: TaskHandler): void;

  /** Push a streaming update to the client watching taskId */
  sendUpdate(taskId: string, update: StreamEvent): void | Promise<void>;

  /** Finalize taskId with a terminal result */
  completeTask(taskId: string, result: TaskResult): void | Promise<void>;

  /**
   * Escalate taskId to require human input before proceeding.
   * Implementation sends an input-required status event via the SDK.
   */
  requestInput(taskId: string, request: PermissionRequest): Promise<void>;

  /** Start the HTTP server and begin accepting A2A connections */
  listen(bindAddr: string): Promise<void>;
}
