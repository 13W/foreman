import type { StreamEvent } from '@foreman-stack/shared';

export class DispatchHandle implements AsyncIterableIterator<StreamEvent> {
  readonly taskId: string;
  readonly agentUrl: string;

  private readonly _gen: AsyncGenerator<StreamEvent>;
  private readonly _cancelFn: () => Promise<void>;

  constructor(
    taskId: string,
    agentUrl: string,
    gen: AsyncGenerator<StreamEvent>,
    cancelFn: () => Promise<void>,
  ) {
    this.taskId = taskId;
    this.agentUrl = agentUrl;
    this._gen = gen;
    this._cancelFn = cancelFn;
  }

  next(): Promise<IteratorResult<StreamEvent>> {
    return this._gen.next();
  }

  return(value?: StreamEvent): Promise<IteratorResult<StreamEvent, unknown>> {
    return this._gen.return(value);
  }

  throw(err?: unknown): Promise<IteratorResult<StreamEvent, unknown>> {
    return this._gen.throw(err);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Cancel the remote task and terminate the event stream. */
  async cancel(): Promise<void> {
    await this._cancelFn();
    await this._gen.return(undefined);
  }
}
