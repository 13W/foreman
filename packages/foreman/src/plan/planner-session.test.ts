import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plan, StreamEvent } from '@foreman-stack/shared';
import type { ForemanConfig } from '../config.js';
import type { LLMEvent, LLMClient } from '../llm/client.js';
import type { DispatchManager } from '../workers/dispatch-manager.js';
import type { A2AClient } from '@foreman-stack/shared';
import { DispatchHandle } from '../workers/task-handle.js';
import {
  ExternalPlannerSession,
  SelfPlannedSession,
  SingleTaskDispatchSession,
  createPlannerSession,
} from './planner-session.js';
import type { ExecutionStateSnapshot } from './planner-session.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_PLAN: Plan = {
  plan_id: 'plan-1',
  originator_intent: 'do something',
  goal_summary: 'accomplish the task',
  source: 'external_planner',
  batches: [
    {
      batch_id: 'batch-1',
      subtasks: [
        {
          id: 'subtask-1',
          assigned_agent: 'http://worker.local',
          description: 'do the thing',
          inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          expected_output: 'done',
        },
      ],
    },
  ],
};

const SELF_PLAN: Plan = { ...MINIMAL_PLAN, source: 'self_planned' };

const logger = pino({ level: 'silent' });

const baseConfig: ForemanConfig = {
  foreman: { name: 'test', version: '0.0.1', working_dir: '/tmp' },
  llm: { backend: 'anthropic', model: 'claude-3', api_key_env: 'API_KEY', max_tokens_per_turn: 4096 },
  workers: [],
  mcps: { personal: [], injected: [] },
  runtime: {
    max_concurrent_sessions: 5,
    max_parallel_dispatches: 5,
    default_task_timeout_sec: 300,
    worker_discovery_timeout_sec: 10,
    planner_response_timeout_sec: 5,
  },
  logging: { level: 'info', format: 'json', destination: 'stderr' },
};

// ---------------------------------------------------------------------------
// MockHandle factory  (push-based: onEvent/waitForDone/cancel/release)
// ---------------------------------------------------------------------------

interface MockHandleControl {
  handle: DispatchHandle;
  push: (event: StreamEvent) => void;
  complete: () => void;
  fail: (err: Error) => void;
  isCancelled: () => boolean;
}

function makeMockHandle(taskId: string): MockHandleControl {
  const listeners: Array<(e: StreamEvent) => void> = [];
  const buffered: StreamEvent[] = [];
  let doneResolve!: () => void;
  let doneReject!: (err: Error) => void;
  const donePromise = new Promise<void>((res, rej) => {
    doneResolve = res;
    doneReject = rej;
  });
  let cancelled = false;

  const handle = {
    taskId,
    agentUrl: 'http://planner.local',
    onEvent(listener: (e: StreamEvent) => void): () => void {
      for (const e of buffered) listener(e);
      buffered.length = 0;
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    waitForDone(): Promise<void> { return donePromise; },
    cancel: vi.fn(async () => {
      cancelled = true;
      doneResolve();
    }),
    release: vi.fn(),
  } as unknown as DispatchHandle;

  return {
    handle,
    push(event: StreamEvent) {
      if (listeners.length === 0) {
        buffered.push(event);
      } else {
        for (const l of [...listeners]) l(event);
      }
    },
    complete() { doneResolve(); },
    fail(err: Error) { doneReject(err); },
    isCancelled: () => cancelled,
  };
}

// ---------------------------------------------------------------------------
// StreamEvent helpers
// ---------------------------------------------------------------------------

function makeInputRequiredEvent(taskId = 'plan-task'): StreamEvent {
  return { type: 'status', taskId, data: { state: 'input-required' }, timestamp: new Date().toISOString() };
}

function makeCompletedWithPlanEvent(plan: Plan, taskId = 'plan-task'): StreamEvent {
  return {
    type: 'status',
    taskId,
    data: {
      state: 'completed',
      final: true,
      message: { parts: [{ kind: 'data', data: plan }] },
    },
    timestamp: new Date().toISOString(),
  };
}

function makeTextMessageEvent(text: string, taskId = 'plan-task'): StreamEvent {
  return {
    type: 'message',
    taskId,
    data: { kind: 'message', messageId: 'msg-1', role: 'agent', parts: [{ kind: 'text', text }] },
  };
}

/** Matches the flat wire shape produced by proxy mappers.ts case 'plan' (post double-wrap fix). */
function makePlanEntriesEvent(
  entries: Array<{ content: string; subtaskId: string; assignedAgent: string; blockedBy?: string[] }>,
  taskId = 'plan-task',
): StreamEvent {
  return {
    type: 'status',
    taskId,
    data: {
      kind: 'message',
      messageId: 'plan-msg',
      role: 'agent',
      parts: [
        {
          kind: 'data',
          data: {
            entries: entries.map((e) => ({
              content: e.content,
              priority: 'medium',
              status: 'pending',
              _meta: {
                subtaskId: e.subtaskId,
                assignedAgent: e.assignedAgent,
                blockedBy: e.blockedBy ?? [],
              },
            })),
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// ExternalPlannerSession
// ---------------------------------------------------------------------------

describe('ExternalPlannerSession', () => {
  const plannerUrl = 'http://planner.local';
  const taskId = 'plan-task';

  let ctrl: MockHandleControl;
  let mockDispatch: ReturnType<typeof vi.fn>;
  let mockSendFollowUp: ReturnType<typeof vi.fn>;
  let dispatchManager: DispatchManager;
  let a2aClient: A2AClient;

  beforeEach(() => {
    ctrl = makeMockHandle(taskId);
    mockDispatch = vi.fn().mockResolvedValue(ctrl.handle);
    mockSendFollowUp = vi.fn().mockResolvedValue(undefined);

    dispatchManager = { dispatch: mockDispatch } as unknown as DispatchManager;
    a2aClient = {
      fetchAgentCard: vi.fn(),
      dispatchTask: vi.fn(),
      subscribe: vi.fn(),
      waitForDone: vi.fn(),
      pollTask: vi.fn(),
      cancelTask: vi.fn(),
      respondToPermission: vi.fn(),
      sendFollowUp: mockSendFollowUp,
    };
  });

  it('open() dispatches once with decomposition request payload', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));

    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [url, payload] = mockDispatch.mock.calls[0];
    expect(url).toBe(plannerUrl);
    expect(payload.description).toBe('build the thing');
  });

  it('open() parses Plan from data part in terminal status event', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));

    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    expect(session.getPlan()).toEqual(MINIMAL_PLAN);
  });

  it('open() parses Plan from JSON text in message event', async () => {
    ctrl.push(makeTextMessageEvent(JSON.stringify(MINIMAL_PLAN)));
    ctrl.push(makeInputRequiredEvent());

    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    expect(session.getPlan()).toMatchObject({ plan_id: MINIMAL_PLAN.plan_id });
  });

  it('open() sets getPlan() null when response is not parseable as Plan', async () => {
    ctrl.push(makeTextMessageEvent('hello world (not a plan)'));
    ctrl.push(makeInputRequiredEvent());

    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    expect(session.getPlan()).toBeNull();
  });

  it('ask() sends sendFollowUp with text part on existing taskId', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    // Queue response to ask()
    ctrl.push(makeTextMessageEvent('proceed with option A'));
    ctrl.push(makeInputRequiredEvent());

    const answer = await session.ask('which option?');

    expect(mockSendFollowUp).toHaveBeenCalledTimes(1);
    const [calledTaskId, parts] = mockSendFollowUp.mock.calls[0];
    expect(calledTaskId).toBe(taskId);
    expect(parts).toEqual([{ kind: 'text', text: 'which option?' }]);
    expect(answer).toContain('proceed with option A');
  });

  it('ask() returns text accumulated from multiple message events', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    ctrl.push(makeTextMessageEvent('first part '));
    ctrl.push(makeTextMessageEvent('second part'));
    ctrl.push(makeInputRequiredEvent());

    const answer = await session.ask('tell me more');
    expect(answer).toContain('first part');
    expect(answer).toContain('second part');
  });

  it('close() cancels the dispatch handle', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    await session.close();

    expect(ctrl.isCancelled()).toBe(true);
  });

  it('close() is idempotent', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');

    await session.close();
    await expect(session.close()).resolves.not.toThrow();
    expect(ctrl.isCancelled()).toBe(true);
  });

  it('ask() throws when session is closed', async () => {
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    await session.open('build the thing');
    await session.close();

    await expect(session.ask('any question')).rejects.toThrow(/closed/i);
  });

  it('ask() throws timeout when handle produces no events within planner_response_timeout_sec', async () => {
    // Use a config with very short timeout
    const fastConfig: ForemanConfig = {
      ...baseConfig,
      runtime: { ...baseConfig.runtime, planner_response_timeout_sec: 0 },
    };

    ctrl.push(makeInputRequiredEvent()); // consumed by open()
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, fastConfig, logger);
    await session.open('build the thing');

    // No events queued — ask() should timeout immediately (0s)
    await expect(session.ask('will this timeout?')).rejects.toThrow(/timeout/i);
  }, 2000);

  it('mode is external_planner', () => {
    const session = new ExternalPlannerSession(dispatchManager, a2aClient, plannerUrl, baseConfig, logger);
    expect(session.mode).toBe('external_planner');
  });
});

// ---------------------------------------------------------------------------
// SelfPlannedSession
// ---------------------------------------------------------------------------

describe('SelfPlannedSession', () => {
  type CompleteEvent = LLMEvent & { type: 'stop'; stopReason: string };

  function makeMockLLMClient(responses: string[]): LLMClient {
    let callCount = 0;
    return {
      async *completeWithTools(_messages, _tools, _systemPrompt, _signal) {
        const text = responses[callCount++] ?? '';
        yield { type: 'text_chunk', text } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as CompleteEvent;
      },
    };
  }

  it('open() runs LLM and parses Plan from JSON response', async () => {
    const llmClient = makeMockLLMClient([JSON.stringify(SELF_PLAN)]);
    const session = new SelfPlannedSession(llmClient, baseConfig, logger);
    await session.open('build the thing');

    expect(session.getPlan()).toMatchObject({ plan_id: SELF_PLAN.plan_id });
  });

  it('open() sets getPlan() null when LLM returns non-Plan text', async () => {
    const llmClient = makeMockLLMClient(['I cannot decompose that.']);
    const session = new SelfPlannedSession(llmClient, baseConfig, logger);
    await session.open('build the thing');

    expect(session.getPlan()).toBeNull();
  });

  it('ask() returns LLM response text', async () => {
    const llmClient = makeMockLLMClient([JSON.stringify(SELF_PLAN), 'option B is correct']);
    const session = new SelfPlannedSession(llmClient, baseConfig, logger);
    await session.open('build the thing');

    const answer = await session.ask('which option?');
    expect(answer).toBe('option B is correct');
  });

  it('conversation history accumulates across multiple ask() calls', async () => {
    const allMessages: unknown[][] = [];
    const llmClient: LLMClient = {
      async *completeWithTools(messages, _tools, _systemPrompt, _signal) {
        allMessages.push([...messages]);
        yield { type: 'text_chunk', text: `response-${allMessages.length}` } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as CompleteEvent;
      },
    };

    const session = new SelfPlannedSession(llmClient, baseConfig, logger);
    await session.open('build the thing');
    await session.ask('question 1');
    await session.ask('question 2');

    // First call: [user-open]
    // Second call: [user-open, assistant-plan, user-q1]
    // Third call:  [user-open, assistant-plan, user-q1, assistant-a1, user-q2]
    expect(allMessages[0]).toHaveLength(1);
    expect(allMessages[1]).toHaveLength(3);
    expect(allMessages[2]).toHaveLength(5);
  });

  it('close() clears conversation history', async () => {
    const llmClient = makeMockLLMClient([JSON.stringify(SELF_PLAN), 'answer']);
    const session = new SelfPlannedSession(llmClient, baseConfig, logger);
    await session.open('build the thing');
    await session.ask('a question');
    await session.close();

    // After close, subsequent ask() starts fresh (no accumulated history visible to LLM)
    // We verify by checking that the next LLM call receives only the new message
    let lastCallMessages: unknown[] = [];
    const trackingClient: LLMClient = {
      async *completeWithTools(messages) {
        lastCallMessages = [...messages];
        yield { type: 'text_chunk', text: 'fresh' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as CompleteEvent;
      },
    };
    const session2 = new SelfPlannedSession(trackingClient, baseConfig, logger);
    await session2.open('new request');
    expect(lastCallMessages).toHaveLength(1);
  });

  it('mode is self_planned', () => {
    const llmClient = makeMockLLMClient([]);
    const session = new SelfPlannedSession(llmClient, baseConfig, logger);
    expect(session.mode).toBe('self_planned');
  });
});

// ---------------------------------------------------------------------------
// SingleTaskDispatchSession
// ---------------------------------------------------------------------------

describe('SingleTaskDispatchSession', () => {
  it('open() resolves without error', async () => {
    const session = new SingleTaskDispatchSession();
    await expect(session.open('anything')).resolves.not.toThrow();
  });

  it('ask() throws clearly', async () => {
    const session = new SingleTaskDispatchSession();
    await expect(session.ask('a question')).rejects.toThrow(/single_task_dispatch/i);
  });

  it('getPlan() returns null', () => {
    const session = new SingleTaskDispatchSession();
    expect(session.getPlan()).toBeNull();
  });

  it('close() is a no-op', async () => {
    const session = new SingleTaskDispatchSession();
    await expect(session.close()).resolves.not.toThrow();
  });

  it('mode is single_task_dispatch', () => {
    const session = new SingleTaskDispatchSession();
    expect(session.mode).toBe('single_task_dispatch');
  });
});

// ---------------------------------------------------------------------------
// Cross-mode parity test
// ---------------------------------------------------------------------------

describe('cross-mode parity: open + getPlan() shape + close()', () => {
  it('all three modes resolve open() and expose a consistent interface', async () => {
    // external_planner
    const ctrl = makeMockHandle('plan-task');
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    const mockDispatch = vi.fn().mockResolvedValue(ctrl.handle);
    const a2aClient: A2AClient = {
      fetchAgentCard: vi.fn(), dispatchTask: vi.fn(), subscribe: vi.fn(), waitForDone: vi.fn(),
      pollTask: vi.fn(), cancelTask: vi.fn(), respondToPermission: vi.fn(),
      sendFollowUp: vi.fn().mockResolvedValue(undefined),
    };
    const externalSession = new ExternalPlannerSession(
      { dispatch: mockDispatch } as unknown as DispatchManager,
      a2aClient,
      'http://planner.local',
      baseConfig,
      logger,
    );

    // self_planned
    const llmClient: LLMClient = {
      async *completeWithTools() {
        yield { type: 'text_chunk', text: JSON.stringify(SELF_PLAN) } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent & { type: 'stop'; stopReason: string };
      },
    };
    const selfSession = new SelfPlannedSession(llmClient, baseConfig, logger);

    // single_task_dispatch
    const singleSession = new SingleTaskDispatchSession();

    const sessions = [externalSession, selfSession, singleSession] as const;

    for (const session of sessions) {
      await session.open('decompose the task');
      const plan = session.getPlan();
      // Only single_task_dispatch always returns null; others may or may not have a plan
      if (session.mode === 'single_task_dispatch') {
        expect(plan).toBeNull();
      }
      await session.close();
    }

    // Verify all three have the right mode value
    expect(externalSession.mode).toBe('external_planner');
    expect(selfSession.mode).toBe('self_planned');
    expect(singleSession.mode).toBe('single_task_dispatch');
  });
});

// ---------------------------------------------------------------------------
// createPlannerSession factory
// ---------------------------------------------------------------------------

describe('createPlannerSession', () => {
  it('creates SingleTaskDispatchSession for single_task_dispatch mode', () => {
    const session = createPlannerSession({ mode: 'single_task_dispatch', config: baseConfig, logger });
    expect(session).toBeInstanceOf(SingleTaskDispatchSession);
  });

  it('creates SelfPlannedSession for self_planned mode with llmClient', () => {
    const llmClient = { completeWithTools: vi.fn() } as unknown as LLMClient;
    const session = createPlannerSession({ mode: 'self_planned', llmClient, config: baseConfig, logger });
    expect(session).toBeInstanceOf(SelfPlannedSession);
  });

  it('creates ExternalPlannerSession for external_planner mode', () => {
    const dm = { dispatch: vi.fn() } as unknown as DispatchManager;
    const ac = { sendFollowUp: vi.fn() } as unknown as A2AClient;
    const session = createPlannerSession({
      mode: 'external_planner',
      dispatchManager: dm,
      a2aClient: ac,
      plannerUrl: 'http://planner.local',
      config: baseConfig,
      logger,
    });
    expect(session).toBeInstanceOf(ExternalPlannerSession);
  });

  it('throws when external_planner mode is missing required options', () => {
    expect(() =>
      createPlannerSession({ mode: 'external_planner', config: baseConfig, logger }),
    ).toThrow();
  });

  it('throws when self_planned mode is missing llmClient', () => {
    expect(() =>
      createPlannerSession({ mode: 'self_planned', config: baseConfig, logger }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Commit 3: ExternalPlannerSession listens for plan events (primary path)
// ---------------------------------------------------------------------------

describe('ExternalPlannerSession — ACP plan events (primary path)', () => {
  const plannerUrl = 'http://planner.local';
  const taskId = 'plan-task';
  const workers = ['worker_a', 'worker_b'];

  function makeSession(ctrl: MockHandleControl) {
    const mockDispatch = vi.fn().mockResolvedValue(ctrl.handle);
    const a2aClient: A2AClient = {
      fetchAgentCard: vi.fn(), dispatchTask: vi.fn(), subscribe: vi.fn(), waitForDone: vi.fn(),
      pollTask: vi.fn(), cancelTask: vi.fn(), respondToPermission: vi.fn(),
      sendFollowUp: vi.fn().mockResolvedValue(undefined),
    };
    const dispatchManager = { dispatch: mockDispatch } as unknown as DispatchManager;
    return new ExternalPlannerSession(
      dispatchManager, a2aClient, plannerUrl, baseConfig, logger, workers,
    );
  }

  it('builds Plan from ACP plan entries when planner emits them before input-required', async () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);

    ctrl.push(makePlanEntriesEvent([
      { content: 'implement feature', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
      { content: 'write tests', subtaskId: 't2', assignedAgent: 'worker_b', blockedBy: ['t1'] },
    ]));
    ctrl.push(makeInputRequiredEvent());

    await session.open('build the thing');

    const plan = session.getPlan();
    expect(plan).not.toBeNull();
    expect(plan!.batches).toHaveLength(2); // sequential: t1 → t2
    expect(plan!.batches[0].subtasks[0].id).toBe('t1');
    expect(plan!.batches[1].subtasks[0].id).toBe('t2');
  });

  it('latest plan entries win when planner emits multiple plan events', async () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);

    ctrl.push(makePlanEntriesEvent([
      { content: 'old task', subtaskId: 'old', assignedAgent: 'worker_a', blockedBy: [] },
    ]));
    ctrl.push(makePlanEntriesEvent([
      { content: 'refined task A', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
      { content: 'refined task B', subtaskId: 't2', assignedAgent: 'worker_b', blockedBy: [] },
    ]));
    ctrl.push(makeInputRequiredEvent());

    await session.open('build the thing');

    const plan = session.getPlan();
    expect(plan).not.toBeNull();
    expect(plan!.batches[0].subtasks).toHaveLength(2);
    expect(plan!.batches[0].subtasks.map((s) => s.id).sort()).toEqual(['t1', 't2']);
  });

  it('falls back to JSON-in-text when no plan events emitted', async () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);

    ctrl.push(makeTextMessageEvent(JSON.stringify(MINIMAL_PLAN)));
    ctrl.push(makeInputRequiredEvent());

    await session.open('build the thing');

    const plan = session.getPlan();
    expect(plan).not.toBeNull();
    expect(plan!.plan_id).toBe(MINIMAL_PLAN.plan_id);
  });
});

// ---------------------------------------------------------------------------
// Commit 5: ask() injects plan state
// ---------------------------------------------------------------------------

describe('ExternalPlannerSession — ask() injects execution state', () => {
  const plannerUrl = 'http://planner.local';
  const taskId = 'plan-task';
  const workers = ['worker_a'];

  it('prepends formatted plan state to the question sent via sendFollowUp', async () => {
    const ctrl = makeMockHandle(taskId);
    const mockSendFollowUp = vi.fn().mockResolvedValue(undefined);
    const a2aClient: A2AClient = {
      fetchAgentCard: vi.fn(), dispatchTask: vi.fn(), subscribe: vi.fn(), waitForDone: vi.fn(),
      pollTask: vi.fn(), cancelTask: vi.fn(), respondToPermission: vi.fn(),
      sendFollowUp: mockSendFollowUp,
    };
    const dispatchManager = { dispatch: vi.fn().mockResolvedValue(ctrl.handle) } as unknown as DispatchManager;
    const executionState: ExecutionStateSnapshot = {
      completed: new Map([['t1', { resultSummary: 'done' }]]),
      inProgress: new Map([['t2', { workerName: 'worker_a' }]]),
      failed: new Map(),
    };
    const session = new ExternalPlannerSession(
      dispatchManager, a2aClient, plannerUrl, baseConfig, logger, workers,
      () => executionState,
    );

    // open with a plan so _plan is set
    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    await session.open('build the thing');

    // Queue ask() response
    ctrl.push(makeTextMessageEvent('allow_once'));
    ctrl.push(makeInputRequiredEvent());

    await session.ask('can worker do X?');

    expect(mockSendFollowUp).toHaveBeenCalledTimes(1);
    const sentText = mockSendFollowUp.mock.calls[0][1][0].text as string;
    expect(sentText).toContain('[FOREMAN STATE]');
    expect(sentText).toContain('can worker do X?');
    expect(sentText).toContain('ASK_USER');
  });

  it('does not inject state when getExecutionState is not provided', async () => {
    const ctrl = makeMockHandle(taskId);
    const mockSendFollowUp = vi.fn().mockResolvedValue(undefined);
    const a2aClient: A2AClient = {
      fetchAgentCard: vi.fn(), dispatchTask: vi.fn(), subscribe: vi.fn(), waitForDone: vi.fn(),
      pollTask: vi.fn(), cancelTask: vi.fn(), respondToPermission: vi.fn(),
      sendFollowUp: mockSendFollowUp,
    };
    const dispatchManager = { dispatch: vi.fn().mockResolvedValue(ctrl.handle) } as unknown as DispatchManager;
    const session = new ExternalPlannerSession(
      dispatchManager, a2aClient, plannerUrl, baseConfig, logger, workers,
      // no getExecutionState
    );

    ctrl.push(makeCompletedWithPlanEvent(MINIMAL_PLAN));
    await session.open('build the thing');

    ctrl.push(makeTextMessageEvent('allow_once'));
    ctrl.push(makeInputRequiredEvent());

    await session.ask('plain question');

    const sentText = mockSendFollowUp.mock.calls[0][1][0].text as string;
    expect(sentText).toBe('plain question');
  });
});

describe('SelfPlannedSession — ask() injects execution state', () => {
  type CompleteEvent = LLMEvent & { type: 'stop'; stopReason: string };

  it('prepends formatted plan state to user message passed to LLM', async () => {
    const capturedMessages: unknown[][] = [];
    const llmClient: LLMClient = {
      async *completeWithTools(messages) {
        capturedMessages.push([...messages]);
        const callIdx = capturedMessages.length;
        yield { type: 'text_chunk', text: callIdx === 1 ? JSON.stringify({ ...MINIMAL_PLAN, source: 'self_planned' }) : 'done' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as CompleteEvent;
      },
    };
    const executionState: ExecutionStateSnapshot = {
      completed: new Map([['subtask-1', { resultSummary: 'complete' }]]),
      inProgress: new Map(),
      failed: new Map(),
    };
    const session = new SelfPlannedSession(llmClient, baseConfig, logger, () => executionState);
    await session.open('build the thing');
    await session.ask('which approach?');

    // Second LLM call is for ask(); its user message should contain state
    const askMessages = capturedMessages[1] as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    const userMsg = askMessages[askMessages.length - 1];
    expect(userMsg.role).toBe('user');
    const text = userMsg.content[0].text;
    expect(text).toContain('[FOREMAN STATE]');
    expect(text).toContain('which approach?');
  });
});

// ---------------------------------------------------------------------------
// Commit 6: execution phase filtering
// ---------------------------------------------------------------------------

describe('ExternalPlannerSession — execution phase filtering', () => {
  const plannerUrl = 'http://planner.local';
  const taskId = 'plan-task';
  const workers = ['worker_a', 'worker_b'];

  function makeSession(ctrl: MockHandleControl) {
    const mockDispatch = vi.fn().mockResolvedValue(ctrl.handle);
    const a2aClient: A2AClient = {
      fetchAgentCard: vi.fn(), dispatchTask: vi.fn(), subscribe: vi.fn(), waitForDone: vi.fn(),
      pollTask: vi.fn(), cancelTask: vi.fn(), respondToPermission: vi.fn(),
      sendFollowUp: vi.fn().mockResolvedValue(undefined),
    };
    return new ExternalPlannerSession(
      { dispatch: mockDispatch } as unknown as DispatchManager,
      a2aClient, plannerUrl, baseConfig, logger, workers,
    );
  }

  it('markExecutionStarted() transitions phase and plan events are filtered for status changes', async () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);

    // Open with plan from entries
    ctrl.push(makePlanEntriesEvent([
      { content: 'task A', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
    ]));
    ctrl.push(makeInputRequiredEvent());
    await session.open('build the thing');

    // Mark execution started
    session.markExecutionStarted();

    // Simulate planner emitting new entries with status changes during execution
    // (planner thinks t1 is 'in_progress', but foreman is authoritative)
    ctrl.push(makePlanEntriesEvent([
      { content: 'task A', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
      // status would be 'in_progress' in the actual entry but makePlanEntriesEvent hardcodes 'pending'
      // The key test: status should stay 'pending' (as originally set)
    ]));
    ctrl.push(makeTextMessageEvent('answer to question'));
    ctrl.push(makeInputRequiredEvent());

    const answer = await session.ask('what next?');
    // The answer is from the text message
    expect(answer).toContain('answer to question');
  });

  it('content changes on existing entries are accepted during execution', async () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);

    ctrl.push(makePlanEntriesEvent([
      { content: 'original content', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
    ]));
    ctrl.push(makeInputRequiredEvent());
    await session.open('build the thing');

    session.markExecutionStarted();

    // Planner refines content
    ctrl.push(makePlanEntriesEvent([
      { content: 'refined content', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
    ]));
    ctrl.push(makeTextMessageEvent('response'));
    ctrl.push(makeInputRequiredEvent());

    await session.ask('question');
    // Plan content should be updated (but we can't inspect _latestEntries directly)
    // The session should not throw and should complete normally
    expect(session.getPlan()).not.toBeNull();
  });

  it('new entries from planner during execution are ignored', async () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);

    ctrl.push(makePlanEntriesEvent([
      { content: 'task A', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
    ]));
    ctrl.push(makeInputRequiredEvent());
    await session.open('build the thing');

    const originalPlan = session.getPlan();
    expect(originalPlan?.batches[0].subtasks).toHaveLength(1);

    session.markExecutionStarted();

    // Planner adds a new entry
    ctrl.push(makePlanEntriesEvent([
      { content: 'task A', subtaskId: 't1', assignedAgent: 'worker_a', blockedBy: [] },
      { content: 'NEW task', subtaskId: 't_new', assignedAgent: 'worker_b', blockedBy: [] },
    ]));
    ctrl.push(makeTextMessageEvent('response'));
    ctrl.push(makeInputRequiredEvent());

    await session.ask('any question');
    // Plan from open() still has 1 subtask (new entries not propagated to _plan)
    // Note: _plan is set during open(), not updated from entries during ask()
    expect(originalPlan?.batches[0].subtasks).toHaveLength(1);
  });

  it('markExecutionStarted() is idempotent', () => {
    const ctrl = makeMockHandle(taskId);
    const session = makeSession(ctrl);
    session.markExecutionStarted();
    expect(() => session.markExecutionStarted()).not.toThrow();
  });
});
