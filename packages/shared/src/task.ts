import { z } from 'zod';
import { McpServerSpec } from './mcp.js';

const ContextFromPriorTask = z
  .object({
    task_id: z.string(),
    summary: z.string(),
  })
  .strict();

const TaskInputs = z
  .object({
    relevant_files: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    context_from_prior_tasks: z.array(ContextFromPriorTask).default([]),
  })
  .strict();

export const TaskPayload = z
  .object({
    description: z.string(),
    expected_output: z.string().nullable().default(null),
    inputs: TaskInputs.default({
      relevant_files: [],
      constraints: [],
      context_from_prior_tasks: [],
    }),
    originator_intent: z.string(),
    max_delegation_depth: z.number().int().nonnegative(),
    parent_task_id: z.string().nullable().default(null),
    base_branch: z.string().nullable().default(null),
    timeout_sec: z.number().int().positive().nullable().default(null),
    injected_mcps: z.array(McpServerSpec).default([]),
  })
  .strict();

export type TaskPayload = z.infer<typeof TaskPayload>;

export const TaskResult = z
  .object({
    status: z.enum(['completed', 'failed', 'cancelled']),
    stop_reason: z.enum([
      'end_turn',
      'max_tokens',
      'refusal',
      'cancelled',
      'timeout',
      'subprocess_crash',
    ]),
    summary: z.string(),
    branch_ref: z.string(),
    session_transcript_ref: z.string(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

export type TaskResult = z.infer<typeof TaskResult>;
