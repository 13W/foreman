import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll } from './index.js';
import { join } from 'node:path';

describe('Harness Smoke Test', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it('should spawn proxy and foreman and perform a simple ACP exchange', async () => {
    // 1. Spawn proxy with trivial script
    const scriptPath = join(import.meta.dirname, '..', 'fixtures', 'scripts', 'trivial.json');
    const { url: proxyUrl } = await spawnProxy({ scriptPath });

    // 2. Spawn foreman pointing to proxy
    const { child: foremanProcess, tempDir: foremanDir } = await spawnForeman({
      workers: [{ url: proxyUrl, name_hint: 'refactorer' }],
    });

    // 3. Connect with ACP client
    const client = new TestACPClient(foremanProcess);

    // 4. Initialize
    const initResult = await client.initialize();
    expect(initResult.agentInfo.name).toBe('foreman');

    // 5. Open session
    const { sessionId } = await client.newSession(foremanDir);
    expect(sessionId).toBeDefined();

    // 6. Prompt
    const promptResult = await client.prompt(sessionId, 'hello');
    
    // Foreman in current state is a stub, so it should respond with something predictable
    expect(promptResult.stopReason).toBe('end_turn');
    
    // Check if we got some updates
    expect(client.updates.length).toBeGreaterThan(0);
    
    // The stub foreman response
    const lastUpdate = client.updates[client.updates.length - 1];
    expect(lastUpdate.sessionUpdate).toBe('agent_message_chunk');
    if (lastUpdate.sessionUpdate === 'agent_message_chunk' && lastUpdate.content.type === 'text') {
      expect(lastUpdate.content.text).toContain('Foreman is starting up');
    }
  }, 20000);
});
