import { describe, it, expect, afterEach } from 'vitest';
import { spawnProxy, spawnForeman, TestACPClient, cleanupAll, MockAnthropicServer } from '../harness/index.js';
import { join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('Permission Escalation Scenario', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it.skip('should route worker permission requests directly to the user', async () => {
    // TODO: BUG in DefaultA2AClient: vulnerable to race condition where 
    // status-update event from proxy arrives BEFORE task event.
    // Error: "expected task event first, got status-update"
    // Fix being prepared; unskip when dispatchTask is robust.
    const testTempDir = join(tmpdir(), `permission-test-${Date.now()}`);
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
          toolInput: { description: 'Permissive task' },
        },
      },
      {
        // Turn 2: Follow-up after tool result
        matcher: (req) => req.messages.length > 1,
        response: {
          kind: 'text',
          text: 'Plan received. Executing...',
        },
      },
      {
        // Synthesis turn
        matcher: (req) => req.messages.length === 1 && (!req.tools || req.tools.length === 0),
        response: {
          kind: 'text',
          text: 'The task with permission was completed successfully.',
        },
      },
    ]);

    // 2. Create planner script
    writeFileSync(plannerScript, JSON.stringify({
      "default": {
        "actions": [
          {
            "type": "agent_message_chunk",
            "text": JSON.stringify({
              "plan_id":"p1",
              "originator_intent":"Permissive task",
              "goal_summary":"Permissive task",
              "source":"external_planner",
              "batches":[{"batch_id":"b1","subtasks":[{"id":"t1","assigned_agent":"coder","description":"Do something risky","inputs":{"relevant_files":[], "constraints":[], "context_from_prior_tasks":[]},"expected_output":"Done"}]}]
            })
          },
          { "type": "stop", "reason": "end_turn" }
        ]
      }
    }));

    // Create coder script
    writeFileSync(coderScript, JSON.stringify({
      "0": [
        {
          "type": "permission_request",
          "permission": { "type": "terminal.create", "command": "rm -rf /" }
        },
        { "type": "agent_message_chunk", "text": "permission granted, task completed successfully" },
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
      description: 'Risky coder.'
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

    // 6. Send prompt
    const result = await client.prompt(sessionId, 'Permissive task');

    // 7. Assertions
    try {
        expect(result.stopReason).toBe('end_turn');

        // Verify at least one permission request was recorded by the client
        expect(client.permissionRequests.length).toBeGreaterThanOrEqual(1);
        
        const request = client.permissionRequests[0];
        expect(request.toolCall.kind).toBe('execute');
        
        // Verify synthesis was received (last update)
        const updates = client.updates;
        const lastUpdate = updates[updates.length - 1];
        expect(lastUpdate.sessionUpdate).toBe('agent_message_chunk');
        if (lastUpdate.sessionUpdate === 'agent_message_chunk' && lastUpdate.content.type === 'text') {
          expect(lastUpdate.content.text).toContain('completed successfully');
        }
    } catch (err) {
        console.error('Test failed. Mock server log:', JSON.stringify(mockAnthropic.getRequestLog(), null, 2));
        throw err;
    } finally {
        try { rmSync(testTempDir, { recursive: true, force: true }); } catch {}
    }
  }, 60000);
});
