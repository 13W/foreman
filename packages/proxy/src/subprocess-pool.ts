import type { ACPClientManager, SessionHandle, SubprocessHandle } from '@foreman-stack/shared';
import type { McpServerSpec } from '@foreman-stack/shared';
import type { ProxyConfig } from './config.js';

export class PoolExhaustedError extends Error {
  constructor(message = 'All task slots are occupied') {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

export interface PooledSession {
  subprocess: SubprocessHandle;
  session: SessionHandle;
  release(): Promise<void>;
}

interface SubprocessEntry {
  handle: SubprocessHandle;
  activeSessions: number;
}

export class SubprocessPool {
  private readonly subprocesses: SubprocessEntry[] = [];
  private isShuttingDown = false;

  constructor(
    private readonly config: ProxyConfig,
    private readonly client: ACPClientManager,
  ) {}

  async acquireSession(cwd: string, mcpServers: McpServerSpec[]): Promise<PooledSession> {
    if (this.isShuttingDown) {
      throw new PoolExhaustedError('Pool is shutting down');
    }

    const maxSubs = this.config.runtime.max_subprocesses;
    const maxSessions = this.config.runtime.max_sessions_per_subprocess;

    let entry: SubprocessEntry;

    if (this.subprocesses.length < maxSubs) {
      // Spread-first: spawn a new subprocess while under the limit
      const handle = await this.client.spawnSubprocess(
        this.config.wrapped_agent.command,
        this.config.wrapped_agent.args,
        this.config.wrapped_agent.env,
      );
      entry = { handle, activeSessions: 0 };
      this.subprocesses.push(entry);
    } else {
      // Find least-loaded subprocess with a free slot (tie-break: first by creation order)
      const available = this.subprocesses.filter((e) => e.activeSessions < maxSessions);
      if (available.length === 0) {
        throw new PoolExhaustedError('All task slots are occupied');
      }
      entry = available.reduce((min, e) => (e.activeSessions < min.activeSessions ? e : min));
    }

    const session = await this.client.createSession(entry.handle, cwd, mcpServers);
    entry.activeSessions++;

    const pool = this;
    return {
      subprocess: entry.handle,
      session,
      async release(): Promise<void> {
        entry.activeSessions--;
        if (entry.activeSessions === 0) {
          const idx = pool.subprocesses.indexOf(entry);
          if (idx !== -1) pool.subprocesses.splice(idx, 1);
          await entry.handle.dispose();
        }
      },
    };
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const entries = this.subprocesses.splice(0);
    await Promise.all(entries.map((e) => e.handle.dispose()));
  }
}
