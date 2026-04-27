// packages/proxy/src/acp/client.ts
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ContentChunk,
  ToolCall,
  Plan,
} from '@agentclientprotocol/sdk';
import type {
  ACPClientManager,
  ACPPermissionRequest,
  ContentBlock,
  PermissionDecision,
  PromptEvent,
  SessionHandle,
  StopReason,
  SubprocessHandle,
} from '@foreman-stack/shared';
import type { McpServerSpec } from '@foreman-stack/shared';
import { DefaultSubprocessHandle } from './subprocess-handle.js';
import { DefaultSessionHandle } from './session-handle.js';
import { mapDecisionToAcpResponse } from '../a2a/mappers.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Internal async queue
// ---------------------------------------------------------------------------
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()!({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    const self = this;
    return {
      next(): Promise<IteratorResult<T>> {
        return new Promise((resolve) => {
          if (self.items.length > 0) {
            resolve({ value: self.items.shift()!, done: false });
          } else if (self.closed) {
            resolve({ value: undefined as unknown as T, done: true });
          } else {
            self.waiters.push(resolve);
          }
        });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// MCP conversion helpers
// ---------------------------------------------------------------------------
function specToSdkMcpServer(spec: McpServerSpec): McpServer {
  if (spec.transport === 'stdio') {
    return {
      name: spec.name,
      command: spec.command ?? '',
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
    };
  }
  return { type: 'sse' as const, name: spec.name, url: spec.url ?? '', headers: [] };
}

// ---------------------------------------------------------------------------
// Permission mapping helpers
// ---------------------------------------------------------------------------
function extractPath(rawInput: unknown): string {
  if (rawInput && typeof rawInput === 'object' && 'path' in rawInput) {
    return String((rawInput as Record<string, unknown>).path ?? '');
  }
  return '';
}

function extractCommand(rawInput: unknown): string {
  if (rawInput && typeof rawInput === 'object' && 'command' in rawInput) {
    return String((rawInput as Record<string, unknown>).command ?? '');
  }
  return '';
}

function toolKindToAcpType(kind: string | null | undefined): ACPPermissionRequest['type'] | null {
  switch (kind) {
    case 'read': return 'fs.read';
    case 'edit': case 'delete': case 'move': return 'fs.write';
    case 'execute': return 'terminal.create';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// DefaultACPClientManager
// ---------------------------------------------------------------------------
export class DefaultACPClientManager implements ACPClientManager {
  // One queue per active session (set when sendPrompt is called, cleared in finally)
  private readonly sessionQueues = new Map<string, AsyncQueue<PromptEvent>>();

  async spawnSubprocess(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<SubprocessHandle> {
    const id = randomUUID();
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...env },
    });

    const stdinStream = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const stdoutStream = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(stdinStream, stdoutStream);

    const self = this;
    const connection = new ClientSideConnection(
      (_agent): Client => ({
        async sessionUpdate(params) {
          const update = params.update as SessionUpdate;
          const updateType = update.sessionUpdate;
          const queue = self.sessionQueues.get(params.sessionId);
          if (!queue) {
            logger.warn({ sessionId: params.sessionId, updateType }, 'ACP sessionUpdate received for unknown session');
            return;
          }

          if (update.sessionUpdate === 'agent_message_chunk') {
            const chunk = update as ContentChunk;
            const preview = typeof chunk.content === 'string' ? chunk.content.slice(0, 80) : undefined;
            logger.debug({ sessionId: params.sessionId, updateType, preview }, 'ACP sessionUpdate received');
            queue.push({ kind: 'agent_message_chunk', content: chunk.content });
          } else if (update.sessionUpdate === 'tool_call') {
            const tc = update as unknown as ToolCall;
            logger.debug({ sessionId: params.sessionId, updateType, toolName: tc.name }, 'ACP sessionUpdate received');
            queue.push({ kind: 'tool_call', update: tc });
          } else if (update.sessionUpdate === 'tool_call_update') {
            logger.debug({ sessionId: params.sessionId, updateType }, 'ACP sessionUpdate received');
            queue.push({ kind: 'tool_call_update', update: update as any });
          } else if (update.sessionUpdate === 'plan') {
            const entries = (update as Plan).entries;
            logger.debug({ sessionId: params.sessionId, updateType, entryCount: entries?.length }, 'ACP sessionUpdate received');
            queue.push({ kind: 'plan', entries });
          } else {
            logger.debug({ sessionId: params.sessionId, updateType }, 'ACP sessionUpdate received (ignored)');
          }
        },
        async requestPermission(params) {
          return self.dispatchPermission(params);
        },
      }),
      stream,
    );

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'foreman-proxy', version: '0.0.1' },
    });

    return new DefaultSubprocessHandle(id, proc, connection);
  }

  async createSession(
    subprocess: SubprocessHandle,
    cwd: string,
    mcpServers: McpServerSpec[],
  ): Promise<SessionHandle> {
    const handle = subprocess as DefaultSubprocessHandle;
    const resp = await handle.connection.newSession({
      cwd,
      mcpServers: mcpServers.map(specToSdkMcpServer),
    });
    return new DefaultSessionHandle(resp.sessionId, handle);
  }

  sendPrompt(session: SessionHandle, content: ContentBlock[]): AsyncIterableIterator<PromptEvent> {
    const sessionId = session.getId();
    const queue = new AsyncQueue<PromptEvent>();
    this.sessionQueues.set(sessionId, queue);

    const handle = session as DefaultSessionHandle;
    const promptPromise = handle.subprocessHandle.connection.prompt({
      sessionId,
      prompt: content,
    });

    promptPromise
      .then((r) => {
        queue.push({ kind: 'stop', reason: r.stopReason as StopReason });
      })
      .catch((err) => {
        logger.warn({ err, sessionId }, 'ACP prompt error; synthesizing cancelled stop');
        queue.push({ kind: 'stop', reason: 'cancelled' as StopReason });
      })
      .finally(() => {
        queue.close();
        this.sessionQueues.delete(sessionId);
      });

    return queue[Symbol.asyncIterator]();
  }

  async cancelSession(session: SessionHandle): Promise<void> {
    const handle = session as DefaultSessionHandle;
    await handle.subprocessHandle.connection.cancel({ sessionId: session.getId() });
  }

  private async dispatchPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const { sessionId, toolCall } = params;
    const queue = this.sessionQueues.get(sessionId);
    if (!queue) return { outcome: { outcome: 'cancelled' } };

    const acpType = toolKindToAcpType(toolCall.kind);
    if (acpType === null) {
      // Unknown tool kind — cancel rather than fabricate a permission request
      return { outcome: { outcome: 'cancelled' } };
    }

    const request: ACPPermissionRequest = {
      type: acpType,
      path: (acpType === 'fs.read' || acpType === 'fs.write') ? extractPath(toolCall.rawInput) : undefined,
      command: acpType === 'terminal.create' ? extractCommand(toolCall.rawInput) : undefined,
    };

    const deferred = createDeferred<PermissionDecision>();
    queue.push({
      kind: 'permission_request',
      requestId: randomUUID(),
      request,
      respond: async (decision: PermissionDecision) => {
        deferred.resolve(decision);
      },
    });

    const decision = await deferred.promise;
    return mapDecisionToAcpResponse(decision, params.options);
  }
}
