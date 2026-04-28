import { Plan } from '@foreman-stack/shared';
import type { A2AClient } from '@foreman-stack/shared';
import type { PlanEntry } from '@agentclientprotocol/sdk';
import type { Logger } from 'pino';
import type { ForemanConfig } from '../config.js';
import type { DispatchManager } from '../workers/dispatch-manager.js';
import type { DispatchHandle } from '../workers/task-handle.js';
import type { LLMClient, Message } from '../llm/client.js';
import { LLMLoop } from '../llm/loop.js';
import { ToolRegistry } from '../llm/tool-registry.js';
import { SELF_PLANNED_SYSTEM_PROMPT } from './planner-prompts.js';
import { extractArtifactText, extractMessageText } from '../workers/stream-helpers.js';
import type { StreamEvent, TaskPayload } from '@foreman-stack/shared';
import { entriesToPlan } from './entries-to-plan.js';
import { formatPlanStateForPlanner } from './state-formatter.js';
import type { ExecutionStateSnapshot } from './state-formatter.js';

export type PlannerSessionMode = 'external_planner' | 'self_planned' | 'single_task_dispatch';

export type { ExecutionStateSnapshot };

export interface PlannerSessionOptions {
  mode: PlannerSessionMode;
  // external_planner deps:
  dispatchManager?: DispatchManager;
  a2aClient?: A2AClient;
  plannerUrl?: string;
  // self_planned deps:
  llmClient?: LLMClient;
  // common:
  config: ForemanConfig;
  logger: Logger;
  // optional execution state for plan-state injection in ask()
  workersAvailable?: string[];
  getExecutionState?: () => ExecutionStateSnapshot;
  cwd?: string | null;
}

export interface PlannerSession {
  readonly mode: PlannerSessionMode;

  /** Task ID assigned by the planner backend. Null for self_planned/single_task_dispatch. */
  readonly taskId: string | null;

  /**
   * Initialize the session.
   * External: dispatch the decomposition request and wait for the plan.
   * Self: prime the LLM context with the request and generate the plan.
   * Single: no-op.
   */
  open(decompositionRequest: string): Promise<void>;

  /**
   * Ask the plan owner a question during execution.
   * Returns the planner's answer text.
   * Throws in single_task_dispatch mode.
   */
  ask(question: string): Promise<string>;

  /**
   * Close the session and release resources.
   * External: best-effort cancel. Self: clear history. Single: no-op.
   */
  close(): Promise<void>;

  /**
   * The Plan parsed during open(). Null for single_task_dispatch or if not yet opened.
   */
  getPlan(): Plan | null;

  /**
   * Non-null when the planner emitted a question (input-required without a plan).
   * The foreman should forward this to the user and call resumeWithAnswer() on the next turn.
   */
  getPendingQuestion(): string | null;

  /**
   * Send the user's answer back to the planner and continue consuming events.
   * Updates the plan if the planner responds with one, or sets a new pending question.
   */
  resumeWithAnswer(answer: string): Promise<void>;

  /**
   * Signal that plan execution has started.
   * After this, the session is authoritative for status — planner plan events are filtered.
   */
  markExecutionStarted(): void;
}

// ---------------------------------------------------------------------------
// Plan extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a status event's message parts.
 * Checks data.parts first (post-fix flat shape), falls back to data.message.parts (legacy).
 */
function extractTextFromStatusMessage(event: StreamEvent): string {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts: unknown[] =
    (data?.['parts'] as unknown[] | undefined) ??
    ((data?.['message'] as Record<string, unknown> | undefined)?.['parts'] as unknown[] | undefined) ??
    [];
  let result = '';
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'text' && typeof p['text'] === 'string') {
      result += p['text'] as string;
    }
  }
  return result;
}

/**
 * Extract ACP plan entries from a status event produced by the proxy mapper.
 * Post-fix flat shape: entries at data.parts[].{kind:'data', data:{entries:[...]}}.
 * Legacy shape fallback: data.message.parts[].{kind:'data', data:{entries:[...]}}.
 */
function extractPlanEntriesFromStatusEvent(event: StreamEvent): unknown[] | null {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts: unknown[] =
    (data?.['parts'] as unknown[] | undefined) ??
    ((data?.['message'] as Record<string, unknown> | undefined)?.['parts'] as unknown[] | undefined) ??
    [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'data') {
      const d = p['data'] as Record<string, unknown> | null | undefined;
      if (d && Array.isArray(d['entries'])) {
        return d['entries'];
      }
    }
  }
  return null;
}

function tryParsePlanFromText(text: string): Plan | null {
  text = text.trim();
  if (!text) return null;
  const attempts = [text, text.match(/\{[\s\S]*\}/)?.[0] ?? ''];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed = Plan.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // not valid JSON, try next
    }
  }
  return null;
}

function tryParsePlanFromStatusEvent(event: StreamEvent): Plan | null {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts: unknown[] =
    (data?.['parts'] as unknown[] | undefined) ??
    ((data?.['message'] as Record<string, unknown> | undefined)?.['parts'] as unknown[] | undefined) ??
    [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'data' && p['data']) {
      const parsed = Plan.safeParse(p['data']);
      if (parsed.success) return parsed.data;
    }
    if (p?.['kind'] === 'text' && typeof p['text'] === 'string') {
      const plan = tryParsePlanFromText(p['text'] as string);
      if (plan) return plan;
    }
  }
  return null;
}

function isInputRequired(event: StreamEvent): boolean {
  const data = event.data as Record<string, unknown> | null | undefined;
  return event.type === 'status' && data?.['state'] === 'input-required';
}

function isTerminalStatus(event: StreamEvent): boolean {
  const TERMINAL = new Set(['completed', 'canceled', 'failed', 'rejected']);
  const data = event.data as Record<string, unknown> | null | undefined;
  if (event.type !== 'status') return false;
  const state = data?.['state'] as string | undefined;
  if (!state) return false;
  if (state === 'input-required') return false;
  return (data?.['final'] === true) || TERMINAL.has(state);
}

// ---------------------------------------------------------------------------
// ExternalPlannerSession
// ---------------------------------------------------------------------------

/**
 * Planner session backed by a long-lived A2A task.
 *
 * Protocol:
 *   open()  → dispatch decomposition request, consume events until plan received
 *             or input-required (planner stays alive for follow-ups).
 *   ask()   → sendFollowUp text question, consume events until next input-required
 *             or terminal (planner answered).
 *   close() → best-effort cancel.
 *
 * Primary plan source: ACP plan events (TodoWrite → adapter → plan entries in status event).
 * Fallback: JSON-in-text / JSON-in-status-data-part (legacy path retained).
 *
 * During execution phase (after markExecutionStarted()):
 *   - Foreman is authoritative for subtask statuses.
 *   - Planner plan event status changes are silently ignored.
 *   - Planner content/metadata changes on existing entries are accepted.
 *   - New entries from planner during execution are logged and ignored (MVP).
 */
export class ExternalPlannerSession implements PlannerSession {
  readonly mode: PlannerSessionMode = 'external_planner';

  private _handle: DispatchHandle | null = null;
  private _taskId: string | null = null;
  private _plan: Plan | null = null;
  private _pendingQuestion: string | null = null;
  private _closed = false;
  private _latestEntries: PlanEntry[] | null = null;
  private _phase: 'planning' | 'executing' | 'closed' = 'planning';
  private _originatorIntent = '';

  get taskId(): string | null { return this._taskId; }

  private readonly _logger: Logger;
  private readonly _timeoutMs: number;
  private readonly _workersAvailable: string[];
  private readonly _getExecutionState?: () => ExecutionStateSnapshot;
  private readonly _cwd: string | null;

  constructor(
    private readonly _dispatchManager: DispatchManager,
    private readonly _a2aClient: A2AClient,
    private readonly _plannerUrl: string,
    private readonly _config: ForemanConfig,
    logger: Logger,
    workersAvailable: string[] = [],
    getExecutionState?: () => ExecutionStateSnapshot,
    cwd: string | null = null,
  ) {
    this._logger = logger.child({ component: 'planner-session', mode: 'external_planner' });
    this._timeoutMs = _config.runtime.planner_response_timeout_sec * 1000;
    this._workersAvailable = workersAvailable;
    this._getExecutionState = getExecutionState;
    this._cwd = cwd;
  }

  async open(decompositionRequest: string): Promise<void> {
    this._originatorIntent = decompositionRequest;

    const payload: TaskPayload = {
      description: decompositionRequest,
      expected_output: 'A structured Plan object in JSON format',
      originator_intent: decompositionRequest,
      max_delegation_depth: 1,
      parent_task_id: null,
      base_branch: null,
      timeout_sec: this._config.runtime.default_task_timeout_sec,
      injected_mcps: [],
      inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
      cwd: this._cwd,
    };

    this._logger.debug({ plannerUrl: this._plannerUrl }, 'dispatching decomposition request');
    const handle = await this._dispatchManager.dispatch(this._plannerUrl, payload);
    this._handle = handle;
    this._taskId = handle.taskId;

    const { plan } = await this._consumeUntilPlanOrPause();
    this._plan = plan;
    this._logger.debug({ taskId: this._taskId, hasPlan: !!plan }, 'open complete');
  }

  async ask(question: string): Promise<string> {
    if (this._closed) throw new Error('PlannerSession already closed');
    if (!this._handle || !this._taskId) throw new Error('PlannerSession not open');

    let fullQuestion = question;
    if (this._plan && this._getExecutionState) {
      const state = this._getExecutionState();
      const formatted = formatPlanStateForPlanner(this._plan, state);
      fullQuestion =
        `${formatted}\n\n---\n\n${question}\n\n` +
        'Please answer the question. Do not modify the plan list — execution status is managed externally. ' +
        'If the question requires user input, respond with the literal text "ASK_USER".';
    }

    this._logger.debug({ taskId: this._taskId }, 'sending follow-up question to planner');
    await this._a2aClient.sendFollowUp(this._taskId, [{ kind: 'text', text: fullQuestion }]);

    const { text } = await this._consumeUntilPlanOrPause();
    return text;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._phase = 'closed';
    if (this._handle) {
      await this._handle.cancel().catch((err: unknown) => {
        this._logger.debug({ err: String(err) }, 'planner cancel error (ignored)');
      });
      this._handle = null;
    }
  }

  getPlan(): Plan | null {
    return this._plan;
  }

  getPendingQuestion(): string | null {
    return this._pendingQuestion;
  }

  async resumeWithAnswer(answer: string): Promise<void> {
    if (this._closed) throw new Error('PlannerSession already closed');
    if (!this._handle || !this._taskId) throw new Error('PlannerSession not open');

    this._pendingQuestion = null;
    this._logger.debug({ taskId: this._taskId }, 'resuming planner with user answer');
    await this._a2aClient.sendFollowUp(this._taskId, [{ kind: 'text', text: answer }]);

    const { plan } = await this._consumeUntilPlanOrPause();
    if (plan) this._plan = plan;
  }

  markExecutionStarted(): void {
    if (this._phase === 'planning') {
      this._phase = 'executing';
      this._logger.debug({ taskId: this._taskId }, 'execution started; plan events from planner will be filtered');
    }
  }

  /**
   * Consume events from the handle until:
   *  - input-required: planner is waiting for next input
   *  - terminal state: planner finished
   *  - done: stream ended
   *
   * Detects ACP plan entries from status events and updates _latestEntries.
   * On exit, converts _latestEntries to Plan if available (primary path);
   * falls back to JSON-in-text / JSON-in-status-data-part.
   *
   * During 'executing' phase, plan events are filtered:
   *   - Status changes on existing entries: silently ignored (foreman authoritative)
   *   - Additions: logged and ignored (TODO: surface as suggestion in future)
   *   - Content/metadata changes on existing entries: accepted
   */
  private async _consumeUntilPlanOrPause(): Promise<{ plan: Plan | null; text: string }> {
    const handle = this._handle!;
    let text = '';
    let plan: Plan | null = null;

    const deadline = Date.now() + this._timeoutMs;

    while (true) {
      const remaining = Math.max(0, deadline - Date.now());

      const nextPromise = handle.next();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('planner response timeout')), remaining),
      );

      const { value: event, done } = await Promise.race([nextPromise, timeoutPromise]);
      if (done) break;

      if (event.type === 'message') {
        text += extractMessageText(event);
      } else if (event.type === 'artifact') {
        text += extractArtifactText(event);
      } else if (event.type === 'status') {
        // Check for plan entries from the proxy mapper (primary ACP plan path)
        const rawEntries = extractPlanEntriesFromStatusEvent(event);
        if (rawEntries !== null) {
          this._logger.debug(
            { entryCount: rawEntries.length, phase: this._phase },
            'received plan entries from status event',
          );
          this._handleIncomingEntries(rawEntries as PlanEntry[]);
          // Don't break — keep consuming; plan can be refined multiple times
        }

        const statusText = extractTextFromStatusMessage(event);
        if (statusText) text += statusText;

        if (isInputRequired(event)) {
          const fromStatus = tryParsePlanFromStatusEvent(event);
          if (fromStatus) plan = fromStatus;
          if (!plan && !tryParsePlanFromText(text)) {
            this._pendingQuestion = text.trim() || '(planner needs clarification)';
          }
          break;
        }
        if (isTerminalStatus(event)) {
          const fromStatus = tryParsePlanFromStatusEvent(event);
          if (fromStatus) plan = fromStatus;
          break;
        }
      } else if (event.type === 'error') {
        const data = event.data as Record<string, unknown> | null | undefined;
        throw new Error(`planner error: ${data?.['reason'] ?? 'unknown'}`);
      }
    }

    // Primary path: convert _latestEntries to Plan if available
    if (this._latestEntries !== null && this._latestEntries.length > 0) {
      try {
        plan = entriesToPlan(this._latestEntries, {
          originatorIntent: this._originatorIntent,
          availableWorkerNames: this._workersAvailable,
          logger: this._logger,
        });
        this._pendingQuestion = null;
        this._logger.info({ entryCount: this._latestEntries.length }, 'plan built from ACP plan entries (primary path)');
      } catch (err) {
        this._logger.warn({ err: String(err) }, 'entriesToPlan failed; falling back to text/status path');
      }
    }

    // Fallback: parse from accumulated text
    if (!plan && text) {
      plan = tryParsePlanFromText(text);
      if (plan) {
        this._pendingQuestion = null;
        this._logger.info('plan built from text JSON (fallback path)');
      }
    }

    return { plan, text };
  }

  /**
   * Handle incoming plan entries, applying phase-appropriate filtering.
   */
  private _handleIncomingEntries(incoming: PlanEntry[]): void {
    if (this._phase === 'planning') {
      this._latestEntries = incoming;
      this._logger.debug({ count: incoming.length }, 'plan entries updated (planning phase)');
      return;
    }

    if (this._phase !== 'executing' || this._latestEntries === null) {
      return;
    }

    // Executing phase: foreman is authoritative for statuses
    const existingById = new Map(
      this._latestEntries.map((e) => {
        const id = ((e._meta ?? {}) as Record<string, unknown>)['subtaskId'] as string | undefined ?? '';
        return [id, e] as const;
      }),
    );

    let hasNewEntries = false;
    const updated = [...this._latestEntries];

    for (const entry of incoming) {
      const id = ((entry._meta ?? {}) as Record<string, unknown>)['subtaskId'] as string | undefined ?? '';
      if (!id || !existingById.has(id)) {
        this._logger.info(
          { subtaskId: id },
          // TODO: surface new entries as suggestions in future
          'planner added new entry during execution; ignoring (foreman authoritative)',
        );
        hasNewEntries = true;
        continue;
      }
      const existingEntry = existingById.get(id)!;
      const existingIdx = updated.findIndex(
        (e) => ((e._meta ?? {}) as Record<string, unknown>)['subtaskId'] === id,
      );
      if (existingIdx >= 0) {
        // Accept content/metadata changes, preserve status
        updated[existingIdx] = { ...entry, status: existingEntry.status };
      }
    }

    if (!hasNewEntries) {
      this._latestEntries = updated;
      this._logger.debug('plan entries refined during execution (statuses preserved)');
    } else {
      // Only update existing entries, don't add new ones
      this._latestEntries = updated;
      this._logger.debug('plan entries partially refined during execution (new entries ignored)');
    }
  }
}

// ---------------------------------------------------------------------------
// SelfPlannedSession
// ---------------------------------------------------------------------------

/**
 * Planner session backed by an in-process LLM context stream.
 * Maintains its own conversation history independent of the main user session.
 */
export class SelfPlannedSession implements PlannerSession {
  readonly mode: PlannerSessionMode = 'self_planned';
  readonly taskId: string | null = null;

  private _history: Message[] = [];
  private _plan: Plan | null = null;
  private _pendingQuestion: string | null = null;
  private readonly _getExecutionState?: () => ExecutionStateSnapshot;

  private readonly _logger: Logger;
  private readonly _timeoutMs: number;

  constructor(
    private readonly _llmClient: LLMClient,
    private readonly _config: ForemanConfig,
    logger: Logger,
    getExecutionState?: () => ExecutionStateSnapshot,
  ) {
    this._logger = logger.child({ component: 'planner-session', mode: 'self_planned' });
    this._timeoutMs = _config.runtime.planner_response_timeout_sec * 1000;
    this._getExecutionState = getExecutionState;
  }

  async open(decompositionRequest: string): Promise<void> {
    const userMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: decompositionRequest }],
    };
    this._logger.debug('starting self-planned decomposition');

    const text = await this._runOneTurn([userMsg]);
    this._history = [userMsg, { role: 'assistant', content: [{ type: 'text', text }] }];
    this._plan = tryParsePlanFromText(text);
    this._logger.debug({ hasPlan: !!this._plan }, 'open complete');
  }

  async ask(question: string): Promise<string> {
    let fullQuestion = question;
    if (this._plan && this._getExecutionState) {
      const state = this._getExecutionState();
      const formatted = formatPlanStateForPlanner(this._plan, state);
      fullQuestion =
        `${formatted}\n\n---\n\n${question}\n\n` +
        'Please answer the question. Do not modify the plan list — execution status is managed externally. ' +
        'If the question requires user input, respond with the literal text "ASK_USER".';
    }

    const qMsg: Message = { role: 'user', content: [{ type: 'text', text: fullQuestion }] };
    const messages = [...this._history, qMsg];

    this._logger.debug('asking self-planned session');
    const text = await this._runOneTurn(messages);
    this._history = [...messages, { role: 'assistant', content: [{ type: 'text', text }] }];
    return text;
  }

  async close(): Promise<void> {
    this._history = [];
  }

  getPlan(): Plan | null {
    return this._plan;
  }

  getPendingQuestion(): string | null {
    return this._pendingQuestion;
  }

  async resumeWithAnswer(_answer: string): Promise<void> {
    // Self-planned sessions don't pause for user questions.
  }

  markExecutionStarted(): void {
    // no-op for self-planned; no stream to filter
  }

  private async _runOneTurn(messages: Message[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._timeoutMs);

    const loop = new LLMLoop(this._llmClient, new ToolRegistry());
    let text = '';

    try {
      for await (const event of loop.run(messages, SELF_PLANNED_SYSTEM_PROMPT, controller.signal)) {
        if (event.type === 'text_chunk') text += event.text;
      }
    } finally {
      clearTimeout(timeout);
    }

    return text;
  }
}

// ---------------------------------------------------------------------------
// SingleTaskDispatchSession
// ---------------------------------------------------------------------------

/** No plan owner. open/close are no-ops; ask() always throws. */
export class SingleTaskDispatchSession implements PlannerSession {
  readonly mode: PlannerSessionMode = 'single_task_dispatch';
  readonly taskId: string | null = null;

  async open(_decompositionRequest: string): Promise<void> {
    // no-op
  }

  async ask(_question: string): Promise<string> {
    throw new Error('No plan owner in single_task_dispatch mode');
  }

  async close(): Promise<void> {
    // no-op
  }

  getPlan(): Plan | null {
    return null;
  }

  getPendingQuestion(): string | null {
    return null;
  }

  async resumeWithAnswer(_answer: string): Promise<void> {
    // no-op
  }

  markExecutionStarted(): void {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlannerSession(options: PlannerSessionOptions): PlannerSession {
  const { mode, config, logger } = options;

  switch (mode) {
    case 'external_planner': {
      if (!options.dispatchManager) throw new Error('external_planner mode requires dispatchManager');
      if (!options.a2aClient) throw new Error('external_planner mode requires a2aClient');
      if (!options.plannerUrl) throw new Error('external_planner mode requires plannerUrl');
      return new ExternalPlannerSession(
        options.dispatchManager,
        options.a2aClient,
        options.plannerUrl,
        config,
        logger,
        options.workersAvailable,
        options.getExecutionState,
        options.cwd ?? null,
      );
    }
    case 'self_planned': {
      if (!options.llmClient) throw new Error('self_planned mode requires llmClient');
      return new SelfPlannedSession(options.llmClient, config, logger, options.getExecutionState);
    }
    case 'single_task_dispatch':
      return new SingleTaskDispatchSession();
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown PlannerSessionMode: ${exhaustive}`);
    }
  }
}
