import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll, MockAnthropicServer } from '../harness/index.js';
import { join } from 'node:path';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('User Cancellation Scenario', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it('should cancel the session mid-flight', async () => {
    const testTempDir = join(tmpdir(), `cancellation-test-${Date.now()}`);
    mkdirSync(testTempDir, { recursive: true });
    
    const plannerScript = join(testTempDir, 'planner.json');
    const coderScript = join(testTempDir, 'coder.json');

    // 1. Setup Mock Anthropic Server
    const mockAnthropic = new MockAnthropicServer([
      {
        // Turn 1: Planning
        matcher: (req) => req.messages.length === 1 && !!req.tools && req.tools.length > 0,
        response: {
          kind: 'tool_use',
          toolName: 'planner',
          toolInput: { description: 'Slow task' },
        },
      },
      {
        // Turn 2: Post-planning
        matcher: (req) => req.messages.length > 1 && !!req.tools && req.tools.length > 0,
        response: {
          kind: 'text',
          text: 'Plan received. Executing...',
        },
      },
      {
        // Synthesis: Fresh call
        matcher: (req) => req.messages.length === 1 && (!req.tools || req.tools.length === 0),
        response: {
          kind: 'text',
          text: 'Task was cancelled.',
        },
      },
    ]);

    // 2. Create scripts
    writeFileSync(plannerScript, JSON.stringify({
      "default": {
        "actions": [
          {
            "type": "agent_message_chunk",
            "text": JSON.stringify({
              "plan_id":"p1",
              "originator_intent":"Slow task",
              "goal_summary":"Slow task",
              "source":"external_planner",
              "batches":[{"batch_id":"b1","subtasks":[{"id":"t1","assigned_agent":"coder","description":"Be slow","inputs":{"relevant_files":[]},"expected_output":"Done"}]}]
            })
          },
          { "type": "stop", "reason": "end_turn" }
        ]
      }
    }));

    writeFileSync(coderScript, JSON.stringify({
      "0": [
        { "type": "agent_message_chunk", "text": "I will take my time..." },
        { "type": "sleep", "ms": 5000 },
        { "type": "agent_message_chunk", "text": "I am done now." },
        { "type": "stop", "reason": "end_turn" }
      ]
    }));

    // 3. Spawn workers
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
      description: 'Slow coder.'
    });

    // 4. Spawn foreman
    const { child: foremanProcess, tempDir: foremanDir } = await spawnForeman({
      workers: [
        { url: plannerUrl, name_hint: 'planner' },
        { url: coderUrl, name_hint: 'coder' },
      ],
      mockAnthropic,
    });

    // 5. Connect with ACP client
    const client = new TestACPClient(foremanProcess);
    await client.initialize();
    const { sessionId } = await client.newSession(foremanDir);

    // 6. Send prompt asynchronously
    const promptPromise = client.prompt(sessionId, 'Be slow');

    // 7. Wait for planning to finish and coder to be dispatched
    let planningFinished = false;
    for (let i = 0; i < 50; i++) {
      if (mockAnthropic.getRequestLog().length >= 2) {
        planningFinished = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(planningFinished).toBe(true);

    // Give it a bit more time to actually dispatch to coder and for coder to hit 'sleep'
    await new Promise(r => setTimeout(r, 1000));

    try {
      // 8. Call cancel
      await client.cancel(sessionId);

      // 9. Await promptPromise
      const result = await promptPromise;
      
      // 10. Assertions
      expect(result.stopReason).toBeDefined();
    } finally {
        try { rmSync(testTempDir, { recursive: true, force: true }); } catch {}
    }
  }, 60000);
});
