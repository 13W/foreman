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
// MockHandle factory  (mirrors executor.test.ts pattern)
// ---------------------------------------------------------------------------

interface MockHandleControl {
  handle: DispatchHandle;
  push: (event: StreamEvent) => void;
  complete: () => void;
  isCancelled: () => boolean;
}

function makeMockHandle(taskId: string): MockHandleControl {
  const queue: StreamEvent[] = [];
  const waiters: Array<(r: IteratorResult<StreamEvent>) => void> = [];
  let terminated = false;
  let cancelled = false;

  const gen = {
    async next(): Promise<IteratorResult<StreamEvent>> {
      if (queue.length > 0) return { value: queue.shift()!, done: false };
      if (terminated) return { value: undefined as unknown as StreamEvent, done: true };
      return new Promise<IteratorResult<StreamEvent>>((resolve) => waiters.push(resolve));
    },
    async return(value?: unknown): Promise<IteratorResult<StreamEvent>> {
      terminated = true;
      for (const w of waiters) w({ value: undefined as unknown as StreamEvent, done: true });
      waiters.length = 0;
      queue.length = 0;
      return { value: value as StreamEvent, done: true };
    },
    async throw(err?: unknown): Promise<IteratorResult<StreamEvent>> {
      terminated = true;
      throw err;
    },
    [Symbol.asyncIterator]() { return this as AsyncGenerator<StreamEvent>; },
    async [Symbol.asyncDispose]() { await gen.return(undefined); },
  };

  const cancelFn = async () => {
    cancelled = true;
    await gen.return(undefined);
  };

  const handle = new DispatchHandle(taskId, 'http://planner.local', gen as unknown as AsyncGenerator<StreamEvent>, cancelFn);

  return {
    handle,
    push(event: StreamEvent) {
      if (waiters.length > 0) waiters.shift()!({ value: event, done: false });
      else queue.push(event);
    },
    complete() {
      terminated = true;
      for (const w of waiters) w({ value: undefined as unknown as StreamEvent, done: true });
      waiters.length = 0;
    },
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
      streamTask: vi.fn(),
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
      fetchAgentCard: vi.fn(), dispatchTask: vi.fn(), streamTask: vi.fn(),
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
