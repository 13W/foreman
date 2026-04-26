import type { TaskResult } from '@foreman-stack/shared';

export class PlanAbortedError extends Error {
  constructor(
    public readonly subtaskId: string,
    public readonly taskResult: TaskResult,
  ) {
    const reason =
      taskResult.error?.message ?? taskResult.stop_reason ?? taskResult.status;
    super(`Plan aborted: subtask "${subtaskId}" ${taskResult.status} — ${reason}`);
    this.name = 'PlanAbortedError';
  }
}
