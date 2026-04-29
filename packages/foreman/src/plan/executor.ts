import type { PermissionRequest, Plan, StreamEvent, TaskPayload, TaskResult } from '@foreman-stack/shared';
import type { Logger } from 'pino';
import type { DispatchManager } from '../workers/dispatch-manager.js';
import type { DispatchHandle } from '../workers/task-handle.js';
import type { WorkerCatalog } from '../workers/catalog.js';
import type { SessionState } from '../session/state.js';
import type { ForemanConfig } from '../config.js';
import { toToolName } from '../workers/catalog.js';
import {
  extractArtifactText,
  extractFollowUpResult,
  extractMessageText,
  extractPermissionRequest,
  extractStatusResult,
  isPermissionEvent,
} from '../workers/stream-helpers.js';
import { PlanAbortedError } from './errors.js';
import { validatePlan } from './validator.js';

export { PlanAbortedError } from './errors.js';
export { PlanValidationError, validatePlan } from './validator.js';

export interface PlanExecutionResult {
  subtaskResults: Array<{
    subtaskId: string;
    result: TaskResult;
  }>;
}

export interface PlanExecutorOptions {
  dispatchManager: DispatchManager;
  catalog: WorkerCatalog;
  sessionState: SessionState;
  config: ForemanConfig;
  logger: Logger;
  /** Called when a subtask emits a permission escalation event. Default throws. */
  onWorkerEscalation?: (taskId: string, request: PermissionRequest) => Promise<void>;
  /** Called for each non-permission stream event from a subtask. Default: no-op. */
  onSubtaskEvent?: (subtaskId: string, event: StreamEvent) => void;
}

export class PlanExecutor {
  private readonly _dispatchManager: DispatchManager;
  private readonly _catalog: WorkerCatalog;
  private readonly _sessionState: SessionState;
  private readonly _config: ForemanConfig;
  private readonly _logger: Logger;
  private readonly _onWorkerEscalation: (taskId: string, request: PermissionRequest) => Promise<void>;
  private readonly _onSubtaskEvent: (subtaskId: string, event: StreamEvent) => void;

  constructor(opts: PlanExecutorOptions) {
    this._dispatchManager = opts.dispatchManager;
    this._catalog = opts.catalog;
    this._sessionState = opts.sessionState;
    this._config = opts.config;
    this._logger = opts.logger.child({ component: 'plan-executor' });
    this._onWorkerEscalation =
      opts.onWorkerEscalation ??
      (async () => {
        throw new Error('no escalation handler installed');
      });
    this._onSubtaskEvent = opts.onSubtaskEvent ?? (() => {});
  }

  /**
   * Execute a plan. Validates first, then runs batches sequentially.
   * Within each batch, subtasks dispatch in parallel via Promise.all.
   * On any subtask failure, cancels siblings in that batch and throws PlanAbortedError.
   */
  async execute(plan: Plan, originatorIntent: string): Promise<PlanExecutionResult> {
    validatePlan(plan, this._catalog);

    const subtaskResults: Array<{ subtaskId: string; result: TaskResult }> = [];

    for (const batch of plan.batches) {
      const batchResults = await this._executeBatch(batch.subtasks, originatorIntent);
      subtaskResults.push(...batchResults);
    }

    return { subtaskResults };
  }

  private async _executeBatch(
    subtasks: Plan['batches'][0]['subtasks'],
    originatorIntent: string,
  ): Promise<Array<{ subtaskId: string; result: TaskResult }>> {
    // Resolve workers upfront so we fail fast before any dispatches
    const subtaskWorkers = subtasks.map((subtask) => {
      const worker = this._catalog.getAvailable().find(
        (w) =>
          toToolName(w) === subtask.assigned_agent ||
          w.agent_card?.name === subtask.assigned_agent ||
          w.url === subtask.assigned_agent,
      );
      if (!worker) {
        throw new Error(
          `No available worker for subtask "${subtask.id}" (assigned_agent: ${subtask.assigned_agent})`,
        );
      }
      return { subtask, worker };
    });

    // Dispatch all subtasks concurrently — all dispatch() calls start before any resolve
    const dispatched = await Promise.all(
      subtaskWorkers.map(async ({ subtask, worker }) => {
        const payload: TaskPayload = {
          description: subtask.description,
          expected_output: subtask.expected_output,
          inputs: subtask.inputs,
          originator_intent: originatorIntent,
          max_delegation_depth: 2,
          parent_task_id: null,
          base_branch: null,
          timeout_sec: this._config.runtime.default_task_timeout_sec,
          injected_mcps: [],
          cwd: this._sessionState.cwd,
        };
        const handle = await this._dispatchManager.dispatch(worker.url, payload);
        this._logger.info(
          { subtaskId: subtask.id, agentUrl: worker.url, taskId: handle.taskId },
          'subtask dispatched',
        );
        this._sessionState.activeDispatchHandles.set(handle.taskId, handle);
        return { subtask, handle };
      }),
    );

    // Consume all handles concurrently; on first failure, cancel siblings best-effort
    let firstFailure: Error | null = null;
    const activeHandles = new Set<DispatchHandle>(dispatched.map((d) => d.handle));

    const consumePromises = dispatched.map(({ subtask, handle }) =>
      this._consumeHandle(handle, subtask.id)
        .then((result) => ({ subtaskId: subtask.id, result }))
        .catch(async (err: unknown) => {
          if (!firstFailure) {
            firstFailure = err instanceof Error ? err : new Error(String(err));
            this._logger.error(
              { subtaskId: subtask.id, taskId: handle.taskId, err: String(firstFailure) },
              'subtask failed, cancelling siblings',
            );
            const siblings = [...activeHandles].filter((h) => h !== handle);
            await Promise.all(
              siblings.map((h) =>
                h.cancel().catch((cancelErr: unknown) => {
                  this._logger.warn(
                    { taskId: h.taskId, err: String(cancelErr) },
                    'sibling cancel failed',
                  );
                }),
              ),
            );
          }
          throw err;
        })
        .finally(() => {
          activeHandles.delete(handle);
          this._sessionState.activeDispatchHandles.delete(handle.taskId);
        }),
    );

    const settled = await Promise.allSettled(consumePromises);

    if (firstFailure) {
      throw firstFailure;
    }

    // All succeeded — return results in plan order
    return settled.map((s) => {
      if (s.status === 'fulfilled') return s.value;
      throw s.reason; // unreachable: firstFailure would be set
    });
  }

  private _consumeHandle(handle: DispatchHandle, subtaskId: string): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      let structuredResult: TaskResult | null = null;
      let fallbackText = '';
      let settled = false;

      const finish = (result: TaskResult) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        handle.release();
        resolve(result);
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        handle.release();
        reject(err);
      };

      const onEvent = (event: StreamEvent) => {
        if (settled) return;

        try {
          if (isPermissionEvent(event)) {
            const req = extractPermissionRequest(event);
            if (req) {
              // Fire-and-forget: pump must not block on escalation.
              // If escalation throws, propagate via finishError.
              this._onWorkerEscalation(handle.taskId, req).catch((err) => {
                this._logger.warn(
                  { subtaskId, taskId: handle.taskId, err: String(err) },
                  'escalation handler error',
                );
                finishError(err instanceof Error ? err : new Error(String(err)));
              });
            }
            return;
          }

          this._onSubtaskEvent(subtaskId, event);

          if (event.type === 'status') {
            const data = event.data as Record<string, unknown> | null | undefined;
            const state = data?.['state'] as string | undefined;
            const final = data?.['final'] as boolean | undefined;
            if (state) this._logger.info({ subtaskId, taskId: handle.taskId, state, final }, 'subtask status');

            const parsed = extractStatusResult(event);
            if (parsed) structuredResult = parsed;

            if (!parsed) {
              const followUp = extractFollowUpResult(event);
              if (followUp) {
                structuredResult = followUp;
                // Cancel the task and let waitForDone signal completion.
                handle.cancel().catch((err) =>
                  this._logger.warn(
                    { subtaskId, taskId: handle.taskId, err: String(err) },
                    'cancel after follow-up failed',
                  ),
                );
                return;
              }
            }
          } else if (event.type === 'artifact') {
            fallbackText = extractArtifactText(event);
          } else if (event.type === 'message') {
            const text = extractMessageText(event);
            if (text) {
              this._logger.info({ subtaskId, taskId: handle.taskId, message: text.slice(0, 200) }, 'subtask message');
              fallbackText += text;
            }
          } else if (event.type === 'error') {
            const data = event.data as Record<string, unknown> | null | undefined;
            this._logger.warn({ subtaskId, taskId: handle.taskId, reason: data?.['reason'] }, 'subtask error');
            finishError(new Error(`Worker error: ${data?.['reason'] ?? 'unknown'}`));
          }
        } catch (err) {
          finishError(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const unsubscribe = handle.onEvent(onEvent);

      // When the pump signals done, finalize the result.
      handle.waitForDone()
        .then(() => {
          if (settled) return;

          const result: TaskResult = structuredResult ?? {
            status: 'completed',
            stop_reason: 'end_turn',
            summary: fallbackText || '(no output)',
            branch_ref: '',
            session_transcript_ref: '',
            error: null,
          };

          if (result.status !== 'completed') {
            this._logger.error(
              { subtaskId, taskId: handle.taskId, status: result.status, stopReason: result.stop_reason },
              'subtask finished with non-completed status',
            );
            finishError(new PlanAbortedError(subtaskId, result));
            return;
          }
          finish(result);
        })
        .catch((err) => {
          finishError(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
