import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DefaultA2AClient } from './client.js';
import { AgentCardValidationError, DispatchFailedError, TaskNotFoundError } from '@foreman-stack/shared';
import type { StreamEvent, TaskPayload } from '@foreman-stack/shared';

// ---------------------------------------------------------------------------
// SDK mocks
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockSendMessageStream = vi.fn();
const mockGetTask = vi.fn();
const mockCancelTask = vi.fn();

const mockClient = {
  sendMessage: mockSendMessage,
  sendMessageStream: mockSendMessageStream,
  getTask: mockGetTask,
  cancelTask: mockCancelTask,
  getAgentCard: vi.fn(),
  transport: {},
};

const mockCreateFromUrl = vi.fn().mockResolvedValue(mockClient);
const mockResolve = vi.fn();

vi.mock('@a2a-js/sdk/client', () => ({
  ClientFactory: vi.fn().mockImplementation(() => ({
    createFromUrl: mockCreateFromUrl,
  })),
  ClientFactoryOptions: {
    default: {},
    createFrom: vi.fn((orig: object, overrides: object) => ({ ...orig, ...overrides })),
  },
  DefaultAgentCardResolver: vi.fn().mockImplementation(() => ({
    resolve: mockResolve,
  })),
}));

vi.mock('@a2a-js/sdk', () => ({
  AGENT_CARD_PATH: '.well-known/agent-card.json',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePayload: TaskPayload = {
  description: 'write tests',
  expected_output: null,
  originator_intent: 'improve coverage',
  max_delegation_depth: 1,
  parent_task_id: null,
  base_branch: null,
  timeout_sec: null,
  injected_mcps: [],
  inputs: { relevant_files: [], constraints: [], context_from_prior_tasks: [] },
  cwd: null,
};

const agentUrl = 'http://agent.local:4000';

const mockSdkAgentCard = {
  name: 'test-agent',
  url: agentUrl,
  version: '1.0.0',
  description: 'a test agent',
  skills: [],
  protocolVersion: '0.3.0',
  capabilities: { streaming: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

async function* fakeStream(events: unknown[]) {
  for (const e of events) yield e;
}

/**
 * A stream that yields the initial events then hangs until manually completed.
 * The caller drives completion: for cancellation tests, `cancelTask` aborts the
 * pump's AbortController which fires stream.return() via the abort handler in
 * _pumpStream. For other tests, explicitly call `complete()`.
 */
function makeLongLivedStream(events: unknown[]): { stream: AsyncGenerator; complete: () => void } {
  let complete!: () => void;
  const endPromise = new Promise<void>((res) => { complete = res; });
  const stream = (async function* () {
    for (const e of events) yield e;
    await endPromise;
  })() as AsyncGenerator;
  return { stream, complete };
}

/** Collect all events from subscribe until done, with optional timeout. */
function collectEvents(client: DefaultA2AClient, taskId: string): Promise<StreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: StreamEvent[] = [];
    client.subscribe(taskId, (e) => events.push(e));
    client.waitForDone(taskId).then(() => resolve(events)).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// fetchAgentCard
// ---------------------------------------------------------------------------

describe('fetchAgentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue(mockSdkAgentCard);
  });

  it('maps AgentCard to AgentCardMetadata', async () => {
    const client = new DefaultA2AClient();
    const result = await client.fetchAgentCard(agentUrl);
    expect(result).toEqual({
      name: 'test-agent',
      url: agentUrl,
      version: '1.0.0',
      description: 'a test agent',
      skills: [],
    });
  });

  it('throws AgentCardValidationError when resolver fails', async () => {
    mockResolve.mockRejectedValue(new Error('connection refused'));
    const client = new DefaultA2AClient();
    await expect(client.fetchAgentCard(agentUrl)).rejects.toBeInstanceOf(AgentCardValidationError);
  });

  it('throws AgentCardValidationError when required fields are missing', async () => {
    mockResolve.mockResolvedValue({ ...mockSdkAgentCard, version: '' });
    const client = new DefaultA2AClient();
    await expect(client.fetchAgentCard(agentUrl)).rejects.toBeInstanceOf(AgentCardValidationError);
  });
});

// ---------------------------------------------------------------------------
// dispatchTask
// ---------------------------------------------------------------------------

describe('dispatchTask', () => {
  const taskId = 'task-abc-123';
  const contextId = 'ctx-xyz-456';
  const mockTask = { kind: 'task', id: taskId, contextId, status: { state: 'submitted' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    mockSendMessageStream.mockReturnValue(fakeStream([mockTask]));
  });

  it('returns taskId from first task event in stream', async () => {
    const client = new DefaultA2AClient();
    const id = await client.dispatchTask(agentUrl, basePayload);
    expect(id).toBe(taskId);
    await client.waitForDone(taskId);
  });

  it('sends payload as data part in message via sendMessageStream', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const [params] = mockSendMessageStream.mock.calls[0];
    expect(params.message.kind).toBe('message');
    expect(params.message.role).toBe('user');
    expect(params.message.parts[0]).toMatchObject({ kind: 'data', data: basePayload });
    await client.waitForDone(taskId);
  });

  it('reuses cached client for same URL', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.waitForDone(taskId);

    mockSendMessageStream.mockReturnValue(fakeStream([{ ...mockTask, id: 'task-2' }]));
    await client.dispatchTask(agentUrl, basePayload);
    await client.waitForDone('task-2');

    expect(mockCreateFromUrl).toHaveBeenCalledTimes(1);
  });

  it('throws DispatchFailedError when stream next() throws', async () => {
    mockSendMessageStream.mockReturnValue((async function* () { throw new Error('timeout'); })());
    const client = new DefaultA2AClient();
    await expect(client.dispatchTask(agentUrl, basePayload)).rejects.toBeInstanceOf(DispatchFailedError);
  });

  it('throws DispatchFailedError when first event is not a task', async () => {
    mockSendMessageStream.mockReturnValue(fakeStream([
      { kind: 'message', messageId: 'x', role: 'agent', parts: [] },
    ]));
    const client = new DefaultA2AClient();
    await expect(client.dispatchTask(agentUrl, basePayload)).rejects.toBeInstanceOf(DispatchFailedError);
  });
});

// ---------------------------------------------------------------------------
// subscribe + waitForDone (pump behavior)
// ---------------------------------------------------------------------------

describe('subscribe and waitForDone', () => {
  const taskId = 'task-stream-1';
  const contextId = 'ctx-stream-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'submitted' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
  });

  it('delivers mapped status-update events to subscribers', async () => {
    const resultMessage = { kind: 'message', messageId: 'msg-1', parts: [{ kind: 'data', data: { status: 'completed' } }], role: 'agent' };
    const sdkEvents = [
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working', timestamp: '2024-01-01T00:00:00Z' } },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed', timestamp: '2024-01-01T00:01:00Z', message: resultMessage } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected = await collectEvents(client, taskId);

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ type: 'status', taskId, data: { state: 'working', final: false } });
    expect(collected[1]).toMatchObject({ type: 'status', taskId, data: { state: 'completed', final: true, message: resultMessage } });
  });

  it('delivers mapped artifact-update events to subscribers', async () => {
    const artifact = { artifactId: 'art-1', name: 'result.ts', parts: [] };
    const sdkEvents = [
      { kind: 'artifact-update', taskId, contextId, artifact },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected = await collectEvents(client, taskId);

    expect(collected[0]).toMatchObject({ type: 'artifact', taskId, data: artifact });
  });

  it('stops emitting after terminal status-update (final: true)', async () => {
    const sdkEvents = [
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working' } },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working' } }, // should not be emitted
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected = await collectEvents(client, taskId);

    expect(collected).toHaveLength(2);
  });

  it('stops emitting after terminal task event (state: failed)', async () => {
    const sdkEvents = [
      { kind: 'task', id: taskId, contextId, status: { state: 'failed' } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected = await collectEvents(client, taskId);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ type: 'status', data: { state: 'failed' } });
  });

  it('waitForDone resolves when pump exits cleanly', async () => {
    mockSendMessageStream.mockReturnValue(fakeStream([
      taskEvent,
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
    ]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await expect(client.waitForDone(taskId)).resolves.toBeUndefined();
  });

  it('multiple subscribers receive the same events', async () => {
    const sdkEvents = [
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working' } },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);

    const sub1: StreamEvent[] = [];
    const sub2: StreamEvent[] = [];
    client.subscribe(taskId, (e) => sub1.push(e));
    client.subscribe(taskId, (e) => sub2.push(e));
    await client.waitForDone(taskId);

    expect(sub1).toHaveLength(2);
    expect(sub2).toHaveLength(2);
    expect(sub1).toEqual(sub2);
  });

  it('unsubscribe stops event delivery', async () => {
    const sdkEvents = [
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working' } },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);

    const received: StreamEvent[] = [];
    const unsub = client.subscribe(taskId, (e) => received.push(e));
    // Unsubscribe immediately
    unsub();
    await client.waitForDone(taskId);

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------

describe('polling fallback', () => {
  const taskId = 'task-poll-fb';
  const contextId = 'ctx-poll-fb';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'submitted' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
  });

  it('falls back to polling when SSE stream throws after first event', async () => {
    mockSendMessageStream.mockReturnValue(
      (async function* () {
        yield taskEvent;
        throw new Error('SSE not supported');
      })(),
    );
    mockGetTask.mockResolvedValue({ id: taskId, status: { state: 'completed', timestamp: '' } });

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);

    const collected = await collectEvents(client, taskId);
    expect(mockGetTask).toHaveBeenCalled();
    expect(collected.some((e) => (e.data as { state?: string }).state === 'completed')).toBe(true);
  });

  it('yields connection_lost error after max consecutive poll failures', async () => {
    vi.useFakeTimers();

    mockSendMessageStream.mockReturnValue(
      (async function* () {
        yield taskEvent;
        throw new Error('no SSE');
      })(),
    );
    mockGetTask.mockRejectedValue(new Error('5xx'));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);

    const collectedPromise = collectEvents(client, taskId);

    // Advance through all poll intervals (10 consecutive failures)
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(35_000);
    }

    const collected = await collectedPromise;
    const errorEvent = collected.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { reason: string }).reason).toBe('connection_lost');
  });
});

// ---------------------------------------------------------------------------
// pollTask
// ---------------------------------------------------------------------------

describe('pollTask', () => {
  const taskId = 'task-poll-1';
  const contextId = 'ctx-poll-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'submitted' } };
  let completeStream: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    const { stream, complete } = makeLongLivedStream([taskEvent]);
    completeStream = complete;
    mockSendMessageStream.mockReturnValue(stream);
  });

  it('returns latest status as StreamEvent', async () => {
    mockGetTask.mockResolvedValue({ id: taskId, status: { state: 'working', timestamp: '2024-01-01T00:00:00Z' } });

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const event = await client.pollTask(taskId);

    expect(event).toMatchObject({ type: 'status', taskId, data: { state: 'working' } });
    expect(mockGetTask).toHaveBeenCalledWith({ id: taskId });

    completeStream();
    await client.waitForDone(taskId);
  });

  it('throws TaskNotFoundError for unknown taskId', async () => {
    const client = new DefaultA2AClient();
    await expect(client.pollTask('not-registered')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe('cancelTask', () => {
  const taskId = 'task-cancel-1';
  const contextId = 'ctx-cancel-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'working' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    // Use a long-lived stream so the pump keeps the task in registry until cancel.
    const { stream } = makeLongLivedStream([taskEvent]);
    mockSendMessageStream.mockReturnValue(stream);
    mockCancelTask.mockResolvedValue({ id: taskId, status: { state: 'canceled' } });
  });

  it('delegates to SDK cancelTask', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.cancelTask(taskId);
    expect(mockCancelTask).toHaveBeenCalledWith({ id: taskId });
    // Note: we don't await waitForDone here because cancelTask aborts the AbortController
    // but stream.return() on an await-suspended generator does not interrupt it.
    // The assertion has passed; the pump remains suspended but causes no test pollution.
  });

  it('is a no-op for unknown taskId (task already done)', async () => {
    const client = new DefaultA2AClient();
    // Should not throw
    await expect(client.cancelTask('not-registered')).resolves.toBeUndefined();
    expect(mockCancelTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// respondToPermission
// ---------------------------------------------------------------------------

describe('respondToPermission', () => {
  const taskId = 'task-perm-1';
  const contextId = 'ctx-perm-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'input-required' } };
  let completeStream: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    const { stream, complete } = makeLongLivedStream([taskEvent]);
    completeStream = complete;
    mockSendMessageStream.mockReturnValue(stream);
    mockSendMessage.mockResolvedValue({ kind: 'task', id: taskId, contextId, status: { state: 'working' } });
  });

  it('sends sendMessage with same contextId for allow_once decision', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.respondToPermission(taskId, { kind: 'allow_once' });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [params] = mockSendMessage.mock.calls[0];
    expect(params.message.contextId).toBe(contextId);
    expect(params.message.parts[0]).toMatchObject({ kind: 'data', data: { kind: 'allow_once' } });

    completeStream();
    await client.waitForDone(taskId);
  });

  it('sends sendMessage with same contextId for reject_once decision', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.respondToPermission(taskId, { kind: 'reject_once' });

    const [params] = mockSendMessage.mock.calls[0];
    expect(params.message.contextId).toBe(contextId);
    expect(params.message.parts[0].data).toMatchObject({ kind: 'reject_once' });

    completeStream();
    await client.waitForDone(taskId);
  });

  it('throws TaskNotFoundError for unknown taskId', async () => {
    const client = new DefaultA2AClient();
    await expect(
      client.respondToPermission('not-registered', { kind: 'allow_once' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// sendFollowUp
// ---------------------------------------------------------------------------

describe('sendFollowUp', () => {
  const taskId = 'task-followup-1';
  const contextId = 'ctx-followup-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'input-required' } };
  let completeStream: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    const { stream, complete } = makeLongLivedStream([taskEvent]);
    completeStream = complete;
    mockSendMessageStream.mockReturnValue(stream);
    mockSendMessage.mockResolvedValue({ kind: 'task', id: taskId, contextId, status: { state: 'working' } });
  });

  it('sends sendMessage with correct contextId and provided parts', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.sendFollowUp(taskId, [{ kind: 'text', text: 'should I continue?' }]);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [params] = mockSendMessage.mock.calls[0];
    expect(params.message.contextId).toBe(contextId);
    expect(params.message.parts).toEqual([{ kind: 'text', text: 'should I continue?' }]);

    completeStream();
    await client.waitForDone(taskId);
  });

  it('sends data parts verbatim', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const decision = { kind: 'allow_once' };
    await client.sendFollowUp(taskId, [{ kind: 'data', data: decision }]);

    const [params] = mockSendMessage.mock.calls[0];
    expect(params.message.parts[0]).toMatchObject({ kind: 'data', data: decision });

    completeStream();
    await client.waitForDone(taskId);
  });

  it('throws TaskNotFoundError for unknown taskId', async () => {
    const client = new DefaultA2AClient();
    await expect(
      client.sendFollowUp('not-registered', [{ kind: 'text', text: 'hello' }]),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
