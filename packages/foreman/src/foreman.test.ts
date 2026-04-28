/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Foreman } from './foreman.js';
import { SessionManager } from './session/manager.js';
import { SessionState } from './session/state.js';
import { DispatchHandle } from './workers/task-handle.js';
import type { StreamEvent, TaskResult, TaskPayload } from '@foreman-stack/shared';

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

function makeHandle(taskId: string, events: StreamEvent[], cancelFn = vi.fn()): DispatchHandle {
  async function* gen() {
    yield* events;
  }
  return new DispatchHandle(taskId, 'http://worker.test', gen(), cancelFn);
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

