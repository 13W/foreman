import type { TaskPayload, TaskResult } from '../task.js';
import type { PermissionDecision, PermissionRequestType } from '../permissions.js';
import type { AgentSkill } from '@a2a-js/sdk';

export type { TaskPayload, TaskResult };
export type { PermissionDecision, PermissionRequestType };
export type { AgentSkill };

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
  type: PermissionRequestType;
  path?: string;    // present for fs.read / fs.write
  command?: string; // present for terminal.create
  message: string;  // human-readable summary for the operator
}

export interface AgentCardMetadata {
  name: string;
  url: string;
  version: string;
  description?: string;
  skills?: AgentSkill[];
}
