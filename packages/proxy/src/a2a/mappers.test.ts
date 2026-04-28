import { describe, it, expect, vi } from 'vitest';
import {
  buildSystemPrompt,
  mapPromptEventToStreamEvent,
  buildTaskResult,
  buildErrorTaskResult,
  parsePermissionDecision,
  parseTaskPayload,
  mapDecisionToAcpResponse,
  buildSdkAgentCard,
  MissingBaseBranchError,
  InvalidPayloadError,
} from './mappers.js';
import type { TaskPayload } from '@foreman-stack/shared';
import type { ProxyConfig } from '../config.js';

const baseConfig = {
  role: { description: 'Test agent' },
  permissions: { permission_timeout_sec: 300, terminal_whitelist: [] },
} as unknown as ProxyConfig;

const basePayload: TaskPayload = {
  description: 'Do X',
  originator_intent: 'Because Y',
  max_delegation_depth: 1,
  expected_output: null,
  inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
  parent_task_id: null,
  base_branch: null,
  timeout_sec: null,
  injected_mcps: [],
};

// --- buildSystemPrompt ---
describe('buildSystemPrompt', () => {
  it('builds a text block with role and task sections', () => {
    const parts = buildSystemPrompt(baseConfig, basePayload);
    expect(parts).toHaveLength(1);
    const text = (parts[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('=== Role ===');
    expect(text).toContain('Test agent');
    expect(text).toContain('=== Task ===');
    expect(text).toContain('Do X');
  });

  it('omits Expected Output when null', () => {
    const parts = buildSystemPrompt(baseConfig, { ...basePayload, expected_output: null });
    const text = (parts[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Expected Output');
  });

  it('includes Expected Output when present', () => {
    const parts = buildSystemPrompt(baseConfig, { ...basePayload, expected_output: 'A working form' });
    const text = (parts[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('=== Expected Output ===');
    expect(text).toContain('A working form');
  });

  it('omits Relevant Files when empty', () => {
    const parts = buildSystemPrompt(baseConfig, basePayload);
    const text = (parts[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Relevant Files');
  });

  it('includes Relevant Files when non-empty', () => {
    const payload = { ...basePayload, inputs: { ...basePayload.inputs, relevant_files: ['src/foo.ts'] } };
    const text = (buildSystemPrompt(baseConfig, payload)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('=== Relevant Files ===');
    expect(text).toContain('src/foo.ts');
  });
});

// --- mapPromptEventToStreamEvent ---
describe('mapPromptEventToStreamEvent', () => {
  it('maps agent_message_chunk to message event', () => {
    const event = mapPromptEventToStreamEvent({ kind: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } as any });
    expect(event?.type).toBe('message');
  });

  it('maps tool_call_update to status working', () => {
    const event = mapPromptEventToStreamEvent({ kind: 'tool_call_update', update: { toolCallId: 'id', title: 'Read file' } as any });
    expect(event?.type).toBe('status');
    expect((event?.data as any).state).toBe('working');
    expect((event?.data as any).message).toBe('Read file');
  });

  it('maps tool_call to status working', () => {
    const event = mapPromptEventToStreamEvent({ kind: 'tool_call', update: { toolCallId: 'id', title: 'Write file' } as any });
    expect(event?.type).toBe('status');
  });

  it('maps plan event to status with entries carried in data part', () => {
    const entries = [
      { content: 'task 1', priority: 'medium', status: 'pending' },
      { content: 'task 2', priority: 'low', status: 'pending' },
    ];
    const event = mapPromptEventToStreamEvent({ kind: 'plan', entries });
    expect(event?.type).toBe('status');
    const data = event?.data as any;
    expect(data.state).toBe('working');
    const parts = data.message?.parts as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('data');
    expect(parts[0].data.entries).toHaveLength(2);
    expect(parts[0].data.entries[0].content).toBe('task 1');
    expect(parts[0].data.entries[1].content).toBe('task 2');
  });

  it('returns null for stop', () => {
    expect(mapPromptEventToStreamEvent({ kind: 'stop', reason: 'end_turn' })).toBeNull();
  });

  it('returns null for permission_request', () => {
    expect(mapPromptEventToStreamEvent({ kind: 'permission_request', requestId: 'r', request: {} as any, respond: async () => {} })).toBeNull();
  });
});

// --- buildTaskResult ---
describe('buildTaskResult', () => {
  const wt = { worktreePath: '/tmp/wt', branchName: 'foreman/task-1' };

  it('end_turn → completed', () => {
    const r = buildTaskResult('end_turn', wt);
    expect(r.status).toBe('completed');
    expect(r.stop_reason).toBe('end_turn');
    expect(r.branch_ref).toBe('foreman/task-1');
  });

  it('max_tokens → failed', () => {
    expect(buildTaskResult('max_tokens', wt).status).toBe('failed');
  });

  it('refusal → failed', () => {
    expect(buildTaskResult('refusal', wt).status).toBe('failed');
  });

  it('cancelled → cancelled', () => {
    expect(buildTaskResult('cancelled', wt).status).toBe('cancelled');
  });

  it('timeout → failed', () => {
    expect(buildTaskResult('timeout' as any, wt).status).toBe('failed');
  });
});

// --- buildErrorTaskResult ---
describe('buildErrorTaskResult', () => {
  const wt = { worktreePath: '/tmp/wt', branchName: 'foreman/task-1' };

  it('MissingBaseBranchError → failed, null stop_reason, missing_base_branch', () => {
    const r = buildErrorTaskResult(new MissingBaseBranchError(), wt);
    expect(r.status).toBe('failed');
    expect(r.stop_reason).toBeNull();
    expect(r.error?.code).toBe('missing_base_branch');
  });

  it('unknown error → failed, subprocess_crash', () => {
    const r = buildErrorTaskResult(new Error('oops'), wt);
    expect(r.status).toBe('failed');
    expect(r.stop_reason).toBe('subprocess_crash');
    expect(r.error?.code).toBe('internal_error');
  });

  it('works without worktreeResult', () => {
    const r = buildErrorTaskResult(new MissingBaseBranchError());
    expect(r.branch_ref).toBe('');
  });
});

// --- parsePermissionDecision ---
describe('parsePermissionDecision', () => {
  it('parses allow_once from DataPart', () => {
    const msg = { kind: 'message', parts: [{ kind: 'data', data: { kind: 'allow_once' } }], messageId: 'm', role: 'user' } as any;
    const d = parsePermissionDecision(msg);
    expect(d.kind).toBe('allow_once');
  });

  it('parses from TextPart JSON fallback', () => {
    const msg = { kind: 'message', parts: [{ kind: 'text', text: '{"kind":"reject_once"}' }], messageId: 'm', role: 'user' } as any;
    const d = parsePermissionDecision(msg);
    expect(d.kind).toBe('reject_once');
  });

  it('returns reject_once on invalid input', () => {
    const msg = { kind: 'message', parts: [{ kind: 'text', text: 'not json' }], messageId: 'm', role: 'user' } as any;
    const d = parsePermissionDecision(msg);
    expect(d.kind).toBe('reject_once');
  });
});

// --- parseTaskPayload ---
describe('parseTaskPayload', () => {
  it('parses from DataPart', () => {
    const payload = { description: 'D', originator_intent: 'I', max_delegation_depth: 0 };
    const msg = { kind: 'message', parts: [{ kind: 'data', data: payload }], messageId: 'm', role: 'user' } as any;
    const p = parseTaskPayload(msg);
    expect(p.description).toBe('D');
  });

  it('throws InvalidPayloadError on missing required fields', () => {
    const msg = { kind: 'message', parts: [{ kind: 'data', data: { bad: true } }], messageId: 'm', role: 'user' } as any;
    expect(() => parseTaskPayload(msg)).toThrow(InvalidPayloadError);
  });
});

// --- mapDecisionToAcpResponse ---
describe('mapDecisionToAcpResponse', () => {
  const options = [
    { optionId: 'o1', kind: 'allow_once', title: 'Allow once', description: '', name: 'Allow once' },
    { optionId: 'o2', kind: 'reject_once', title: 'Reject once', description: '', name: 'Reject once' },
  ] as any;

  it('cancelled → { outcome: { outcome: cancelled } }', () => {
    const r = mapDecisionToAcpResponse({ kind: 'cancelled' }, options);
    expect(r.outcome).toEqual({ outcome: 'cancelled' });
  });

  it('allow_once → selected with matching optionId', () => {
    const r = mapDecisionToAcpResponse({ kind: 'allow_once' }, options);
    expect(r.outcome).toEqual({ outcome: 'selected', optionId: 'o1' });
  });

  it('falls back to cancelled when no matching option', () => {
    const r = mapDecisionToAcpResponse({ kind: 'allow_always' }, options);
    expect(r.outcome).toEqual({ outcome: 'cancelled' });
  });
});

// --- buildSdkAgentCard ---
describe('buildSdkAgentCard', () => {
  it('fills required SDK fields with defaults', () => {
    const card = buildSdkAgentCard({ name: 'Test', url: 'http://localhost:4000', version: '1.0.0' });
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.skills).toEqual([]);
    expect(card.description).toBe('');
  });
});
