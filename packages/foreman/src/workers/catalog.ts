import type { A2AClient, AgentCardMetadata } from '@foreman-stack/shared';
import type { WorkerConfig } from '../config.js';
import { logger as rootLogger } from '../logger.js';

export const PLANNER_SKILL_ID = 'task_decomposition';

export type WorkerStatus = 'available' | 'unreachable';

export interface WorkerCatalogEntry {
  url: string;
  name_hint?: string;
  agent_card: AgentCardMetadata | null;
  status: WorkerStatus;
  last_check_at: Date;
}

export function toToolName(worker: WorkerCatalogEntry): string {
  const raw = worker.agent_card?.name ?? worker.name_hint ?? new URL(worker.url).hostname;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class WorkerCatalog {
  private readonly _entries = new Map<string, WorkerCatalogEntry>();

  constructor(
    private readonly _client: A2AClient,
    private readonly _discoveryTimeoutMs = 10_000,
  ) {}

  async loadFromConfig(workers: WorkerConfig[]): Promise<void> {
    await Promise.all(workers.map((w) => this._probe(w.url, w.name_hint)));
    const available = this.getAvailable().length;
    rootLogger.info(
      { available, unreachable: this._entries.size - available },
      'worker discovery complete',
    );
  }

  /** Recheck only workers currently marked unreachable — call on each user turn. */
  async recheckUnreachable(): Promise<void> {
    const stale = [...this._entries.values()].filter((e) => e.status === 'unreachable');
    await Promise.all(stale.map((e) => this._probe(e.url, e.name_hint)));
  }

  getAvailable(): WorkerCatalogEntry[] {
    return [...this._entries.values()].filter((e) => e.status === 'available');
  }

  getAll(): WorkerCatalogEntry[] {
    return [...this._entries.values()];
  }

  isPlanner(entry: WorkerCatalogEntry): boolean {
    return entry.agent_card?.skills?.some((s) => s.id === PLANNER_SKILL_ID) ?? false;
  }

  private async _probe(url: string, name_hint?: string): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('discovery timeout')),
        this._discoveryTimeoutMs,
      );
    });

    let agent_card: AgentCardMetadata | null = null;
    let status: WorkerStatus = 'unreachable';

    try {
      agent_card = await Promise.race([this._client.fetchAgentCard(url), timeout]);
      status = 'available';
    } catch (err) {
      rootLogger.warn({ url, err: err instanceof Error ? err.message : String(err) }, 'worker unreachable during discovery');
    } finally {
      clearTimeout(timeoutId);
    }

    this._entries.set(url, {
      url,
      name_hint,
      agent_card,
      status,
      last_check_at: new Date(),
    });
  }
}
