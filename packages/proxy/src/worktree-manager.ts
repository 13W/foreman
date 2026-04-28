import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { ProxyConfig } from './config.js';

const execFileAsync = promisify(execFile);

export class BaseBranchNotFoundError extends Error {
  constructor(branch: string) {
    super(`Base branch '${branch}' not found locally`);
    this.name = 'BaseBranchNotFoundError';
  }
}

export class WorktreeCreationError extends Error {
  constructor(taskId: string, cause: string) {
    super(`Failed to create worktree for task ${taskId}: ${cause}`);
    this.name = 'WorktreeCreationError';
  }
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}

export class WorktreeManager {
  private readonly _fallbackCwd: string;
  private readonly _worktreeCwds = new Map<string, string>();

  constructor(
    private readonly config: ProxyConfig,
    cwd: string = process.cwd(),
  ) {
    this._fallbackCwd = cwd;
  }

  private _worktreePath(taskId: string, cwd: string): string {
    return isAbsolute(this.config.worktrees.base_dir)
      ? join(this.config.worktrees.base_dir, taskId)
      : join(cwd, this.config.worktrees.base_dir, taskId);
  }

  async createForTask(taskId: string, baseBranch: string, cwd: string): Promise<WorktreeResult> {
    this._worktreeCwds.set(taskId, cwd);

    // Validate base branch exists locally — no network operations
    try {
      await execFileAsync('git', ['rev-parse', '--verify', baseBranch], { cwd });
    } catch {
      throw new BaseBranchNotFoundError(baseBranch);
    }

    const branchName = `${this.config.worktrees.branch_prefix}${taskId}`;
    const worktreePath = this._worktreePath(taskId, cwd);

    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
        { cwd },
      );
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new WorktreeCreationError(taskId, cause);
    }

    return { worktreePath, branchName };
  }

  async cleanup(taskId: string, taskStatus?: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const policy = this.config.worktrees.cleanup_policy;

    const shouldClean =
      policy === 'always' || (policy === 'on_success' && taskStatus === 'completed');

    if (!shouldClean) return;

    const cwd = this._worktreeCwds.get(taskId) ?? this._fallbackCwd;
    this._worktreeCwds.delete(taskId);

    const worktreePath = this._worktreePath(taskId, cwd);
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd });
    } catch {
      // Best-effort cleanup
    }
  }
}
