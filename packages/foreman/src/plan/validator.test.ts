import { describe, expect, it } from 'vitest';
import type { Plan } from '@foreman-stack/shared';
import type { WorkerCatalog, WorkerCatalogEntry } from '../workers/catalog.js';
import { toToolName } from '../workers/catalog.js';
import { PlanValidationError, validatePlan } from './validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(name: string, url?: string): WorkerCatalogEntry {
  const resolvedUrl = url ?? `http://${name}.test`;
  return {
    url: resolvedUrl,
    agent_card: {
      name,
      url: resolvedUrl,
      version: '1.0',
      description: '',
    },
    status: 'available',
    last_check_at: new Date(),
  };
}

function makeCatalog(names: string[]): WorkerCatalog {
  const entries = names.map((n) => makeEntry(n));
  return {
    getAvailable: () => entries,
    getAll: () => entries,
    isPlanner: () => false,
    loadFromConfig: async () => {},
    recheckUnreachable: async () => {},
  } as unknown as WorkerCatalog;
}

function makePlan(batches: Array<{ batchId: string; subtasks: Array<{ id: string; agent: string }> }>): Plan {
  return {
    plan_id: 'plan-1',
    originator_intent: 'test intent',
    goal_summary: 'test goal',
    source: 'self_planned',
    batches: batches.map(({ batchId, subtasks }) => ({
      batch_id: batchId,
      subtasks: subtasks.map(({ id, agent }) => ({
        id,
        assigned_agent: agent,
        description: `Task ${id}`,
        expected_output: null,
        inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validatePlan', () => {
  it('passes when all assigned_agents resolve to catalog workers (by tool name)', () => {
    const catalog = makeCatalog(['my-worker']);
    const toolName = toToolName(makeEntry('my-worker'));
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: toolName }] }]);

    expect(() => validatePlan(plan, catalog)).not.toThrow();
    expect(validatePlan(plan, catalog)).toBe(plan);
  });

  it('passes when assigned_agent matches agent_card.name directly', () => {
    const catalog = makeCatalog(['My Worker']);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'My Worker' }] }]);

    expect(() => validatePlan(plan, catalog)).not.toThrow();
  });

  it('passes when assigned_agent matches worker url', () => {
    const catalog = makeCatalog(['worker']);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'http://worker.test' }] }]);

    expect(() => validatePlan(plan, catalog)).not.toThrow();
  });

  it('throws PlanValidationError when assigned_agent is unknown', () => {
    const catalog = makeCatalog(['known-worker']);
    const plan = makePlan([{ batchId: 'b1', subtasks: [{ id: 's1', agent: 'unknown-agent' }] }]);

    expect(() => validatePlan(plan, catalog)).toThrow(PlanValidationError);
    try {
      validatePlan(plan, catalog);
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      const e = err as PlanValidationError;
      expect(e.issues).toHaveLength(1);
      expect(e.issues[0]).toContain('unknown-agent');
      expect(e.issues[0]).toContain('s1');
    }
  });

  it('throws with all issues when multiple subtasks reference unknown agents', () => {
    const catalog = makeCatalog(['real-worker']);
    const plan = makePlan([
      {
        batchId: 'b1',
        subtasks: [
          { id: 's1', agent: 'ghost-a' },
          { id: 's2', agent: 'ghost-b' },
          { id: 's3', agent: toToolName(makeEntry('real-worker')) },
        ],
      },
    ]);

    try {
      validatePlan(plan, catalog);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      const e = err as PlanValidationError;
      expect(e.issues).toHaveLength(2);
      expect(e.issues.some((i) => i.includes('ghost-a'))).toBe(true);
      expect(e.issues.some((i) => i.includes('ghost-b'))).toBe(true);
    }
  });

  it('throws when subtask ids are duplicated across batches', () => {
    const catalog = makeCatalog(['worker']);
    const toolName = toToolName(makeEntry('worker'));
    const plan = makePlan([
      { batchId: 'b1', subtasks: [{ id: 'dup-id', agent: toolName }] },
      { batchId: 'b2', subtasks: [{ id: 'dup-id', agent: toolName }] },
    ]);

    try {
      validatePlan(plan, catalog);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      const e = err as PlanValidationError;
      expect(e.issues.some((i) => i.includes('dup-id'))).toBe(true);
    }
  });

  it('collects all issues (unknown agent + duplicate id) before throwing', () => {
    const catalog = makeCatalog(['known']);
    const toolName = toToolName(makeEntry('known'));
    const plan = makePlan([
      {
        batchId: 'b1',
        subtasks: [
          { id: 'dup', agent: toolName },
          { id: 'dup', agent: 'unknown-agent' }, // duplicate id AND unknown agent
        ],
      },
    ]);

    try {
      validatePlan(plan, catalog);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      const e = err as PlanValidationError;
      // Should see both the duplicate-id issue and the unknown-agent issue
      expect(e.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
