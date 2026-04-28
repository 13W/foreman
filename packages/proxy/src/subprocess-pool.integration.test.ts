import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DefaultACPClientManager } from './acp/client.js';
import { SubprocessPool, PoolExhaustedError } from './subprocess-pool.js';
import type { ProxyConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '..', 'tests', 'fixtures', 'echo-agent.ts');

function makeConfig(maxSubs = 1, maxSess = 1): ProxyConfig {
  return {
    proxy: { name: 'test', version: '0.1.0', bind: '127.0.0.1:7000', terminal_mode: 'strict' },
    wrapped_agent: {
      command: 'node',
      args: ['--experimental-strip-types', FIXTURE_PATH],
      env: {},
      cwd_strategy: 'worktree',
      startup_timeout_sec: 30,
      disallowed_tools: [],
    },
    role: { description: 'test', skills: [] },
    mcps: { personal: [] },
    permissions: {
      terminal_whitelist: [],
      permission_timeout_sec: 300,
    },
    worktrees: {
      base_dir: '/tmp/test-worktrees',
      branch_prefix: 'foreman/task-',
      default_base_branch: 'main',
      cleanup_policy: 'never',
    },
    runtime: {
      max_subprocesses: maxSubs,
      max_sessions_per_subprocess: maxSess,
      task_hard_timeout_sec: 3600,
    },
    logging: { level: 'info', format: 'json', destination: 'stderr' },
  } satisfies ProxyConfig;
}

describe('SubprocessPool — integration with echo-agent fixture', () => {
  let pool: SubprocessPool | undefined;

  afterEach(async () => {
    await pool?.shutdown().catch(() => {});
    pool = undefined;
  });

  it('acquires a session and can send a prompt through it', async () => {
    const client = new DefaultACPClientManager();
    pool = new SubprocessPool(makeConfig(1, 1), client);

    const slot = await pool.acquireSession(process.cwd(), []);

    const stream = client.sendPrompt(slot.session, [{ type: 'text', text: 'Hello' }]);
    const toolCallUpdates: unknown[] = [];
    let stopReason: string | undefined;

    for await (const event of stream) {
      if (event.kind === 'tool_call_update') {
        toolCallUpdates.push(event.update);
      } else if (event.kind === 'stop') {
        stopReason = event.reason;
        break;
      }
    }

    expect(stopReason).toBe('end_turn');
    expect(toolCallUpdates).toHaveLength(1);

    await slot.release();
  }, 20_000);

  it('throws PoolExhaustedError when slots exhausted', async () => {
    const client = new DefaultACPClientManager();
    pool = new SubprocessPool(makeConfig(1, 1), client);

    const slot = await pool.acquireSession(process.cwd(), []);

    await expect(pool.acquireSession(process.cwd(), [])).rejects.toThrow(PoolExhaustedError);

    await slot.release();
  }, 20_000);

  it('allows reuse after session release', async () => {
    const client = new DefaultACPClientManager();
    pool = new SubprocessPool(makeConfig(1, 1), client);

    const slot1 = await pool.acquireSession(process.cwd(), []);
    await slot1.release();

    // After release the subprocess was disposed (ref count = 0 with max_sess=1)
    // A new subprocess should be spawnable
    const slot2 = await pool.acquireSession(process.cwd(), []);
    expect(slot2.session.getId()).toBeDefined();

    await slot2.release();
  }, 40_000);
});
