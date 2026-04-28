import { describe, it, expect, vi } from 'vitest';
import type { PlanEntry } from '@agentclientprotocol/sdk';
import { entriesToPlan, EntriesToPlanError, parseWorkerPrefix } from './entries-to-plan.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const workers = ['worker_a', 'worker_b'];

function makeEntry(
  content: string,
  meta: Record<string, unknown> = {},
): PlanEntry {
  return { content, priority: 'medium', status: 'pending', _meta: meta };
}

describe('entriesToPlan', () => {
  it('single independent entry → 1 batch with 1 subtask', () => {
    const entries = [
      makeEntry('implement feature', { subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'build it', availableWorkerNames: workers, logger });

    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].subtasks).toHaveLength(1);
    expect(plan.batches[0].subtasks[0].id).toBe('t1');
    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(plan.batches[0].subtasks[0].description).toBe('implement feature');
    expect(plan.source).toBe('external_planner');
    expect(plan.originator_intent).toBe('build it');
  });

  it('two independent entries → 1 batch with 2 subtasks (parallel)', () => {
    const entries = [
      makeEntry('task A', { subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] }),
      makeEntry('task B', { subtaskId: 't2', assignedAgent: 'worker_b', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'do both', availableWorkerNames: workers, logger });

    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].subtasks).toHaveLength(2);
    const ids = plan.batches[0].subtasks.map((s) => s.id).sort();
    expect(ids).toEqual(['t1', 't2']);
  });

  it('sequential a → b → 2 batches', () => {
    const entries = [
      makeEntry('step A', { subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] }),
      makeEntry('step B', { subtaskId: 't2', assignedAgent: 'worker_b', blockedBy: ['t1'] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'seq', availableWorkerNames: workers, logger });

    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0].subtasks.map((s) => s.id)).toEqual(['t1']);
    expect(plan.batches[1].subtasks.map((s) => s.id)).toEqual(['t2']);
  });

  it('diamond a → {b, c} → d → 3 batches (b and c parallel in batch 2)', () => {
    const entries = [
      makeEntry('step A', { subtaskId: 'a', assignedAgent: 'worker_a', blockedBy: [] }),
      makeEntry('step B', { subtaskId: 'b', assignedAgent: 'worker_a', blockedBy: ['a'] }),
      makeEntry('step C', { subtaskId: 'c', assignedAgent: 'worker_b', blockedBy: ['a'] }),
      makeEntry('step D', { subtaskId: 'd', assignedAgent: 'worker_b', blockedBy: ['b', 'c'] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'diamond', availableWorkerNames: workers, logger });

    expect(plan.batches).toHaveLength(3);
    expect(plan.batches[0].subtasks.map((s) => s.id)).toEqual(['a']);
    expect(plan.batches[1].subtasks.map((s) => s.id).sort()).toEqual(['b', 'c']);
    expect(plan.batches[2].subtasks.map((s) => s.id)).toEqual(['d']);
  });

  it('cycle a ↔ b → throws EntriesToPlanError', () => {
    const entries = [
      makeEntry('step A', { subtaskId: 'a', assignedAgent: 'worker_a', blockedBy: ['b'] }),
      makeEntry('step B', { subtaskId: 'b', assignedAgent: 'worker_b', blockedBy: ['a'] }),
    ];
    expect(() =>
      entriesToPlan(entries, { originatorIntent: 'cycle', availableWorkerNames: workers, logger }),
    ).toThrow(EntriesToPlanError);
  });

  it('no prefix and no _meta.assignedAgent → falls back to first worker with warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const entries = [
      makeEntry('task without agent', { subtaskId: 't1', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(plan.batches[0].subtasks[0].description).toBe('task without agent');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subtaskId: 't1' }),
      expect.stringContaining('no worker prefix or _meta.assignedAgent'),
    );
  });

  it('unknown _meta.assignedAgent falls back to first worker with warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const entries = [
      makeEntry('task with bad agent', { subtaskId: 't1', assignedAgent: 'nonexistent_worker', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metaWorker: 'nonexistent_worker' }),
      expect.stringContaining('unknown _meta.assignedAgent'),
    );
  });

  it('empty availableWorkerNames with missing agent → throws', () => {
    const entries = [
      makeEntry('task', { subtaskId: 't1', blockedBy: [] }),
    ];
    expect(() =>
      entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: [], logger }),
    ).toThrow(EntriesToPlanError);
  });

  it('throws on empty entries array', () => {
    expect(() =>
      entriesToPlan([], { originatorIntent: 'test', availableWorkerNames: workers, logger }),
    ).toThrow(EntriesToPlanError);
  });

  it('goal_summary is first entry content truncated to 200 chars', () => {
    const longContent = 'x'.repeat(300);
    const entries = [
      makeEntry(longContent, { subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });
    expect(plan.goal_summary).toHaveLength(200);
  });

  it('IDs derived from index when subtaskId not in _meta', () => {
    const entries = [
      makeEntry('task one', { assignedAgent: 'worker_a', blockedBy: [] }),
      makeEntry('task two', { assignedAgent: 'worker_b', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });
    const ids = plan.batches[0].subtasks.map((s) => s.id).sort();
    expect(ids).toEqual(['t1', 't2']);
  });
});

describe('parseWorkerPrefix', () => {
  it('parses valid prefix and strips it from description', () => {
    const result = parseWorkerPrefix('[worker_a] do something');
    expect(result.worker).toBe('worker_a');
    expect(result.description).toBe('do something');
  });

  it('returns null worker and original content when no prefix', () => {
    const result = parseWorkerPrefix('do something');
    expect(result.worker).toBeNull();
    expect(result.description).toBe('do something');
  });

  it('handles whitespace before bracket', () => {
    const result = parseWorkerPrefix('  [worker_a]  do X  ');
    expect(result.worker).toBe('worker_a');
    expect(result.description).toBe('do X');
  });

  it('handles no space between bracket and description', () => {
    const result = parseWorkerPrefix('[worker_a]do Y');
    expect(result.worker).toBe('worker_a');
    expect(result.description).toBe('do Y');
  });

  it('parses worker name with hyphen and digits', () => {
    const result = parseWorkerPrefix('[worker-2_v1] do Q');
    expect(result.worker).toBe('worker-2_v1');
    expect(result.description).toBe('do Q');
  });

  it('only consumes first bracket group; second stays in description', () => {
    const result = parseWorkerPrefix('[worker_a] [important] fix the bug');
    expect(result.worker).toBe('worker_a');
    expect(result.description).toBe('[important] fix the bug');
  });

  it('returns null for bracket that starts with digit', () => {
    const result = parseWorkerPrefix('[2worker] task');
    expect(result.worker).toBeNull();
    expect(result.description).toBe('[2worker] task');
  });

  it('returns null and original when content is only a bracket pair', () => {
    const result = parseWorkerPrefix('[worker_a]');
    expect(result.worker).toBe('worker_a');
    expect(result.description).toBe('');
  });
});

describe('entriesToPlan prefix routing', () => {
  it('prefix correctly parsed, stripped from description, used as assignedAgent', () => {
    const entries = [
      makeEntry('[worker_a] do something', { subtaskId: 't1', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(plan.batches[0].subtasks[0].description).toBe('do something');
  });

  it('prefix wins over _meta.assignedAgent when both present', () => {
    const entries = [
      makeEntry('[worker_a] do X', { subtaskId: 't1', assignedAgent: 'worker_b', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(plan.batches[0].subtasks[0].description).toBe('do X');
  });

  it('unknown prefix worker falls back to first available with warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const entries = [
      makeEntry('[mystery_agent] do Y', { subtaskId: 't1', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prefixWorker: 'mystery_agent' }),
      expect.stringContaining('unknown worker prefix'),
    );
  });

  it('no prefix with valid _meta.assignedAgent uses _meta', () => {
    const entries = [
      makeEntry('do Z', { subtaskId: 't1', assignedAgent: 'worker_b', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_b');
    expect(plan.batches[0].subtasks[0].description).toBe('do Z');
  });

  it('no prefix and no _meta → fallback to first worker', () => {
    const entries = [
      makeEntry('do W', { subtaskId: 't1', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: workers, logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker_a');
    expect(plan.batches[0].subtasks[0].description).toBe('do W');
  });

  it('worker name with hyphen and digits parses correctly', () => {
    const entries = [
      makeEntry('[worker-2_v1] do Q', { subtaskId: 't1', blockedBy: [] }),
    ];
    const plan = entriesToPlan(entries, { originatorIntent: 'test', availableWorkerNames: ['worker-2_v1'], logger });

    expect(plan.batches[0].subtasks[0].assigned_agent).toBe('worker-2_v1');
    expect(plan.batches[0].subtasks[0].description).toBe('do Q');
  });
});
