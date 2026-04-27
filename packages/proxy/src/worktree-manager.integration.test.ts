import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { ProxyConfig } from './config.js';
import { WorktreeManager, BaseBranchNotFoundError } from './worktree-manager.js';

const execFileAsync = promisify(execFile);

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // Need at least one commit for branches to exist
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
}

function makeConfig(repoDir: string, worktreeBaseDir: string): ProxyConfig {
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
    permissions: {
      terminal_whitelist: [],
      permission_timeout_sec: 300,
    },
    worktrees: {
      base_dir: worktreeBaseDir,
      branch_prefix: 'foreman/task-',
      default_base_branch: 'main',
      cleanup_policy: 'never',
    },
    runtime: {
      max_subprocesses: 1,
      max_sessions_per_subprocess: 1,
      task_hard_timeout_sec: 3600,
    },
    logging: { level: 'info', format: 'json', destination: 'stderr' },
  } satisfies ProxyConfig;
}

describe('WorktreeManager — integration with real git repo', () => {
  let repoDir: string;
  let worktreeBaseDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'wt-repo-'));
    worktreeBaseDir = await mkdtemp(join(tmpdir(), 'wt-base-'));
    await gitInit(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(worktreeBaseDir, { recursive: true, force: true });
  });

  it('creates a worktree at the expected path', async () => {
    const config = makeConfig(repoDir, worktreeBaseDir);
    const manager = new WorktreeManager(config, repoDir);

    const result = await manager.createForTask('task-001', 'main');

    expect(result.worktreePath).toBe(join(worktreeBaseDir, 'task-001'));
    expect(result.branchName).toBe('foreman/task-task-001');

    // Verify the path actually exists on disk
    const { stat } = await import('node:fs/promises');
    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });

  it('creates the feature branch from the base branch', async () => {
    const config = makeConfig(repoDir, worktreeBaseDir);
    const manager = new WorktreeManager(config, repoDir);

    await manager.createForTask('task-002', 'main');

    const { stdout } = await execFileAsync('git', ['branch', '--list', 'foreman/task-task-002'], {
      cwd: repoDir,
    });
    expect(stdout.trim()).toContain('foreman/task-task-002');
  });

  it('throws BaseBranchNotFoundError for non-existent branch', async () => {
    const config = makeConfig(repoDir, worktreeBaseDir);
    const manager = new WorktreeManager(config, repoDir);

    await expect(manager.createForTask('task-003', 'no-such-branch')).rejects.toThrow(
      BaseBranchNotFoundError,
    );
  });

  it('removes the worktree directory on cleanup with policy "always"', async () => {
    const config = makeConfig(repoDir, worktreeBaseDir);
    config.worktrees.cleanup_policy = 'always';
    const manager = new WorktreeManager(config, repoDir);

    const result = await manager.createForTask('task-004', 'main');
    await manager.cleanup('task-004', 'completed');

    const { stat } = await import('node:fs/promises');
    await expect(stat(result.worktreePath)).rejects.toThrow();
  });

  it('leaves worktree intact on cleanup with policy "never"', async () => {
    const config = makeConfig(repoDir, worktreeBaseDir);
    config.worktrees.cleanup_policy = 'never';
    const manager = new WorktreeManager(config, repoDir);

    const result = await manager.createForTask('task-005', 'main');
    await manager.cleanup('task-005', 'completed');

    const { stat } = await import('node:fs/promises');
    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });

  it('leaves worktree intact on failure when policy is "on_success"', async () => {
    const config = makeConfig(repoDir, worktreeBaseDir);
    config.worktrees.cleanup_policy = 'on_success';
    const manager = new WorktreeManager(config, repoDir);

    const result = await manager.createForTask('task-006', 'main');
    await manager.cleanup('task-006', 'failed');

    const { stat } = await import('node:fs/promises');
    const info = await stat(result.worktreePath);
    expect(info.isDirectory()).toBe(true);
  });
});
