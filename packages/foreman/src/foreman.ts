import type { ContentBlock, PlanEntry } from '@agentclientprotocol/sdk';
import type { ForemanConfig } from './config.js';
import { createLogger } from './logger.js';
import type { MsgLogger } from './msg-logger.js';
import { DefaultACPAgentServer } from './acp/server.js';
import { DefaultA2AClient } from './a2a/client.js';
import { WorkerCatalog, toToolName } from './workers/catalog.js';
import type { WorkerCatalogEntry } from './workers/catalog.js';
import { DispatchManager } from './workers/dispatch-manager.js';
import {
  isPermissionEvent,
  extractPermissionRequest,
  extractStatusResult,
  extractFollowUpResult,
  extractArtifactText,
  extractMessageText,
  extractToolActivityTitle,
} from './workers/stream-helpers.js';
import { AnthropicLLMClient } from './llm/anthropic-client.js';
import { LLMLoop } from './llm/loop.js';
import { ToolRegistry } from './llm/tool-registry.js';

import type {
  Plan as PlanType,
  PermissionDecision,
  PermissionRequest,
  TaskPayload,
  TaskResult as TaskResultType,
} from '@foreman-stack/shared';
import { mapPermissionOptionToDecision } from './permissions/mapper.js';
import { PlanAbortedError, PlanExecutor, PlannerFallbackHandler } from './plan/index.js';
import type { PlannerSession, PlannerSessionOptions, ExecutionStateSnapshot } from './plan/index.js';
import { SessionManager } from './session/manager.js';
import { SessionLimitError } from './session/errors.js';
import type { SessionState } from './session/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_EXECUTION_STATE: ExecutionStateSnapshot = {
  completed: new Map(),
  inProgress: new Map(),
  failed: new Map(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromContent(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('\n');
}

function buildWorkerDescription(worker: WorkerCatalogEntry): string {
  const name = worker.agent_card?.name ?? worker.name_hint ?? worker.url;
  const desc = worker.agent_card?.description ?? '';
  const skills =
    worker.agent_card?.skills
      ?.map((s) => s.description ?? (s as { name?: string }).name ?? s.id)
      .join(', ') ?? '';
  return [name, desc, skills ? `Skills: ${skills}` : ''].filter(Boolean).join('. ');
}

function buildWorkerList(workers: WorkerCatalogEntry[]): string {
  if (workers.length === 0) return '(none)';
  return workers.map((w) => `- ${toToolName(w)}: ${buildWorkerDescription(w)}`).join('\n');
}

function buildDecompositionRequest(userText: string, workers: WorkerCatalogEntry[]): string {
  const nonPlanners = workers.filter((w) => {
    const skills = w.agent_card?.skills ?? [];
    return !skills.some((s) => s.id === 'task_decomposition');
  });
  const workerList = buildWorkerList(nonPlanners);
  return `${userText}\n\n--- Available workers ---\n${workerList}`;
}

/**
 * Parse a PermissionDecision from planner answer text.
 * Returns null if the text is unparseable, empty, or contains "ask_user"/"ask user".
 */
function tryParsePermissionDecision(text: string): PermissionDecision | null {
  const lower = text.trim().toLowerCase();
  if (!lower || lower.includes('ask_user') || lower.includes('ask user')) return null;

  const candidates = [text.trim(), text.match(/\{[^}]*\}/)?.[0] ?? ''];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { kind?: string };
      if (
        typeof parsed.kind === 'string' &&
        ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(parsed.kind)
      ) {
        return { kind: parsed.kind as PermissionDecision['kind'] };
      }
    } catch {
      // not JSON — try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ForemanOpts
// ---------------------------------------------------------------------------

export interface ForemanOpts {
  config: ForemanConfig;
  sessionManager: SessionManager;
  plannerSessionFactory: (options: PlannerSessionOptions) => PlannerSession;
  fallbackHandler?: PlannerFallbackHandler;
  msgLogger?: MsgLogger;
}

// ---------------------------------------------------------------------------
// Foreman
// ---------------------------------------------------------------------------

export class Foreman {
  private readonly config: ForemanConfig;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly acpServer: DefaultACPAgentServer;
  private readonly a2aClient: DefaultA2AClient;
  private readonly catalog: WorkerCatalog;
  private readonly dispatchManager: DispatchManager;
  private readonly llmClient: AnthropicLLMClient;
  private readonly sessionManager: SessionManager;
  private readonly plannerSessionFactory: (options: PlannerSessionOptions) => PlannerSession;
  private readonly fallbackHandler: PlannerFallbackHandler;

  /** Active PlannerSessions by ACP sessionId — kept alive during plan execution for escalation. */
  private readonly _plannerSessions = new Map<string, PlannerSession>();

  /** Per-session execution state snapshot, populated during _executePlan for ask() state injection. */
  private readonly _executionStates = new Map<string, ExecutionStateSnapshot>();

  constructor(opts: ForemanOpts) {
    this.config = opts.config;
    this.logger = createLogger(opts.config.logging);
    this.acpServer = new DefaultACPAgentServer(opts.msgLogger);
    this.a2aClient = new DefaultA2AClient({ msgLogger: opts.msgLogger });
    this.catalog = new WorkerCatalog(
      this.a2aClient,
      opts.config.runtime.worker_discovery_timeout_sec * 1000,
    );
    this.dispatchManager = new DispatchManager(
      this.a2aClient,
      opts.config.runtime.max_parallel_dispatches,
    );
    this.llmClient = new AnthropicLLMClient(opts.config);
    this.sessionManager = opts.sessionManager;
    this.plannerSessionFactory = opts.plannerSessionFactory;
    this.fallbackHandler =
      opts.fallbackHandler ??
      new PlannerFallbackHandler({
        acpServer: this.acpServer,
        catalog: this.catalog,
        logger: this.logger,
      });
  }

  async start(): Promise<void> {
    const { config, logger, acpServer } = this;
    logger.info({ name: config.foreman.name, version: config.foreman.version }, 'Foreman starting');

    await this.catalog.loadFromConfig(config.workers);

    acpServer.onInitialize(() => {
      logger.info('ACP initialize received');
    });

    acpServer.onSessionNew((sessionId, cwd) => {
      logger.info({ sessionId, cwd }, 'ACP session/new received');
      this._handleSessionNew(sessionId, cwd);
    });

    acpServer.onPrompt(async (sessionId, content) => {
      logger.info({ sessionId }, 'ACP session/prompt received');
      await this._handlePrompt(sessionId, content);
    });

    acpServer.onCancel(async (sessionId) => {
      logger.info({ sessionId }, 'ACP session/cancel received');
      await this._handleCancel(sessionId);
    });

    logger.info('Listening for ACP connections on stdio');
    await acpServer.listen();
  }

  async shutdown(): Promise<void> {
    this.logger.info('Foreman shutting down');

    const sessionIds = this.sessionManager.getAllSessionIds();
    for (const sessionId of sessionIds) {
      const state = this.sessionManager.get(sessionId);
      state?.abortController?.abort();

      const plannerSession = this._plannerSessions.get(sessionId);
      if (plannerSession) {
        await plannerSession.close().catch((err) =>
          this.logger.warn({ sessionId, err: String(err) }, 'planner session close error during shutdown'),
        );
        this._plannerSessions.delete(sessionId);
      }

      await this.sessionManager.close(sessionId).catch((err) =>
        this.logger.warn({ sessionId, err: String(err) }, 'session close error during shutdown'),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  private _handleSessionNew(sessionId: string, cwd: string | null): void {
    const effectiveCwd = cwd ?? process.cwd();
    try {
      this.sessionManager.create(sessionId, effectiveCwd);
    } catch (err) {
      if (err instanceof SessionLimitError) {
        this.logger.warn({ sessionId, limit: err.limit }, 'session limit reached; session not created');
      } else {
        this.logger.error({ sessionId, err: String(err) }, 'unexpected error creating session');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt handler
  // ---------------------------------------------------------------------------

  private async _handlePrompt(sessionId: string, content: ContentBlock[]): Promise<void> {
    const sessionState = this.sessionManager.get(sessionId);
    if (!sessionState) {
      await this.acpServer.sendUpdate(sessionId, [
        { type: 'text', text: 'Session not found. Please start a new session.' },
      ]);
      return;
    }

    // If a planner question is pending, treat this prompt as the user's answer.
    if (sessionState.pendingPlannerQuestion !== null) {
      const plannerSession = this._plannerSessions.get(sessionId);
      if (plannerSession) {
        const userText = extractTextFromContent(content);
        await this._resumePlannerWithAnswer(sessionId, sessionState, userText, plannerSession);
        return;
      }
      sessionState.pendingPlannerQuestion = null;
    }

    await this.catalog.recheckUnreachable();

    const available = this.catalog.getAvailable();
    const userText = extractTextFromContent(content);
    const planners = available.filter((w) => this.catalog.isPlanner(w));

    if (planners.length > 0) {
      this.logger.info({ sessionId, plannerUrl: planners[0].url }, 'has-planner path: programmatic dispatch');
      await this._runWithExternalPlanner(sessionId, sessionState, userText, available, planners[0]);
      return;
    }

    // No planner available — ask user via fallback handler.
    const choice = await this.fallbackHandler.ask(sessionId, userText);

    switch (choice.kind) {
      case 'cancel':
        await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: 'Task cancelled.' }]);
        return;

      case 'self_plan': {
        const plannerSession = this.plannerSessionFactory({
          mode: 'self_planned',
          llmClient: this.llmClient,
          config: this.config,
          logger: this.logger,
          getExecutionState: () => this._executionStates.get(sessionId) ?? EMPTY_EXECUTION_STATE,
        });
        this._plannerSessions.set(sessionId, plannerSession);
        sessionState.planOwnerRef = { kind: 'self' };
        await plannerSession.open(buildDecompositionRequest(userText, available));
        const selfPlan = plannerSession.getPlan();
        if (!selfPlan) {
          await this.acpServer.sendUpdate(sessionId, [
            { type: 'text', text: 'Could not generate a self-made plan.' },
          ]);
          await plannerSession.close();
          this._plannerSessions.delete(sessionId);
          return;
        }
        sessionState.activePlan = selfPlan;
        await this._executePlan(selfPlan, sessionId, sessionState, userText, available);
        return;
      }

      case 'delegate': {
        const plannerSession = this.plannerSessionFactory({
          mode: 'external_planner',
          dispatchManager: this.dispatchManager,
          a2aClient: this.a2aClient,
          plannerUrl: choice.workerUrl,
          config: this.config,
          logger: this.logger,
          workersAvailable: available.filter((w) => !this.catalog.isPlanner(w)).flatMap((w) => [toToolName(w), ...(w.agent_card?.name ? [w.agent_card.name] : [])]),
          getExecutionState: () => this._executionStates.get(sessionId) ?? EMPTY_EXECUTION_STATE,
          cwd: sessionState.cwd,
        });
        this._plannerSessions.set(sessionId, plannerSession);
        sessionState.planOwnerRef = { kind: 'external', taskId: '' };
        try {
          await plannerSession.open(buildDecompositionRequest(userText, available));
        } catch (err) {
          this.logger.error({ err: String(err), sessionId }, 'delegate planner session open failed');
          await this.acpServer.sendUpdate(sessionId, [
            { type: 'text', text: `[${choice.workerName}] failed: ${err instanceof Error ? err.message : String(err)}` },
          ]);
          await plannerSession.close();
          this._plannerSessions.delete(sessionId);
          return;
        }
        const delegatePlan = plannerSession.getPlan();
        sessionState.planOwnerRef = { kind: 'external', taskId: plannerSession.taskId ?? '' };
        if (!delegatePlan) {
          await this.acpServer.sendUpdate(sessionId, [
            { type: 'text', text: `[${choice.workerName}] did not return a valid plan.` },
          ]);
          await plannerSession.close();
          this._plannerSessions.delete(sessionId);
          return;
        }
        sessionState.activePlan = delegatePlan;
        await this._executePlan(delegatePlan, sessionId, sessionState, userText, available);
        return;
      }

      case 'dispatch_whole': {
        const plannerSession = this.plannerSessionFactory({
          mode: 'single_task_dispatch',
          config: this.config,
          logger: this.logger,
        });
        this._plannerSessions.set(sessionId, plannerSession);
        sessionState.planOwnerRef = { kind: 'single_task_dispatch' };
        sessionState.activePlan = choice.plan;
        await this._executePlan(choice.plan, sessionId, sessionState, userText, available);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Programmatic external-planner flow
  // ---------------------------------------------------------------------------

  /**
   * Dispatches the user's prompt to the given planner, awaits the plan, and
   * executes it via PlanExecutor. No LLM loop — foreman selects the planner
   * deterministically from the catalog.
   */
  private async _runWithExternalPlanner(
    sessionId: string,
    sessionState: SessionState,
    userText: string,
    available: WorkerCatalogEntry[],
    planner: WorkerCatalogEntry,
  ): Promise<void> {
    const plannerName = planner.agent_card?.name ?? planner.name_hint ?? toToolName(planner);

    await this.acpServer.sendUpdate(sessionId, [
      { type: 'text', text: `Dispatching to [${plannerName}]...` },
    ]);

    const workersAvailable = available
      .filter((w) => !this.catalog.isPlanner(w))
      .flatMap((w) => [toToolName(w), ...(w.agent_card?.name ? [w.agent_card.name] : [])]);

    const plannerSession = this.plannerSessionFactory({
      mode: 'external_planner',
      dispatchManager: this.dispatchManager,
      a2aClient: this.a2aClient,
      plannerUrl: planner.url,
      config: this.config,
      logger: this.logger,
      workersAvailable,
      getExecutionState: () => this._executionStates.get(sessionId) ?? EMPTY_EXECUTION_STATE,
      cwd: sessionState.cwd,
    });

    this._plannerSessions.set(sessionId, plannerSession);
    sessionState.planOwnerRef = { kind: 'external', taskId: '' };

    try {
      await plannerSession.open(buildDecompositionRequest(userText, available));
    } catch (err) {
      this.logger.error({ err: String(err), sessionId }, 'planner session open failed');
      await this.acpServer.sendUpdate(sessionId, [
        { type: 'text', text: `[${plannerName}] failed: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      await plannerSession.close();
      this._plannerSessions.delete(sessionId);
      return;
    }

    const plan = plannerSession.getPlan();
    const pendingQuestion = plannerSession.getPendingQuestion();
    sessionState.planOwnerRef = {
      kind: 'external',
      taskId: plannerSession.taskId ?? '',
    };

    if (plan) {
      this.logger.info({ sessionId, plannerUrl: planner.url, batchCount: plan.batches.length }, 'plan received; starting execution');
      sessionState.activePlan = plan;
      await this._executePlan(plan, sessionId, sessionState, userText, available);
      return;
    }

    if (pendingQuestion) {
      this.logger.info({ sessionId }, 'planner pending question; suspending until next user prompt');
      sessionState.pendingPlannerQuestion = pendingQuestion;
      sessionState.originatorIntent = userText;
      await this.acpServer.sendUpdate(sessionId, [
        { type: 'text', text: `[${plannerName}] ${pendingQuestion}` },
      ]);
      return;
    }

    // No plan, no question → planner failed silently.
    this.logger.warn({ sessionId, plannerUrl: planner.url }, 'planner returned no plan and no question');
    await this.acpServer.sendUpdate(sessionId, [
      { type: 'text', text: `[${plannerName}] did not return a valid plan.` },
    ]);
    await plannerSession.close();
    this._plannerSessions.delete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Plan execution — shared by planner-present and fallback paths
  // ---------------------------------------------------------------------------

  private async _executePlan(
    plan: PlanType,
    sessionId: string,
    sessionState: SessionState,
    userText: string,
    available: WorkerCatalogEntry[],
  ): Promise<void> {
    const subtaskWorkerNames = new Map<string, string>();
    const subtaskDescriptions = new Map<string, string>();
    for (const batch of plan.batches) {
      for (const subtask of batch.subtasks) {
        const worker = available.find(
          (w) =>
            toToolName(w) === subtask.assigned_agent ||
            w.agent_card?.name === subtask.assigned_agent,
        );
        subtaskWorkerNames.set(subtask.id, worker?.agent_card?.name ?? subtask.assigned_agent);
        subtaskDescriptions.set(subtask.id, subtask.description ?? subtask.id);
      }
    }

    // Build ACP plan entries for visualization
    const planEntries: PlanEntry[] = [];
    const subtaskEntryIndex = new Map<string, number>();
    for (const batch of plan.batches) {
      for (const subtask of batch.subtasks) {
        const idx = planEntries.length;
        subtaskEntryIndex.set(subtask.id, idx);
        planEntries.push({
          content: subtask.description ?? subtask.id,
          priority: 'medium',
          status: 'pending',
          _meta: {
            subtaskId: subtask.id,
            assignedAgent: subtask.assigned_agent,
            workerName: subtaskWorkerNames.get(subtask.id) ?? subtask.assigned_agent,
            batchId: batch.batch_id,
          },
        });
      }
    }

    this.acpServer
      .sendPlan(sessionId, [...planEntries])
      .catch((err: unknown) => this.logger.warn({ err: String(err) }, 'sendPlan failed'));

    const subtaskTextBuffers = new Map<string, string>();
    const subtaskActivityLog = new Map<string, string[]>();
    const MAX_ACTIVITY_LINES = 50;
    const subtaskStarted = new Set<string>();

    function composeSubtaskContent(activity: string[], text: string): string {
      const activityBlock = activity.join('\n');
      if (!activityBlock) return text;
      if (!text) return activityBlock;
      return activityBlock + '\n\n' + text;
    }

    // Initialize per-session execution state for plan-state injection in ask()
    const executionState: ExecutionStateSnapshot = {
      completed: new Map(),
      inProgress: new Map(),
      failed: new Map(),
    };
    this._executionStates.set(sessionId, executionState);

    // Signal planner session that execution is starting (enables stream filtering)
    this._plannerSessions.get(sessionId)?.markExecutionStarted?.();

    const executor = new PlanExecutor({
      dispatchManager: this.dispatchManager,
      catalog: this.catalog,
      sessionState,
      config: this.config,
      logger: this.logger,
      onWorkerEscalation: async (taskId, request) => {
        await this._handleWorkerEscalation(taskId, request, sessionId);
      },
      onSubtaskEvent: (subtaskId, event) => {
        const workerName = subtaskWorkerNames.get(subtaskId) ?? subtaskId;
        const description = subtaskDescriptions.get(subtaskId) ?? subtaskId;

        // Track execution state for plan-state injection in ask()
        if (!executionState.inProgress.has(subtaskId)) {
          executionState.inProgress.set(subtaskId, { workerName });
        }

        // First event for this subtask → open tool_call card and transition plan entry
        if (!subtaskStarted.has(subtaskId)) {
          subtaskStarted.add(subtaskId);
          this.acpServer
            .sendToolCall(sessionId, {
              toolCallId: subtaskId,
              title: `${workerName}: ${description}`.slice(0, 200),
              status: 'in_progress',
              kind: 'execute',
              rawInput: { subtaskId, assignedAgent: workerName },
            })
            .catch((err: unknown) =>
              this.logger.warn({ err: String(err) }, 'sendToolCall failed'),
            );

          const idx = subtaskEntryIndex.get(subtaskId);
          if (idx !== undefined) {
            planEntries[idx] = { ...planEntries[idx], status: 'in_progress' };
            this.acpServer
              .sendPlan(sessionId, [...planEntries])
              .catch((err: unknown) =>
                this.logger.warn({ err: String(err) }, 'sendPlan update failed'),
              );
          }
        }

        // Stream worker text into the tool_call content (full buffer replace per ACP spec)
        if (event.type === 'message') {
          const text = extractMessageText(event);
          if (text) {
            const buf = (subtaskTextBuffers.get(subtaskId) ?? '') + text;
            subtaskTextBuffers.set(subtaskId, buf);
            const combined = composeSubtaskContent(subtaskActivityLog.get(subtaskId) ?? [], buf);
            this.acpServer
              .sendToolCallUpdate(sessionId, {
                toolCallId: subtaskId,
                content: [{ type: 'content', content: { type: 'text', text: combined } }],
              })
              .catch((err: unknown) =>
                this.logger.warn({ err: String(err) }, 'sendToolCallUpdate failed'),
              );
          }
        }

        // Status events with tool-call titles → accumulate activity log
        if (event.type === 'status') {
          const toolTitle = extractToolActivityTitle(event);
          if (toolTitle) {
            const lines = subtaskActivityLog.get(subtaskId) ?? [];
            const last = lines[lines.length - 1];
            if (last !== undefined && toolTitle.startsWith(last + ' ')) {
              lines[lines.length - 1] = toolTitle;
            } else if (last !== toolTitle) {
              lines.push(toolTitle);
            }
            if (lines.length > MAX_ACTIVITY_LINES) {
              lines.splice(0, lines.length - MAX_ACTIVITY_LINES);
            }
            subtaskActivityLog.set(subtaskId, lines);

            const combined = composeSubtaskContent(lines, subtaskTextBuffers.get(subtaskId) ?? '');
            this.acpServer
              .sendToolCallUpdate(sessionId, {
                toolCallId: subtaskId,
                content: [{ type: 'content', content: { type: 'text', text: combined } }],
              })
              .catch((err: unknown) =>
                this.logger.warn({ err: String(err) }, 'sendToolCallUpdate activity failed'),
              );
          }
        }
      },
    });

    let results: string[];
    try {
      this.logger.debug(
        {
          sessionId,
          planId: plan.plan_id,
          batchCount: plan.batches.length,
          subtaskCount: plan.batches.reduce((acc, b) => acc + b.subtasks.length, 0),
        },
        '_executePlan: about to invoke PlanExecutor.execute',
      );
      const { subtaskResults } = await executor.execute(plan, userText);
      this.logger.debug(
        {
          sessionId,
          planId: plan.plan_id,
          subtaskResultsLength: subtaskResults.length,
          subtaskIds: subtaskResults.map((r) => r.subtaskId),
          subtaskStatuses: subtaskResults.map((r) => r.result.status),
        },
        '_executePlan: PlanExecutor.execute resolved',
      );
      results = subtaskResults.map(
        ({ subtaskId, result }) => `[${subtaskId}] ${JSON.stringify(result)}`,
      );

      // Terminal: mark all completed subtasks
      for (const { subtaskId, result } of subtaskResults) {
        this.logger.debug(
          {
            sessionId,
            subtaskId,
            resultStatus: result.status,
            iterationIndex: subtaskResults.findIndex((r) => r.subtaskId === subtaskId),
          },
          '_executePlan: completion loop iteration',
        );
        executionState.inProgress.delete(subtaskId);
        executionState.completed.set(subtaskId, { resultSummary: result.summary.slice(0, 100) });

        const finalContent = composeSubtaskContent(
          subtaskActivityLog.get(subtaskId) ?? [],
          subtaskTextBuffers.get(subtaskId) ?? '',
        );
        this.acpServer
          .sendToolCallUpdate(sessionId, {
            toolCallId: subtaskId,
            status: 'completed',
            ...(finalContent
              ? { content: [{ type: 'content', content: { type: 'text', text: finalContent } }] }
              : {}),
          })
          .catch((err: unknown) =>
            this.logger.warn({ err: String(err) }, 'sendToolCallUpdate completed failed'),
          );
        const idx = subtaskEntryIndex.get(subtaskId);
        if (idx !== undefined) {
          planEntries[idx] = { ...planEntries[idx], status: 'completed' };
        }
      }
      this.logger.debug(
        {
          sessionId,
          planEntriesCount: planEntries.length,
          planEntriesStatuses: planEntries.map((e) => e.status),
        },
        '_executePlan: about to emit final sendPlan',
      );
      this.acpServer
        .sendPlan(sessionId, [...planEntries])
        .catch((err: unknown) =>
          this.logger.warn({ err: String(err), sessionId }, 'sendPlan terminal failed'),
        );
      this.logger.debug(
        { sessionId },
        '_executePlan: final sendPlan dispatched (Promise pending)',
      );
    } catch (err) {
      this.logger.debug(
        {
          sessionId,
          errType: err === null || err === undefined ? 'null/undefined' : typeof err,
          errName: err instanceof Error ? err.name : '(not Error)',
          errMessage: err instanceof Error ? err.message : String(err),
          isPlanAborted: err instanceof PlanAbortedError,
        },
        '_executePlan: caught error in try block',
      );
      let failureInfo: string;
      if (err instanceof PlanAbortedError) {
        const detail =
          err.taskResult.error?.message ?? err.taskResult.stop_reason ?? err.taskResult.status;
        failureInfo = `Subtask "${err.subtaskId}" failed: ${detail}`;
        this.logger.error(
          { sessionId, subtaskId: err.subtaskId, status: err.taskResult.status, detail },
          'plan execution aborted',
        );

        executionState.inProgress.delete(err.subtaskId);
        executionState.failed.set(err.subtaskId, { errorMessage: detail ?? err.taskResult.status });

        // Mark failed subtask
        this.acpServer
          .sendToolCallUpdate(sessionId, { toolCallId: err.subtaskId, status: 'failed' })
          .catch((erx: unknown) =>
            this.logger.warn({ err: String(erx) }, 'sendToolCallUpdate failed-subtask error'),
          );
        const failedIdx = subtaskEntryIndex.get(err.subtaskId);
        if (failedIdx !== undefined) {
          planEntries[failedIdx] = {
            ...planEntries[failedIdx],
            status: 'completed',
            _meta: { ...(planEntries[failedIdx]._meta ?? {}), failed: true },
          };
        }

        // Mark sibling subtasks that had started
        for (const startedId of subtaskStarted) {
          if (startedId === err.subtaskId) continue;
          this.acpServer
            .sendToolCallUpdate(sessionId, {
              toolCallId: startedId,
              status: 'failed',
              content: [{ type: 'content', content: { type: 'text', text: 'cancelled due to sibling failure' } }],
            })
            .catch((erx: unknown) =>
              this.logger.warn({ err: String(erx) }, 'sendToolCallUpdate sibling cancel error'),
            );
          const sibIdx = subtaskEntryIndex.get(startedId);
          if (sibIdx !== undefined) {
            planEntries[sibIdx] = { ...planEntries[sibIdx], status: 'completed' };
          }
        }

        this.acpServer
          .sendPlan(sessionId, [...planEntries])
          .catch((erx: unknown) =>
            this.logger.warn({ err: String(erx) }, 'sendPlan abort failed'),
          );
      } else {
        failureInfo = `Plan execution failed: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error({ sessionId, err: String(err) }, 'plan execution failed');
      }
      const summary = await this._synthesize([failureInfo], userText);
      await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: summary }]);
      return;
    } finally {
      this.logger.debug({ sessionId }, '_executePlan: finally block entered');
      this._executionStates.delete(sessionId);
      const plannerSession = this._plannerSessions.get(sessionId);
      if (plannerSession) {
        await plannerSession.close().catch((err: unknown) =>
          this.logger.warn({ err: String(err) }, 'planner session close error'),
        );
        this._plannerSessions.delete(sessionId);
      }
      sessionState.activePlan = null;
      sessionState.planOwnerRef = null;
    }

    this.logger.debug(
      { sessionId, resultsCount: results.length },
      '_executePlan: about to invoke _synthesize',
    );
    const summary = await this._synthesize(results, userText);
    await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: summary }]);
  }

  // ---------------------------------------------------------------------------
  // Worker task dispatch (non-planner, LLM tool path)
  // ---------------------------------------------------------------------------

  private async _runWorkerTask(
    url: string,
    payload: TaskPayload,
    sessionId: string,
    sessionState: SessionState,
    signal?: AbortSignal,
  ): Promise<TaskResultType> {
    const handle = await this.dispatchManager.dispatch(url, payload);
    sessionState.activeDispatchHandles.set(handle.taskId, handle);

    try {
      return await new Promise<TaskResultType>((resolve, reject) => {
        let structuredResult: TaskResultType | null = null;
        let fallbackText = '';
        let settled = false;

        const finish = (result: TaskResultType) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          handle.release();
          resolve(result);
        };

        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          handle.release();
          reject(err);
        };

        // Handle abort signal
        if (signal?.aborted) {
          handle.cancel().catch(() => {});
          reject(new Error('Cancelled'));
          return;
        }
        const onAbort = () => {
          this.logger.warn({ taskId: handle.taskId, agentUrl: url }, 'worker task cancelled via abort signal');
          handle.cancel().catch(() => {});
          fail(new Error('Cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const unsubscribe = handle.onEvent((event) => {
          if (settled) return;

          if (isPermissionEvent(event)) {
            const req = extractPermissionRequest(event);
            if (req) {
              this._handleWorkerEscalation(handle.taskId, req, sessionId).catch((err) => {
                fail(err instanceof Error ? err : new Error(String(err)));
              });
            }
            return;
          }

          if (event.type === 'status') {
            const data = event.data as Record<string, unknown> | null | undefined;
            const state = data?.['state'] as string | undefined;
            const final = data?.['final'] as boolean | undefined;
            if (state) this.logger.info({ taskId: handle.taskId, agentUrl: url, state, final }, 'worker status');
            const parsed = extractStatusResult(event);
            if (parsed) structuredResult = parsed;
            if (!parsed) {
              const followUp = extractFollowUpResult(event);
              if (followUp) {
                structuredResult = followUp;
                handle.cancel().catch(() => {});
                return;
              }
            }
          } else if (event.type === 'artifact') {
            fallbackText = extractArtifactText(event);
            this.logger.debug({ taskId: handle.taskId, agentUrl: url, len: fallbackText.length }, 'worker artifact');
          } else if (event.type === 'message') {
            const text = extractMessageText(event);
            if (text) {
              this.logger.info({ taskId: handle.taskId, agentUrl: url, message: text.slice(0, 200) }, 'worker message');
              fallbackText += text;
            }
          } else if (event.type === 'error') {
            const data = event.data as Record<string, unknown> | null | undefined;
            this.logger.warn({ taskId: handle.taskId, agentUrl: url, reason: data?.['reason'] }, 'worker error');
            fail(new Error(`Worker error: ${data?.['reason'] ?? 'unknown'}`));
          }
        });

        handle.waitForDone()
          .then(() => {
            signal?.removeEventListener('abort', onAbort);
            if (!settled) {
              finish(
                structuredResult ?? {
                  status: 'completed',
                  stop_reason: 'end_turn',
                  summary: fallbackText || '(no output)',
                  branch_ref: '',
                  session_transcript_ref: '',
                  error: null,
                },
              );
            }
          })
          .catch((err) => {
            signal?.removeEventListener('abort', onAbort);
            fail(err instanceof Error ? err : new Error(String(err)));
          });
      });
    } finally {
      sessionState.activeDispatchHandles.delete(handle.taskId);
    }
  }

  // ---------------------------------------------------------------------------
  // Worker escalation — plan-owner-first routing (foreman-spec 6.7 variant C)
  // ---------------------------------------------------------------------------

  private async _handleWorkerEscalation(
    taskId: string,
    request: PermissionRequest,
    sessionId: string,
  ): Promise<void> {
    const plannerSession = this._plannerSessions.get(sessionId);

    if (plannerSession) {
      try {
        const question =
          `Worker task ${taskId} requests permission: ${request.type}` +
          (request.path ? ` path="${request.path}"` : '') +
          (request.command ? ` command="${request.command}"` : '') +
          (request.message ? `. ${request.message}` : '') +
          ' Respond with a JSON PermissionDecision (e.g. {"kind":"allow_once"}) or say "ask_user" to escalate to the user.';

        const answer = await plannerSession.ask(question);
        const decision = tryParsePermissionDecision(answer);
        if (decision) {
          this.logger.debug({ taskId, decision: decision.kind }, 'plan owner resolved permission');
          await this.a2aClient.respondToPermission(taskId, decision);
          return;
        }
        this.logger.debug({ taskId }, 'plan owner deferred permission to user');
      } catch (err) {
        this.logger.warn({ taskId, err: String(err) }, 'plan owner ask failed; escalating to user');
      }
    }

    // Fallback: ask user directly.
    const option = await this.acpServer.requestPermission(sessionId, {
      type: request.type,
      path: request.path,
      command: request.command,
    });
    const decision = mapPermissionOptionToDecision(option);
    await this.a2aClient.respondToPermission(taskId, decision);
  }

  // ---------------------------------------------------------------------------
  // Synthesis (fresh LLM call, not a continuation)
  // ---------------------------------------------------------------------------

  private async _synthesize(results: string[], originalIntent: string): Promise<string> {
    const content = results.join('\n\n');
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: `Original intent: ${originalIntent}\n\nSubtask results:\n${content}\n\nPlease summarize these results for the user.`,
          },
        ],
      },
    ];

    const synthRegistry = new ToolRegistry();
    const synthLoop = new LLMLoop(this.llmClient, synthRegistry);
    let summary = '';

    for await (const event of synthLoop.run(
      messages,
      'You are summarizing the results of subtasks for the user. Be concise.',
    )) {
      if (event.type === 'text_chunk') {
        summary += event.text;
      }
    }

    return summary || content;
  }

  // ---------------------------------------------------------------------------
  // Planner question resume
  // ---------------------------------------------------------------------------

  private async _resumePlannerWithAnswer(
    sessionId: string,
    sessionState: SessionState,
    answer: string,
    plannerSession: PlannerSession,
  ): Promise<void> {
    sessionState.pendingPlannerQuestion = null;

    try {
      await plannerSession.resumeWithAnswer(answer);
    } catch (err) {
      this.logger.error({ sessionId, err: String(err) }, 'planner resumeWithAnswer failed; closing session');
      await this.acpServer.sendUpdate(sessionId, [
        { type: 'text', text: `[planner] error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      await plannerSession.close().catch((closeErr: unknown) =>
        this.logger.warn({ sessionId, err: String(closeErr) }, 'planner close error after resumeWithAnswer failure'),
      );
      this._plannerSessions.delete(sessionId);
      return;
    }

    const plan = plannerSession.getPlan();
    const nextQuestion = plannerSession.getPendingQuestion();

    if (nextQuestion) {
      sessionState.pendingPlannerQuestion = nextQuestion;
      await this.acpServer.sendUpdate(sessionId, [
        { type: 'text', text: `[planner] ${nextQuestion}` },
      ]);
      return;
    }

    if (plan) {
      sessionState.activePlan = plan;
      const intent = sessionState.originatorIntent ?? '';
      sessionState.originatorIntent = null;
      await this.catalog.recheckUnreachable();
      const available = this.catalog.getAvailable();
      await this._executePlan(plan, sessionId, sessionState, intent, available);
    } else {
      const summary = await this._synthesize(['Planner did not return a valid plan.'], '');
      await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: summary }]);
      const plannerSess = this._plannerSessions.get(sessionId);
      if (plannerSess) {
        await plannerSess.close().catch(() => {});
        this._plannerSessions.delete(sessionId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel handler
  // ---------------------------------------------------------------------------

  private async _handleCancel(sessionId: string): Promise<void> {
    const state = this.sessionManager.get(sessionId);
    if (state) {
      state.abortController?.abort();
    }

    // Close plannerSession first — it may be awaiting a follow-up.
    const plannerSession = this._plannerSessions.get(sessionId);
    if (plannerSession) {
      await plannerSession.close().catch((err: unknown) =>
        this.logger.warn({ sessionId, err: String(err) }, 'planner session close on cancel'),
      );
      this._plannerSessions.delete(sessionId);
    }

    // SessionManager.close cascades to active dispatch handles.
    await this.sessionManager.close(sessionId);
  }
}
