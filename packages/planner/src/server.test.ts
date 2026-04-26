import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClientSideConnection, ndJsonStream, Client } from '@agentclientprotocol/sdk';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
const BIN_PATH = join(__dirname, '..', 'dist', 'cli.js');

describe('PlannerServer Smoke Test', () => {
  let configPath: string;
  let child: ChildProcess;
  let connection: ClientSideConnection;
  let lastUpdate: string | null = null;

  beforeAll(async () => {
    configPath = join(tmpdir(), `planner-test-config-${Date.now()}.yaml`);
    const configContent = `
planner:
  strategy: "stub"
llm:
  model: "test-model"
logging:
  level: "debug"
`;
    writeFileSync(configPath, configContent);
  });

  afterAll(() => {
    if (child) child.kill();
    if (configPath && existsSync(configPath)) unlinkSync(configPath);
  });

  it('should initialize and respond to prompt', async () => {
    child = spawn('node', [BIN_PATH, '--config', configPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const clientStub: Client = {
      async requestPermission() { throw new Error('Not implemented'); },
      async sessionUpdate(params) {
        if (params.update.sessionUpdate === 'agent_message_chunk' && params.update.content.type === 'text') {
          lastUpdate = params.update.content.text;
        }
      },
    };

    connection = new ClientSideConnection(() => clientStub, stream);

    // 1. Initialize
    const initResult = await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    expect(initResult).toMatchObject({
      protocolVersion: 1,
      agentInfo: {
        name: 'foreman-planner',
      },
    });

    // 2. New session
    const { sessionId } = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(sessionId).toBeDefined();

    // 3. Prompt
    lastUpdate = null;
    const promptResult = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Hello, help me refactor auth' }],
    });

    expect(promptResult.stopReason).toBe('end_turn');
    expect(lastUpdate).toContain('stub-plan-id');

    // 4. Follow-up prompt
    lastUpdate = null;
    const followupResult = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Tell me more' }],
    });

    expect(followupResult.stopReason).toBe('end_turn');
    expect(lastUpdate).toBe('stub answer');

    // 5. Cancel notification
    await connection.cancel({ sessionId });
  }, 10000);
});
