import { execFile } from 'node:child_process';
import { join } from 'node:path';
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
  private readonly cwd: string;

  constructor(
    private readonly config: ProxyConfig,
    cwd: string = process.cwd(),
  ) {
    this.cwd = cwd;
  }

  async createForTask(taskId: string, baseBranch: string): Promise<WorktreeResult> {
    // Validate base branch exists locally — no network operations
    try {
      await execFileAsync('git', ['rev-parse', '--verify', baseBranch], { cwd: this.cwd });
    } catch {
      throw new BaseBranchNotFoundError(baseBranch);
    }

    const branchName = `${this.config.worktrees.branch_prefix}${taskId}`;
    const worktreePath = join(this.config.worktrees.base_dir, taskId);

    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', branchName, worktreePath, baseBranch],
        { cwd: this.cwd },
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

    const worktreePath = join(this.config.worktrees.base_dir, taskId);
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: this.cwd,
      });
    } catch {
      // Best-effort cleanup
    }
  }
}
