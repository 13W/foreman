import { describe, expect, it, vi } from 'vitest';
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
