import type { SessionHandle } from '@foreman-stack/shared';
import type { DefaultSubprocessHandle } from './subprocess-handle.js';

export class DefaultSessionHandle implements SessionHandle {
  private readonly _id: string;
  readonly subprocessHandle: DefaultSubprocessHandle;

  constructor(id: string, subprocessHandle: DefaultSubprocessHandle) {
    this._id = id;
    this.subprocessHandle = subprocessHandle;
  }

  getId(): string {
    return this._id;
  }

  async dispose(): Promise<void> {
    // Session cleanup is managed by DefaultACPClientManager
  }
}
