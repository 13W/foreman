import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Message } from '@a2a-js/sdk';
import type { A2AClient, AgentCardMetadata, PermissionDecision, StreamEvent } from '@foreman-stack/shared';
import { AgentCardValidationError, DispatchFailedError, TaskNotFoundError } from '@foreman-stack/shared';
import type { TaskPayload } from '@foreman-stack/shared';
import { logger } from '../logger.js';
import type { MsgLogger } from '../msg-logger.js';

type SdkStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

const TERMINAL_STATES = new Set(['completed', 'canceled', 'failed', 'rejected']);

const POLL_INITIAL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_MAX_CONSECUTIVE_FAILURES = 10;

interface TaskEntry {
  client: Client;
  contextId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DefaultA2AClientOptions {
  fetchImpl?: typeof fetch;
  agentCardPath?: string;
  msgLogger?: MsgLogger;
}

/**
 * Push-based A2A client.
 *
 * Events emitted:
 *   'task:<taskId>'       — every mapped StreamEvent for that task
 *   'task:<taskId>:done'  — emitted once when pump exits cleanly
 *   'task:<taskId>:error' — emitted if pump errors out
 */
export class DefaultA2AClient extends EventEmitter implements A2AClient {
  private readonly _factory: ClientFactory;
  private readonly _resolver: DefaultAgentCardResolver;
  private readonly _clientCache = new Map<string, Client>();
  private readonly _taskRegistry = new Map<string, TaskEntry>();
  private readonly _activeStreams = new Map<string, AbortController>();
  private readonly _taskErrors = new Map<string, Error>();
  private readonly _msgLogger?: MsgLogger;

  constructor(options: DefaultA2AClientOptions = {}) {
    super();
    // Bump max listeners — one per active subscriber per task plus done/error listeners.
    this.setMaxListeners(1000);
    this._factory = new ClientFactory(ClientFactoryOptions.default);
    this._resolver = new DefaultAgentCardResolver({
      path: options.agentCardPath ?? AGENT_CARD_PATH,
      fetchImpl: options.fetchImpl,
    });
    this._msgLogger = options.msgLogger;
  }

  async fetchAgentCard(url: string): Promise<AgentCardMetadata> {
    let card;
    try {
      card = await this._resolver.resolve(url);
    } catch (err) {
      throw new AgentCardValidationError(url, err instanceof Error ? err.message : String(err));
    }
    if (!card.name || !card.url || !card.version) {
      throw new AgentCardValidationError(url, 'missing required fields: name, url, or version');
    }
    return {
      name: card.name,
      url: card.url,
      version: card.version,
      description: card.description,
      skills: card.skills,
    };
  }

  async dispatchTask(url: string, payload: TaskPayload): Promise<string> {
    this._msgLogger?.log('out', 'a2a', 'task', payload);
    const client = await this._getOrCreateClient(url);
    const stream = client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: payload }],
      },
    }) as AsyncGenerator<SdkStreamEvent>;

    let firstResult: IteratorResult<SdkStreamEvent>;
    try {
      firstResult = await stream.next();
    } catch (err) {
      throw new DispatchFailedError(url, err instanceof Error ? err.message : String(err));
    }

    if (firstResult.done || firstResult.value.kind !== 'task') {
      const got = firstResult.done ? 'done' : (firstResult.value as SdkStreamEvent).kind;
      throw new DispatchFailedError(url, `expected task event first, got ${got}`);
    }

    const task = firstResult.value as Task;
    this._taskRegistry.set(task.id, { client, contextId: task.contextId });
    this._msgLogger?.log('in', 'a2a', 'task_ack', { taskId: task.id }, { taskId: task.id });
    logger.debug({ taskId: task.id, agentUrl: url }, 'task dispatched, pump started');

    const ac = new AbortController();
    this._activeStreams.set(task.id, ac);
    void this._pumpStream(task.id, stream, ac.signal);

    return task.id;
  }

  subscribe(taskId: string, listener: (event: StreamEvent) => void): () => void {
    const eventName = `task:${taskId}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  waitForDone(taskId: string): Promise<void> {
    // Pump may have already exited — check registry first so we don't hang.
    const storedError = this._taskErrors.get(taskId);
    if (storedError) {
      this._taskErrors.delete(taskId);
      return Promise.reject(storedError);
    }
    if (!this._taskRegistry.has(taskId)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onDone = () => {
        this.off(`task:${taskId}:error`, onError);
        resolve();
      };
      const onError = (err: unknown) => {
        this.off(`task:${taskId}:done`, onDone);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      this.once(`task:${taskId}:done`, onDone);
      this.once(`task:${taskId}:error`, onError);
    });
  }

  async pollTask(taskId: string): Promise<StreamEvent> {
    const entry = this._requireTaskEntry(taskId);
    const task = await entry.client.getTask({ id: taskId });
    return {
      type: 'status',
      taskId,
      data: { state: task.status.state },
      timestamp: task.status.timestamp,
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    const entry = this._taskRegistry.get(taskId);
    if (!entry) return;
    await entry.client.cancelTask({ id: taskId });
    this._activeStreams.get(taskId)?.abort();
  }

  async respondToPermission(taskId: string, decision: PermissionDecision): Promise<void> {
    this._msgLogger?.log('out', 'a2a', 'permission_response', decision, { taskId });
    await this.sendFollowUp(taskId, [{ kind: 'data', data: decision }]);
  }

  async sendFollowUp(taskId: string, parts: unknown[]): Promise<void> {
    const entry = this._requireTaskEntry(taskId);
    await entry.client.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        taskId,
        contextId: entry.contextId,
        role: 'user',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parts: parts as any,
      },
    });
  }

  private async _pumpStream(
    taskId: string,
    stream: AsyncGenerator<SdkStreamEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    // Interrupt the stream when abort fires so the for-await loop can exit promptly.
    const onAbort = () => { void stream.return(undefined); };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // Primary path: SSE streaming
      try {
        for await (const event of stream) {
          if (signal.aborted) break;
          const mapped = mapSdkEvent(taskId, event as SdkStreamEvent);
          this._msgLogger?.log('in', 'a2a', mapped.type, mapped, { taskId });
          this.emit(`task:${taskId}`, mapped);
          if (isTerminal(event as SdkStreamEvent)) {
            this.emit(`task:${taskId}:done`);
            return;
          }
        }
        // Stream ended (naturally or via abort)
        this.emit(`task:${taskId}:done`);
        return;
      } catch (streamErr) {
        if (signal.aborted) {
          this.emit(`task:${taskId}:done`);
          return;
        }
        logger.debug({ taskId, err: String(streamErr) }, 'stream failed, falling back to polling');
      }

      // Fallback path: polling
      let intervalMs = POLL_INITIAL_INTERVAL_MS;
      let consecutiveFailures = 0;

      while (!signal.aborted) {
        const entry = this._taskRegistry.get(taskId);
        if (!entry) break;

        try {
          const task = await entry.client.getTask({ id: taskId });
          consecutiveFailures = 0;
          const event: StreamEvent = {
            type: 'status',
            taskId,
            data: { state: task.status.state },
            timestamp: task.status.timestamp,
          };
          this._msgLogger?.log('in', 'a2a', 'poll', event, { taskId });
          this.emit(`task:${taskId}`, event);
          if (TERMINAL_STATES.has(task.status.state)) {
            this.emit(`task:${taskId}:done`);
            return;
          }
        } catch (pollErr) {
          consecutiveFailures++;
          logger.debug({ taskId, consecutiveFailures, err: String(pollErr) }, 'poll attempt failed');
          if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
            const errorEvent: StreamEvent = {
              type: 'error',
              taskId,
              data: { reason: 'connection_lost' },
              timestamp: new Date().toISOString(),
            };
            this.emit(`task:${taskId}`, errorEvent);
            this.emit(`task:${taskId}:done`);
            return;
          }
        }

        await sleep(intervalMs);
        intervalMs = Math.min(intervalMs * 2, POLL_MAX_INTERVAL_MS);
      }

      // Aborted during poll loop
      this.emit(`task:${taskId}:done`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ taskId, err: String(err) }, 'a2a stream pump errored');
      this._taskErrors.set(taskId, error);
      this.emit(`task:${taskId}:error`, error);
    } finally {
      signal.removeEventListener('abort', onAbort);
      this._activeStreams.delete(taskId);
      this._taskRegistry.delete(taskId);
      // Remove all listeners for this task — pump is gone, no more events possible.
      // done/error listeners were already fired (and auto-removed via once), but clean up extras.
      this.removeAllListeners(`task:${taskId}`);
      this.removeAllListeners(`task:${taskId}:done`);
      this.removeAllListeners(`task:${taskId}:error`);
    }
  }

  private async _getOrCreateClient(url: string): Promise<Client> {
    const cached = this._clientCache.get(url);
    if (cached) return cached;
    const client = await this._factory.createFromUrl(url);
    this._clientCache.set(url, client);
    return client;
  }

  private _requireTaskEntry(taskId: string): TaskEntry {
    const entry = this._taskRegistry.get(taskId);
    if (!entry) throw new TaskNotFoundError(taskId);
    return entry;
  }
}

function mapSdkEvent(knownTaskId: string, event: SdkStreamEvent): StreamEvent {
  switch (event.kind) {
    case 'status-update':
      return {
        type: 'status',
        taskId: event.taskId,
        data: { state: event.status.state, final: event.final, message: event.status.message },
        timestamp: event.status.timestamp,
      };
    case 'artifact-update':
      return {
        type: 'artifact',
        taskId: event.taskId,
        data: event.artifact,
      };
    case 'task':
      return {
        type: 'status',
        taskId: event.id,
        data: { state: event.status.state },
        timestamp: event.status.timestamp,
      };
    case 'message':
      return {
        type: 'message',
        taskId: event.taskId ?? knownTaskId,
        data: event,
      };
  }
}

function isTerminal(event: SdkStreamEvent): boolean {
  if (event.kind === 'status-update') {
    if (event.status.state === 'input-required') return false;
    return event.final || TERMINAL_STATES.has(event.status.state);
  }
  if (event.kind === 'task') {
    return TERMINAL_STATES.has(event.status.state);
  }
  return false;
}
