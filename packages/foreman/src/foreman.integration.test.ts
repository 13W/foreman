/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Mock-based integration test for the Foreman orchestrator.
 * Uses real SessionManager, PlanExecutor, PlannerSession, and Foreman.
 * Mocks ACPAgentServer (sendUpdate/requestPermission), DispatchManager.dispatch,
 * and AnthropicLLMClient.completeWithTools to drive controlled scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Foreman } from './foreman.js';
import { SessionManager } from './session/manager.js';
import { createPlannerSession, PlannerFallbackHandler } from './plan/index.js';
import type { FallbackChoice } from './plan/index.js';
import { DispatchHandle } from './workers/task-handle.js';
import type { StreamEvent, AgentCardMetadata } from '@foreman-stack/shared';
import type { LLMEvent } from './llm/client.js';

// Prevent real Anthropic SDK instantiation.
vi.mock('./llm/anthropic-client.js', () => ({
  AnthropicLLMClient: vi.fn().mockImplementation(() => ({
    completeWithTools: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Config + helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  foreman: { name: 'test-foreman', version: '0.0.1', working_dir: '/tmp' },
  llm: {
    backend: 'anthropic' as const,
    model: 'claude-3-5-haiku-20241022',
    api_key_env: 'ANTHROPIC_API_KEY',
    max_tokens_per_turn: 8192,
  },
  workers: [
    { url: 'http://planner.test' },
    { url: 'http://coder.test' },
    { url: 'http://tester.test' },
  ],
  mcps: { personal: [], injected: [] },
  runtime: {
    max_parallel_dispatches: 4,
    default_task_timeout_sec: 30,
    worker_discovery_timeout_sec: 5,
    max_concurrent_sessions: 4,
    planner_response_timeout_sec: 30,
  },
  logging: { level: 'error' as const, format: 'json' as const, destination: 'stderr' as const },
};

const PLANNER_CARD: AgentCardMetadata = {
  name: 'planner',
  url: 'http://planner.test',
  version: '1.0',
  skills: [{ id: 'task_decomposition', name: 'Task Decomposition', description: '', tags: [] }],
};
const CODER_CARD: AgentCardMetadata = {
  name: 'coder',
  url: 'http://coder.test',
  version: '1.0',
  skills: [],
};
const TESTER_CARD: AgentCardMetadata = {
  name: 'tester',
  url: 'http://tester.test',
  version: '1.0',
  skills: [],
};

function priv(instance: Foreman): any {
  return instance as any;
}

function makeHandle(
  taskId: string,
  url: string,
  events: StreamEvent[],
  cancelFn = vi.fn().mockResolvedValue(undefined) as () => Promise<void>,
): DispatchHandle {
  let doneResolve!: () => void;
  const donePromise = new Promise<void>((res) => { doneResolve = res; });

  return {
    taskId,
    agentUrl: url,
    onEvent(listener: (e: StreamEvent) => void): () => void {
      for (const e of events) listener(e);
      doneResolve();
      return () => {};
    },
    waitForDone(): Promise<void> { return donePromise; },
    cancel: cancelFn,
    release: vi.fn(),
  } as unknown as DispatchHandle;
}

function makeCompletedStatusEvent(taskId: string): StreamEvent {
  return {
    type: 'status',
    taskId,
    data: {
      state: 'completed',
      final: true,
      message: {
        role: 'agent',
        parts: [
          {
            kind: 'data',
            data: {
              status: 'completed',
              stop_reason: 'end_turn',
              summary: 'done',
              branch_ref: '',
              session_transcript_ref: '',
              error: null,
            },
          },
        ],
      },
    },
    timestamp: '',
  };
}

function makePlannerHandle(taskId: string): DispatchHandle {
  const planData = {
    plan_id: 'plan-1',
    originator_intent: 'Refactor auth and add tests',
    goal_summary: 'Refactor and test',
    source: 'external_planner',
    batches: [
      {
        batch_id: 'b1',
        subtasks: [
          {
            id: 's1',
            assigned_agent: 'coder',
            description: 'Refactor auth module',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          },
          {
            id: 's2',
            assigned_agent: 'tester',
            description: 'Add auth tests',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          },
        ],
      },
    ],
  };

  const event: StreamEvent = {
    type: 'status',
    taskId,
    data: {
      state: 'completed',
      final: true,
      message: {
        role: 'agent',
        parts: [{ kind: 'data', data: planData }],
      },
    },
    timestamp: '',
  };

  return makeHandle(taskId, 'http://planner.test', [event]);
}

/** Build a Foreman instance with pre-populated catalog (mocked agent cards). */
async function buildForeman(): Promise<Foreman> {
  const sessionManager = new SessionManager({
    maxConcurrentSessions: BASE_CONFIG.runtime.max_concurrent_sessions,
  });

  const foreman = new Foreman({
    config: BASE_CONFIG as never,
    sessionManager,
    plannerSessionFactory: createPlannerSession,
  });

  // Pre-populate catalog by mocking fetchAgentCard.
  vi.spyOn(priv(foreman).a2aClient, 'fetchAgentCard').mockImplementation(
    (async (url: any): Promise<AgentCardMetadata> => {
      if (url === 'http://planner.test') return PLANNER_CARD;
      if (url === 'http://coder.test') return CODER_CARD;
      if (url === 'http://tester.test') return TESTER_CARD;
      throw new Error(`Unknown agent URL: ${url}`);
    }) as any,
  );
  await priv(foreman).catalog.loadFromConfig(BASE_CONFIG.workers);

  // Silence ACP server methods so they don't throw on missing conn.
  vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'requestPermission').mockResolvedValue({
    optionId: 'allow_once',
    kind: 'allow_once' as const,
    name: 'Allow once',
  });

  return foreman;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('Foreman integration — happy path', () => {
  let foreman: Foreman;
  const SESSION_ID = 'test-session-1';

  beforeEach(async () => {
    foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes a 2-subtask plan and emits structured plan + tool_call updates', async () => {
    // With the programmatic planner path, the LLM is only called for synthesis.
    vi.spyOn(priv(foreman).llmClient, 'completeWithTools').mockImplementation(async function* () {
      yield { type: 'text_chunk', text: 'Done.' } as LLMEvent;
      yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent;
    });

    // Dispatch mock: planner → plan; coder + tester → success.
    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockImplementation(
      (async (url: any): Promise<DispatchHandle> => {
        if (url === 'http://planner.test') return makePlannerHandle('planner-task-1');
        if (url === 'http://coder.test') return makeHandle('coder-task-1', url, [makeCompletedStatusEvent('coder-task-1')]);
        if (url === 'http://tester.test') return makeHandle('tester-task-1', url, [makeCompletedStatusEvent('tester-task-1')]);
        throw new Error(`Unexpected dispatch to ${url}`);
      }) as any,
    );

    // Capture structured ACP updates.
    const sendUpdates: string[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      (async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      }) as any,
    );

    const planCalls: any[][] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockImplementation(
      (async (_sid: any, entries: any) => { planCalls.push(entries); }) as any,
    );

    const toolCallCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockImplementation(
      (async (_sid: any, tc: any) => { toolCallCalls.push(tc); }) as any,
    );

    const toolCallUpdateCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockImplementation(
      (async (_sid: any, upd: any) => { toolCallUpdateCalls.push(upd); }) as any,
    );

    await priv(foreman)._handlePrompt(SESSION_ID, [
      { type: 'text', text: 'Refactor auth and add tests' },
    ]);

    // _runWithExternalPlanner sends "Dispatching to [planner]..." which contains "[planner]"
    expect(sendUpdates.some((u) => u.includes('[planner]'))).toBe(true);
    // "Done." is the final synthesis update.
    expect(sendUpdates[sendUpdates.length - 1]).toBe('Done.');

    // Plan was emitted at least once (initial + updates)
    expect(planCalls.length).toBeGreaterThan(0);
    // Initial plan has both subtasks pending
    const initialPlan = planCalls[0];
    expect(initialPlan).toHaveLength(2);
    expect(initialPlan[0].status).toBe('pending');
    expect(initialPlan[1].status).toBe('pending');

    // A tool_call was emitted for each subtask (coder + tester)
    expect(toolCallCalls).toHaveLength(2);
    const toolCallIds = toolCallCalls.map((tc: any) => tc.toolCallId);
    expect(toolCallIds).toContain('s1');
    expect(toolCallIds).toContain('s2');
    // Each tool_call has status in_progress and kind execute
    for (const tc of toolCallCalls) {
      expect(tc.status).toBe('in_progress');
      expect(tc.kind).toBe('execute');
    }

    // Terminal tool_call_updates mark both subtasks completed
    const terminalUpdates = toolCallUpdateCalls.filter((u: any) => u.status === 'completed');
    expect(terminalUpdates.length).toBeGreaterThanOrEqual(2);

    // Final plan has all entries completed
    const finalPlan = planCalls[planCalls.length - 1];
    expect(finalPlan.every((e: any) => e.status === 'completed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Programmatic planner path — unit-level tests
// ---------------------------------------------------------------------------

describe('Foreman integration — has-planner programmatic dispatch', () => {
  const SESSION_ID = 'planner-dispatch-session';

  afterEach(() => { vi.restoreAllMocks(); });

  it('calls plannerSessionFactory with external_planner mode and executes the plan', async () => {
    const foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    const mockPlannerSession = {
      mode: 'external_planner' as const,
      taskId: 'planner-task-p1',
      open: vi.fn().mockResolvedValue(undefined),
      ask: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue({
        plan_id: 'p1',
        originator_intent: 'do work',
        goal_summary: 'Do it',
        source: 'external_planner',
        batches: [{
          batch_id: 'b1',
          subtasks: [{
            id: 's1',
            assigned_agent: 'coder',
            description: 'write code',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          }],
        }],
      }),
      getPendingQuestion: vi.fn().mockReturnValue(null),
      resumeWithAnswer: vi.fn(),
      markExecutionStarted: vi.fn(),
    };

    const factorySpy = vi.fn().mockReturnValue(mockPlannerSession);
    priv(foreman).plannerSessionFactory = factorySpy;

    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockImplementation(
      (async (url: any) => {
        if (url === 'http://coder.test')
          return makeHandle('coder-task-p1', url, [makeCompletedStatusEvent('coder-task-p1')]);
        throw new Error(`Unexpected dispatch to ${url}`);
      }) as any,
    );

    priv(foreman).llmClient = {
      completeWithTools: async function* () {
        yield { type: 'text_chunk', text: 'done' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent;
      },
    };

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do work' }]);

    // plannerSessionFactory called with external_planner mode pointing to planner URL
    expect(factorySpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'external_planner',
      plannerUrl: 'http://planner.test',
    }));
    // plannerSession.open was called with the decomposition request
    expect(mockPlannerSession.open).toHaveBeenCalledWith(expect.stringContaining('do work'));
  });

  it('forwards pending question to user and suspends without executing plan', async () => {
    const foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    const mockPlannerSession = {
      mode: 'external_planner' as const,
      taskId: 'planner-task-q1',
      open: vi.fn().mockResolvedValue(undefined),
      ask: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(null),
      getPendingQuestion: vi.fn().mockReturnValue('Which branch should I use?'),
      resumeWithAnswer: vi.fn(),
      markExecutionStarted: vi.fn(),
    };
    priv(foreman).plannerSessionFactory = vi.fn().mockReturnValue(mockPlannerSession);

    const sendUpdates: string[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      (async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      }) as any,
    );
    const dispatchSpy = vi.spyOn(priv(foreman).dispatchManager, 'dispatch');

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do work' }]);

    // Planner question was forwarded to user
    expect(sendUpdates.some((u) => u.includes('Which branch should I use?'))).toBe(true);
    // No worker dispatch happened
    expect(dispatchSpy).not.toHaveBeenCalled();
    // sessionState has pending question set
    const state = priv(foreman).sessionManager.get(SESSION_ID);
    expect(state.pendingPlannerQuestion).toBe('Which branch should I use?');
  });

  it('handles planner open() failure gracefully', async () => {
    const foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    const mockPlannerSession = {
      mode: 'external_planner' as const,
      taskId: null,
      open: vi.fn().mockRejectedValue(new Error('planner unreachable')),
      ask: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(null),
      getPendingQuestion: vi.fn().mockReturnValue(null),
      resumeWithAnswer: vi.fn(),
      markExecutionStarted: vi.fn(),
    };
    priv(foreman).plannerSessionFactory = vi.fn().mockReturnValue(mockPlannerSession);

    const sendUpdates: string[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      (async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      }) as any,
    );

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do work' }]);

    // Error message sent to user
    expect(sendUpdates.some((u) => u.includes('planner unreachable'))).toBe(true);
    // Session cleaned up
    expect(mockPlannerSession.close).toHaveBeenCalled();
  });

  it('picks the first planner deterministically when multiple planners are available', async () => {
    // Build a foreman with two planners registered.
    const TWO_PLANNER_CONFIG = {
      ...BASE_CONFIG,
      workers: [
        { url: 'http://planner.test' },
        { url: 'http://planner2.test' },
        { url: 'http://coder.test' },
      ],
    };
    const PLANNER2_CARD: AgentCardMetadata = {
      name: 'planner2',
      url: 'http://planner2.test',
      version: '1.0',
      skills: [{ id: 'task_decomposition', name: 'Task Decomposition', description: '', tags: [] }],
    };

    const sessionManager = new SessionManager({ maxConcurrentSessions: 4 });
    const foreman = new Foreman({
      config: TWO_PLANNER_CONFIG as never,
      sessionManager,
      plannerSessionFactory: createPlannerSession,
    });

    vi.spyOn(priv(foreman).a2aClient, 'fetchAgentCard').mockImplementation(
      (async (url: any): Promise<AgentCardMetadata> => {
        if (url === 'http://planner.test') return PLANNER_CARD;
        if (url === 'http://planner2.test') return PLANNER2_CARD;
        if (url === 'http://coder.test') return CODER_CARD;
        throw new Error(`Unknown agent URL: ${url}`);
      }) as any,
    );
    await priv(foreman).catalog.loadFromConfig(TWO_PLANNER_CONFIG.workers);

    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockResolvedValue(undefined);
    vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockResolvedValue(undefined);
    vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockResolvedValue(undefined);
    vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockResolvedValue(undefined);

    sessionManager.create(SESSION_ID, '/tmp');

    const factorySpy = vi.fn().mockReturnValue({
      mode: 'external_planner' as const,
      taskId: null,
      open: vi.fn().mockResolvedValue(undefined),
      ask: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(null),
      getPendingQuestion: vi.fn().mockReturnValue('clarify?'),
      resumeWithAnswer: vi.fn(),
      markExecutionStarted: vi.fn(),
    });
    priv(foreman).plannerSessionFactory = factorySpy;

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do work' }]);

    // First planner (http://planner.test) is picked
    expect(factorySpy).toHaveBeenCalledWith(expect.objectContaining({
      plannerUrl: 'http://planner.test',
    }));
    // Second planner was not used
    const calls = factorySpy.mock.calls as Array<[{ plannerUrl?: string }]>;
    expect(calls.every((c) => c[0].plannerUrl !== 'http://planner2.test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('Foreman integration — cancel mid-execution', () => {
  let foreman: Foreman;
  const SESSION_ID = 'cancel-session';

  beforeEach(async () => {
    foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closing the session cancels active dispatch handles', async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined) as () => Promise<void>;
    const slowHandle = makeHandle(
      'slow-task',
      'http://coder.test',
      [makeCompletedStatusEvent('slow-task')],
      cancelFn,
    );

    // Register handle directly in sessionState to simulate mid-execution.
    const state = priv(foreman).sessionManager.get(SESSION_ID);
    state.activeDispatchHandles.set('slow-task', slowHandle);

    await priv(foreman)._handleCancel(SESSION_ID);

    expect(cancelFn).toHaveBeenCalled();
    // Session should be removed from the manager.
    expect(priv(foreman).sessionManager.get(SESSION_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permission escalation — plan owner resolves directly
// ---------------------------------------------------------------------------

describe('Foreman integration — plan owner resolves permission', () => {
  let foreman: Foreman;
  const SESSION_ID = 'escalation-session-1';

  beforeEach(async () => {
    foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plan owner answers with valid JSON decision — no user permission requested', async () => {
    // Stub a plannerSession that resolves permission without user involvement.
    const mockPlannerSession = {
      mode: 'external_planner' as const,
      taskId: 'planner-task-x',
      open: vi.fn(),
      ask: vi.fn().mockResolvedValue('{"kind":"allow_once"}'),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(null),
    };
    priv(foreman)._plannerSessions.set(SESSION_ID, mockPlannerSession);

    const requestPermSpy = vi.spyOn(priv(foreman).acpServer, 'requestPermission');
    const respondSpy = vi
      .spyOn(priv(foreman).a2aClient, 'respondToPermission')
      .mockResolvedValue(undefined);

    await priv(foreman)._handleWorkerEscalation(
      'worker-task-1',
      { type: 'fs.write', path: '/tmp/foo.ts', message: 'Write file' },
      SESSION_ID,
    );

    // Plan owner answered directly — user should NOT have been asked.
    expect(requestPermSpy).not.toHaveBeenCalled();
    expect(respondSpy).toHaveBeenCalledWith('worker-task-1', { kind: 'allow_once' });
  });
});

// ---------------------------------------------------------------------------
// Permission escalation — plan owner defers to user
// ---------------------------------------------------------------------------

describe('Foreman integration — plan owner defers to user', () => {
  let foreman: Foreman;
  const SESSION_ID = 'escalation-session-2';

  beforeEach(async () => {
    foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plan owner returns "ask_user" — falls back to user permission request', async () => {
    const mockPlannerSession = {
      mode: 'external_planner' as const,
      taskId: 'planner-task-y',
      open: vi.fn(),
      ask: vi.fn().mockResolvedValue('ask_user'),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(null),
    };
    priv(foreman)._plannerSessions.set(SESSION_ID, mockPlannerSession);

    const requestPermSpy = vi
      .spyOn(priv(foreman).acpServer, 'requestPermission')
      .mockResolvedValue({ optionId: 'reject_once', kind: 'reject_once' as const, name: 'Reject' });
    const respondSpy = vi
      .spyOn(priv(foreman).a2aClient, 'respondToPermission')
      .mockResolvedValue(undefined);

    await priv(foreman)._handleWorkerEscalation(
      'worker-task-2',
      { type: 'terminal.create', command: 'rm', message: 'Remove file' },
      SESSION_ID,
    );

    // User WAS asked.
    expect(requestPermSpy).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ type: 'terminal.create' }));
    // Response routed back to worker.
    expect(respondSpy).toHaveBeenCalledWith('worker-task-2', { kind: 'reject_once' });
  });

  it('plan owner throws — falls back to user permission request', async () => {
    const mockPlannerSession = {
      mode: 'external_planner' as const,
      taskId: 'planner-task-z',
      open: vi.fn(),
      ask: vi.fn().mockRejectedValue(new Error('planner timeout')),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(null),
    };
    priv(foreman)._plannerSessions.set(SESSION_ID, mockPlannerSession);

    const requestPermSpy = vi
      .spyOn(priv(foreman).acpServer, 'requestPermission')
      .mockResolvedValue({ optionId: 'allow_once', kind: 'allow_once' as const, name: 'Allow once' });
    const respondSpy = vi
      .spyOn(priv(foreman).a2aClient, 'respondToPermission')
      .mockResolvedValue(undefined);

    await priv(foreman)._handleWorkerEscalation(
      'worker-task-3',
      { type: 'fs.read', path: '/secret', message: 'Read file' },
      SESSION_ID,
    );

    expect(requestPermSpy).toHaveBeenCalled();
    expect(respondSpy).toHaveBeenCalledWith('worker-task-3', { kind: 'allow_once' });
  });
});

// ---------------------------------------------------------------------------
// No-planner fallback path
// ---------------------------------------------------------------------------

const NO_PLANNER_CONFIG = {
  ...BASE_CONFIG,
  workers: [
    { url: 'http://coder.test' },
    { url: 'http://tester.test' },
  ],
};

function makeMockFallbackHandler(choice: FallbackChoice): PlannerFallbackHandler {
  return { ask: vi.fn().mockResolvedValue(choice) } as unknown as PlannerFallbackHandler;
}

async function buildForemanNoPlanner(
  fallbackHandler: PlannerFallbackHandler,
): Promise<Foreman> {
  const sessionManager = new SessionManager({
    maxConcurrentSessions: NO_PLANNER_CONFIG.runtime.max_concurrent_sessions,
  });

  const foreman = new Foreman({
    config: NO_PLANNER_CONFIG as never,
    sessionManager,
    plannerSessionFactory: createPlannerSession,
    fallbackHandler,
  });

  vi.spyOn(priv(foreman).a2aClient, 'fetchAgentCard').mockImplementation(
    (async (url: any): Promise<AgentCardMetadata> => {
      if (url === 'http://coder.test') return CODER_CARD;
      if (url === 'http://tester.test') return TESTER_CARD;
      throw new Error(`Unknown agent URL: ${url}`);
    }) as any,
  );
  await priv(foreman).catalog.loadFromConfig(NO_PLANNER_CONFIG.workers);

  vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockResolvedValue(undefined);
  vi.spyOn(priv(foreman).acpServer, 'requestPermission').mockResolvedValue({
    optionId: 'allow_once',
    kind: 'allow_once' as const,
    name: 'Allow once',
  });

  return foreman;
}

describe('Foreman integration — no-planner fallback: cancel', () => {
  const SESSION_ID = 'fallback-cancel-session';

  afterEach(() => { vi.restoreAllMocks(); });

  it('emits cancellation update and returns when user picks cancel', async () => {
    const fallbackHandler = makeMockFallbackHandler({ kind: 'cancel' });
    const foreman = await buildForemanNoPlanner(fallbackHandler);
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    const sendUpdates: string[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      (async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      }) as any,
    );

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do something' }]);

    expect(fallbackHandler.ask).toHaveBeenCalledWith(SESSION_ID, 'do something');
    expect(sendUpdates).toEqual(['Task cancelled.']);
  });
});

describe('Foreman integration — no-planner fallback: self_plan', () => {
  const SESSION_ID = 'fallback-self-plan-session';

  afterEach(() => { vi.restoreAllMocks(); });

  it('executes self-generated plan when user picks self_plan', async () => {
    const selfPlan = {
      plan_id: 'self-plan-1',
      originator_intent: 'do something',
      goal_summary: 'Do it',
      source: 'self_planned',
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 's1',
              assigned_agent: 'coder',
              description: 'implement it',
              expected_output: null,
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
            },
          ],
        },
      ],
    };

    const mockPlannerSession = {
      mode: 'self_planned' as const,
      taskId: null,
      open: vi.fn().mockResolvedValue(undefined),
      ask: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      getPlan: vi.fn().mockReturnValue(selfPlan),
      getPendingQuestion: vi.fn().mockReturnValue(null),
      resumeWithAnswer: vi.fn().mockResolvedValue(undefined),
      markExecutionStarted: vi.fn(),
    };

    const fallbackHandler = makeMockFallbackHandler({ kind: 'self_plan' });
    const foreman = await buildForemanNoPlanner(fallbackHandler);
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    // Inject mock plannerSessionFactory so self_planned returns our mock.
    priv(foreman).plannerSessionFactory = vi.fn().mockReturnValue(mockPlannerSession);

    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockImplementation(
      (async (url: any) => {
        if (url === 'http://coder.test')
          return makeHandle('coder-task-1', url, [makeCompletedStatusEvent('coder-task-1')]);
        throw new Error(`Unexpected dispatch to ${url}`);
      }) as any,
    );

    // Synthesis LLM turn.
    priv(foreman).llmClient = {
      completeWithTools: async function* () {
        yield { type: 'text_chunk', text: 'Self-plan done.' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent;
      },
    };

    const sendUpdates: string[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      (async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      }) as any,
    );

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do something' }]);

    expect(mockPlannerSession.open).toHaveBeenCalledWith(expect.stringContaining('do something'));
    expect(sendUpdates[sendUpdates.length - 1]).toBe('Self-plan done.');
  });
});

describe('Foreman integration — no-planner fallback: dispatch_whole', () => {
  const SESSION_ID = 'fallback-dispatch-whole-session';

  afterEach(() => { vi.restoreAllMocks(); });

  it('executes synthetic single-subtask plan when user picks dispatch_whole', async () => {
    const syntheticPlan = {
      plan_id: 'synthetic-plan-1',
      originator_intent: 'do something',
      goal_summary: 'Dispatching whole task as a single subtask.',
      source: 'single_task_dispatch',
      batches: [
        {
          batch_id: 'batch-0',
          subtasks: [
            {
              id: 'whole_task',
              assigned_agent: 'coder',
              description: 'do something',
              expected_output: 'Task completed.',
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
            },
          ],
        },
      ],
    };

    const fallbackHandler = makeMockFallbackHandler({ kind: 'dispatch_whole', plan: syntheticPlan as never });
    const foreman = await buildForemanNoPlanner(fallbackHandler);
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockImplementation(
      (async (url: any) => {
        if (url === 'http://coder.test')
          return makeHandle('coder-task-2', url, [makeCompletedStatusEvent('coder-task-2')]);
        throw new Error(`Unexpected dispatch to ${url}`);
      }) as any,
    );

    priv(foreman).llmClient = {
      completeWithTools: async function* () {
        yield { type: 'text_chunk', text: 'Dispatch-whole done.' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent;
      },
    };

    const sendUpdates: string[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      (async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      }) as any,
    );

    const toolCallCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockImplementation(
      (async (_sid: any, tc: any) => { toolCallCalls.push(tc); }) as any,
    );

    await priv(foreman)._handlePrompt(SESSION_ID, [{ type: 'text', text: 'do something' }]);

    // Coder subtask was dispatched as a tool_call (not bracketed text spam)
    expect(toolCallCalls.some((tc: any) => String(tc.title).toLowerCase().includes('coder'))).toBe(true);
    expect(sendUpdates[sendUpdates.length - 1]).toBe('Dispatch-whole done.');
  });
});

// ---------------------------------------------------------------------------
// Plan visualization — direct _executePlan tests
// ---------------------------------------------------------------------------

function makePlan2Subtasks() {
  return {
    plan_id: 'viz-plan-1',
    originator_intent: 'test visualization',
    goal_summary: 'Visualize plan',
    source: 'external_planner' as const,
    batches: [
      {
        batch_id: 'b1',
        subtasks: [
          {
            id: 's1',
            assigned_agent: 'coder',
            description: 'Refactor auth module',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          },
          {
            id: 's2',
            assigned_agent: 'tester',
            description: 'Add auth tests',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          },
        ],
      },
    ],
  };
}

describe('Foreman integration — plan visualization: happy path', () => {
  const SESSION_ID = 'viz-happy-session';

  afterEach(() => { vi.restoreAllMocks(); });

  it('emits sendPlan before execution, sendToolCall per subtask, terminal completed updates', async () => {
    const foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    // Synthesis LLM
    priv(foreman).llmClient = {
      completeWithTools: async function* () {
        yield { type: 'text_chunk', text: 'All done.' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent;
      },
    };

    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockImplementation(
      (async (url: any) => {
        if (url === 'http://coder.test')
          return makeHandle('coder-task-v1', url, [makeCompletedStatusEvent('coder-task-v1')]);
        if (url === 'http://tester.test')
          return makeHandle('tester-task-v1', url, [makeCompletedStatusEvent('tester-task-v1')]);
        throw new Error(`Unexpected dispatch to ${url}`);
      }) as any,
    );

    const planCalls: any[][] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockImplementation(
      (async (_sid: any, entries: any) => { planCalls.push(entries); }) as any,
    );

    const toolCallCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockImplementation(
      (async (_sid: any, tc: any) => { toolCallCalls.push(tc); }) as any,
    );

    const toolCallUpdateCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockImplementation(
      (async (_sid: any, upd: any) => { toolCallUpdateCalls.push(upd); }) as any,
    );

    const plan = makePlan2Subtasks();
    const state = priv(foreman).sessionManager.get(SESSION_ID);
    const available = priv(foreman).catalog.getAvailable();

    await priv(foreman)._executePlan(plan, SESSION_ID, state, 'test viz', available);

    // Initial plan emitted with both entries pending
    expect(planCalls.length).toBeGreaterThan(0);
    expect(planCalls[0]).toHaveLength(2);
    expect(planCalls[0][0].status).toBe('pending');
    expect(planCalls[0][1].status).toBe('pending');

    // One tool_call per subtask
    expect(toolCallCalls).toHaveLength(2);
    expect(toolCallCalls.map((tc: any) => tc.toolCallId)).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(toolCallCalls.every((tc: any) => tc.status === 'in_progress')).toBe(true);
    expect(toolCallCalls.every((tc: any) => tc.kind === 'execute')).toBe(true);

    // Terminal tool_call_updates with completed status
    const completedUpdates = toolCallUpdateCalls.filter((u: any) => u.status === 'completed');
    expect(completedUpdates.map((u: any) => u.toolCallId)).toEqual(expect.arrayContaining(['s1', 's2']));

    // Final plan has all entries completed
    const finalPlan = planCalls[planCalls.length - 1];
    expect(finalPlan.every((e: any) => e.status === 'completed')).toBe(true);
  });
});

describe('Foreman integration — plan visualization: failure scenario', () => {
  const SESSION_ID = 'viz-fail-session';

  afterEach(() => { vi.restoreAllMocks(); });

  it('marks failed subtask and sibling with failed status on PlanAbortedError', async () => {
    const foreman = await buildForeman();
    priv(foreman).sessionManager.create(SESSION_ID, '/tmp');

    // Synthesis LLM
    priv(foreman).llmClient = {
      completeWithTools: async function* () {
        yield { type: 'text_chunk', text: 'Failed.' } as LLMEvent;
        yield { type: 'stop', stopReason: 'end_turn' } as LLMEvent;
      },
    };

    const failedResult = {
      status: 'failed' as const,
      stop_reason: 'subprocess_crash' as const,
      summary: 'coder failed',
      branch_ref: '',
      session_transcript_ref: '',
      error: { code: 'compile_error', message: 'compile error' },
    };
    const failedStatusEvent: StreamEvent = {
      type: 'status',
      taskId: 'coder-task-f1',
      data: {
        state: 'failed',
        final: true,
        message: {
          role: 'agent',
          parts: [{ kind: 'data', data: failedResult }],
        },
      },
      timestamp: '',
    };

    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockImplementation(
      (async (url: any) => {
        if (url === 'http://coder.test')
          return makeHandle('coder-task-f1', url, [failedStatusEvent]);
        if (url === 'http://tester.test')
          return makeHandle('tester-task-f1', url, [makeCompletedStatusEvent('tester-task-f1')]);
        throw new Error(`Unexpected dispatch to ${url}`);
      }) as any,
    );

    const planCalls: any[][] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockImplementation(
      (async (_sid: any, entries: any) => { planCalls.push(entries); }) as any,
    );

    const toolCallCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockImplementation(
      (async (_sid: any, tc: any) => { toolCallCalls.push(tc); }) as any,
    );

    const toolCallUpdateCalls: any[] = [];
    vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockImplementation(
      (async (_sid: any, upd: any) => { toolCallUpdateCalls.push(upd); }) as any,
    );

    const plan = makePlan2Subtasks();
    const state = priv(foreman).sessionManager.get(SESSION_ID);
    const available = priv(foreman).catalog.getAvailable();

    await priv(foreman)._executePlan(plan, SESSION_ID, state, 'test viz fail', available);

    // Failed subtask gets a 'failed' tool_call_update
    const failedUpdates = toolCallUpdateCalls.filter((u: any) => u.status === 'failed');
    expect(failedUpdates.length).toBeGreaterThanOrEqual(1);
    expect(failedUpdates.some((u: any) => u.toolCallId === 's1')).toBe(true);

    // Plan was emitted at least once
    expect(planCalls.length).toBeGreaterThan(0);
    // Initial plan has pending entries
    expect(planCalls[0][0].status).toBe('pending');
  });
});
