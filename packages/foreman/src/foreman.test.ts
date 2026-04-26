import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Foreman } from './foreman.js';
import { DispatchHandle } from './workers/task-handle.js';
import { PlanAbortedError } from './plan/errors.js';
import type { StreamEvent, TaskResult, Plan, TaskPayload } from '@foreman-stack/shared';

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
  llm: { backend: 'anthropic' as const, model: 'claude-3-5-haiku-20241022', api_key_env: 'ANTHROPIC_API_KEY', max_tokens_per_turn: 8192 },
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

function makeHandle(taskId: string, events: StreamEvent[], cancelFn = vi.fn()): DispatchHandle {
  async function* gen() {
    yield* events;
  }
  return new DispatchHandle(taskId, 'http://worker.test', gen(), cancelFn);
}

// ---------------------------------------------------------------------------
// _runWorkerTask tests
// ---------------------------------------------------------------------------

describe('Foreman._runWorkerTask', () => {
  let foreman: Foreman;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    foreman = new Foreman(minimalConfig as never);
  });

  it('parses TaskResult from terminal status message', async () => {
    const expected = makeTaskResult({ summary: 'all good' });
    const handle = makeHandle('task-1', [makeStatusEvent('task-1', expected)]);
    dispatchSpy = vi.spyOn((foreman as never)['dispatchManager'], 'dispatch').mockResolvedValue(handle);

    const result = await (foreman as never)['_runWorkerTask']('http://worker.test', {} as TaskPayload, 'session-1', undefined);

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
    dispatchSpy = vi.spyOn((foreman as never)['dispatchManager'], 'dispatch').mockResolvedValue(handle);

    const result = await (foreman as never)['_runWorkerTask']('http://worker.test', {} as TaskPayload, 'session-1', undefined);

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('hello from worker');
    dispatchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// _executePlan tests
// ---------------------------------------------------------------------------

describe('Foreman._executePlan', () => {
  let foreman: Foreman;

  const workerUrl = 'http://worker.test';

  const basePlan: Plan = {
    schema_version: '1.0',
    plan_id: 'plan-1',
    originator_intent: 'test intent',
    batches: [
      {
        batch_id: 'b1',
        subtasks: [
          {
            id: 'sub-1',
            assigned_agent: 'test_worker',
            description: 'first task',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          },
          {
            id: 'sub-2',
            assigned_agent: 'test_worker',
            description: 'second task',
            expected_output: null,
            inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
          },
        ],
      },
    ],
  };

  function stubCatalogWorker(f: Foreman, url: string, name: string) {
    vi.spyOn((f as never)['catalog'], 'getAvailable').mockReturnValue([
      {
        url,
        name_hint: name,
        agent_card: { name, description: '', skills: [], version: '1.0', url },
        status: 'reachable' as const,
        last_check_at: 0,
      },
    ]);
  }

  beforeEach(() => {
    foreman = new Foreman(minimalConfig as never);
    stubCatalogWorker(foreman, workerUrl, 'test_worker');
  });

  it('returns array of result strings when all subtasks complete', async () => {
    const r1 = makeTaskResult({ summary: 'sub1 done' });
    const r2 = makeTaskResult({ summary: 'sub2 done' });

    const h1 = makeHandle('t1', [makeStatusEvent('t1', r1)]);
    const h2 = makeHandle('t2', [makeStatusEvent('t2', r2)]);

    const dispatch = vi.spyOn((foreman as never)['dispatchManager'], 'dispatch')
      .mockResolvedValueOnce(h1)
      .mockResolvedValueOnce(h2);

    const results = await (foreman as never)['_executePlan'](basePlan, 'test intent', 'session-1');

    expect(results).toHaveLength(2);
    expect(results[0]).toContain('sub-1');
    expect(results[1]).toContain('sub-2');
    dispatch.mockRestore();
  });

  it('throws PlanAbortedError and cancels sibling handles when second subtask fails', async () => {
    const r1 = makeTaskResult({ summary: 'sub1 done' });
    const r2 = makeTaskResult({ status: 'failed', stop_reason: null, summary: '', branch_ref: '', session_transcript_ref: '', error: { code: 'ERR', message: 'boom' } });

    const cancelSpy1 = vi.fn().mockResolvedValue(undefined);
    const cancelSpy2 = vi.fn().mockResolvedValue(undefined);

    const h1 = makeHandle('t1', [makeStatusEvent('t1', r1)], cancelSpy1);
    const h2 = makeHandle('t2', [makeStatusEvent('t2', r2)], cancelSpy2);

    const dispatch = vi.spyOn((foreman as never)['dispatchManager'], 'dispatch')
      .mockResolvedValueOnce(h1)
      .mockResolvedValueOnce(h2);

    await expect(
      (foreman as never)['_executePlan'](basePlan, 'test intent', 'session-1'),
    ).rejects.toThrow(PlanAbortedError);

    dispatch.mockRestore();
  });

  it('PlanAbortedError carries subtask id and taskResult', async () => {
    const failResult = makeTaskResult({
      status: 'failed',
      stop_reason: null,
      summary: '',
      branch_ref: '',
      session_transcript_ref: '',
      error: { code: 'ERR_TEST', message: 'worker exploded' },
    });

    const h1 = makeHandle('t1', [makeStatusEvent('t1', failResult)]);

    const singleSubtaskPlan: Plan = {
      ...basePlan,
      batches: [{ batch_id: 'b1', subtasks: [basePlan.batches[0].subtasks[0]] }],
    };

    const dispatch = vi.spyOn((foreman as never)['dispatchManager'], 'dispatch')
      .mockResolvedValueOnce(h1);

    let caught: PlanAbortedError | null = null;
    try {
      await (foreman as never)['_executePlan'](singleSubtaskPlan, 'intent', 'session-1');
    } catch (err) {
      caught = err as PlanAbortedError;
    }

    expect(caught).toBeInstanceOf(PlanAbortedError);
    expect(caught?.subtaskId).toBe('sub-1');
    expect(caught?.taskResult).toEqual(failResult);
    expect(caught?.message).toContain('worker exploded');
    dispatch.mockRestore();
  });
});
