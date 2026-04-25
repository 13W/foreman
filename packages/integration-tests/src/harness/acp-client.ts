import { ChildProcess } from 'node:child_process';
import { ClientSideConnection, ndJsonStream, Client, SessionUpdate } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

export class TestACPClient {
  public connection: ClientSideConnection;
  public updates: SessionUpdate[] = [];

  constructor(child: ChildProcess) {
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const clientStub: Client = {
      requestPermission: async () => {
        throw new Error('TestACPClient: requestPermission not implemented yet');
      },
      sessionUpdate: async (params) => {
        this.updates.push(params.update);
      },
    };

    this.connection = new ClientSideConnection(() => clientStub, transportToWeb(stream));
  }

  async initialize() {
    return this.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test-harness', version: '1.0.0' },
    });
  }

  async newSession(cwd: string) {
    return this.connection.newSession({ cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string) {
    return this.connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancel(sessionId: string) {
    return this.connection.cancel({ sessionId });
  }
}

// Helper to convert ndJsonStream to what ClientSideConnection expects if needed
// Actually ndJsonStream returns a JSONRPCStream which has readable/writable.
// The SDK's ClientSideConnection expects an object with readable/writable.

function transportToWeb(transport: any) {
    return {
        readable: transport.readable,
        writable: transport.writable
    };
}
