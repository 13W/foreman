import type { A2AClient, StreamEvent } from '@foreman-stack/shared';

export class DispatchHandle {
  readonly taskId: string;
  readonly agentUrl: string;

  private readonly _client: A2AClient;
  private readonly _release: () => void;
  private _released = false;

  constructor(taskId: string, agentUrl: string, client: A2AClient, release: () => void) {
    this.taskId = taskId;
    this.agentUrl = agentUrl;
    this._client = client;
    this._release = release;
  }

  /**
   * Subscribe to events for this task. Returns an unsubscribe function.
   * The listener is called synchronously by the EventEmitter pump for each event.
   */
  onEvent(listener: (event: StreamEvent) => void): () => void {
    return this._client.subscribe(this.taskId, listener);
  }

  /**
   * Resolves when the task's pump exits (terminal event or stream end).
   * Rejects if the pump errors out.
   */
  waitForDone(): Promise<void> {
    return this._client.waitForDone(this.taskId);
  }

  /** Cancel the remote task. The pump will see the terminal event and exit naturally. */
  async cancel(): Promise<void> {
    await this._client.cancelTask(this.taskId);
  }

  /**
   * Release the dispatch concurrency slot. Idempotent.
   * The slot is also auto-released when the pump exits, but callers may release
   * earlier (e.g. after all desired events have been processed).
   */
  release(): void {
    if (this._released) return;
    this._released = true;
    this._release();
  }
}
