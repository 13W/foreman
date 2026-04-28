import type { Plan } from '@foreman-stack/shared';

export interface ExecutionStateSnapshot {
  completed: Map<string, { resultSummary: string }>;
  inProgress: Map<string, { workerName: string }>;
  failed: Map<string, { errorMessage: string }>;
}

const MAX_OUTPUT_LENGTH = 1500;

/**
 * Compact text representation of plan execution state for the planner.
 * Bounded to ~1500 chars to fit within LLM context budget.
 */
export function formatPlanStateForPlanner(
  plan: Plan,
  state: ExecutionStateSnapshot,
  focus?: { subtaskId: string },
): string {
  // Build subtask description lookup
  const descById = new Map<string, string>();
  for (const batch of plan.batches) {
    for (const subtask of batch.subtasks) {
      descById.set(subtask.id, subtask.description);
    }
  }

  const lines: string[] = [];
  lines.push('[FOREMAN STATE]');
  lines.push(`Plan goal: ${plan.goal_summary}`);
  lines.push('');

  // Completed subtasks
  if (state.completed.size > 0) {
    lines.push('Completed:');
    for (const [id, { resultSummary }] of state.completed) {
      const desc = descById.get(id) ?? id;
      if (focus?.subtaskId === id) {
        lines.push(`- ${id}: ${desc} → ${resultSummary}`);
      } else {
        lines.push(`- ${id}: ${desc.slice(0, 60)} → ${resultSummary.slice(0, 80)}`);
      }
    }
    lines.push('');
  }

  // In-progress subtasks
  if (state.inProgress.size > 0) {
    lines.push('In progress:');
    for (const [id, { workerName }] of state.inProgress) {
      const desc = descById.get(id) ?? id;
      if (focus?.subtaskId === id) {
        lines.push(`- ${id} (${workerName}): ${desc}`);
      } else {
        lines.push(`- ${id} (${workerName}): ${desc.slice(0, 60)}`);
      }
    }
    lines.push('');
  }

  // Failed subtasks
  if (state.failed.size > 0) {
    lines.push('Failed:');
    for (const [id, { errorMessage }] of state.failed) {
      const desc = descById.get(id) ?? id;
      if (focus?.subtaskId === id) {
        lines.push(`- ${id}: ${desc} → ${errorMessage}`);
      } else {
        lines.push(`- ${id}: ${desc.slice(0, 60)} → ${errorMessage.slice(0, 80)}`);
      }
    }
    lines.push('');
  }

  // Pending count
  const knownIds = new Set([
    ...state.completed.keys(),
    ...state.inProgress.keys(),
    ...state.failed.keys(),
  ]);
  let pendingCount = 0;
  for (const batch of plan.batches) {
    for (const subtask of batch.subtasks) {
      if (!knownIds.has(subtask.id)) pendingCount++;
    }
  }
  if (pendingCount > 0) {
    lines.push(`Pending: ${pendingCount} more subtask${pendingCount === 1 ? '' : 's'}.`);
  }

  const result = lines.join('\n').trimEnd();
  return result.length <= MAX_OUTPUT_LENGTH ? result : result.slice(0, MAX_OUTPUT_LENGTH - 3) + '...';
}
