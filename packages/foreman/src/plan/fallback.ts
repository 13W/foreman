import type { ACPAgentServer, PermissionOption, Plan } from '@foreman-stack/shared';
import type { WorkerCatalog } from '../workers/catalog.js';
import { toToolName } from '../workers/catalog.js';
import type { Logger } from 'pino';

export type FallbackChoice =
  | { kind: 'self_plan' }
  | { kind: 'delegate'; workerUrl: string; workerName: string }
  | { kind: 'dispatch_whole'; plan: Plan }
  | { kind: 'cancel' };

export interface PlannerFallbackHandlerOptions {
  acpServer: ACPAgentServer;
  catalog: WorkerCatalog;
  logger: Logger;
}

export class PlannerFallbackHandler {
  private readonly _acpServer: ACPAgentServer;
  private readonly _catalog: WorkerCatalog;
  private readonly _logger: Logger;

  constructor(opts: PlannerFallbackHandlerOptions) {
    this._acpServer = opts.acpServer;
    this._catalog = opts.catalog;
    this._logger = opts.logger.child({ component: 'planner-fallback' });
  }

  /**
   * Ask the user how to proceed when no planner is available.
   * Returns the user's choice as a structured FallbackChoice.
   *
   * Implementation:
   *  1. Issue requestPermission with 4 options.
   *  2. If user selected 'delegate': issue a SECOND requestPermission listing available workers.
   *     Return the selected worker as the delegate target.
   *  3. If user selected 'dispatch_whole': wrap the original userText as a single-subtask Plan
   *     with assigned_agent = first available worker.
   *  4. If user selected 'self_plan': return { kind: 'self_plan' }.
   *  5. If user selected 'cancel' or response is cancelled: return { kind: 'cancel' }.
   */
  async ask(sessionId: string, userText: string): Promise<FallbackChoice> {
    this._logger.info({ sessionId }, 'No planner available, asking user for fallback choice');

    const options: PermissionOption[] = [
      { optionId: 'self_plan', name: 'Let me plan it myself', kind: 'allow_once' },
      { optionId: 'delegate', name: 'Pick a worker to plan', kind: 'allow_once' },
      { optionId: 'dispatch_whole', name: 'Send the whole task to one worker', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel this task', kind: 'reject_once' },
    ];

    const selected = await this._acpServer.requestPermission(
      sessionId,
      { type: 'choice', title: 'No planner available. How to proceed?' },
      options,
    );

    if (selected.optionId === 'self_plan') {
      return { kind: 'self_plan' };
    }

    if (
      selected.optionId === 'cancel' ||
      selected.kind === 'reject_once' ||
      selected.kind === 'reject_always'
    ) {
      return { kind: 'cancel' };
    }

    if (selected.optionId === 'delegate') {
      return this._handleDelegate(sessionId);
    }

    if (selected.optionId === 'dispatch_whole') {
      return this._handleDispatchWhole(sessionId, userText);
    }

    return { kind: 'cancel' };
  }

  private async _handleDelegate(sessionId: string): Promise<FallbackChoice> {
    const workers = this._catalog.getAvailable();
    if (workers.length === 0) {
      this._logger.warn('No workers available to delegate planning');
      return { kind: 'cancel' };
    }

    const delegateOptions: PermissionOption[] = workers.map((w) => ({
      optionId: w.url,
      name: w.agent_card?.name ?? w.name_hint ?? w.url,
      kind: 'allow_once' as const,
    }));
    delegateOptions.push({
      optionId: '__cancel__',
      name: 'Cancel instead',
      kind: 'reject_once' as const,
    });

    const second = await this._acpServer.requestPermission(
      sessionId,
      { type: 'choice', title: 'Select a worker to act as an ad-hoc planner' },
      delegateOptions,
    );

    if (
      second.optionId === '__cancel__' ||
      second.kind === 'reject_once' ||
      second.kind === 'reject_always'
    ) {
      return { kind: 'cancel' };
    }

    const chosen = workers.find((w) => w.url === second.optionId);
    if (!chosen) {
      // Defensive — selected URL not in current catalog
      return { kind: 'cancel' };
    }

    return {
      kind: 'delegate',
      workerUrl: chosen.url,
      workerName: chosen.agent_card?.name ?? chosen.name_hint ?? chosen.url,
    };
  }

  private async _handleDispatchWhole(_sessionId: string, userText: string): Promise<FallbackChoice> {
    const workers = this._catalog.getAvailable();
    if (workers.length === 0) {
      this._logger.warn('No workers available for dispatch_whole');
      return { kind: 'cancel' };
    }

    const target = workers[0];
    const plan: Plan = {
      plan_id: `synthetic-${Date.now()}`,
      originator_intent: userText,
      goal_summary: 'Dispatching whole task as a single subtask.',
      source: 'single_task_dispatch',
      batches: [
        {
          batch_id: 'batch-0',
          subtasks: [
            {
              id: 'whole_task',
              assigned_agent: toToolName(target),
              description: userText,
              expected_output: 'Task completed.',
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
            },
          ],
        },
      ],
    };

    return { kind: 'dispatch_whole', plan };
  }
}
