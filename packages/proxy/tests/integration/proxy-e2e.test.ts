import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ProxyServer } from '../../src/proxy-server.js';
import { DefaultA2AServer } from '../../src/a2a/server.js';
import { SubprocessPool } from '../../src/subprocess-pool.js';
import { DefaultACPClientManager } from '../../src/acp/client.js';
import type { ProxyConfig } from '../../src/config.js';
import type { WorktreeManager } from '../../src/worktree-manager.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const ECHO_AGENT = join(FIXTURE_DIR, 'echo-agent.ts');

function makeConfig(): ProxyConfig {
  return {
    proxy: { name: 'test-proxy', version: '0.0.1', bind: '127.0.0.1:0' },
    wrapped_agent: {
      command: process.execPath,
      args: ['--experimental-strip-types', ECHO_AGENT],
      env: {},
      cwd_strategy: 'worktree',
      startup_timeout_sec: 10,
    },
    role: { description: 'Test role', skills: [] },
    mcps: { personal: [] },
    permissions: { terminal_whitelist: [], permission_timeout_sec: 30 },
    worktrees: {
      base_dir: tmpdir(),
      branch_prefix: 'foreman/task-',
      default_base_branch: 'main',
      cleanup_policy: 'always',
    },
    runtime: { max_subprocesses: 1, max_sessions_per_subprocess: 1, task_hard_timeout_sec: 60 },
    logging: { level: 'error', format: 'json', destination: 'stderr' },
  } as unknown as ProxyConfig;
}

function makeMockWorktreeManager(tmpPath: string): WorktreeManager {
  return {
    createForTask: vi.fn().mockResolvedValue({
      worktreePath: tmpPath,
      branchName: 'foreman/task-e2e-test',
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorktreeManager;
}

describe('ProxyServer e2e', () => {
  let proxy: ProxyServer;
  let boundAddr: string;
  let a2aServer: DefaultA2AServer;

  beforeEach(async () => {
    const config = makeConfig();
    const tmpPath = mkdtempSync(join(tmpdir(), 'proxy-e2e-'));
    const acpClientManager = new DefaultACPClientManager();
    const subprocessPool = new SubprocessPool(config, acpClientManager);
    const worktreeManager = makeMockWorktreeManager(tmpPath);
    a2aServer = new DefaultA2AServer();
    proxy = new ProxyServer(config, a2aServer, subprocessPool, worktreeManager, acpClientManager);
    await proxy.start();
    boundAddr = a2aServer.getBoundAddress();
  }, 15_000);

  afterEach(async () => {
    await proxy.shutdown();
  });

  it('dispatches a task and receives a terminal result via JSON-RPC streaming', async () => {
    const taskPayload = {
      description: 'Write a hello world',
      originator_intent: 'Test the proxy',
      max_delegation_depth: 0,
      base_branch: 'main',
      injected_mcps: [],
      inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
      expected_output: null,
      parent_task_id: null,
      timeout_sec: null,
    };

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          kind: 'message',
          messageId: 'test-msg-1',
          role: 'user',
          parts: [{ kind: 'data', data: taskPayload }],
        },
      },
    });

    const response = await fetch(`http://${boundAddr}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body,
    });

    expect(response.status).toBe(200);

    // Collect SSE events
    const events: unknown[] = [];
    const text = await response.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith('data: ')) {
        try {
          events.push(JSON.parse(trimmed.slice(6)));
        } catch {
          // non-JSON SSE lines (comments, [DONE], etc.)
        }
      }
    }

    expect(events.length).toBeGreaterThan(0);

    // Find the terminal status-update or a message containing the final result
    const terminal = events.find((e: any) => {
      // Direct status update
      if (e?.result?.status?.state === 'completed' || e?.result?.status?.state === 'failed') {
        return true;
      }
      // Result serialized in a message (iteration 1 convention)
      if (e?.result?.kind === 'message') {
        const dataPart = e.result.parts?.find((p: any) => p.kind === 'text');
        if (dataPart) {
          try {
            const parsed = JSON.parse(dataPart.text);
            return parsed.status === 'completed' || parsed.status === 'failed';
          } catch {
            return false;
          }
        }
      }
      return false;
    });
    expect(terminal).toBeTruthy();
  }, 20_000);
});
