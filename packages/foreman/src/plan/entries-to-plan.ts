import { randomUUID } from 'node:crypto';
import type { PlanEntry } from '@agentclientprotocol/sdk';
import type { Plan, Subtask } from '@foreman-stack/shared';
import type { Logger } from 'pino';

export class EntriesToPlanError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = 'EntriesToPlanError';
  }
}

/**
 * Convert ACP PlanEntries into a Foreman Plan via topological sort.
 *
 * _meta conventions:
 *   subtaskId: string — Subtask.id; derived from index ("t1", "t2"...) if missing
 *   assignedAgent: string — must be in availableWorkerNames; falls back to first available
 *   blockedBy: string[] — IDs of prerequisites; [] = independent
 *   expectedOutput: string — Subtask.expected_output; defaults to null
 *
 * Batches are derived by Kahn's topological sort:
 *   - Subtasks with no deps → batch 1 (run in parallel)
 *   - Subtasks whose deps all live in batch 1 → batch 2
 *   - Cycles throw EntriesToPlanError
 */
export function entriesToPlan(
  entries: PlanEntry[],
  args: {
    originatorIntent: string;
    availableWorkerNames: string[];
    logger: Logger;
  },
): Plan {
  if (entries.length === 0) {
    throw new EntriesToPlanError('Cannot create plan from empty entries', ['entries array is empty']);
  }

  // Parse metadata from each entry
  const subtaskMetas = entries.map((entry, idx) => {
    const meta = (entry._meta ?? {}) as Record<string, unknown>;
    const subtaskId =
      typeof meta['subtaskId'] === 'string' && meta['subtaskId'] ? meta['subtaskId'] : `t${idx + 1}`;
    let assignedAgent = typeof meta['assignedAgent'] === 'string' ? meta['assignedAgent'] : '';
    const blockedBy: string[] = Array.isArray(meta['blockedBy'])
      ? (meta['blockedBy'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const expectedOutput =
      typeof meta['expectedOutput'] === 'string' ? meta['expectedOutput'] : null;

    if (!assignedAgent || !args.availableWorkerNames.includes(assignedAgent)) {
      if (!assignedAgent) {
        args.logger.warn(
          { entryIndex: idx, subtaskId },
          'entry missing _meta.assignedAgent; falling back to first available worker',
        );
      } else {
        args.logger.warn(
          { entryIndex: idx, subtaskId, assignedAgent },
          'unknown _meta.assignedAgent; falling back to first available worker',
        );
      }
      if (args.availableWorkerNames.length === 0) {
        throw new EntriesToPlanError('Cannot assign subtask: no available workers', [
          `subtask ${subtaskId} needs an agent but availableWorkerNames is empty`,
        ]);
      }
      assignedAgent = args.availableWorkerNames[0];
    }

    return { subtaskId, assignedAgent, blockedBy, content: entry.content, expectedOutput };
  });

  // Deduplicate subtask IDs (defensive; planner should provide unique IDs)
  const idSet = new Set<string>();
  for (const meta of subtaskMetas) {
    if (idSet.has(meta.subtaskId)) {
      let newId = meta.subtaskId;
      let i = 2;
      while (idSet.has(newId)) newId = `${meta.subtaskId}_${i++}`;
      meta.subtaskId = newId;
    }
    idSet.add(meta.subtaskId);
  }

  // Build dependency graph
  const idToMeta = new Map(subtaskMetas.map((m) => [m.subtaskId, m]));
  const inDegree = new Map<string, number>(subtaskMetas.map((m) => [m.subtaskId, 0]));
  const dependents = new Map<string, string[]>(subtaskMetas.map((m) => [m.subtaskId, []]));

  for (const meta of subtaskMetas) {
    for (const dep of meta.blockedBy) {
      if (!idToMeta.has(dep)) {
        args.logger.warn(
          { subtaskId: meta.subtaskId, dep },
          'blockedBy references unknown subtask; ignoring dependency',
        );
        continue;
      }
      inDegree.set(meta.subtaskId, (inDegree.get(meta.subtaskId) ?? 0) + 1);
      dependents.get(dep)!.push(meta.subtaskId);
    }
  }

  // Kahn's algorithm: build ordered batches
  const batches: Array<{ batch_id: string; subtasks: Subtask[] }> = [];
  const remaining = new Set(subtaskMetas.map((m) => m.subtaskId));

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) ready.push(id);
    }
    if (ready.length === 0) {
      throw new EntriesToPlanError('Cycle detected in subtask dependencies', [
        `Remaining subtasks with unresolvable dependencies: ${[...remaining].join(', ')}`,
      ]);
    }

    for (const id of ready) remaining.delete(id);
    for (const id of ready) {
      for (const dep of dependents.get(id) ?? []) {
        if (remaining.has(dep)) {
          inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
        }
      }
    }

    batches.push({
      batch_id: `b${batches.length + 1}`,
      subtasks: ready.map((id) => {
        const meta = idToMeta.get(id)!;
        return {
          id: meta.subtaskId,
          assigned_agent: meta.assignedAgent,
          description: meta.content,
          inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          expected_output: meta.expectedOutput,
        };
      }),
    });
  }

  return {
    plan_id: randomUUID(),
    originator_intent: args.originatorIntent,
    goal_summary: subtaskMetas[0].content.slice(0, 200),
    source: 'external_planner',
    batches,
  };
}
