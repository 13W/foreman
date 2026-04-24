import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SubprocessHandle, SessionHandle } from '@foreman-stack/shared';
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

    const result = manager.sendPrompt(session, [{ type: 'text', text: 'Hello, agent!' }]);

    const updates: unknown[] = [];
    for await (const update of result.updates) {
      updates.push(update);
    }

    const stopReason = await result.stopReason;

    expect(stopReason).toBe('end_turn');
    expect(updates).toHaveLength(1);
    expect((updates[0] as { toolCallId: string }).toolCallId).toBe('echo-call-1');
  }, 15_000);
});
