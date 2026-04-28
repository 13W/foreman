import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, ContentBlock, PermissionOption, PlanEntry, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type {
  ACPAgentServer,
  ACPPermissionRequest,
  ACPTransport,
  CancelHandler,
  InitializeHandler,
  PromptHandler,
  SessionNewHandler,
} from '@foreman-stack/shared';
import type { MsgLogger } from '../msg-logger.js';

// Maps our internal permission type to the ACP tool kind
function acpTypeToToolKind(type: ACPPermissionRequest['type']): 'read' | 'edit' | 'execute' {
  switch (type) {
    case 'fs.read':
      return 'read';
    case 'fs.write':
      return 'edit';
    case 'terminal.create':
      return 'execute';
    case 'choice':
      return 'read'; // Fallback for choice
  }
}

export class DefaultACPAgentServer implements ACPAgentServer {
  private _initHandler?: InitializeHandler;
  private _sessionNewHandler?: SessionNewHandler;
  private _promptHandler?: PromptHandler;
  private _cancelHandler?: CancelHandler;
  private _conn: AgentSideConnection | null = null;
  private readonly _msgLogger?: MsgLogger;

  constructor(msgLogger?: MsgLogger) {
    this._msgLogger = msgLogger;
  }

  onInitialize(handler: InitializeHandler): void {
    this._initHandler = handler;
  }

  onSessionNew(handler: SessionNewHandler): void {
    this._sessionNewHandler = handler;
  }

  onPrompt(handler: PromptHandler): void {
    this._promptHandler = handler;
  }

  onCancel(handler: CancelHandler): void {
    this._cancelHandler = handler;
  }

  async sendUpdate(sessionId: string, content: ContentBlock[]): Promise<void> {
    const conn = this._conn;
    if (!conn) throw new Error('DefaultACPAgentServer: not connected — call listen() first');
    this._msgLogger?.log('out', 'acp', 'agent_message_chunk', content, { sessionId });
    await Promise.all(
      content.map((block) =>
        conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: block } }),
      ),
    );
  }

  async sendPlan(sessionId: string, entries: PlanEntry[]): Promise<void> {
    const conn = this._conn;
    if (!conn) throw new Error('DefaultACPAgentServer: not connected — call listen() first');
    this._msgLogger?.log('out', 'acp', 'plan', { entries }, { sessionId });
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'plan', entries },
    });
  }

  async sendToolCall(sessionId: string, toolCall: ToolCall): Promise<void> {
    const conn = this._conn;
    if (!conn) throw new Error('DefaultACPAgentServer: not connected — call listen() first');
    this._msgLogger?.log('out', 'acp', 'tool_call', toolCall, { sessionId });
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call', ...toolCall },
    });
  }

  async sendToolCallUpdate(sessionId: string, update: ToolCallUpdate): Promise<void> {
    const conn = this._conn;
    if (!conn) throw new Error('DefaultACPAgentServer: not connected — call listen() first');
    this._msgLogger?.log('out', 'acp', 'tool_call_update', update, { sessionId });
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call_update', ...update },
    });
  }

  async requestPermission(
    sessionId: string,
    request: ACPPermissionRequest,
    options?: PermissionOption[],
  ): Promise<PermissionOption> {
    const conn = this._conn;
    if (!conn) throw new Error('DefaultACPAgentServer: not connected — call listen() first');

    const toolCallId = randomUUID();
    const defaultOptions: PermissionOption[] = [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
    ];
    const finalOptions = options ?? defaultOptions;

    this._msgLogger?.log('out', 'acp', 'permission_request', { request, options: finalOptions }, { sessionId });
    const response = await conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId,
        kind: acpTypeToToolKind(request.type),
        title: request.title ?? request.path ?? request.command ?? request.type,
        rawInput: { path: request.path, command: request.command },
        status: 'pending',
      },
      options: finalOptions,
    });
    this._msgLogger?.log('in', 'acp', 'permission_response', response, { sessionId });

    if (response.outcome.outcome === 'cancelled') {
      return (
        finalOptions.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always') ??
        finalOptions[0]
      );
    }
    const { optionId } = response.outcome as { outcome: 'selected'; optionId: string };
    return finalOptions.find((o) => o.optionId === optionId) ?? finalOptions[0];
  }

  async listen(_transport?: ACPTransport): Promise<void> {
    const stdinStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
    const stdoutStream = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(stdoutStream, stdinStream);

    const self = this;
    const conn = new AgentSideConnection(
      (c): Agent => {
        self._conn = c;
        return {
          async initialize(params) {
            await self._initHandler?.();
            return {
              protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
              agentInfo: { name: 'foreman', version: '0.0.1' },
              agentCapabilities: {},
            };
          },

          async newSession(_params) {
            const sessionId = randomUUID();
            await self._sessionNewHandler?.(sessionId);
            return { sessionId };
          },

          async prompt(params) {
            self._msgLogger?.log('in', 'acp', 'prompt', params.prompt, { sessionId: params.sessionId });
            const handler = self._promptHandler;
            if (handler) {
              await handler(params.sessionId, params.prompt);
            }
            return { stopReason: 'end_turn' as const };
          },

          async cancel(params) {
            await self._cancelHandler?.(params.sessionId);
          },

          async authenticate(_params) {
            return;
          },
        };
      },
      stream,
    );

    await conn.closed;
  }
}
