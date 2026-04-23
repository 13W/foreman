import { z } from 'zod';

const SubtaskInputs = z
  .object({
    relevant_files: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    context_from_prior_tasks: z
      .array(
        z
          .object({
            task_id: z.string(),
            summary: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const Subtask = z
  .object({
    id: z.string(),
    assigned_agent: z.string(),
    description: z.string(),
    inputs: SubtaskInputs.default({ relevant_files: [], constraints: [], context_from_prior_tasks: [] }),
    expected_output: z.string().nullable().default(null),
  })
  .strict();

export type Subtask = z.infer<typeof Subtask>;

export const Batch = z
  .object({
    batch_id: z.string(),
    subtasks: z.array(Subtask).min(1),
  })
  .strict();

export type Batch = z.infer<typeof Batch>;

export const Plan = z
  .object({
    plan_id: z.string(),
    originator_intent: z.string(),
    goal_summary: z.string(),
    source: z.enum(['external_planner', 'self_planned', 'single_task_dispatch']),
    batches: z.array(Batch).min(1),
  })
  .strict();

export type Plan = z.infer<typeof Plan>;
