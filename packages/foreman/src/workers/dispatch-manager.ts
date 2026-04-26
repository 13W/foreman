import type { A2AClient, StreamEvent, TaskPayload } from '@foreman-stack/shared';
import { logger } from '../logger.js';
import { DispatchHandle } from './task-handle.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISPATCH_MAX_RETRIES = 3;
// Base delays in ms for each retry attempt (spec §9.4.1: 1s / 5s / 15s)
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;
// Max random ±jitter per attempt
const RETRY_JITTER_MS = [200, 1_000, 3_000] as const;

const TERMINAL_STATES = new Set(['completed', 'canceled', 'failed', 'rejected']);

const POLL_INITIAL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_MAX_CONSECUTIVE_FAILURES = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithJitter(attempt: number): Promise<void> {
  const base = RETRY_DELAYS_MS[attempt];
  const jitter = RETRY_JITTER_MS[attempt];
  const ms = base + (Math.random() * 2 - 1) * jitter;
  return sleep(ms);
}

function isTerminalEvent(event: StreamEvent): boolean {
  if (event.type !== 'status') return false;
  const data = event.data as { state?: string; final?: boolean };
  return data.final === true || TERMINAL_STATES.has(data.state ?? '');
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private _count: number;
  private readonly _queue: Array<() => void> = [];

  constructor(max: number) {
    this._count = max;
  }

  acquire(): Promise<void> {
    if (this._count > 0) {
      this._count--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._count++;
    }
  }
}

// ---------------------------------------------------------------------------
// Event stream generator
// ---------------------------------------------------------------------------

async function* makeEventStream(
  taskId: string,
  client: A2AClient,
  release: () => void,
): AsyncGenerator<StreamEvent> {
  try {
    // Primary: SSE streaming
    try {
      for await (const event of client.streamTask(taskId)) {
        yield event;
        if (isTerminalEvent(event)) return;
      }
      return;
    } catch (streamErr) {
      logger.debug({ taskId, err: String(streamErr) }, 'stream failed, falling back to polling');
    }

    // Fallback: polling via tasks/get with exponential backoff
    let intervalMs = POLL_INITIAL_INTERVAL_MS;
    let consecutiveFailures = 0;

    while (true) {
      try {
        const event = await client.pollTask(taskId);
        consecutiveFailures = 0;
        yield event;
        if (isTerminalEvent(event)) return;
      } catch (pollErr) {
        consecutiveFailures++;
        logger.debug(
          { taskId, consecutiveFailures, err: String(pollErr) },
          'poll attempt failed',
        );
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          yield {
            type: 'error',
            taskId,
            data: { reason: 'connection_lost' },
            timestamp: new Date().toISOString(),
          };
          return;
        }
      }
      await sleep(intervalMs);
      intervalMs = Math.min(intervalMs * 2, POLL_MAX_INTERVAL_MS);
    }
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// DispatchManager
// ---------------------------------------------------------------------------

export class DispatchManager {
  private readonly _semaphore: Semaphore;

  constructor(
    private readonly _client: A2AClient,
    maxParallelDispatches: number,
  ) {
    this._semaphore = new Semaphore(maxParallelDispatches);
  }

  /**
   * Dispatch a task to the worker at `url`.
   *
   * Acquires a global semaphore slot (blocks when at capacity).
   * Retries dispatch up to 3 times with jittered backoff ONLY before a taskId
   * is received. Once taskId is known the slot is held until the returned
   * DispatchHandle's event stream reaches a terminal state.
   */
  async dispatch(url: string, payload: TaskPayload): Promise<DispatchHandle> {
    await this._semaphore.acquire();

    let taskId: string | undefined;

    for (let attempt = 0; attempt < DISPATCH_MAX_RETRIES; attempt++) {
      try {
        taskId = await this._client.dispatchTask(url, payload);
        break;
      } catch (err) {
        if (attempt === DISPATCH_MAX_RETRIES - 1) {
          this._semaphore.release();
          throw err;
        }
        logger.debug(
          { url, attempt, nextDelayMs: RETRY_DELAYS_MS[attempt] },
          'dispatch failed, retrying',
        );
        await delayWithJitter(attempt);
      }
    }

    const finalTaskId = taskId!;
    const gen = makeEventStream(finalTaskId, this._client, () => this._semaphore.release());
    const cancelFn = async () => {
      await this._client.cancelTask(finalTaskId);
    };

    return new DispatchHandle(finalTaskId, url, gen, cancelFn);
  }
}
