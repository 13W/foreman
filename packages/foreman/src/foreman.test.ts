/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Foreman } from './foreman.js';
import { SessionManager } from './session/manager.js';
import { SessionState } from './session/state.js';
import { DispatchHandle } from './workers/task-handle.js';
import type { StreamEvent, TaskResult, TaskPayload, AgentCardMetadata } from '@foreman-stack/shared';

// Prevent real Anthropic SDK instantiation.
vi.mock('./llm/anthropic-client.js', () => ({
  AnthropicLLMClient: vi.fn().mockImplementation(() => ({
    complete: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Minimal config stub
// ---------------------------------------------------------------------------

const minimalConfig = {
  foreman: { name: 'test-foreman', version: '0.0.1', working_dir: '/tmp' },
  llm: {
    backend: 'anthropic' as const,
    model: 'claude-3-5-haiku-20241022',
    api_key_env: 'ANTHROPIC_API_KEY',
    max_tokens_per_turn: 8192,
  },
  workers: [],
  mcps: { personal: [], injected: [] },
  runtime: {
    max_parallel_dispatches: 2,
    default_task_timeout_sec: 30,
    worker_discovery_timeout_sec: 5,
    max_concurrent_sessions: 4,
    planner_response_timeout_sec: 300,
  },
  logging: { level: 'info' as const, format: 'json' as const, destination: 'stderr' as const },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTaskResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    status: 'completed',
    stop_reason: 'end_turn',
    summary: 'done',
    branch_ref: 'refs/heads/main',
    session_transcript_ref: '',
    error: null,
    ...overrides,
  };
}

function makeStatusEvent(taskId: string, taskResult: TaskResult): StreamEvent {
  return {
    type: 'status',
    taskId,
    data: {
      state: taskResult.status,
      final: true,
      message: {
        role: 'agent',
        parts: [{ kind: 'data', data: taskResult }],
      },
    },
    timestamp: '',
  };
}

function makeHandle(taskId: string, events: StreamEvent[], cancelFn = vi.fn().mockResolvedValue(undefined)): DispatchHandle {
  let doneResolve!: () => void;
  const donePromise = new Promise<void>((res) => { doneResolve = res; });

  return {
    taskId,
    agentUrl: 'http://worker.test',
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

/** Access private members for testing without type errors. */
function priv(instance: Foreman): any {
  return instance as any;
}

// ---------------------------------------------------------------------------
// _runWorkerTask tests
// ---------------------------------------------------------------------------

describe('Foreman._runWorkerTask', () => {
  let foreman: Foreman;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const sessionManager = new SessionManager({
      maxConcurrentSessions: minimalConfig.runtime.max_concurrent_sessions,
    });
    foreman = new Foreman({
      config: minimalConfig as never,
      sessionManager,
      plannerSessionFactory: vi.fn(),
    });
  });

  it('parses TaskResult from terminal status message', async () => {
    const expected = makeTaskResult({ summary: 'all good' });
    const handle = makeHandle('task-1', [makeStatusEvent('task-1', expected)]);
    dispatchSpy = vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockResolvedValue(handle);

    const sessionState = new SessionState('session-1', '/tmp');
    const result = await priv(foreman)._runWorkerTask(
      'http://worker.test',
      {} as TaskPayload,
      'session-1',
      sessionState,
      undefined,
    );

    expect(result).toEqual(expected);
    dispatchSpy.mockRestore();
  });

  it('returns synthetic completed result when no status TaskResult is present', async () => {
    const msgEvent: StreamEvent = {
      type: 'message',
      taskId: 'task-2',
      data: { parts: [{ kind: 'text', text: 'hello from worker' }] },
      timestamp: '',
    };
    const handle = makeHandle('task-2', [msgEvent]);
    dispatchSpy = vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockResolvedValue(handle);

    const sessionState = new SessionState('session-1', '/tmp');
    const result = await priv(foreman)._runWorkerTask(
      'http://worker.test',
      {} as TaskPayload,
      'session-1',
      sessionState,
      undefined,
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('hello from worker');
    dispatchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// _handleSessionNew tests
// ---------------------------------------------------------------------------

describe('Foreman._handleSessionNew', () => {
  let foreman: Foreman;
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager({
      maxConcurrentSessions: minimalConfig.runtime.max_concurrent_sessions,
    });
    foreman = new Foreman({
      config: minimalConfig as never,
      sessionManager,
      plannerSessionFactory: vi.fn(),
    });
  });

  it('creates session with the provided cwd', () => {
    const createSpy = vi.spyOn(sessionManager, 'create');

    priv(foreman)._handleSessionNew('session-1', '/home/user/myproject');

    expect(createSpy).toHaveBeenCalledWith('session-1', '/home/user/myproject');
  });

  it('falls back to process.cwd() when cwd is null', () => {
    const createSpy = vi.spyOn(sessionManager, 'create');

    priv(foreman)._handleSessionNew('session-2', null);

    expect(createSpy).toHaveBeenCalledWith('session-2', process.cwd());
  });

  it('stores the cwd on the resulting SessionState', () => {
    priv(foreman)._handleSessionNew('session-3', '/path/to/project');

    const state = sessionManager.get('session-3');
    expect(state?.cwd).toBe('/path/to/project');
  });
});

// ---------------------------------------------------------------------------
// _runMergePhase tests
// ---------------------------------------------------------------------------

const CLAUDE_AGENT_CARD: AgentCardMetadata = {
  name: 'claude_agent',
  url: 'http://claude-agent.test',
  version: '1.0',
  skills: [],
};

const CLAUDE_AGENT_ENTRY = {
  url: 'http://claude-agent.test',
  name_hint: 'claude_agent',
  agent_card: CLAUDE_AGENT_CARD,
  status: 'available' as const,
  last_check_at: new Date(),
};

const MERGE_BRANCHES = [
  { subtaskId: 's1', branchRef: 'foreman/task-aaa', description: 'feature A' },
  { subtaskId: 's2', branchRef: 'foreman/task-bbb', description: 'feature B' },
];

describe('Foreman._runMergePhase', () => {
  let foreman: Foreman;
  let sendUpdates: string[];
  const SESSION_ID = 'merge-session';

  beforeEach(() => {
    const sessionManager = new SessionManager({
      maxConcurrentSessions: minimalConfig.runtime.max_concurrent_sessions,
    });
    foreman = new Foreman({
      config: minimalConfig as never,
      sessionManager,
      plannerSessionFactory: vi.fn(),
    });
    sessionManager.create(SESSION_ID, '/repo');

    sendUpdates = [];
    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockImplementation(
      async (_sid: any, content: any) => {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === 'text' && block.text) sendUpdates.push(block.text);
        }
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: dispatches merge task and surfaces "Auto-merge completed"', async () => {
    vi.spyOn(priv(foreman).catalog, 'getAvailable').mockReturnValue([CLAUDE_AGENT_ENTRY]);

    const mergeResult = makeTaskResult({ summary: 'merged 2 branches into main' });
    const handle = makeHandle('merge-task-1', [makeStatusEvent('merge-task-1', mergeResult)]);
    const dispatchSpy = vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockResolvedValue(handle);

    const state = priv(foreman).sessionManager.get(SESSION_ID);
    await priv(foreman)._runMergePhase(SESSION_ID, state, MERGE_BRANCHES, 'main', 'add features');

    expect(dispatchSpy).toHaveBeenCalledWith(
      'http://claude-agent.test',
      expect.objectContaining({ description: expect.stringContaining('git merge') }),
    );
    expect(sendUpdates.some((u) => u.includes('Auto-merge completed'))).toBe(true);
    expect(sendUpdates.some((u) => u.includes('merged 2 branches into main'))).toBe(true);
  });

  it('conflict path: surfaces "Auto-merge stopped" and branch list, no error thrown', async () => {
    vi.spyOn(priv(foreman).catalog, 'getAvailable').mockReturnValue([CLAUDE_AGENT_ENTRY]);

    const mergeResult = makeTaskResult({
      status: 'failed',
      stop_reason: 'end_turn',
      summary: 'CONFLICT on foreman/task-aaa, files: src/foo.ts',
      branch_ref: '',
      error: null,
    });
    const handle = makeHandle('merge-task-2', [makeStatusEvent('merge-task-2', mergeResult)]);
    vi.spyOn(priv(foreman).dispatchManager, 'dispatch').mockResolvedValue(handle);

    const state = priv(foreman).sessionManager.get(SESSION_ID);
    await expect(
      priv(foreman)._runMergePhase(SESSION_ID, state, MERGE_BRANCHES, 'main', 'add features'),
    ).resolves.toBeUndefined();

    expect(sendUpdates.some((u) => u.includes('Auto-merge stopped'))).toBe(true);
    expect(sendUpdates.some((u) => u.includes('CONFLICT on foreman/task-aaa'))).toBe(true);
    expect(sendUpdates.some((u) => u.includes('foreman/task-aaa'))).toBe(true);
    expect(sendUpdates.some((u) => u.includes('foreman/task-bbb'))).toBe(true);
  });

  it('no claude worker: sends skip message without dispatching', async () => {
    vi.spyOn(priv(foreman).catalog, 'getAvailable').mockReturnValue([
      {
        url: 'http://gemini.test',
        agent_card: {
          name: 'gemini_agent',
          url: 'http://gemini.test',
          version: '1.0',
          skills: [],
        } as AgentCardMetadata,
        status: 'available' as const,
        last_check_at: new Date(),
      },
    ]);

    const dispatchSpy = vi.spyOn(priv(foreman).dispatchManager, 'dispatch');

    const state = priv(foreman).sessionManager.get(SESSION_ID);
    await priv(foreman)._runMergePhase(SESSION_ID, state, MERGE_BRANCHES, 'main', 'add features');

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(sendUpdates.some((u) => u.includes('auto-merge was skipped'))).toBe(true);
    expect(sendUpdates.some((u) => u.includes('foreman/task-aaa'))).toBe(true);
    expect(sendUpdates.some((u) => u.includes('foreman/task-bbb'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _executePlan merge guard: no branches when all branch_refs are empty
// ---------------------------------------------------------------------------

describe('Foreman._executePlan merge guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not invoke _runMergePhase when all completed subtasks have empty branch_ref', async () => {
    const sessionManager = new SessionManager({
      maxConcurrentSessions: minimalConfig.runtime.max_concurrent_sessions,
    });
    const configWithWorker = {
      ...minimalConfig,
      workers: [{ url: 'http://claude-agent.test' }],
    };
    const foreman = new Foreman({
      config: configWithWorker as never,
      sessionManager,
      plannerSessionFactory: vi.fn(),
    });

    vi.spyOn(priv(foreman).a2aClient, 'fetchAgentCard').mockResolvedValue(CLAUDE_AGENT_CARD as any);
    await priv(foreman).catalog.loadFromConfig(configWithWorker.workers);

    vi.spyOn(priv(foreman).acpServer, 'sendUpdate').mockResolvedValue(undefined);
    vi.spyOn(priv(foreman).acpServer, 'sendPlan').mockResolvedValue(undefined);
    vi.spyOn(priv(foreman).acpServer, 'sendToolCall').mockResolvedValue(undefined);
    vi.spyOn(priv(foreman).acpServer, 'sendToolCallUpdate').mockResolvedValue(undefined);

    priv(foreman).llmClient = {
      completeWithTools: async function* () {
        yield { type: 'text_chunk', text: 'done' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    sessionManager.create('guard-session', '/tmp');

    const plan = {
      plan_id: 'guard-plan',
      originator_intent: 'do work',
      goal_summary: 'work',
      source: 'external_planner' as const,
      batches: [
        {
          batch_id: 'b1',
          subtasks: [
            {
              id: 's1',
              assigned_agent: 'claude_agent',
              description: 'do it',
              expected_output: null,
              inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
            },
          ],
        },
      ],
    };

    // Worker completes with empty branch_ref
    const subtaskResult = makeTaskResult({ branch_ref: '' });
    const subtaskHandle = makeHandle('subtask-task', [makeStatusEvent('subtask-task', subtaskResult)]);
    const dispatchSpy = vi
      .spyOn(priv(foreman).dispatchManager, 'dispatch')
      .mockResolvedValue(subtaskHandle);

    const runMergeSpy = vi.spyOn(priv(foreman), '_runMergePhase');

    const state = sessionManager.get('guard-session');
    const available = priv(foreman).catalog.getAvailable();
    await priv(foreman)._executePlan(plan, 'guard-session', state, 'do work', available);

    // Only the one subtask dispatch; no merge dispatch
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(runMergeSpy).not.toHaveBeenCalled();
  });
});

