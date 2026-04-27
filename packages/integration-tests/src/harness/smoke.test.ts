import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll, MockAnthropicServer } from './index.js';
import { join } from 'node:path';

describe('Harness Smoke Test', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it('should spawn proxy and foreman and perform a simple ACP exchange', async () => {
    // 1. Spawn proxy with trivial script
    const scriptPath = join(import.meta.dirname, '..', 'fixtures', 'scripts', 'trivial.json');
    const { url: proxyUrl } = await spawnProxy({ scriptPath });

    // 2. Mock Anthropic for the self-plan LLM call that foreman makes after t4.8
    //    when no planner worker is available (TestACPClient picks self_plan automatically).
    const mockAnthropic = new MockAnthropicServer([
      {
        matcher: () => true,
        response: { kind: 'text', text: 'I cannot plan this task.' },
      },
    ]);

    // 3. Spawn foreman pointing to proxy
    const { child: foremanProcess, tempDir: foremanDir } = await spawnForeman({
      workers: [{ url: proxyUrl, name_hint: 'refactorer' }],
      mockAnthropic,
    });

    // 4. Connect with ACP client
    const client = new TestACPClient(foremanProcess);

    // 5. Initialize
    const initResult = await client.initialize();
    expect(initResult.agentInfo.name).toBe('foreman');

    // 6. Open session
    const { sessionId } = await client.newSession(foremanDir);
    expect(sessionId).toBeDefined();

    // 7. Prompt
    const promptResult = await client.prompt(sessionId, 'hello');

    expect(promptResult.stopReason).toBe('end_turn');

    // Check if we got some updates
    expect(client.updates.length).toBeGreaterThan(0);

    // The proxy worker has no task_decomposition skill. After t4.8 the fallback
    // handler asks the user via requestPermission. TestACPClient picks self_plan
    // (first allow_once option). The LLM returns non-plan text, so foreman
    // replies with the self-plan failure message.
    const lastUpdate = client.updates[client.updates.length - 1];
    expect(lastUpdate.sessionUpdate).toBe('agent_message_chunk');
    if (lastUpdate.sessionUpdate === 'agent_message_chunk' && lastUpdate.content.type === 'text') {
      expect(lastUpdate.content.text).toContain('Could not generate a self-made plan.');
    }
  }, 30000);
});
