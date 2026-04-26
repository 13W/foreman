import type { Plan } from '@foreman-stack/shared';
import type { WorkerCatalog } from '../workers/catalog.js';
import { toToolName } from '../workers/catalog.js';

export class PlanValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

function workerExists(assignedAgent: string, catalog: WorkerCatalog): boolean {
  return catalog.getAvailable().some(
    (w) =>
      toToolName(w) === assignedAgent ||
      w.agent_card?.name === assignedAgent ||
      w.url === assignedAgent,
  );
}

/**
 * Validates a plan against runtime constraints.
 * Collects all issues before throwing so callers see the full problem list.
 */
export function validatePlan(plan: Plan, catalog: WorkerCatalog): Plan {
  const issues: string[] = [];
  const seenIds = new Set<string>();

  if (plan.batches.length === 0) {
    issues.push('plan has no batches');
  }

  for (const batch of plan.batches) {
    if (batch.subtasks.length === 0) {
      issues.push(`batch "${batch.batch_id}" has no subtasks`);
    }
    for (const subtask of batch.subtasks) {
      if (seenIds.has(subtask.id)) {
        issues.push(`duplicate subtask id: "${subtask.id}"`);
      } else {
        seenIds.add(subtask.id);
      }
      if (!workerExists(subtask.assigned_agent, catalog)) {
        issues.push(`unknown agent "${subtask.assigned_agent}" in subtask "${subtask.id}"`);
      }
    }
  }

  if (issues.length > 0) {
    throw new PlanValidationError(
      `Plan validation failed with ${issues.length} issue(s)`,
      issues,
    );
  }

  return plan;
}
