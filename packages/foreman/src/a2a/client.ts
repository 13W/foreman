import { randomUUID } from 'node:crypto';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Message } from '@a2a-js/sdk';
import type { A2AClient, AgentCardMetadata, PermissionDecision, StreamEvent } from '@foreman-stack/shared';
import { AgentCardValidationError, DispatchFailedError, TaskNotFoundError } from '@foreman-stack/shared';
import type { TaskPayload } from '@foreman-stack/shared';
import { logger } from '../logger.js';

type SdkStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

const TERMINAL_STATES = new Set(['completed', 'canceled', 'failed', 'rejected']);

interface TaskEntry {
  client: Client;
  contextId: string;
}

export interface DefaultA2AClientOptions {
  fetchImpl?: typeof fetch;
  agentCardPath?: string;
}

export class DefaultA2AClient implements A2AClient {
  private readonly _factory: ClientFactory;
  private readonly _resolver: DefaultAgentCardResolver;
  private readonly _clientCache = new Map<string, Client>();
  private readonly _taskRegistry = new Map<string, TaskEntry>();
  private readonly _streamRegistry = new Map<string, AsyncGenerator<SdkStreamEvent>>();

  constructor(options: DefaultA2AClientOptions = {}) {
    this._factory = new ClientFactory(ClientFactoryOptions.default);
    this._resolver = new DefaultAgentCardResolver({
      path: options.agentCardPath ?? AGENT_CARD_PATH,
      fetchImpl: options.fetchImpl,
    });
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
    this._streamRegistry.set(task.id, stream);
    this._taskRegistry.set(task.id, { client, contextId: task.contextId });
    logger.debug({ taskId: task.id, agentUrl: url }, 'task dispatched');
    return task.id;
  }

  async *streamTask(taskId: string): AsyncIterableIterator<StreamEvent> {
    this._requireTaskEntry(taskId);
    const stream = this._streamRegistry.get(taskId);
    if (!stream) throw new TaskNotFoundError(taskId);

    try {
      for await (const event of stream) {
        yield mapSdkEvent(taskId, event as SdkStreamEvent);
        if (isTerminal(event as SdkStreamEvent)) return;
      }
    } finally {
      this._streamRegistry.delete(taskId);
    }
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
    const entry = this._requireTaskEntry(taskId);
    await entry.client.cancelTask({ id: taskId });
  }

  async respondToPermission(taskId: string, decision: PermissionDecision): Promise<void> {
    const entry = this._requireTaskEntry(taskId);
    await entry.client.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        contextId: entry.contextId,
        role: 'user',
        parts: [{ kind: 'data', data: decision }],
      },
    });
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
