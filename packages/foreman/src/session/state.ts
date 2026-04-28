import type { Plan } from '@foreman-stack/shared';
import type { Message } from '../llm/client.js';
import type { DispatchHandle } from '../workers/task-handle.js';

export interface PermissionRequestRecord {
  requestId: string;
  taskId: string;
  receivedAt: number;
}

/** Per foreman-spec §9.1.1. */
export type PlanOwnerRef =
  | { kind: 'external'; taskId: string }
  | { kind: 'self' }
  | { kind: 'single_task_dispatch' }
  | { kind: 'none' };

export class SessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;

  conversationHistory: Message[];
  activeDispatchHandles: Map<string, DispatchHandle>;
  pendingPermissionRequests: Map<string, PermissionRequestRecord>;
  planOwnerRef: PlanOwnerRef | null;
  activePlan: Plan | null;
  abortController: AbortController | null;
  /** Non-null when planner asked a question and we're waiting for the user's answer. */
  pendingPlannerQuestion: string | null;
  /** The original user intent, persisted for plan execution after multi-turn planner dialogue. */
  originatorIntent: string | null;

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.conversationHistory = [];
    this.activeDispatchHandles = new Map();
    this.pendingPermissionRequests = new Map();
    this.planOwnerRef = null;
    this.activePlan = null;
    this.abortController = null;
    this.pendingPlannerQuestion = null;
    this.originatorIntent = null;
  }
}
