import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ForemanConfig } from './config.js';
import { createLogger } from './logger.js';
import { DefaultACPAgentServer } from './acp/server.js';
import { DefaultA2AClient } from './a2a/client.js';
import { WorkerCatalog } from './workers/catalog.js';
import type { WorkerCatalogEntry } from './workers/catalog.js';
import { DispatchManager } from './workers/dispatch-manager.js';
import type { DispatchHandle } from './workers/task-handle.js';
import { AnthropicLLMClient } from './llm/anthropic-client.js';
import { LLMLoop } from './llm/loop.js';
import { ToolRegistry } from './llm/tool-registry.js';
import { buildForemanSystemPrompt } from './llm/prompts.js';
import { Plan } from '@foreman-stack/shared';
import type {
  Plan as PlanType,
  PermissionRequest,
  StreamEvent,
  TaskPayload,
} from '@foreman-stack/shared';
import { mapPermissionOptionToDecision } from './permissions/mapper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromContent(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('\n');
}

function toToolName(worker: WorkerCatalogEntry): string {
  const raw = worker.agent_card?.name ?? worker.name_hint ?? new URL(worker.url).hostname;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function isPermissionRequestPart(part: unknown): boolean {
  const p = part as Record<string, unknown> | null | undefined;
  if (!p || p['kind'] !== 'data') return false;
  const data = p['data'] as Record<string, unknown> | null | undefined;
  return (
    !!data &&
    typeof data['type'] === 'string' &&
    ['fs.read', 'fs.write', 'terminal.create'].includes(data['type'])
  );
}

function isPermissionEvent(event: StreamEvent): boolean {
  if (event.type !== 'message') return false;
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts = data?.['parts'];
  if (!Array.isArray(parts)) return false;
  return parts.some(isPermissionRequestPart);
}

function extractPermissionRequest(event: StreamEvent): PermissionRequest | null {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts = (data?.['parts'] as unknown[]) ?? [];
  for (const part of parts) {
    if (isPermissionRequestPart(part)) {
      const p = part as Record<string, unknown>;
      const d = p['data'] as Record<string, unknown>;
      return {
        type: d['type'] as PermissionRequest['type'],
        path: d['path'] as string | undefined,
        command: d['command'] as string | undefined,
        message: (d['message'] as string | undefined) ?? '',
      };
    }
  }
  return null;
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

  // TODO(t4.4): SessionManager will track concurrent sessions and enforce max_concurrent_sessions limit.
  private _activeHandles = new Map<string, DispatchHandle>();
  private _activeController: AbortController | null = null;

  constructor(config: ForemanConfig) {
    this.config = config;
    this.logger = createLogger(config.logging);
    this.acpServer = new DefaultACPAgentServer();
    this.a2aClient = new DefaultA2AClient();
    this.catalog = new WorkerCatalog(
      this.a2aClient,
      config.runtime.worker_discovery_timeout_sec * 1000,
    );
    this.dispatchManager = new DispatchManager(
      this.a2aClient,
      config.runtime.max_parallel_dispatches,
    );
    this.llmClient = new AnthropicLLMClient(config);
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
    this._activeController?.abort();
    for (const handle of this._activeHandles.values()) {
      await handle.cancel().catch(() => {});
    }
    this._activeHandles.clear();
  }

  // ---------------------------------------------------------------------------
  // Prompt handler
  // ---------------------------------------------------------------------------

  private async _handlePrompt(sessionId: string, content: ContentBlock[]): Promise<void> {
    await this.catalog.recheckUnreachable();

    const available = this.catalog.getAvailable();
    const hasPlanner = available.some((w) => this.catalog.isPlanner(w));

    if (!hasPlanner) {
      // TODO(t4.8): When no planner in catalog, ask user how to proceed (self-plan / delegate / dispatch-whole / cancel).
      await this.acpServer.sendUpdate(sessionId, [
        { type: 'text', text: 'No planner agent available; please configure one.' },
      ]);
      return;
    }

    const userText = extractTextFromContent(content);
    const registry = new ToolRegistry();

    // Workers are write tools. Escalation is handled at the A2A stream level (see _handleWorkerEscalation).
    // The ToolRegistry escalation gate is bypassed here — permissions are routed directly to the user per
    // the iteration-1 design. TODO(t4.7-full): Worker permission escalations route to plan owner first.
    registry.setEscalationCallback(async () => true);

    let capturedPlan: PlanType | null = null;

    for (const worker of available) {
      const toolName = toToolName(worker);
      const isPlanner = this.catalog.isPlanner(worker);
      this.logger.debug({ toolName, isPlanner }, 'Registering worker tool');

      registry.register(
        toolName,
        {
          name: toolName,
          description: buildWorkerDescription(worker),
          inputSchema: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Task description to dispatch to this worker.',
              },
              expected_output: {
                type: 'string',
                description: 'Expected output description (optional).',
              },
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

          const result = await this._runWorkerTask(worker.url, payload, sessionId, signal);

          if (isPlanner) {
            try {
              const parsed = Plan.safeParse(JSON.parse(result));
              if (parsed.success) {
                capturedPlan = parsed.data;
                return 'Plan received. Executing subtasks.';
              }
            } catch {
              // Not valid JSON plan — return raw result
            }
          }

          return result;
        },
        { forceWrite: true },
      );
    }

    const systemPrompt = buildForemanSystemPrompt(buildWorkerList(available));
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: userText }] },
    ];

    this._activeController = new AbortController();
    const loop = new LLMLoop(this.llmClient, registry);
    let finalText = '';

    try {
      for await (const event of loop.run(messages, systemPrompt, this._activeController.signal)) {
        if (event.type === 'text_chunk') {
          finalText += event.text;
        } else if (event.type === 'stop' && event.stopReason === 'tool_use') {
          // A new LLM turn follows; discard intermediate text accumulated so far.
          finalText = '';
        }
      }
    } finally {
      this._activeController = null;
    }

    if (capturedPlan) {
      let results: string[];
      try {
        // TODO(t4.5): PlanExecutor will replace this serial loop with parallel batch dispatch and proper failure handling.
        results = await this._executePlan(capturedPlan, userText, sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.acpServer.sendUpdate(sessionId, [
          { type: 'text', text: `Plan execution failed: ${msg}` },
        ]);
        return;
      }
      const summary = await this._synthesize(results, userText);
      await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: summary }]);
    } else if (finalText) {
      await this.acpServer.sendUpdate(sessionId, [{ type: 'text', text: finalText }]);
    }
  }

  // ---------------------------------------------------------------------------
  // Plan execution (serial dispatch, iteration 1)
  // ---------------------------------------------------------------------------

  // TODO(t4.5): PlanExecutor will replace this serial loop with parallel batch dispatch and proper failure handling.
  private async _executePlan(
    plan: PlanType,
    originatorIntent: string,
    sessionId: string,
  ): Promise<string[]> {
    const results: string[] = [];

    for (const batch of plan.batches) {
      for (const subtask of batch.subtasks) {
        const workerEntry = this.catalog
          .getAvailable()
          .find(
            (w) =>
              toToolName(w) === subtask.assigned_agent ||
              w.agent_card?.name === subtask.assigned_agent ||
              w.url === subtask.assigned_agent,
          );

        if (!workerEntry) {
          throw new Error(
            `No available worker for subtask "${subtask.id}" (assigned_agent: ${subtask.assigned_agent})`,
          );
        }

        const payload: TaskPayload = {
          description: subtask.description,
          expected_output: subtask.expected_output,
          inputs: subtask.inputs,
          originator_intent: originatorIntent,
          max_delegation_depth: 2,
          parent_task_id: null,
          base_branch: null,
          timeout_sec: this.config.runtime.default_task_timeout_sec,
          injected_mcps: [],
        };

        const result = await this._runWorkerTask(workerEntry.url, payload, sessionId, undefined);
        results.push(`[${subtask.id}] ${result}`);
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Worker task dispatch
  // ---------------------------------------------------------------------------

  private async _runWorkerTask(
    url: string,
    payload: TaskPayload,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const handle = await this.dispatchManager.dispatch(url, payload);
    this._activeHandles.set(handle.taskId, handle);

    try {
      let resultText = '';

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
        } else if (event.type === 'artifact') {
          resultText = extractArtifactText(event);
        } else if (event.type === 'message') {
          const text = extractMessageText(event);
          if (text) resultText += text;
        } else if (event.type === 'error') {
          const data = event.data as Record<string, unknown> | null | undefined;
          throw new Error(`Worker error: ${data?.['reason'] ?? 'unknown'}`);
        }
      }

      return resultText || '(no output)';
    } finally {
      this._activeHandles.delete(handle.taskId);
    }
  }

  // ---------------------------------------------------------------------------
  // Worker escalation (iteration 1: direct to user)
  // ---------------------------------------------------------------------------

  // TODO(t4.7-full): Worker permission escalations route to plan owner first; for now, escalate directly to user.
  // TODO(t4.6): PlannerSessionManager will keep planner alive for stateful escalation routing.
  private async _handleWorkerEscalation(
    taskId: string,
    request: PermissionRequest,
    sessionId: string,
  ): Promise<void> {
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
  // Cancel handler
  // ---------------------------------------------------------------------------

  private async _handleCancel(_sessionId: string): Promise<void> {
    this._activeController?.abort();
    // TODO(t4.4): SessionManager will track concurrent sessions and enforce max_concurrent_sessions limit.
    for (const handle of this._activeHandles.values()) {
      await handle.cancel().catch((err: unknown) => {
        this.logger.warn({ taskId: handle.taskId, err: String(err) }, 'cancel failed');
      });
    }
    this._activeHandles.clear();
  }
}

// ---------------------------------------------------------------------------
// Event content extraction helpers
// ---------------------------------------------------------------------------

function extractArtifactText(event: StreamEvent): string {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts = (data?.['parts'] as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (!p) continue;
    if (p['kind'] === 'text') {
      chunks.push(String(p['text'] ?? ''));
    } else if (p['kind'] === 'data') {
      chunks.push(JSON.stringify(p['data']));
    }
  }
  return chunks.join('');
}

function extractMessageText(event: StreamEvent): string {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts = (data?.['parts'] as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'text' && !isPermissionRequestPart(p)) {
      chunks.push(String(p['text'] ?? ''));
    }
  }
  return chunks.join('');
}
