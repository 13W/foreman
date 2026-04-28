import { describe, it, expect } from 'vitest';
import type { Plan } from '@foreman-stack/shared';
import { formatPlanStateForPlanner } from './state-formatter.js';
import type { ExecutionStateSnapshot } from './state-formatter.js';

const PLAN: Plan = {
  plan_id: 'p1',
  originator_intent: 'build the feature',
  goal_summary: 'Implement and test the new feature',
  source: 'external_planner',
  batches: [
    {
      batch_id: 'b1',
      subtasks: [
        {
          id: 't1',
          assigned_agent: 'worker_a',
          description: 'write the implementation',
          inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          expected_output: null,
        },
        {
          id: 't2',
          assigned_agent: 'worker_b',
          description: 'write unit tests',
          inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          expected_output: null,
        },
      ],
    },
    {
      batch_id: 'b2',
      subtasks: [
        {
          id: 't3',
          assigned_agent: 'worker_a',
          description: 'run integration tests',
          inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          expected_output: null,
        },
      ],
    },
  ],
};

function emptyState(): ExecutionStateSnapshot {
  return {
    completed: new Map(),
    inProgress: new Map(),
    failed: new Map(),
  };
}

describe('formatPlanStateForPlanner', () => {
  it('empty state → shows goal and pending count', () => {
    const output = formatPlanStateForPlanner(PLAN, emptyState());
    expect(output).toContain('[FOREMAN STATE]');
    expect(output).toContain('Plan goal: Implement and test the new feature');
    expect(output).toContain('Pending: 3 more subtasks');
    expect(output).not.toContain('Completed:');
    expect(output).not.toContain('In progress:');
    expect(output).not.toContain('Failed:');
  });

  it('mixed state → renders all categories', () => {
    const state: ExecutionStateSnapshot = {
      completed: new Map([['t1', { resultSummary: 'implementation done' }]]),
      inProgress: new Map([['t2', { workerName: 'worker_b' }]]),
      failed: new Map([['t3', { errorMessage: 'test runner crashed' }]]),
    };

    const output = formatPlanStateForPlanner(PLAN, state);
    expect(output).toContain('Completed:');
    expect(output).toContain('t1');
    expect(output).toContain('implementation done');
    expect(output).toContain('In progress:');
    expect(output).toContain('t2');
    expect(output).toContain('worker_b');
    expect(output).toContain('Failed:');
    expect(output).toContain('t3');
    expect(output).toContain('test runner crashed');
    // All subtasks accounted for — no pending
    expect(output).not.toContain('Pending:');
  });

  it('with focus → focused subtask rendered in full (not truncated)', () => {
    const longDesc = 'a'.repeat(200);
    const longResult = 'r'.repeat(200);
    const focusPlan: Plan = {
      ...PLAN,
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 'fx',
              assigned_agent: 'worker_a',
              description: longDesc,
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
              expected_output: null,
            },
          ],
        },
      ],
    };
    const state: ExecutionStateSnapshot = {
      completed: new Map([['fx', { resultSummary: longResult }]]),
      inProgress: new Map(),
      failed: new Map(),
    };

    const output = formatPlanStateForPlanner(focusPlan, state, { subtaskId: 'fx' });
    // Full desc and result should appear (not truncated)
    expect(output).toContain(longDesc);
    expect(output).toContain(longResult);
  });

  it('without focus → descriptions and summaries are truncated', () => {
    const longDesc = 'a'.repeat(200);
    const longResult = 'r'.repeat(200);
    const focusPlan: Plan = {
      ...PLAN,
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 'fx',
              assigned_agent: 'worker_a',
              description: longDesc,
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
              expected_output: null,
            },
          ],
        },
      ],
    };
    const state: ExecutionStateSnapshot = {
      completed: new Map([['fx', { resultSummary: longResult }]]),
      inProgress: new Map(),
      failed: new Map(),
    };

    const output = formatPlanStateForPlanner(focusPlan, state);
    // Should NOT contain the full 200-char strings (truncated to 60 and 80)
    expect(output).not.toContain(longDesc);
    expect(output).not.toContain(longResult);
  });

  it('very long plan → output bounded at ~1500 chars', () => {
    const manyBatches: Plan['batches'] = Array.from({ length: 30 }, (_, i) => ({
      batch_id: `b${i + 1}`,
      subtasks: [
        {
          id: `t${i + 1}`,
          assigned_agent: 'worker_a',
          description: `subtask ${i + 1} with a fairly long description text here`,
          inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          expected_output: null,
        },
      ],
    }));
    const bigPlan: Plan = { ...PLAN, batches: manyBatches };
    const state: ExecutionStateSnapshot = {
      completed: new Map(
        Array.from({ length: 15 }, (_, i) => [`t${i + 1}`, { resultSummary: `result of subtask ${i + 1}` }]),
      ),
      inProgress: new Map(),
      failed: new Map(),
    };

    const output = formatPlanStateForPlanner(bigPlan, state);
    expect(output.length).toBeLessThanOrEqual(1503); // 1500 + possible "..."
  });
});
