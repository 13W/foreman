import { describe, expect, it } from 'vitest';
import { Plan } from './plan.js';

describe('Plan', () => {
  const validSubtask = {
    id: 't1',
    assigned_agent: 'refactorer',
    description: 'Refactor auth module',
    inputs: {
      relevant_files: ['src/auth.ts'],
      constraints: ['No breaking changes'],
      context_from_prior_tasks: [],
    },
    expected_output: 'Clean auth module with tests',
  };

  const validPlan = {
    plan_id: '550e8400-e29b-41d4-a716-446655440000',
    originator_intent: 'Refactor the codebase',
    goal_summary: 'Improve code quality',
    source: 'self_planned',
    batches: [
      {
        batch_id: 'b1',
        subtasks: [validSubtask],
      },
    ],
  };

  it('parses a valid plan', () => {
    const result = Plan.safeParse(validPlan);
    expect(result.success).toBe(true);
  });

  it('parses a plan with multiple batches and subtasks', () => {
    const result = Plan.safeParse({
      ...validPlan,
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            validSubtask,
            { ...validSubtask, id: 't2', assigned_agent: 'tester' },
          ],
        },
        {
          batch_id: 'b2',
          subtasks: [{ ...validSubtask, id: 't3', assigned_agent: 'deployer' }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses a plan from external planner', () => {
    const result = Plan.safeParse({
      ...validPlan,
      source: 'external_planner',
    });
    expect(result.success).toBe(true);
  });

  it('parses a single_task_dispatch plan', () => {
    const result = Plan.safeParse({
      ...validPlan,
      source: 'single_task_dispatch',
    });
    expect(result.success).toBe(true);
  });

  it('parses subtask with null expected_output', () => {
    const result = Plan.safeParse({
      ...validPlan,
      batches: [
        {
          batch_id: 'b1',
          subtasks: [{ ...validSubtask, expected_output: null }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses subtask without optional inputs', () => {
    const result = Plan.safeParse({
      ...validPlan,
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 't1',
              assigned_agent: 'refactorer',
              description: 'Do something',
              expected_output: null,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid source', () => {
    const result = Plan.safeParse({
      ...validPlan,
      source: 'unknown_source',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing plan_id', () => {
    const { plan_id: _, ...withoutId } = validPlan;
    const result = Plan.safeParse(withoutId);
    expect(result.success).toBe(false);
  });

  it('rejects empty batches array', () => {
    const result = Plan.safeParse({
      ...validPlan,
      batches: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects batch with empty subtasks', () => {
    const result = Plan.safeParse({
      ...validPlan,
      batches: [{ batch_id: 'b1', subtasks: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = Plan.safeParse({
      ...validPlan,
      unknownField: 'should fail',
    });
    expect(result.success).toBe(false);
  });
});
