import type { TaskPayload, TaskResult } from '../task.js';

export type { TaskPayload, TaskResult };

export interface TaskHandle {
  taskId: string;
  agentUrl: string;
}

export type StreamEventType = 'status' | 'artifact' | 'message' | 'error';

export interface StreamEvent {
  type: StreamEventType;
  taskId: string;
  /** Event-specific payload; shape depends on type */
  data: unknown;
  timestamp?: string;
}

export interface PermissionRequest {
  taskId: string;
  requestId: string;
  message: string;
  /** Suggested choices presented to the human operator */
  options?: string[];
}

export interface InputDecision {
  requestId: string;
  approved: boolean;
  /** Free-form response or selected option */
  response?: string;
}

export interface AgentCardMetadata {
  name: string;
  url: string;
  version: string;
  description?: string;
  capabilities?: string[];
}
