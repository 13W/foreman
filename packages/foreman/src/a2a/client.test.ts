import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DefaultA2AClient } from './client.js';
import { AgentCardValidationError, DispatchFailedError, TaskNotFoundError } from '@foreman-stack/shared';
import type { TaskPayload } from '@foreman-stack/shared';

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
  });

  it('sends payload as data part in message via sendMessageStream', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const [params] = mockSendMessageStream.mock.calls[0];
    expect(params.message.kind).toBe('message');
    expect(params.message.role).toBe('user');
    expect(params.message.parts[0]).toMatchObject({ kind: 'data', data: basePayload });
  });

  it('reuses cached client for same URL', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    mockSendMessageStream.mockReturnValue(fakeStream([{ ...mockTask, id: 'task-2' }]));
    await client.dispatchTask(agentUrl, basePayload);
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
// streamTask
// ---------------------------------------------------------------------------

describe('streamTask', () => {
  const taskId = 'task-stream-1';
  const contextId = 'ctx-stream-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'submitted' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
  });

  it('maps status-update events to StreamEvent (including message field)', async () => {
    const resultMessage = { kind: 'message', messageId: 'msg-1', parts: [{ kind: 'data', data: { status: 'completed' } }], role: 'agent' };
    const sdkEvents = [
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working', timestamp: '2024-01-01T00:00:00Z' } },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed', timestamp: '2024-01-01T00:01:00Z', message: resultMessage } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected: unknown[] = [];
    for await (const event of client.streamTask(taskId)) collected.push(event);

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ type: 'status', taskId, data: { state: 'working', final: false } });
    expect(collected[1]).toMatchObject({ type: 'status', taskId, data: { state: 'completed', final: true, message: resultMessage } });
  });

  it('maps artifact-update events to StreamEvent', async () => {
    const artifact = { artifactId: 'art-1', name: 'result.ts', parts: [] };
    const sdkEvents = [
      { kind: 'artifact-update', taskId, contextId, artifact },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected: unknown[] = [];
    for await (const event of client.streamTask(taskId)) collected.push(event);

    expect(collected[0]).toMatchObject({ type: 'artifact', taskId, data: artifact });
  });

  it('stops at terminal status-update (final: true)', async () => {
    const sdkEvents = [
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working' } },
      { kind: 'status-update', taskId, contextId, final: true, status: { state: 'completed' } },
      { kind: 'status-update', taskId, contextId, final: false, status: { state: 'working' } }, // should not be yielded
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected: unknown[] = [];
    for await (const event of client.streamTask(taskId)) collected.push(event);

    expect(collected).toHaveLength(2);
  });

  it('stops at terminal task event (state: failed)', async () => {
    const sdkEvents = [
      { kind: 'task', id: taskId, contextId, status: { state: 'failed' } },
    ];
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent, ...sdkEvents]));

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const collected: unknown[] = [];
    for await (const event of client.streamTask(taskId)) collected.push(event);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ type: 'status', data: { state: 'failed' } });
  });

  it('throws TaskNotFoundError for unknown taskId', async () => {
    const client = new DefaultA2AClient();
    const gen = client.streamTask('unknown-task');
    await expect(gen.next()).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// pollTask
// ---------------------------------------------------------------------------

describe('pollTask', () => {
  const taskId = 'task-poll-1';
  const contextId = 'ctx-poll-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'submitted' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent]));
  });

  it('returns latest status as StreamEvent', async () => {
    mockGetTask.mockResolvedValue({ id: taskId, status: { state: 'working', timestamp: '2024-01-01T00:00:00Z' } });

    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const event = await client.pollTask(taskId);

    expect(event).toMatchObject({ type: 'status', taskId, data: { state: 'working' } });
    expect(mockGetTask).toHaveBeenCalledWith({ id: taskId });
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
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent]));
    mockCancelTask.mockResolvedValue({ id: taskId, status: { state: 'canceled' } });
  });

  it('delegates to SDK cancelTask', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.cancelTask(taskId);
    expect(mockCancelTask).toHaveBeenCalledWith({ id: taskId });
  });

  it('throws TaskNotFoundError for unknown taskId', async () => {
    const client = new DefaultA2AClient();
    await expect(client.cancelTask('not-registered')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// respondToPermission
// ---------------------------------------------------------------------------

describe('respondToPermission', () => {
  const taskId = 'task-perm-1';
  const contextId = 'ctx-perm-1';
  const taskEvent = { kind: 'task', id: taskId, contextId, status: { state: 'input-required' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent]));
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
  });

  it('sends sendMessage with same contextId for reject_once decision', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    await client.respondToPermission(taskId, { kind: 'reject_once' });

    const [params] = mockSendMessage.mock.calls[0];
    expect(params.message.contextId).toBe(contextId);
    expect(params.message.parts[0].data).toMatchObject({ kind: 'reject_once' });
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFromUrl.mockResolvedValue(mockClient);
    mockSendMessageStream.mockReturnValue(fakeStream([taskEvent]));
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
  });

  it('sends data parts verbatim', async () => {
    const client = new DefaultA2AClient();
    await client.dispatchTask(agentUrl, basePayload);
    const decision = { kind: 'allow_once' };
    await client.sendFollowUp(taskId, [{ kind: 'data', data: decision }]);

    const [params] = mockSendMessage.mock.calls[0];
    expect(params.message.parts[0]).toMatchObject({ kind: 'data', data: decision });
  });

  it('throws TaskNotFoundError for unknown taskId', async () => {
    const client = new DefaultA2AClient();
    await expect(
      client.sendFollowUp('not-registered', [{ kind: 'text', text: 'hello' }]),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});
