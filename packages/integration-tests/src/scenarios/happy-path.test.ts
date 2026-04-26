import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll } from '../harness/index.js';
import { join } from 'node:path';

describe('Happy Path Scenario', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it.skip('should execute a full end-to-end refactoring plan', async () => {
    // 1. Setup fixture scripts paths
    const fixturesDir = join(import.meta.dirname, '..', 'fixtures', 'scripts');
    const plannerScript = join(fixturesDir, 'planner-success.json');
    const coderScript = join(fixturesDir, 'coder-success.json');
    const testerScript = join(fixturesDir, 'tester-success.json');

    // 2. Spawn 3 workers
    // Planner worker needs the task_decomposition skill
    const { url: plannerUrl } = await spawnProxy({
      name: 'planner',
      scriptPath: plannerScript,
      skills: [{
        id: 'task_decomposition',
        name: 'Plan decomposition',
        description: 'Decomposes high-level goals into subtask plans.',
        tags: ['planning'],
        examples: []
      }]
    });

    const { url: coderUrl } = await spawnProxy({
      name: 'coder',
      scriptPath: coderScript,
      description: 'A code refactoring expert.'
    });

    const { url: testerUrl } = await spawnProxy({
      name: 'tester',
      scriptPath: testerScript,
      description: 'A test automation expert.'
    });

    // 3. Spawn foreman pointing to all 3
    const { child: foremanProcess, tempDir: foremanDir } = await spawnForeman({
      workers: [
        { url: plannerUrl, name_hint: 'planner' },
        { url: coderUrl, name_hint: 'coder' },
        { url: testerUrl, name_hint: 'tester' },
      ],
    });

    // 4. Connect with ACP client
    const client = new TestACPClient(foremanProcess);

    // 5. Initialize and session/new
    await client.initialize();
    const { sessionId } = await client.newSession(foremanDir);

    // 6. Send the high-level prompt
    // TODO: This currently fails because Foreman attempts real Anthropic API calls.
    // Blocker: Foreman's AnthropicLLMClient needs baseURL support to point to a mock server,
    // or a fake backend mode.
    const promptPromise = client.prompt(sessionId, 'Refactor the auth module and add tests');

    // For now, we expect this to fail or timeout due to the LLM blocker.
    // Once the blocker is resolved (via mock server or fake backend), the assertions below can be enabled.
    
    const result = await promptPromise;

    // --- ASSERTIONS (Enable after LLM blocker is resolved) ---
    
    expect(result.stopReason).toBe('end_turn');

    // Verify synthesis was received (last update)
    const updates = client.updates;
    expect(updates.length).toBeGreaterThan(0);
    const lastUpdate = updates[updates.length - 1];
    expect(lastUpdate.sessionUpdate).toBe('agent_message_chunk');
    
    // We can't assert exact text because it's LLM-generated, but it should exist
    if (lastUpdate.sessionUpdate === 'agent_message_chunk' && lastUpdate.content.type === 'text') {
      expect(lastUpdate.content.text).toBeTruthy();
    }

    // Optional: verify that each worker was actually reached.
    // This could be done by checking foreman logs or proxy logs if we capture them.
  }, 60000); // 60s timeout for full scenario
});
