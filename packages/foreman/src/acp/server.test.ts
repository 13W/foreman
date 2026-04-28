import { describe, expect, it, vi } from 'vitest';
import type { PlanEntry, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { DefaultACPAgentServer } from './server.js';

// Minimal mock of AgentSideConnection that exercises the handler wiring
function makeConnectionMock(overrides: Partial<{
  sessionUpdate: () => Promise<void>;
  requestPermission: () => Promise<unknown>;
  closed: Promise<void>;
}> = {}) {
  return {
    sessionUpdate: overrides.sessionUpdate ?? vi.fn().mockResolvedValue(undefined),
    requestPermission: overrides.requestPermission ?? vi.fn().mockResolvedValue({ outcome: { outcome: 'cancelled' } }),
    signal: new AbortController().signal,
    closed: overrides.closed ?? new Promise<void>(() => { /* never resolves in tests */ }),
  };
}

describe('DefaultACPAgentServer handler registration', () => {
  it('registers all handlers without error', () => {
    const server = new DefaultACPAgentServer();
    expect(() => {
      server.onInitialize(() => { });
      server.onSessionNew((_id) => { });
      server.onPrompt(async (_id, _content) => { });
      server.onCancel((_id) => { });
    }).not.toThrow();
  });
});

describe('DefaultACPAgentServer sendUpdate', () => {
  it('throws when not connected', async () => {
    const server = new DefaultACPAgentServer();
    await expect(
      server.sendUpdate('session-1', [{ type: 'text', text: 'hello' }]),
    ).rejects.toThrow('not connected');
  });

  it('calls conn.sessionUpdate for each content block when connected', async () => {
    const server = new DefaultACPAgentServer();
    const sessionUpdateFn = vi.fn().mockResolvedValue(undefined);
    const conn = makeConnectionMock({ sessionUpdate: sessionUpdateFn });

    // Inject mock connection
    (server as unknown as { _conn: typeof conn })._conn = conn;

    await server.sendUpdate('session-1', [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);

    expect(sessionUpdateFn).toHaveBeenCalledTimes(2);
    expect(sessionUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });
});

describe('DefaultACPAgentServer sendPlan', () => {
  it('throws when not connected', async () => {
    const server = new DefaultACPAgentServer();
    await expect(server.sendPlan('session-1', [])).rejects.toThrow('not connected');
  });

  it('calls conn.sessionUpdate with sessionUpdate: "plan" and entries', async () => {
    const server = new DefaultACPAgentServer();
    const sessionUpdateFn = vi.fn().mockResolvedValue(undefined);
    const conn = makeConnectionMock({ sessionUpdate: sessionUpdateFn });
    (server as unknown as { _conn: typeof conn })._conn = conn;

    const entries: PlanEntry[] = [
      { content: 'Task A', priority: 'high', status: 'pending' },
      { content: 'Task B', priority: 'medium', status: 'in_progress' },
    ];

    await server.sendPlan('session-1', entries);

    expect(sessionUpdateFn).toHaveBeenCalledTimes(1);
    expect(sessionUpdateFn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      update: { sessionUpdate: 'plan', entries },
    });
  });
});

describe('DefaultACPAgentServer sendToolCall', () => {
  it('throws when not connected', async () => {
    const server = new DefaultACPAgentServer();
    const toolCall: ToolCall = { toolCallId: 'tc-1', title: 'Run coder', status: 'in_progress', kind: 'execute' };
    await expect(server.sendToolCall('session-1', toolCall)).rejects.toThrow('not connected');
  });

  it('calls conn.sessionUpdate with sessionUpdate: "tool_call" and toolCall fields', async () => {
    const server = new DefaultACPAgentServer();
    const sessionUpdateFn = vi.fn().mockResolvedValue(undefined);
    const conn = makeConnectionMock({ sessionUpdate: sessionUpdateFn });
    (server as unknown as { _conn: typeof conn })._conn = conn;

    const toolCall: ToolCall = {
      toolCallId: 'tc-1',
      title: 'Run coder',
      status: 'in_progress',
      kind: 'execute',
      rawInput: { subtaskId: 's1' },
    };

    await server.sendToolCall('session-2', toolCall);

    expect(sessionUpdateFn).toHaveBeenCalledTimes(1);
    expect(sessionUpdateFn).toHaveBeenCalledWith({
      sessionId: 'session-2',
      update: { sessionUpdate: 'tool_call', ...toolCall },
    });
  });
});

describe('DefaultACPAgentServer sendToolCallUpdate', () => {
  it('throws when not connected', async () => {
    const server = new DefaultACPAgentServer();
    const update: ToolCallUpdate = { toolCallId: 'tc-1', status: 'completed' };
    await expect(server.sendToolCallUpdate('session-1', update)).rejects.toThrow('not connected');
  });

  it('calls conn.sessionUpdate with sessionUpdate: "tool_call_update" and update fields', async () => {
    const server = new DefaultACPAgentServer();
    const sessionUpdateFn = vi.fn().mockResolvedValue(undefined);
    const conn = makeConnectionMock({ sessionUpdate: sessionUpdateFn });
    (server as unknown as { _conn: typeof conn })._conn = conn;

    const update: ToolCallUpdate = { toolCallId: 'tc-2', status: 'failed' };

    await server.sendToolCallUpdate('session-3', update);

    expect(sessionUpdateFn).toHaveBeenCalledTimes(1);
    expect(sessionUpdateFn).toHaveBeenCalledWith({
      sessionId: 'session-3',
      update: { sessionUpdate: 'tool_call_update', ...update },
    });
  });
});

describe('DefaultACPAgentServer requestPermission', () => {
  it('throws when not connected', async () => {
    const server = new DefaultACPAgentServer();
    await expect(
      server.requestPermission('session-1', { type: 'fs.read', path: '/tmp/foo' }),
    ).rejects.toThrow('not connected');
  });

  it('returns reject option when outcome is cancelled', async () => {
    const server = new DefaultACPAgentServer();
    const requestPermissionFn = vi.fn().mockResolvedValue({
      outcome: { outcome: 'cancelled' },
    });
    const conn = makeConnectionMock({ requestPermission: requestPermissionFn });
    (server as unknown as { _conn: typeof conn })._conn = conn;

    const result = await server.requestPermission('session-1', { type: 'fs.write', path: '/tmp/foo' });
    expect(result.kind).toBe('reject_once');
  });

  it('returns allow_once option when user selects it', async () => {
    const server = new DefaultACPAgentServer();
    const requestPermissionFn = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    const conn = makeConnectionMock({ requestPermission: requestPermissionFn });
    (server as unknown as { _conn: typeof conn })._conn = conn;

    const result = await server.requestPermission('session-1', { type: 'terminal.create', command: 'bash' });
    expect(result.kind).toBe('allow_once');
    expect(result.optionId).toBe('allow_once');
  });

  it('calls conn.requestPermission with the correct tool kind mapping', async () => {
    const server = new DefaultACPAgentServer();
    const requestPermissionFn = vi.fn().mockResolvedValue({
      outcome: { outcome: 'cancelled' },
    });
    const conn = makeConnectionMock({ requestPermission: requestPermissionFn });
    (server as unknown as { _conn: typeof conn })._conn = conn;

    await server.requestPermission('s', { type: 'fs.read', path: '/etc/passwd' });
    const call = requestPermissionFn.mock.calls[0][0] as { toolCall: { kind: string } };
    expect(call.toolCall.kind).toBe('read');

    await server.requestPermission('s', { type: 'fs.write', path: '/etc/passwd' });
    const call2 = requestPermissionFn.mock.calls[1][0] as { toolCall: { kind: string } };
    expect(call2.toolCall.kind).toBe('edit');

    await server.requestPermission('s', { type: 'terminal.create', command: 'bash' });
    const call3 = requestPermissionFn.mock.calls[2][0] as { toolCall: { kind: string } };
    expect(call3.toolCall.kind).toBe('execute');
  });
});
