import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlannerFallbackHandler } from './fallback.js';
import type { ACPAgentServer } from '@foreman-stack/shared';
import type { WorkerCatalog, WorkerCatalogEntry } from '../workers/catalog.js';
import pino from 'pino';

describe('PlannerFallbackHandler', () => {
  let acpServer: ACPAgentServer;
  let catalog: WorkerCatalog;
  let handler: PlannerFallbackHandler;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    acpServer = {
      requestPermission: vi.fn(),
    } as unknown as ACPAgentServer;

    catalog = {
      getAvailable: vi.fn().mockReturnValue([]),
    } as unknown as WorkerCatalog;

    handler = new PlannerFallbackHandler({ acpServer, catalog, logger });
  });

  it('returns self_plan when user selects it', async () => {
    vi.mocked(acpServer.requestPermission).mockResolvedValue({
      optionId: 'self_plan',
      kind: 'allow_once',
      name: 'Self Plan',
    });

    const result = await handler.ask('session-1', 'do something');
    expect(result).toEqual({ kind: 'self_plan' });
    expect(acpServer.requestPermission).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'choice' }),
      expect.arrayContaining([expect.objectContaining({ optionId: 'self_plan' })]),
    );
  });

  it('returns cancel when user selects cancel', async () => {
    vi.mocked(acpServer.requestPermission).mockResolvedValue({
      optionId: 'cancel',
      kind: 'reject_once',
      name: 'Cancel',
    });

    const result = await handler.ask('session-1', 'do something');
    expect(result).toEqual({ kind: 'cancel' });
  });

  it('returns cancel when request is cancelled', async () => {
    vi.mocked(acpServer.requestPermission).mockResolvedValue({
      optionId: 'reject_once',
      kind: 'reject_once',
      name: 'Reject',
    });

    const result = await handler.ask('session-1', 'do something');
    expect(result).toEqual({ kind: 'cancel' });
  });

  describe('delegate', () => {
    it('returns delegate with chosen worker info', async () => {
      const worker: WorkerCatalogEntry = {
        url: 'http://worker-1',
        name_hint: 'coder',
        agent_card: { name: 'Coder Agent', url: 'http://worker-1', version: '1.0.0', skills: [] },
        status: 'available',
        last_check_at: new Date(),
      };
      vi.mocked(catalog.getAvailable).mockReturnValue([worker]);

      vi.mocked(acpServer.requestPermission)
        .mockResolvedValueOnce({ optionId: 'delegate', kind: 'allow_once', name: '' })
        .mockResolvedValueOnce({ optionId: 'http://worker-1', kind: 'allow_once', name: '' });

      const result = await handler.ask('session-1', 'do something');
      expect(result).toEqual({
        kind: 'delegate',
        workerUrl: 'http://worker-1',
        workerName: 'Coder Agent',
      });
      expect(acpServer.requestPermission).toHaveBeenCalledTimes(2);
    });

    it('returns cancel if no workers available for delegation', async () => {
      vi.mocked(catalog.getAvailable).mockReturnValue([]);
      vi.mocked(acpServer.requestPermission).mockResolvedValue({
        optionId: 'delegate',
        kind: 'allow_once',
        name: '',
      });

      const result = await handler.ask('session-1', 'do something');
      expect(result).toEqual({ kind: 'cancel' });
    });

    it('returns cancel if user cancels in second prompt', async () => {
      const worker: WorkerCatalogEntry = {
        url: 'http://worker-1',
        name_hint: 'coder',
        agent_card: null,
        status: 'available',
        last_check_at: new Date(),
      };
      vi.mocked(catalog.getAvailable).mockReturnValue([worker]);

      vi.mocked(acpServer.requestPermission)
        .mockResolvedValueOnce({ optionId: 'delegate', kind: 'allow_once', name: '' })
        .mockResolvedValueOnce({ optionId: '__cancel__', kind: 'reject_once', name: '' });

      const result = await handler.ask('session-1', 'do something');
      expect(result).toEqual({ kind: 'cancel' });
    });
  });

  describe('dispatch_whole', () => {
    it('returns dispatch_whole with synthetic plan', async () => {
      const worker: WorkerCatalogEntry = {
        url: 'http://worker-1',
        name_hint: 'coder',
        agent_card: { name: 'Coder', url: 'http://worker-1', version: '1.0.0', skills: [] },
        status: 'available',
        last_check_at: new Date(),
      };
      vi.mocked(catalog.getAvailable).mockReturnValue([worker]);

      vi.mocked(acpServer.requestPermission).mockResolvedValue({
        optionId: 'dispatch_whole',
        kind: 'allow_once',
        name: '',
      });

      const result = await handler.ask('session-1', 'original task');
      expect(result.kind).toBe('dispatch_whole');
      if (result.kind === 'dispatch_whole') {
        expect(result.plan.originator_intent).toBe('original task');
        expect(result.plan.batches[0].subtasks[0].assigned_agent).toBe('coder');
        expect(result.plan.batches[0].subtasks[0].description).toBe('original task');
      }
    });

    it('returns cancel if no workers available for dispatch_whole', async () => {
      vi.mocked(catalog.getAvailable).mockReturnValue([]);
      vi.mocked(acpServer.requestPermission).mockResolvedValue({
        optionId: 'dispatch_whole',
        kind: 'allow_once',
        name: '',
      });

      const result = await handler.ask('session-1', 'do something');
      expect(result).toEqual({ kind: 'cancel' });
    });
  });

  it('does not persist choice between calls', async () => {
    vi.mocked(acpServer.requestPermission)
      .mockResolvedValueOnce({ optionId: 'self_plan', kind: 'allow_once', name: '' })
      .mockResolvedValueOnce({ optionId: 'cancel', kind: 'reject_once', name: '' });

    const res1 = await handler.ask('session-1', 'task 1');
    const res2 = await handler.ask('session-1', 'task 2');

    expect(res1).toEqual({ kind: 'self_plan' });
    expect(res2).toEqual({ kind: 'cancel' });
    expect(acpServer.requestPermission).toHaveBeenCalledTimes(2);
  });
});
