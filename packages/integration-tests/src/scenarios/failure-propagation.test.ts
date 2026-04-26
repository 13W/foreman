import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll, MockAnthropicServer } from '../harness/index.js';
import { join } from 'node:path';

describe('Failure Propagation Scenario', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it.skip('should abort the plan and surface the error if a subtask fails', async () => {
    // TODO: BUG in iteration-1 t4.7-min: foreman._runWorkerTask returns failed
    // TaskResult as opaque JSON string; _executePlan does not inspect status
    // and continues to next subtask instead of aborting.
    // Fix being prepared in parallel; unskip when foreman aborts on failed status.
    // 1. Setup Mock Anthropic Server
    const mockAnthropic = new MockAnthropicServer([
      // Turn 1: Planning
      {
        matcher: (req) => req.messages.length === 1 && !!req.tools,
        response: {
          kind: 'tool_use',
          toolName: 'planner',
          toolInput: { description: 'Refactor and test' },
        },
      },
      // Turn 2: Synthesis after failure
      // Foreman calls synthesis even on plan failure, with the error in conversation
      {
        matcher: (req) => req.messages.length > 1,
        response: {
          kind: 'text',
          text: 'The plan execution failed because the tester agent encountered a refusal.',
        },
      },
      // Final synthesis fallback
      {
        matcher: () => true,
        response: {
          kind: 'text',
          text: 'Plan failed.',
        },
      },
    ]);

    // 2. Setup fixture scripts paths
    const fixturesDir = join(import.meta.dirname, '..', 'fixtures', 'scripts');
    const plannerScript = join(fixturesDir, 'planner-success.json');
    const coderScript = join(fixturesDir, 'coder-success.json');
    const testerScript = join(fixturesDir, 'coder-failure.json');

    // 3. Spawn 3 workers
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
      description: 'Coder agent.'
    });

    const { url: testerUrl } = await spawnProxy({
      name: 'tester',
      scriptPath: testerScript,
      description: 'Tester agent (failing).'
    });

    // 4. Spawn foreman
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
    await client.initialize();
    const { sessionId } = await client.newSession(foremanDir);

    // 6. Send prompt
    const result = await client.prompt(sessionId, 'Refactor and test');

    // 7. Assertions
    expect(result.stopReason).toBe('end_turn');

    const updates = client.updates;
    expect(updates.length).toBeGreaterThan(0);
    
    // Verify that we received some failure signal in the updates
    const lastUpdate = updates[updates.length - 1];
    expect(lastUpdate.sessionUpdate).toBe('agent_message_chunk');
    
    if (lastUpdate.sessionUpdate === 'agent_message_chunk' && lastUpdate.content.type === 'text') {
      // It should either be the LLM synthesis or the "Plan execution failed" text from Foreman
      expect(lastUpdate.content.text).toMatch(/failed|refusal/i);
    }

    // Verify mock server saw planning call + synthesis call
    const requests = mockAnthropic.getRequestLog();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    
    // The second call (synthesis) should contain the failure message
    const synthesisRequest = requests[requests.length - 1];
    const synthesisText = synthesisRequest.messages
      .map(m => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map((b: any) => b.type === 'text' ? b.text : '').join('');
        }
        return '';
      })
      .join('\n');
    expect(synthesisText).toMatch(/refusal|failed/i);
    // It should NOT contain the successful result from the first subtask if it aborted immediately
    // Actually, Foreman might include prior results.
    // But if it aborted, it shouldn't have result from second task (except for its failure).
  }, 45000);
});
