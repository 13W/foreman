import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll, MockAnthropicServer } from '../harness/index.js';
import { join } from 'node:path';

describe('Happy Path Scenario', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it('should execute a full end-to-end refactoring plan', async () => {
    // 1. Setup Mock Anthropic Server with scripted responses
    const mockAnthropic = new MockAnthropicServer([
      // Turn 1: Initial prompt with tools
      {
        matcher: (req) => req.messages.length === 1 && !!req.tools && req.tools.length > 0,
        response: {
          kind: 'tool_use',
          toolName: 'planner',
          toolInput: { description: 'Decompose: refactor auth module and add tests' },
        },
      },
      // Turn 2: Follow-up after tool result
      {
        matcher: (req) => req.messages.length > 1,
        response: {
          kind: 'text',
          text: 'Successfully refactored the auth module and added tests.',
        },
      },
      // Synthesis: Fresh call with no tools
      {
        matcher: () => true,
        response: {
          kind: 'text',
          text: 'Successfully refactored the auth module and added tests.',
        },
      },
    ]);

    // 2. Setup fixture scripts paths
    const fixturesDir = join(import.meta.dirname, '..', 'fixtures', 'scripts');
    const plannerScript = join(fixturesDir, 'planner-success.json');
    const coderScript = join(fixturesDir, 'coder-success.json');
    const testerScript = join(fixturesDir, 'tester-success.json');

    // 3. Spawn 3 workers
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

    // 4. Spawn foreman pointing to all 3 and using the mock LLM
    const { child: foremanProcess, tempDir: foremanDir } = await spawnForeman({
      workers: [
        { url: plannerUrl, name_hint: 'planner' },
        { url: coderUrl, name_hint: 'coder' },
        { url: testerUrl, name_hint: 'tester' },
      ],
      mockAnthropic,
    });

    // 5. Connect with ACP client
    const client = new TestACPClient(foremanProcess);

    // 6. Initialize and session/new
    await client.initialize();
    const { sessionId } = await client.newSession(foremanDir);

    // 7. Send the high-level prompt
    const result = await client.prompt(sessionId, 'Refactor the auth module and add tests');

    // 8. Assertions
    expect(result.stopReason).toBe('end_turn');

    // Verify synthesis was received (last update)
    const updates = client.updates;
    expect(updates.length).toBeGreaterThan(0);
    const lastUpdate = updates[updates.length - 1];
    expect(lastUpdate.sessionUpdate).toBe('agent_message_chunk');
    
    if (lastUpdate.sessionUpdate === 'agent_message_chunk' && lastUpdate.content.type === 'text') {
      expect(lastUpdate.content.text).toBe('Successfully refactored the auth module and added tests.');
    }

    // Verify mock server saw at least 2 calls (Planning and synthesis)
    expect(mockAnthropic.getRequestLog().length).toBeGreaterThanOrEqual(2);
  }, 60000); // 60s timeout for full scenario
});
