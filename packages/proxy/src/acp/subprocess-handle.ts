import type { ChildProcess } from 'node:child_process';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type { SubprocessHandle } from '@foreman-stack/shared';

export class DefaultSubprocessHandle implements SubprocessHandle {
  private readonly _id: string;
  private readonly proc: ChildProcess;
  readonly connection: ClientSideConnection;

  constructor(id: string, proc: ChildProcess, connection: ClientSideConnection) {
    this._id = id;
    this.proc = proc;
    this.connection = connection;
  }

  getId(): string {
    return this._id;
  }

  async dispose(): Promise<void> {
    this.proc.kill();
    await this.connection.closed.catch(() => {});
  }
}
