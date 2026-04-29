import type { A2AClient, TaskPayload } from '@foreman-stack/shared';
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
   * is received. Once taskId is known, the slot is held until the task's pump
   * exits (auto-released via waitForDone) or the handle's release() is called.
   */
  async dispatch(url: string, payload: TaskPayload): Promise<DispatchHandle> {
    await this._semaphore.acquire();

    let semaphoreReleased = false;
    const release = () => {
      if (semaphoreReleased) return;
      semaphoreReleased = true;
      this._semaphore.release();
    };

    logger.info({ url, description: payload.description.slice(0, 120) }, 'dispatching task to worker');

    let taskId: string | undefined;

    for (let attempt = 0; attempt < DISPATCH_MAX_RETRIES; attempt++) {
      try {
        taskId = await this._client.dispatchTask(url, payload);
        break;
      } catch (err) {
        if (attempt === DISPATCH_MAX_RETRIES - 1) {
          release();
          throw err;
        }
        logger.debug(
          { url, attempt, nextDelayMs: RETRY_DELAYS_MS[attempt] },
          'dispatch failed, retrying',
        );
        await delayWithJitter(attempt);
      }
    }

    logger.info({ url, taskId }, 'task accepted by worker');

    // Auto-release semaphore when the pump exits. The handle's .release() is also
    // a manual escape hatch (e.g. release early after consuming desired events).
    this._client.waitForDone(taskId!).finally(release).catch(() => {
      // Suppress: release() already handles errors via finally
    });

    return new DispatchHandle(taskId!, url, this._client, release);
  }
}
