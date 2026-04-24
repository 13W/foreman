import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client, Agent } from '@agentclientprotocol/sdk';
import type { PermissionOption } from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be created before vi.mock() factories run
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const connection = {
    initialize: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    get closed() {
      return Promise.resolve();
    },
    get signal() {
      return new AbortController().signal;
    },
  };
  const state = {
    capturedToClient: undefined as ((agent: Agent) => Client) | undefined,
  };
  return { connection, state };
});

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: vi.fn().mockImplementation((toClient: (agent: Agent) => Client) => {
    mocks.state.capturedToClient = toClient;
    return mocks.connection;
  }),
  ndJsonStream: vi.fn().mockReturnValue({}),
  PROTOCOL_VERSION: 1,
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdin: {},
    stdout: {},
    kill: vi.fn(),
    pid: 12345,
  }),
}));

vi.mock('node:stream', () => ({
  Writable: { toWeb: vi.fn().mockReturnValue({}) },
  Readable: { toWeb: vi.fn().mockReturnValue({}) },
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are declared
// ---------------------------------------------------------------------------
import { DefaultACPClientManager } from './client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getClient(): Client {
  if (!mocks.state.capturedToClient) throw new Error('ClientSideConnection not yet constructed');
  return mocks.state.capturedToClient({} as Agent);
}

function makePermissionOption(optionId = 'opt-1'): PermissionOption {
  return { kind: 'allow_once', optionId, name: 'Allow once' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('DefaultACPClientManager', () => {
  let manager: DefaultACPClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.capturedToClient = undefined;
    mocks.connection.initialize.mockResolvedValue({ protocolVersion: 1 });
    mocks.connection.newSession.mockResolvedValue({ sessionId: 'test-session-id' });
    mocks.connection.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    mocks.connection.cancel.mockResolvedValue(undefined);
    manager = new DefaultACPClientManager();
  });

  // ---- spawnSubprocess -------------------------------------------------------

  describe('spawnSubprocess', () => {
    it('spawns a child process with the given command and args', async () => {
      const { spawn } = await import('node:child_process');
      await manager.spawnSubprocess('claude', ['--acp'], { MY_VAR: 'val' });
      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['--acp'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'inherit'] }),
      );
    });

    it('merges provided env vars with process.env', async () => {
      const { spawn } = await import('node:child_process');
      await manager.spawnSubprocess('agent', [], { CUSTOM: 'yes' });
      const callArgs = vi.mocked(spawn).mock.calls[0];
      expect(callArgs[2].env).toMatchObject({ CUSTOM: 'yes' });
    });

    it('calls connection.initialize with PROTOCOL_VERSION', async () => {
      await manager.spawnSubprocess('agent', []);
      expect(mocks.connection.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ protocolVersion: 1 }),
      );
    });

    it('returns a SubprocessHandle with a unique id', async () => {
      const a = await manager.spawnSubprocess('agent', []);
      const b = await manager.spawnSubprocess('agent', []);
      expect(a.getId()).toBeTruthy();
      expect(b.getId()).toBeTruthy();
      expect(a.getId()).not.toBe(b.getId());
    });

    it('returned handle dispose() kills the process', async () => {
      const { spawn } = await import('node:child_process');
      const handle = await manager.spawnSubprocess('agent', []);
      await handle.dispose();
      const mockProcess = vi.mocked(spawn).mock.results[0].value;
      expect(mockProcess.kill).toHaveBeenCalled();
    });
  });

  // ---- createSession ---------------------------------------------------------

  describe('createSession', () => {
    it('calls newSession with the given cwd', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/work/dir', []);
      expect(mocks.connection.newSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/work/dir' }),
      );
    });

    it('converts McpServerSpec (stdio) to SDK McpServer format', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', [
        { name: 'my-mcp', transport: 'stdio', command: 'mcp-server', args: ['--port', '3000'], env: { TOKEN: 'abc' } },
      ]);
      expect(mocks.connection.newSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({
              name: 'my-mcp',
              command: 'mcp-server',
              args: ['--port', '3000'],
              env: [{ name: 'TOKEN', value: 'abc' }],
            }),
          ],
        }),
      );
    });

    it('returns a SessionHandle whose getId() matches the ACP session ID', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      expect(session.getId()).toBe('test-session-id');
    });
  });

  // ---- sendPrompt ------------------------------------------------------------

  describe('sendPrompt', () => {
    it('calls connection.prompt with correct sessionId and content', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const content = [{ type: 'text' as const, text: 'hello' }];

      manager.sendPrompt(session, content);

      expect(mocks.connection.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'test-session-id', prompt: content }),
      );
    });

    it('stopReason resolves with the value from the prompt response', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const result = manager.sendPrompt(session, []);

      await expect(result.stopReason).resolves.toBe('end_turn');
    });

    it('streams tool_call_update notifications via updates iterator', async () => {
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => {
          promptResolve = resolve;
        }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const result = manager.sendPrompt(session, []);

      const client = getClient();

      // Push a tool_call_update notification
      void client.sessionUpdate({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
        },
      });

      // Collect in parallel, then close
      const collectPromise = (async () => {
        const items: unknown[] = [];
        for await (const item of result.updates) {
          items.push(item);
        }
        return items;
      })();

      promptResolve({ stopReason: 'end_turn' });

      const updates = await collectPromise;
      expect(updates).toHaveLength(1);
      expect((updates[0] as { toolCallId: string }).toolCallId).toBe('call-1');
    });

    it('ignores non-tool_call_update session notifications', async () => {
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => {
          promptResolve = resolve;
        }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const result = manager.sendPrompt(session, []);

      const client = getClient();

      void client.sessionUpdate({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });

      const collectPromise = (async () => {
        const items: unknown[] = [];
        for await (const item of result.updates) {
          items.push(item);
        }
        return items;
      })();

      promptResolve({ stopReason: 'end_turn' });

      const updates = await collectPromise;
      expect(updates).toHaveLength(0);
    });
  });

  // ---- cancelSession ---------------------------------------------------------

  describe('cancelSession', () => {
    it('calls connection.cancel with the session ID', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      await manager.cancelSession(session);
      expect(mocks.connection.cancel).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'test-session-id' }),
      );
    });
  });

  // ---- Permission handlers ---------------------------------------------------

  describe('onPermissionRequest', () => {
    it('routes requestPermission to onPermissionRequest catch-all handler', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const handler = vi.fn<import('./client.js').PermissionHandler>()
        .mockResolvedValue(makePermissionOption('perm-1'));
      manager.onPermissionRequest(session, handler);

      const client = getClient();
      const response = await client.requestPermission({
        sessionId: 'test-session-id',
        options: [],
        toolCall: { toolCallId: 'c1', kind: 'other', status: 'pending' },
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(response.outcome).toMatchObject({ outcome: 'selected', optionId: 'perm-1' });
    });

    it('routes fs.read kind to onFsRead handler', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const fsReadHandler = vi.fn<import('./client.js').FsPermissionHandler>()
        .mockResolvedValue(makePermissionOption('read-opt'));
      manager.onFsRead(session, fsReadHandler);

      const client = getClient();
      const response = await client.requestPermission({
        sessionId: 'test-session-id',
        options: [],
        toolCall: { toolCallId: 'c2', kind: 'read', status: 'pending', rawInput: { path: '/some/file.txt' } },
      });

      expect(fsReadHandler).toHaveBeenCalledWith('/some/file.txt');
      expect(response.outcome).toMatchObject({ outcome: 'selected', optionId: 'read-opt' });
    });

    it('routes write/edit kind to onFsWrite handler', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const fsWriteHandler = vi.fn<import('./client.js').FsPermissionHandler>()
        .mockResolvedValue(makePermissionOption('write-opt'));
      manager.onFsWrite(session, fsWriteHandler);

      const client = getClient();
      const response = await client.requestPermission({
        sessionId: 'test-session-id',
        options: [],
        toolCall: { toolCallId: 'c3', kind: 'edit', status: 'pending', rawInput: { path: '/file.ts' } },
      });

      expect(fsWriteHandler).toHaveBeenCalledWith('/file.ts');
      expect(response.outcome).toMatchObject({ outcome: 'selected', optionId: 'write-opt' });
    });

    it('routes execute kind to onTerminalCreate handler', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const terminalHandler = vi.fn<import('./client.js').TerminalPermissionHandler>()
        .mockResolvedValue(makePermissionOption('term-opt'));
      manager.onTerminalCreate(session, terminalHandler);

      const client = getClient();
      const response = await client.requestPermission({
        sessionId: 'test-session-id',
        options: [],
        toolCall: {
          toolCallId: 'c4',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'npm test' },
        },
      });

      expect(terminalHandler).toHaveBeenCalledWith('npm test');
      expect(response.outcome).toMatchObject({ outcome: 'selected', optionId: 'term-opt' });
    });

    it('returns cancelled outcome when no handler is registered', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', []);

      const client = getClient();
      const response = await client.requestPermission({
        sessionId: 'test-session-id',
        options: [],
        toolCall: { toolCallId: 'c5', kind: 'other', status: 'pending' },
      });

      expect(response.outcome).toMatchObject({ outcome: 'cancelled' });
    });

    it('specific handler takes precedence over catch-all for fs.read', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const catchAll = vi.fn<import('./client.js').PermissionHandler>()
        .mockResolvedValue(makePermissionOption('generic'));
      const specific = vi.fn<import('./client.js').FsPermissionHandler>()
        .mockResolvedValue(makePermissionOption('specific'));

      manager.onPermissionRequest(session, catchAll);
      manager.onFsRead(session, specific);

      const client = getClient();
      await client.requestPermission({
        sessionId: 'test-session-id',
        options: [],
        toolCall: { toolCallId: 'c6', kind: 'read', status: 'pending' },
      });

      expect(specific).toHaveBeenCalledOnce();
      expect(catchAll).not.toHaveBeenCalled();
    });
  });
});
