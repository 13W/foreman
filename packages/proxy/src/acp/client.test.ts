import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client, Agent } from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be created before vi.mock() factories run
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const connection = {
    initialize: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    setSessionMode: vi.fn().mockResolvedValue({}),
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
  execFile: vi.fn(),
}));

vi.mock('node:stream', () => ({
  Writable: { toWeb: vi.fn().mockReturnValue({}) },
  Readable: { toWeb: vi.fn().mockReturnValue({}) },
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are declared
// ---------------------------------------------------------------------------
import { DefaultACPClientManager } from './client.js';
import type { PromptEvent } from '@foreman-stack/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getClient(): Client {
  if (!mocks.state.capturedToClient) throw new Error('ClientSideConnection not yet constructed');
  return mocks.state.capturedToClient({} as Agent);
}

async function collectEvents(stream: AsyncIterableIterator<PromptEvent>): Promise<PromptEvent[]> {
  const events: PromptEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
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

    it('does not include _meta when disallowedTools is empty', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', [], { disallowedTools: [] });
      expect(mocks.connection.newSession).toHaveBeenCalledWith(
        expect.not.objectContaining({ _meta: expect.anything() }),
      );
    });

    it('passes disallowedTools via _meta.claudeCode.options when provided', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', [], { disallowedTools: ['EnterPlanMode'] });
      expect(mocks.connection.newSession).toHaveBeenCalledWith(
        expect.objectContaining({
          _meta: { claudeCode: { options: { disallowedTools: ['EnterPlanMode'] } } },
        }),
      );
    });

    it('calls setSessionMode when agent starts in blocked plan mode', async () => {
      mocks.connection.newSession.mockResolvedValueOnce({
        sessionId: 'test-session-id',
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'plan', name: 'Plan' },
            { id: 'normal', name: 'Normal' },
          ],
        },
      });
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', []);
      expect(mocks.connection.setSessionMode).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'test-session-id', modeId: 'normal' }),
      );
    });

    it('does not call setSessionMode when agent starts in a non-blocked mode', async () => {
      mocks.connection.newSession.mockResolvedValueOnce({
        sessionId: 'test-session-id',
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
        },
      });
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', []);
      expect(mocks.connection.setSessionMode).not.toHaveBeenCalled();
    });

    it('does not call setSessionMode when agent advertises no modes', async () => {
      // default mock returns no modes field
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', []);
      expect(mocks.connection.setSessionMode).not.toHaveBeenCalled();
    });

    it('logs warning and skips switching when only blocked modes are available', async () => {
      mocks.connection.newSession.mockResolvedValueOnce({
        sessionId: 'test-session-id',
        modes: {
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      });
      const subprocess = await manager.spawnSubprocess('agent', []);
      await manager.createSession(subprocess, '/tmp', []);
      expect(mocks.connection.setSessionMode).not.toHaveBeenCalled();
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

    it('emits a stop event with the stop reason from the prompt response', async () => {
      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);

      const stream = manager.sendPrompt(session, []);
      const events = await collectEvents(stream);

      const stopEvent = events.find((e) => e.kind === 'stop');
      expect(stopEvent).toBeDefined();
      expect((stopEvent as Extract<PromptEvent, { kind: 'stop' }>).reason).toBe('end_turn');
    });

    it('streams tool_call_update notifications as tool_call_update events', async () => {
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => {
          promptResolve = resolve;
        }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const stream = manager.sendPrompt(session, []);

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
      const collectPromise = collectEvents(stream);

      promptResolve({ stopReason: 'end_turn' });

      const events = await collectPromise;
      const updateEvents = events.filter((e) => e.kind === 'tool_call_update');
      expect(updateEvents).toHaveLength(1);
      const updateEvent = updateEvents[0] as Extract<PromptEvent, { kind: 'tool_call_update' }>;
      expect((updateEvent.update as { toolCallId: string }).toolCallId).toBe('call-1');
    });

    it('emits agent_message_chunk events for agent_message_chunk session updates', async () => {
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => {
          promptResolve = resolve;
        }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const stream = manager.sendPrompt(session, []);

      const client = getClient();

      void client.sessionUpdate({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });

      const collectPromise = collectEvents(stream);
      promptResolve({ stopReason: 'end_turn' });

      const events = await collectPromise;
      const chunkEvents = events.filter((e) => e.kind === 'agent_message_chunk');
      expect(chunkEvents).toHaveLength(1);
    });

    it('permission_request events are emitted in the stream and respond() resolves the decision', async () => {
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => {
          promptResolve = resolve;
        }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const stream = manager.sendPrompt(session, []);

      const client = getClient();

      // Fire permission request from agent side
      const permissionPromise = client.requestPermission({
        sessionId: 'test-session-id',
        options: [{ kind: 'allow_once', optionId: 'opt-1', name: 'Allow once' }],
        toolCall: { toolCallId: 'c1', kind: 'read', status: 'pending', rawInput: { path: '/some/file.txt' } },
      });

      // Consumer responds to the permission_request event
      const consumerPromise = (async () => {
        for await (const event of stream) {
          if (event.kind === 'permission_request') {
            await event.respond({ kind: 'allow_once' });
          }
          if (event.kind === 'stop') break;
        }
      })();

      promptResolve({ stopReason: 'end_turn' });

      const [permResponse] = await Promise.all([permissionPromise, consumerPromise]);
      expect(permResponse).toBeDefined();
    });
  });

  // ---- mode switching (current_mode_update) ----------------------------------

  describe('mode switching', () => {
    it('calls setSessionMode when a current_mode_update switches to a blocked mode', async () => {
      mocks.connection.newSession.mockResolvedValueOnce({
        sessionId: 'test-session-id',
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      });
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => { promptResolve = resolve; }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const stream = manager.sendPrompt(session, []);
      const collectPromise = collectEvents(stream);

      const client = getClient();

      await client.sessionUpdate({
        sessionId: 'test-session-id',
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      });

      // flush microtasks so the fire-and-forget setSessionMode call executes
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.connection.setSessionMode).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'test-session-id', modeId: 'default' }),
      );

      promptResolve({ stopReason: 'end_turn' });
      await collectPromise;
    });

    it('does not call setSessionMode for a current_mode_update to a non-blocked mode', async () => {
      mocks.connection.newSession.mockResolvedValueOnce({
        sessionId: 'test-session-id',
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      });
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => { promptResolve = resolve; }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const stream = manager.sendPrompt(session, []);
      const collectPromise = collectEvents(stream);

      const client = getClient();

      await client.sessionUpdate({
        sessionId: 'test-session-id',
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
      });

      await Promise.resolve();
      expect(mocks.connection.setSessionMode).not.toHaveBeenCalled();

      promptResolve({ stopReason: 'end_turn' });
      await collectPromise;
    });

    it('stops forcing exit after MAX_FORCED_EXITS attempts', async () => {
      mocks.connection.newSession.mockResolvedValueOnce({
        sessionId: 'test-session-id',
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      });
      let promptResolve!: (value: unknown) => void;
      mocks.connection.prompt.mockReturnValueOnce(
        new Promise((resolve) => { promptResolve = resolve; }),
      );

      const subprocess = await manager.spawnSubprocess('agent', []);
      const session = await manager.createSession(subprocess, '/tmp', []);
      const stream = manager.sendPrompt(session, []);
      const collectPromise = collectEvents(stream);

      const client = getClient();

      // Trigger blocked mode 4 times — only 3 setSessionMode calls should happen
      for (let i = 0; i < 4; i++) {
        await client.sessionUpdate({
          sessionId: 'test-session-id',
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
        });
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(mocks.connection.setSessionMode).toHaveBeenCalledTimes(3);

      promptResolve({ stopReason: 'end_turn' });
      await collectPromise;
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
});
