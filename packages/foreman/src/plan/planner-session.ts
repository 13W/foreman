import { Plan } from '@foreman-stack/shared';
import type { A2AClient } from '@foreman-stack/shared';
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

export type PlannerSessionMode = 'external_planner' | 'self_planned' | 'single_task_dispatch';

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
}

// ---------------------------------------------------------------------------
// Plan extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a status event's message parts.
 * The proxy tunnels ACP agent_message_chunk events as working status-updates
 * with text in status.message.parts — not as message events.
 */
function extractTextFromStatusMessage(event: StreamEvent): string {
  const data = event.data as Record<string, unknown> | null | undefined;
  const message = data?.['message'] as Record<string, unknown> | null | undefined;
  if (!message) return '';
  const parts = (message['parts'] as unknown[]) ?? [];
  let result = '';
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'text' && typeof p['text'] === 'string') {
      result += p['text'] as string;
    }
  }
  return result;
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
  const message = data?.['message'] as Record<string, unknown> | null | undefined;
  const parts = (message?.['parts'] as unknown[]) ?? [];
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
 * NOTE: Requires the planner worker to stay in input-required state after
 * emitting the plan (not transition to completed). This is a planner-side
 * change that must be coordinated separately (t4.6 finding).
 *
 * ask() response convention: planner returns plain text (or JSON) in message
 * events. We collect all text and return it. JSON is parsed opportunistically
 * by the caller if needed.
 */
export class ExternalPlannerSession implements PlannerSession {
  readonly mode: PlannerSessionMode = 'external_planner';

  private _handle: DispatchHandle | null = null;
  private _taskId: string | null = null;
  private _plan: Plan | null = null;
  private _pendingQuestion: string | null = null;
  private _closed = false;

  get taskId(): string | null { return this._taskId; }

  private readonly _logger: Logger;
  private readonly _timeoutMs: number;

  constructor(
    private readonly _dispatchManager: DispatchManager,
    private readonly _a2aClient: A2AClient,
    private readonly _plannerUrl: string,
    private readonly _config: ForemanConfig,
    logger: Logger,
  ) {
    this._logger = logger.child({ component: 'planner-session', mode: 'external_planner' });
    this._timeoutMs = _config.runtime.planner_response_timeout_sec * 1000;
  }

  async open(decompositionRequest: string): Promise<void> {
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

    this._logger.debug({ taskId: this._taskId }, 'sending follow-up question to planner');
    await this._a2aClient.sendFollowUp(this._taskId, [{ kind: 'text', text: question }]);

    const { text } = await this._consumeUntilPlanOrPause();
    return text;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
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

  /**
   * Consume events from the handle (using manual .next() to avoid breaking the
   * generator on early exit) until:
   *  - input-required: planner is waiting for next input
   *  - terminal state: planner finished
   *  - done: stream ended
   *
   * Returns any plan found and accumulated text from message/artifact events.
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
        const statusText = extractTextFromStatusMessage(event);
        if (statusText) text += statusText;
        if (isInputRequired(event)) {
          // Try to extract a plan from the status event data (e.g. summary field).
          const fromStatus = tryParsePlanFromStatusEvent(event);
          if (fromStatus) plan = fromStatus;
          if (!plan && !tryParsePlanFromText(text)) {
            // Planner is asking a question or paused without a plan.
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

    if (!plan && text) {
      plan = tryParsePlanFromText(text);
      if (plan) this._pendingQuestion = null;
    }

    return { plan, text };
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

  private readonly _logger: Logger;
  private readonly _timeoutMs: number;

  constructor(
    private readonly _llmClient: LLMClient,
    private readonly _config: ForemanConfig,
    logger: Logger,
  ) {
    this._logger = logger.child({ component: 'planner-session', mode: 'self_planned' });
    this._timeoutMs = _config.runtime.planner_response_timeout_sec * 1000;
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
    const qMsg: Message = { role: 'user', content: [{ type: 'text', text: question }] };
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
      );
    }
    case 'self_planned': {
      if (!options.llmClient) throw new Error('self_planned mode requires llmClient');
      return new SelfPlannedSession(options.llmClient, config, logger);
    }
    case 'single_task_dispatch':
      return new SingleTaskDispatchSession();
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown PlannerSessionMode: ${exhaustive}`);
    }
  }
}
