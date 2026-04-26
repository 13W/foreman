import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerCatalog, PLANNER_SKILL_ID } from './catalog.js';
import type { A2AClient, AgentCardMetadata, AgentSkill } from '@foreman-stack/shared';

// ---------------------------------------------------------------------------
// Mock A2AClient
// ---------------------------------------------------------------------------

const mockFetchAgentCard = vi.fn<(url: string) => Promise<AgentCardMetadata>>();

const mockClient: A2AClient = {
  fetchAgentCard: mockFetchAgentCard,
  dispatchTask: vi.fn(),
  streamTask: vi.fn(),
  pollTask: vi.fn(),
  cancelTask: vi.fn(),
  respondToPermission: vi.fn(),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCard(name: string, skills: Array<{ id: string }> = []): AgentCardMetadata {
  return { name, url: `http://${name}.local`, version: '1.0.0', skills: skills as AgentSkill[] };
}

const WORKER_A = 'http://worker-a.local';
const WORKER_B = 'http://planner.local';
const WORKER_C = 'http://worker-c.local';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerCatalog', () => {
  let catalog: WorkerCatalog;

  beforeEach(() => {
    vi.clearAllMocks();
    catalog = new WorkerCatalog(mockClient, 100); // short timeout for tests
  });

  describe('loadFromConfig', () => {
    it('marks reachable workers as available with their agent card', async () => {
      mockFetchAgentCard
        .mockResolvedValueOnce(makeCard('worker-a'))
        .mockResolvedValueOnce(makeCard('planner', [{ id: PLANNER_SKILL_ID }]));

      await catalog.loadFromConfig([{ url: WORKER_A }, { url: WORKER_B }]);

      const all = catalog.getAll();
      expect(all).toHaveLength(2);

      const a = all.find((e) => e.url === WORKER_A)!;
      expect(a.status).toBe('available');
      expect(a.agent_card?.name).toBe('worker-a');

      const b = all.find((e) => e.url === WORKER_B)!;
      expect(b.status).toBe('available');
    });

    it('marks unreachable workers with status unreachable and null agent_card', async () => {
      mockFetchAgentCard
        .mockResolvedValueOnce(makeCard('worker-a'))
        .mockRejectedValueOnce(new Error('connection refused'));

      await catalog.loadFromConfig([{ url: WORKER_A }, { url: WORKER_C }]);

      const c = catalog.getAll().find((e) => e.url === WORKER_C)!;
      expect(c.status).toBe('unreachable');
      expect(c.agent_card).toBeNull();
    });

    it('handles a mix: some reachable, some unreachable', async () => {
      mockFetchAgentCard
        .mockResolvedValueOnce(makeCard('worker-a'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(makeCard('planner', [{ id: PLANNER_SKILL_ID }]));

      await catalog.loadFromConfig([
        { url: WORKER_A },
        { url: WORKER_C },
        { url: WORKER_B },
      ]);

      expect(catalog.getAvailable()).toHaveLength(2);
      expect(catalog.getAll().find((e) => e.url === WORKER_C)?.status).toBe('unreachable');
    });

    it('stores name_hint from config', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(makeCard('worker-a'));

      await catalog.loadFromConfig([{ url: WORKER_A, name_hint: 'refactorer' }]);

      expect(catalog.getAll()[0].name_hint).toBe('refactorer');
    });

    it('records last_check_at timestamp', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(makeCard('worker-a'));
      const before = new Date();
      await catalog.loadFromConfig([{ url: WORKER_A }]);
      const after = new Date();

      const entry = catalog.getAll()[0];
      expect(entry.last_check_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(entry.last_check_at.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('recheckUnreachable', () => {
    it('re-probes unreachable workers and reanimates those that came back online', async () => {
      // Initial load: worker-c unreachable
      mockFetchAgentCard
        .mockResolvedValueOnce(makeCard('worker-a'))
        .mockRejectedValueOnce(new Error('down'));

      await catalog.loadFromConfig([{ url: WORKER_A }, { url: WORKER_C }]);
      expect(catalog.getAvailable()).toHaveLength(1);

      // worker-c comes back
      mockFetchAgentCard.mockResolvedValueOnce(makeCard('worker-c'));

      await catalog.recheckUnreachable();

      expect(catalog.getAvailable()).toHaveLength(2);
      expect(catalog.getAll().find((e) => e.url === WORKER_C)?.status).toBe('available');
    });

    it('does not re-probe workers that are already available', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(makeCard('worker-a'));

      await catalog.loadFromConfig([{ url: WORKER_A }]);

      vi.clearAllMocks();
      await catalog.recheckUnreachable();

      expect(mockFetchAgentCard).not.toHaveBeenCalled();
    });

    it('keeps worker unreachable if it is still down during recheck', async () => {
      mockFetchAgentCard.mockRejectedValueOnce(new Error('down'));
      await catalog.loadFromConfig([{ url: WORKER_C }]);

      mockFetchAgentCard.mockRejectedValueOnce(new Error('still down'));
      await catalog.recheckUnreachable();

      expect(catalog.getAll()[0].status).toBe('unreachable');
    });
  });

  describe('getAvailable', () => {
    it('returns only available workers', async () => {
      mockFetchAgentCard
        .mockResolvedValueOnce(makeCard('worker-a'))
        .mockRejectedValueOnce(new Error('down'));

      await catalog.loadFromConfig([{ url: WORKER_A }, { url: WORKER_C }]);

      const available = catalog.getAvailable();
      expect(available).toHaveLength(1);
      expect(available[0].url).toBe(WORKER_A);
    });

    it('returns empty array when all workers are unreachable', async () => {
      mockFetchAgentCard.mockRejectedValue(new Error('all down'));
      await catalog.loadFromConfig([{ url: WORKER_A }, { url: WORKER_C }]);

      expect(catalog.getAvailable()).toHaveLength(0);
    });
  });

  describe('isPlanner', () => {
    it('returns true for a worker with task_decomposition skill', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(
        makeCard('planner', [{ id: PLANNER_SKILL_ID }]),
      );
      await catalog.loadFromConfig([{ url: WORKER_B }]);

      const entry = catalog.getAll()[0];
      expect(catalog.isPlanner(entry)).toBe(true);
    });

    it('returns false for a worker without task_decomposition skill', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(makeCard('worker-a', [{ id: 'refactor' }]));
      await catalog.loadFromConfig([{ url: WORKER_A }]);

      const entry = catalog.getAll()[0];
      expect(catalog.isPlanner(entry)).toBe(false);
    });

    it('returns false for a worker with no skills', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(makeCard('worker-a'));
      await catalog.loadFromConfig([{ url: WORKER_A }]);

      expect(catalog.isPlanner(catalog.getAll()[0])).toBe(false);
    });

    it('returns false for an unreachable worker (null agent_card)', async () => {
      mockFetchAgentCard.mockRejectedValueOnce(new Error('down'));
      await catalog.loadFromConfig([{ url: WORKER_C }]);

      const entry = catalog.getAll()[0];
      expect(catalog.isPlanner(entry)).toBe(false);
    });

    it('requires exact skill id match — partial match does not count', async () => {
      mockFetchAgentCard.mockResolvedValueOnce(
        makeCard('worker-a', [{ id: 'task_decomposition_v2' }]),
      );
      await catalog.loadFromConfig([{ url: WORKER_A }]);

      expect(catalog.isPlanner(catalog.getAll()[0])).toBe(false);
    });
  });
});
