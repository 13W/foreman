import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ACPClientManager, SubprocessHandle, SessionHandle } from '@foreman-stack/shared';
import type { ProxyConfig } from './config.js';
import { SubprocessPool, PoolExhaustedError } from './subprocess-pool.js';

// ---------------------------------------------------------------------------
// Minimal ProxyConfig factory
// ---------------------------------------------------------------------------
function makeConfig(
  maxSubprocesses = 2,
  maxSessionsPerSubprocess = 2,
): ProxyConfig {
  return {
    proxy: { name: 'test', version: '0.1.0', bind: '127.0.0.1:7000', terminal_mode: 'strict' },
    wrapped_agent: {
      command: 'echo',
      args: [],
      env: {},
      cwd_strategy: 'worktree',
      startup_timeout_sec: 30,
    },
    role: { description: 'test', skills: [] },
    mcps: { personal: [] },
    permissions: { terminal_whitelist: [], permission_timeout_sec: 300 },
    worktrees: {
      base_dir: '/tmp/test-worktrees',
      branch_prefix: 'foreman/task-',
      default_base_branch: 'main',
      cleanup_policy: 'never',
    },
    runtime: {
      max_subprocesses: maxSubprocesses,
      max_sessions_per_subprocess: maxSessionsPerSubprocess,
      task_hard_timeout_sec: 3600,
    },
    logging: { level: 'info', format: 'json', destination: 'stderr' },
  } satisfies ProxyConfig;
}

// ---------------------------------------------------------------------------
// Mock ACPClientManager factory
// ---------------------------------------------------------------------------
let subprocessCounter = 0;
let sessionCounter = 0;

function makeSubprocessHandle(id: string): SubprocessHandle {
  return {
    getId: () => id,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSessionHandle(id: string): SessionHandle {
  return {
    getId: () => id,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClientManager(): ACPClientManager {
  return {
    spawnSubprocess: vi.fn().mockImplementation(() =>
      Promise.resolve(makeSubprocessHandle(`sp-${++subprocessCounter}`)),
    ),
    createSession: vi.fn().mockImplementation(() =>
      Promise.resolve(makeSessionHandle(`sess-${++sessionCounter}`)),
    ),
    sendPrompt: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  subprocessCounter = 0;
  sessionCounter = 0;
});

describe('SubprocessPool — spread-first assignment policy', () => {
  it('spawns a new subprocess for the first task', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(2, 2), client);

    const slot = await pool.acquireSession('/cwd', []);

    expect(client.spawnSubprocess).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(slot.session.getId()).toBe('sess-1');

    await pool.shutdown();
  });

  it('spawns a second subprocess for the second task (spread-first, even when first has free slot)', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(2, 2), client);

    await pool.acquireSession('/cwd1', []);
    await pool.acquireSession('/cwd2', []);

    expect(client.spawnSubprocess).toHaveBeenCalledTimes(2);

    await pool.shutdown();
  });

  it('reuses existing subprocess once max_subprocesses is reached, picks least-loaded', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(2, 3), client);

    // Fill both subprocess slots with one session each
    const slot1 = await pool.acquireSession('/cwd1', []);
    const slot2 = await pool.acquireSession('/cwd2', []);
    // Give sp-1 an extra session so sp-2 is least-loaded
    await pool.acquireSession('/cwd3', []);
    // 3rd session went to sp-1 (reuse because max reached)... wait, let me rethink:
    // After slots 1 and 2: sp-1 has 1 session, sp-2 has 1 session
    // 3rd call: max_subprocesses=2 reached, pick least-loaded (tie → first by creation order = sp-1)

    expect(client.spawnSubprocess).toHaveBeenCalledTimes(2);
    // The 3rd session should have been created on an existing subprocess
    expect(client.createSession).toHaveBeenCalledTimes(3);

    await pool.shutdown();
  });

  it('throws PoolExhaustedError when all slots are occupied', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(1, 1), client);

    await pool.acquireSession('/cwd1', []);

    await expect(pool.acquireSession('/cwd2', [])).rejects.toThrow(PoolExhaustedError);

    await pool.shutdown();
  });

  it('passes wrapped_agent command/args/env to spawnSubprocess', async () => {
    const client = makeClientManager();
    const config = makeConfig(1, 1);
    config.wrapped_agent.command = 'claude';
    config.wrapped_agent.args = ['--acp'];
    config.wrapped_agent.env = { MY_VAR: 'value' };
    const pool = new SubprocessPool(config, client);

    await pool.acquireSession('/cwd', []);

    expect(client.spawnSubprocess).toHaveBeenCalledWith('claude', ['--acp'], { MY_VAR: 'value' });

    await pool.shutdown();
  });

  it('passes cwd and mcpServers to createSession', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(1, 1), client);
    const mcps = [{ name: 'ts-lsp', transport: 'stdio' as const, command: 'tls', args: [] }];

    const slot = await pool.acquireSession('/my/worktree', mcps);

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ getId: expect.any(Function) }),
      '/my/worktree',
      mcps,
    );
    expect(slot.session).toBeDefined();

    await pool.shutdown();
  });
});

describe('SubprocessPool — reference-counted lifecycle', () => {
  it('disposes subprocess when its last session is released', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(1, 2), client);

    const slot1 = await pool.acquireSession('/cwd1', []);
    const slot2 = await pool.acquireSession('/cwd2', []);
    const subprocHandle = slot1.subprocess;

    await slot1.release();
    expect(subprocHandle.dispose).not.toHaveBeenCalled();

    await slot2.release();
    expect(subprocHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose subprocess while it still has active sessions', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(1, 3), client);

    const slot1 = await pool.acquireSession('/cwd1', []);
    const slot2 = await pool.acquireSession('/cwd2', []);
    const slot3 = await pool.acquireSession('/cwd3', []);
    const subprocHandle = slot1.subprocess;

    await slot1.release();
    await slot2.release();
    expect(subprocHandle.dispose).not.toHaveBeenCalled();

    await slot3.release();
    expect(subprocHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('allows spawning a new subprocess after previous one is fully released', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(1, 1), client);

    const slot1 = await pool.acquireSession('/cwd1', []);
    await slot1.release();

    // Should be able to acquire again (new subprocess spawned)
    const slot2 = await pool.acquireSession('/cwd2', []);
    expect(slot2.session).toBeDefined();
    expect(client.spawnSubprocess).toHaveBeenCalledTimes(2);

    await pool.shutdown();
  });
});

describe('SubprocessPool — shutdown', () => {
  it('disposes all active subprocesses on shutdown', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(2, 2), client);

    const slot1 = await pool.acquireSession('/cwd1', []);
    const slot2 = await pool.acquireSession('/cwd2', []);

    const sp1 = slot1.subprocess;
    const sp2 = slot2.subprocess;

    await pool.shutdown();

    expect(sp1.dispose).toHaveBeenCalledTimes(1);
    expect(sp2.dispose).toHaveBeenCalledTimes(1);
  });

  it('throws PoolExhaustedError after shutdown', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(2, 2), client);

    await pool.shutdown();

    await expect(pool.acquireSession('/cwd', [])).rejects.toThrow(PoolExhaustedError);
  });
});

describe('SubprocessPool — least-loaded tie-breaking', () => {
  it('breaks tie by creation order (first subprocess gets the extra session)', async () => {
    const client = makeClientManager();
    const pool = new SubprocessPool(makeConfig(2, 2), client);

    // Acquire 2 sessions — one on each subprocess (spread-first)
    const slot1 = await pool.acquireSession('/cwd1', []);
    const slot2 = await pool.acquireSession('/cwd2', []);

    // 3rd: max reached, tie between sp-1 (1 session) and sp-2 (1 session) → first wins (sp-1)
    const slot3 = await pool.acquireSession('/cwd3', []);
    expect(slot3.subprocess.getId()).toBe(slot1.subprocess.getId());

    await pool.shutdown();
  });
});
