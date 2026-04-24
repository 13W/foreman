import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SubprocessHandle, SessionHandle, PromptEvent } from '@foreman-stack/shared';
import { DefaultACPClientManager } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '..', '..', 'tests', 'fixtures', 'echo-agent.ts');

describe('DefaultACPClientManager — integration smoke test', () => {
  let subprocess: SubprocessHandle | undefined;
  let session: SessionHandle | undefined;

  afterEach(async () => {
    await session?.dispose().catch(() => {});
    await subprocess?.dispose().catch(() => {});
    subprocess = undefined;
    session = undefined;
  });

  it('spawns echo agent, creates session, sends prompt, receives end_turn with update', async () => {
    const manager = new DefaultACPClientManager();

    subprocess = await manager.spawnSubprocess(
      'node',
      ['--experimental-strip-types', FIXTURE_PATH],
    );

    session = await manager.createSession(subprocess, process.cwd(), []);

    const stream = manager.sendPrompt(session, [{ type: 'text', text: 'Hello, agent!' }]);

    const toolCallUpdates: unknown[] = [];
    let stopReason: string | undefined;

    for await (const event of stream) {
      if (event.kind === 'tool_call_update') {
        toolCallUpdates.push(event.update);
      } else if (event.kind === 'stop') {
        stopReason = event.reason;
        break;
      }
    }

    expect(stopReason).toBe('end_turn');
    expect(toolCallUpdates).toHaveLength(1);
    expect((toolCallUpdates[0] as { toolCallId: string }).toolCallId).toBe('echo-call-1');
  }, 15_000);
});
