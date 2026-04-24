import { describe, expect, it } from 'vitest';
import { TaskPayload, TaskResult } from './task.js';

describe('TaskPayload', () => {
  const validPayload = {
    description: 'Implement login feature',
    originator_intent: 'Build a login page',
    max_delegation_depth: 3,
  };

  it('parses a minimal valid payload', () => {
    const result = TaskPayload.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('parses a full valid payload', () => {
    const result = TaskPayload.safeParse({
      description: 'Implement login feature',
      expected_output: 'A working login form with JWT auth',
      inputs: {
        relevant_files: ['src/auth.ts', 'src/login.tsx'],
        constraints: ['Use existing JWT library', 'No new dependencies'],
        context_from_prior_tasks: [
          { task_id: 'task-001', summary: 'Database schema created' },
        ],
      },
      originator_intent: 'Build a login page',
      max_delegation_depth: 2,
      parent_task_id: 'parent-123',
      base_branch: 'main',
      timeout_sec: 300,
      injected_mcps: [
        {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults optional fields correctly', () => {
    const result = TaskPayload.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expected_output).toBeNull();
      expect(result.data.inputs.relevant_files).toEqual([]);
      expect(result.data.inputs.constraints).toEqual([]);
      expect(result.data.inputs.context_from_prior_tasks).toEqual([]);
      expect(result.data.parent_task_id).toBeNull();
      expect(result.data.base_branch).toBeNull();
      expect(result.data.timeout_sec).toBeNull();
      expect(result.data.injected_mcps).toEqual([]);
    }
  });

  it('rejects missing description', () => {
    const result = TaskPayload.safeParse({
      originator_intent: 'Build a login page',
      max_delegation_depth: 3,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing originator_intent', () => {
    const result = TaskPayload.safeParse({
      description: 'Implement login feature',
      max_delegation_depth: 3,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing max_delegation_depth', () => {
    const result = TaskPayload.safeParse({
      description: 'Implement login feature',
      originator_intent: 'Build a login page',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative max_delegation_depth', () => {
    const result = TaskPayload.safeParse({
      ...validPayload,
      max_delegation_depth: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = TaskPayload.safeParse({
      ...validPayload,
      unknownField: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty injected_mcps array', () => {
    const result = TaskPayload.safeParse({
      ...validPayload,
      injected_mcps: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('TaskResult', () => {
  const validResult = {
    status: 'completed',
    stop_reason: 'end_turn',
    summary: 'Successfully implemented the login feature',
    branch_ref: 'foreman/task-abc123',
    session_transcript_ref: '/workspace/.foreman-transcript.jsonl',
    error: null,
  };

  it('parses a valid completed result', () => {
    const result = TaskResult.safeParse(validResult);
    expect(result.success).toBe(true);
  });

  it('parses a failed result with error', () => {
    const result = TaskResult.safeParse({
      status: 'failed',
      stop_reason: 'subprocess_crash',
      summary: 'Task failed due to crash',
      branch_ref: 'foreman/task-abc123',
      session_transcript_ref: '/workspace/.foreman-transcript.jsonl',
      error: { code: 'mcp_name_collision', message: 'MCP name collision detected' },
    });
    expect(result.success).toBe(true);
  });

  it('parses a cancelled result', () => {
    const result = TaskResult.safeParse({
      ...validResult,
      status: 'cancelled',
      stop_reason: 'cancelled',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = TaskResult.safeParse({
      ...validResult,
      status: 'pending',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid stop_reason', () => {
    const result = TaskResult.safeParse({
      ...validResult,
      stop_reason: 'unknown_reason',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = TaskResult.safeParse({
      ...validResult,
      unknownField: 'should fail',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing summary', () => {
    const { summary: _, ...withoutSummary } = validResult;
    const result = TaskResult.safeParse(withoutSummary);
    expect(result.success).toBe(false);
  });

  it('accepts null stop_reason for pre-flight failures', () => {
    const result = TaskResult.safeParse({
      status: 'failed',
      stop_reason: null,
      summary: '',
      branch_ref: '',
      session_transcript_ref: '',
      error: { code: 'base_branch_not_found', message: 'Branch not found' },
    });
    expect(result.success).toBe(true);
  });
});
