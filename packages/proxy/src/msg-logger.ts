import { createWriteStream, type WriteStream } from 'node:fs';

export type MsgDirection = 'in' | 'out';
export type MsgProtocol = 'a2a' | 'acp';

export interface MsgEntry {
  ts: string;
  dir: MsgDirection;
  proto: MsgProtocol;
  type: string;
  taskId?: string;
  sessionId?: string;
  data: unknown;
}

export class MsgLogger {
  private readonly stream: WriteStream;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  }

  log(
    dir: MsgDirection,
    proto: MsgProtocol,
    type: string,
    data: unknown,
    ids?: { taskId?: string; sessionId?: string },
  ): void {
    const entry: MsgEntry = {
      ts: new Date().toISOString(),
      dir,
      proto,
      type,
      ...ids,
      data,
    };
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
