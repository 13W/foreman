import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProxyConfig } from './config.js';
import { WorktreeManager, BaseBranchNotFoundError, WorktreeCreationError } from './worktree-manager.js';

// ---------------------------------------------------------------------------
// Minimal ProxyConfig factory
// ---------------------------------------------------------------------------
function makeConfig(overrides?: Partial<ProxyConfig['worktrees']>): ProxyConfig {
  return {
    proxy: { name: 'test', version: '0.1.0', bind: '127.0.0.1:7000', terminal_mode: 'strict' },
    wrapped_agent: {
      command: 'echo',
      args: [],
      env: {},
      cwd_strategy: 'worktree',
      startup_timeout_sec: 30,
      disallowed_tools: [],
    },
    role: { description: 'test', skills: [] },
    mcps: { personal: [] },
    permissions: { terminal_whitelist: [], permission_timeout_sec: 300 },
    worktrees: {
      base_dir: '/tmp/test-worktrees',
      branch_prefix: 'foreman/task-',
      default_base_branch: 'main',
      cleanup_policy: 'never',
      ...overrides,
    },
    runtime: {
      max_subprocesses: 1,
      max_sessions_per_subprocess: 1,
      task_hard_timeout_sec: 3600,
    },
    logging: { level: 'info', format: 'json', destination: 'stderr' },
  } satisfies ProxyConfig;
}

// ---------------------------------------------------------------------------
// Hoist mock state so vi.mock factories can reference it
// ---------------------------------------------------------------------------
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

beforeEach(() => {
  mockExecFile.mockReset();
});

// Helper: make execFile resolve successfully
function execFileOk(stdout = ''): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) =>
      cb(null, stdout),
  );
}

// Helper: make execFile fail with an error
function execFileFail(message = 'git error'): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
      cb(new Error(message)),
  );
}

// Helper: make execFile succeed for first N calls then fail
function execFileOkThenFail(okCount: number, failMessage = 'git error'): void {
  let calls = 0;
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
      calls++;
      if (calls <= okCount) {
        cb(null, '');
      } else {
        cb(new Error(failMessage));
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
describe('WorktreeManager.createForTask', () => {
  it('returns worktreePath and branchName on success', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig());

    const result = await manager.createForTask('task-abc', 'main');

    expect(result.worktreePath).toBe('/tmp/test-worktrees/task-abc');
    expect(result.branchName).toBe('foreman/task-task-abc');
  });

  it('uses branch_prefix from config', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig({ branch_prefix: 'custom/prefix-' }));

    const result = await manager.createForTask('my-task', 'main');

    expect(result.branchName).toBe('custom/prefix-my-task');
  });

  it('uses base_dir from config for worktreePath', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig({ base_dir: '/my/custom/dir' }));

    const result = await manager.createForTask('task-1', 'main');

    expect(result.worktreePath).toBe('/my/custom/dir/task-1');
  });

  it('calls git rev-parse --verify to validate base branch', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig());

    await manager.createForTask('task-xyz', 'feature-branch');

    const firstCall = mockExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('git');
    expect(firstCall[1]).toContain('rev-parse');
    expect(firstCall[1]).toContain('--verify');
    expect(firstCall[1]).toContain('feature-branch');
  });

  it('calls git worktree add with correct arguments', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig());

    await manager.createForTask('task-abc', 'main');

    const worktreeCall = mockExecFile.mock.calls[1];
    expect(worktreeCall[0]).toBe('git');
    expect(worktreeCall[1]).toEqual([
      'worktree', 'add', '-b', 'foreman/task-task-abc',
      '/tmp/test-worktrees/task-abc', 'main',
    ]);
  });

  it('throws BaseBranchNotFoundError when rev-parse fails', async () => {
    execFileFail('fatal: not a valid object');
    const manager = new WorktreeManager(makeConfig());

    await expect(manager.createForTask('task-1', 'nonexistent-branch')).rejects.toThrow(
      BaseBranchNotFoundError,
    );
  });

  it('throws BaseBranchNotFoundError with branch name in message', async () => {
    execFileFail('fatal: not valid');
    const manager = new WorktreeManager(makeConfig());

    await expect(manager.createForTask('task-1', 'no-such-branch')).rejects.toThrow(
      /no-such-branch/,
    );
  });

  it('throws WorktreeCreationError when git worktree add fails', async () => {
    execFileOkThenFail(1, 'fatal: worktree already exists');
    const manager = new WorktreeManager(makeConfig());

    await expect(manager.createForTask('task-1', 'main')).rejects.toThrow(WorktreeCreationError);
  });

  it('uses execFile (not exec) — no shell injection possible', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig());

    await manager.createForTask('task-1', 'main');

    // execFile is called with separate args array, not a shell string
    for (const call of mockExecFile.mock.calls) {
      expect(typeof call[0]).toBe('string'); // command is a string
      expect(Array.isArray(call[1])).toBe(true); // args is an array
    }
  });
});

describe('WorktreeManager.cleanup', () => {
  it('does not remove worktree when policy is "never"', async () => {
    const manager = new WorktreeManager(makeConfig({ cleanup_policy: 'never' }));

    await manager.cleanup('task-1', 'completed');

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('removes worktree on success when policy is "on_success"', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig({ cleanup_policy: 'on_success' }));

    await manager.cleanup('task-abc', 'completed');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const call = mockExecFile.mock.calls[0];
    expect(call[0]).toBe('git');
    expect(call[1]).toContain('worktree');
    expect(call[1]).toContain('remove');
    expect(call[1]).toContain('/tmp/test-worktrees/task-abc');
  });

  it('does not remove worktree on failure when policy is "on_success"', async () => {
    const manager = new WorktreeManager(makeConfig({ cleanup_policy: 'on_success' }));

    await manager.cleanup('task-1', 'failed');
    await manager.cleanup('task-2', 'cancelled');

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('removes worktree for any status when policy is "always"', async () => {
    execFileOk();
    const manager = new WorktreeManager(makeConfig({ cleanup_policy: 'always' }));

    await manager.cleanup('task-1', 'failed');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('removes worktree even when git worktree remove fails (best-effort)', async () => {
    execFileFail('error: not a worktree');
    const manager = new WorktreeManager(makeConfig({ cleanup_policy: 'always' }));

    // Should not throw
    await expect(manager.cleanup('task-1', 'completed')).resolves.toBeUndefined();
  });
});
