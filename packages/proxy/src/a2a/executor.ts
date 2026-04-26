import { randomUUID } from 'node:crypto';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type {
  PermissionDecision,
  PermissionRequest,
  StreamEvent,
  TaskHandle,
  TaskHandler,
  TaskResult,
} from '@foreman-stack/shared';
import { PermissionTimeoutError } from '@foreman-stack/shared';
import { logger } from '../logger.js';
import { parsePermissionDecision, parseTaskPayload } from './mappers.js';

// ---------------------------------------------------------------------------
// Deferred helper
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Internal per-task state
// ---------------------------------------------------------------------------

interface TaskContext {
  bus: ExecutionEventBus;
  contextId: string;
  completionDeferred: Deferred<void>;
  pendingInput?: {
    id: string;
    deferred: Deferred<PermissionDecision>;
    timer: ReturnType<typeof setTimeout>;
  };
  cancelFn?: () => void;
}

// ---------------------------------------------------------------------------
// ProxyAgentExecutor
// ---------------------------------------------------------------------------

export class ProxyAgentExecutor implements AgentExecutor {
  private readonly tasks = new Map<string, TaskContext>();

  constructor(
    private readonly taskHandler: TaskHandler,
    private readonly agentUrl: string,
  ) {}

  // -------------------------------------------------------------------------
  // AgentExecutor.execute — called by the A2A SDK on every incoming message
  // -------------------------------------------------------------------------
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const taskId = ctx.taskId;
    const existing = this.tasks.get(taskId);

    // Re-entry: second A2A turn resolving a pending input-required round-trip
    if (existing) {
      existing.bus = bus;
      if (existing.pendingInput) {
        const decision = parsePermissionDecision(ctx.userMessage);
        existing.pendingInput.deferred.resolve(decision);
      }
      return;
    }

    // First turn: initialise context and kick off the task handler
    const completionDeferred = createDeferred<void>();
    const taskCtx: TaskContext = { bus, contextId: ctx.contextId, completionDeferred };
    this.tasks.set(taskId, taskCtx);

    let payload;
    try {
      payload = parseTaskPayload(ctx.userMessage);
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to parse task payload');
      this.completeTask(taskId, {
        status: 'failed',
        stop_reason: 'subprocess_crash',
        summary: '',
        branch_ref: '',
        session_transcript_ref: '',
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }

    bus.publish({
      kind: 'task',
      id: taskId,
      contextId: ctx.contextId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [],
    } as any);

    bus.publish({
      kind: 'status-update',
      taskId,
      contextId: ctx.contextId,
      status: { state: 'working' },
      final: false,
    });

    const handle: TaskHandle = { taskId, agentUrl: this.agentUrl };

    // Kick off task handler asynchronously so execute() can return the Task response immediately
    this.taskHandler(payload, handle).catch((err) => {
      logger.error({ err, taskId }, 'taskHandler rejected');
      if (this.tasks.has(taskId)) {
        this.completeTask(taskId, {
          status: 'failed',
          stop_reason: 'subprocess_crash',
          summary: '',
          branch_ref: '',
          session_transcript_ref: '',
          error: {
            code: 'internal_error',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // AgentExecutor.cancelTask — called by the A2A SDK on a cancel request
  // -------------------------------------------------------------------------
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const ctx = this.tasks.get(taskId);
    if (!ctx) {
      bus.publish({
        kind: 'status-update',
        taskId,
        contextId: '',
        status: { state: 'canceled' },
        final: true,
      });
      return;
    }

    ctx.cancelFn?.();

    if (ctx.pendingInput) {
      clearTimeout(ctx.pendingInput.timer);
      ctx.pendingInput.deferred.resolve({ kind: 'cancelled' });
      ctx.pendingInput = undefined;
    }

    ctx.bus.publish({
      kind: 'status-update',
      taskId,
      contextId: ctx.contextId,
      status: { state: 'canceled' },
      final: true,
    });

    ctx.completionDeferred.resolve();
    this.tasks.delete(taskId);
  }

  // -------------------------------------------------------------------------
  // Public helpers called by ProxyServer / task handler
  // -------------------------------------------------------------------------

  /** Push a non-terminal streaming update to the watching client. */
  sendUpdate(taskId: string, event: StreamEvent): void {
    const ctx = this.tasks.get(taskId);
    if (!ctx) return;

    ctx.bus.publish({
      kind: 'status-update',
      taskId,
      contextId: ctx.contextId,
      status: { state: 'working', message: event.data as any },
      final: false,
      metadata: { streamEvent: event },
    });
  }

  /** Publish a terminal result and tear down state for taskId. */
  completeTask(taskId: string, result: TaskResult): void {
    const ctx = this.tasks.get(taskId);
    if (!ctx) return;

    const state =
      result.status === 'completed'
        ? 'completed'
        : result.status === 'cancelled'
          ? 'canceled'
          : 'failed';

    ctx.bus.publish({
      kind: 'status-update',
      taskId,
      contextId: ctx.contextId,
      status: {
        state,
        message: {
          kind: 'message',
          messageId: randomUUID(),
          parts: [{ kind: 'data', data: result }],
          role: 'agent',
        },
      },
      final: true,
    });

    ctx.completionDeferred.resolve();
    this.tasks.delete(taskId);
  }

  /**
   * Block the task handler until the operator provides a permission decision.
   * Publishes an input-required status event and returns when the A2A client
   * sends a follow-up message, or rejects when the timeout fires.
   */
  async requestInput(
    taskId: string,
    request: PermissionRequest,
    opts: { timeoutMs: number },
  ): Promise<PermissionDecision> {
    const ctx = this.tasks.get(taskId);
    if (!ctx) throw new Error(`No task context for taskId: ${taskId}`);

    const requestId = randomUUID();
    const deferred = createDeferred<PermissionDecision>();

    const timer = setTimeout(() => {
      deferred.reject(new PermissionTimeoutError(taskId, requestId));
    }, opts.timeoutMs);

    ctx.pendingInput = { id: requestId, deferred, timer };

    ctx.bus.publish({
      kind: 'status-update',
      taskId,
      contextId: ctx.contextId,
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          messageId: requestId,
          role: 'agent',
          parts: [{ kind: 'data', data: request as unknown as Record<string, unknown> }],
        },
      },
      final: true,
    });

    try {
      const decision = await deferred.promise;
      return decision;
    } finally {
      clearTimeout(timer);
      ctx.pendingInput = undefined;
    }
  }

  /** Register a cancel callback so the SDK can cascade cancellation into ACP. */
  setCancelFn(taskId: string, fn: () => void): void {
    const ctx = this.tasks.get(taskId);
    if (ctx) ctx.cancelFn = fn;
  }
}
