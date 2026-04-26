import pino from 'pino';
import { logger as rootLogger } from '../logger.js';
import { SessionLimitError } from './errors.js';
import { SessionState } from './state.js';

export class SessionManager {
  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxConcurrentSessions: number;
  private readonly _logger: pino.Logger;

  constructor(opts: { maxConcurrentSessions: number; logger?: pino.Logger }) {
    this._maxConcurrentSessions = opts.maxConcurrentSessions;
    this._logger = (opts.logger ?? rootLogger).child({ component: 'session-manager' });
  }

  create(sessionId: string, cwd: string): SessionState {
    if (this._sessions.size >= this._maxConcurrentSessions) {
      throw new SessionLimitError(this._maxConcurrentSessions);
    }
    const state = new SessionState(sessionId, cwd);
    this._sessions.set(sessionId, state);
    this._logger.info({ sessionId }, 'session created');
    return state;
  }

  get(sessionId: string): SessionState | null {
    return this._sessions.get(sessionId) ?? null;
  }

  async close(sessionId: string): Promise<void> {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    this._sessions.delete(sessionId);

    for (const [taskId, handle] of state.activeDispatchHandles) {
      try {
        await handle.cancel();
      } catch (err) {
        this._logger.warn({ sessionId, taskId, err: String(err) }, 'cancel error during session close');
      }
    }

    this._logger.info({ sessionId }, 'session closed');
  }

  size(): number {
    return this._sessions.size;
  }
}
