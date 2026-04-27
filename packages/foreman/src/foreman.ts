import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ForemanConfig } from './config.js';
import { createLogger } from './logger.js';
import { DefaultACPAgentServer } from './acp/server.js';
import { DefaultA2AClient } from './a2a/client.js';
import { WorkerCatalog, toToolName } from './workers/catalog.js';
import type { WorkerCatalogEntry } from './workers/catalog.js';
import { DispatchManager } from './workers/dispatch-manager.js';
import {
  isPermissionEvent,
  extractPermissionRequest,
  extractStatusResult,
  extractArtifactText,
  extractMessageText,
} from './workers/stream-helpers.js';
import { AnthropicLLMClient } from './llm/anthropic-client.js';
import { LLMLoop } from './llm/loop.js';
import { ToolRegistry } from './llm/tool-registry.js';
import { buildForemanSystemPrompt } from './llm/prompts.js';
import type {
  Plan as PlanType,
  PermissionDecision,
  PermissionRequest,
  StreamEvent,
  TaskPayload,
  TaskResult as TaskResultType,
} from '@foreman-stack/shared';
import { mapPermissionOptionToDecision } from './permissions/mapper.js';
import { PlanAbortedError, PlanExecutor, PlannerFallbackHandler } from './plan/index.js';
import type { PlannerSession, PlannerSessionOptions } from './plan/index.js';
import { SessionManager } from './session/manager.js';
import { SessionLimitError } from './session/errors.js';
import type { SessionState } from './session/state.js';

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

  constructor(opts: ForemanOpts) {
    this.config = opts.config;
    this.logger = createLogger(opts.config.logging);
    this.acpServer = new DefaultACPAgentServer();
    this.a2aClient = new DefaultA2AClient();
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

    acpServer.onSessionNew((sessionId) => {
      logger.info({ sessionId }, 'ACP session/new received');
      this._handleSessionNew(sessionId);
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

  private _handleSessionNew(sessionId: string): void {
    try {
      this.sessionManager.create(sessionId, process.cwd());
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

    await this.catalog.recheckUnreachable();

    const available = this.catalog.getAvailable();
    const hasPlanner = available.some((w) => this.catalog.isPlanner(w));
    const userText = extractTextFromContent(content);

    if (!hasPlanner) {
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
          });
          this._plannerSessions.set(sessionId, plannerSession);
          sessionState.planOwnerRef = { kind: 'self' };
          await plannerSession.open(userText);
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
          });
          this._plannerSessions.set(sessionId, plannerSession);
          sessionState.planOwnerRef = { kind: 'external', taskId: '' };
          await plannerSession.open(userText);
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
    const registry = new ToolRegistry();
    // Escalation gate bypassed; escalation is handled at the A2A stream level.
    registry.setEscalationCallback(async () => true);

    let capturedPlan: PlanType | null = null;

    for (const worker of available) {
      const toolName = toToolName(worker);
      const isPlanner = this.catalog.isPlanner(worker);
      this.logger.debug({ toolName, isPlanner }, 'Registering worker tool');

      if (isPlanner) {
        const plannerName = worker.agent_card?.name ?? worker.name_hint ?? toolName;
        const plannerUrl = worker.url;

        registry.register(
          toolName,
          {
            name: toolName,
            description: buildWorkerDescription(worker),
            inputSchema: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Task description for decomposition.' },
              },
              required: ['description'],
            },
          },
          async (_args, _signal) => {
            const plannerSession = this.plannerSessionFactory({
              mode: 'external_planner',
              dispatchManager: this.dispatchManager,
              a2aClient: this.a2aClient,
              plannerUrl,
              config: this.config,
              logger: this.logger,
            });
            this._plannerSessions.set(sessionId, plannerSession);
            sessionState.planOwnerRef = { kind: 'external', taskId: '' };

            await this.acpServer.sendUpdate(sessionId, [
              { type: 'text', text: `[${plannerName}] starting...` },
            ]);
            this.logger.debug({ plannerUrl, sessionId }, 'opening planner session');

            await plannerSession.open(userText);

            const plan = plannerSession.getPlan();
            sessionState.planOwnerRef = {
              kind: 'external',
              taskId: plannerSession.taskId ?? '',
            };

            await this.acpServer.sendUpdate(sessionId, [
              { type: 'text', text: `[${plannerName}] done.` },
            ]);

            if (plan) {
              capturedPlan = plan;
              sessionState.activePlan = plan;
              return 'Plan received. Executing subtasks.';
            }
            return 'Planner did not return a valid plan.';
          },
          { forceWrite: true },
        );
      } else {
        registry.register(
          toolName,
          {
            name: toolName,
            description: buildWorkerDescription(worker),
            inputSchema: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Task description.' },
                expected_output: { type: 'string', description: 'Expected output (optional).' },
              },
              required: ['description'],
            },
          },
          async (args, signal) => {
            const payload: TaskPayload = {
              description: String(args['description'] ?? ''),
              expected_output:
                typeof args['expected_output'] === 'string' ? args['expected_output'] : null,
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
              originator_intent: userText,
              max_delegation_depth: 3,
              parent_task_id: null,
              base_branch: null,
              timeout_sec: this.config.runtime.default_task_timeout_sec,
              injected_mcps: [],
            };
            const taskResult = await this._runWorkerTask(
              worker.url,
              payload,
              sessionId,
              sessionState,
              signal,
            );
            return JSON.stringify(taskResult);
          },
          { forceWrite: true },
        );
      }
    }

    const systemPrompt = buildForemanSystemPrompt(buildWorkerList(available));
    const userMsg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: userText }],
    };
    const messages = [...sessionState.conversationHistory, userMsg];

    sessionState.abortController = new AbortController();
    const loop = new LLMLoop(this.llmClient, registry);
    let finalText = '';

    try {
      // Drive the generator manually to capture the return value (updated history).
      const gen = loop.run(messages, systemPrompt, sessionState.abortController.signal);
      while (true) {
        const result = await gen.next();
        if (result.done) {
          sessionState.conversationHistory = result.value;
          break;
        }
        const event = result.value;
        if (event.type === 'text_chunk') {
          finalText += event.text;
        } else if (event.type === 'stop' && event.stopReason === 'tool_use') {
          finalText = '';
        }
      }
    } finally {
      sessionState.abortController = null;
    }

    if (capturedPlan) {
      await this._executePlan(capturedPlan, sessionId, sessionState, userText, available);
    } else if (finalText) {
      await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: finalText }]);
    }
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
    for (const batch of plan.batches) {
      for (const subtask of batch.subtasks) {
        const worker = available.find(
          (w) =>
            toToolName(w) === subtask.assigned_agent ||
            w.agent_card?.name === subtask.assigned_agent,
        );
        subtaskWorkerNames.set(subtask.id, worker?.agent_card?.name ?? subtask.assigned_agent);
      }
    }
    const seenSubtasks = new Set<string>();

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
        if (!seenSubtasks.has(subtaskId)) {
          seenSubtasks.add(subtaskId);
          this.acpServer
            .sendUpdate(sessionId, [{ type: 'text', text: `[${workerName}] starting...` }])
            .catch((err: unknown) =>
              this.logger.warn({ err: String(err) }, 'transparency send failed'),
            );
        }
        const update = this._transparencyText(workerName, event);
        if (update) {
          this.acpServer
            .sendUpdate(sessionId, [{ type: 'text', text: update }])
            .catch((err: unknown) =>
              this.logger.warn({ err: String(err) }, 'transparency send failed'),
            );
        }
      },
    });

    let results: string[];
    try {
      const { subtaskResults } = await executor.execute(plan, userText);
      results = subtaskResults.map(
        ({ subtaskId, result }) => `[${subtaskId}] ${JSON.stringify(result)}`,
      );
    } catch (err) {
      let failureInfo: string;
      if (err instanceof PlanAbortedError) {
        const detail =
          err.taskResult.error?.message ?? err.taskResult.stop_reason ?? err.taskResult.status;
        failureInfo = `Subtask "${err.subtaskId}" failed: ${detail}`;
      } else {
        failureInfo = `Plan execution failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      const summary = await this._synthesize([failureInfo], userText);
      await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: summary }]);
      return;
    } finally {
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
      let structuredResult: TaskResultType | null = null;
      let fallbackText = '';

      for await (const event of handle) {
        if (signal?.aborted) {
          await handle.cancel().catch(() => {});
          throw new Error('Cancelled');
        }

        if (isPermissionEvent(event)) {
          const req = extractPermissionRequest(event);
          if (req) {
            await this._handleWorkerEscalation(handle.taskId, req, sessionId);
          }
        } else if (event.type === 'status') {
          const parsed = extractStatusResult(event);
          if (parsed) structuredResult = parsed;
        } else if (event.type === 'artifact') {
          fallbackText = extractArtifactText(event);
        } else if (event.type === 'message') {
          const text = extractMessageText(event);
          if (text) fallbackText += text;
        } else if (event.type === 'error') {
          const data = event.data as Record<string, unknown> | null | undefined;
          throw new Error(`Worker error: ${data?.['reason'] ?? 'unknown'}`);
        }
      }

      if (structuredResult) return structuredResult;

      return {
        status: 'completed',
        stop_reason: 'end_turn',
        summary: fallbackText || '(no output)',
        branch_ref: '',
        session_transcript_ref: '',
        error: null,
      };
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
  // Transparency text extraction (foreman-spec 5.2)
  // ---------------------------------------------------------------------------

  private _transparencyText(workerName: string, event: StreamEvent): string | null {
    if (event.type === 'message') {
      const text = extractMessageText(event);
      if (text) return `[${workerName}] ${text}`;
    } else if (event.type === 'status') {
      const data = event.data as Record<string, unknown> | null | undefined;
      const state = data?.['state'] as string | undefined;
      if (data?.['final'] && state === 'completed') {
        return `[${workerName}] done.`;
      }
      if (state && ['failed', 'canceled', 'rejected'].includes(state)) {
        return `[${workerName}] failed: ${state}`;
      }
    }
    return null;
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
