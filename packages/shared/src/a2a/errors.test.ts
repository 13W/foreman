import { describe, expect, it } from 'vitest';
import {
  A2AError,
  AgentCardValidationError,
  DispatchFailedError,
  PermissionTimeoutError,
  TaskNotFoundError,
} from './errors.js';

describe('A2AError', () => {
  it('is an instance of Error', () => {
    const err = new A2AError('TEST_CODE', 'test message');
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes code and message', () => {
    const err = new A2AError('SOME_CODE', 'some message');
    expect(err.code).toBe('SOME_CODE');
    expect(err.message).toBe('some message');
  });

  it('has name A2AError', () => {
    const err = new A2AError('X', 'y');
    expect(err.name).toBe('A2AError');
  });
});

describe('TaskNotFoundError', () => {
  it('extends A2AError', () => {
    const err = new TaskNotFoundError('task-123');
    expect(err).toBeInstanceOf(A2AError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has TASK_NOT_FOUND code', () => {
    const err = new TaskNotFoundError('task-abc');
    expect(err.code).toBe('TASK_NOT_FOUND');
  });

  it('includes taskId in message', () => {
    const err = new TaskNotFoundError('task-xyz');
    expect(err.message).toContain('task-xyz');
  });

  it('exposes taskId', () => {
    const err = new TaskNotFoundError('task-123');
    expect(err.taskId).toBe('task-123');
  });
});

describe('DispatchFailedError', () => {
  it('extends A2AError', () => {
    const err = new DispatchFailedError('http://agent', 'connection refused');
    expect(err).toBeInstanceOf(A2AError);
  });

  it('has DISPATCH_FAILED code', () => {
    const err = new DispatchFailedError('http://agent', 'timeout');
    expect(err.code).toBe('DISPATCH_FAILED');
  });

  it('exposes agentUrl and reason', () => {
    const err = new DispatchFailedError('http://agent:8080', 'timeout');
    expect(err.agentUrl).toBe('http://agent:8080');
    expect(err.reason).toBe('timeout');
  });
});

describe('PermissionTimeoutError', () => {
  it('extends A2AError', () => {
    const err = new PermissionTimeoutError('task-1', 'req-1');
    expect(err).toBeInstanceOf(A2AError);
  });

  it('has PERMISSION_TIMEOUT code', () => {
    const err = new PermissionTimeoutError('task-1', 'req-1');
    expect(err.code).toBe('PERMISSION_TIMEOUT');
  });

  it('exposes taskId and requestId', () => {
    const err = new PermissionTimeoutError('task-abc', 'req-xyz');
    expect(err.taskId).toBe('task-abc');
    expect(err.requestId).toBe('req-xyz');
  });
});

describe('AgentCardValidationError', () => {
  it('extends A2AError', () => {
    const err = new AgentCardValidationError('http://agent', 'missing name');
    expect(err).toBeInstanceOf(A2AError);
  });

  it('has AGENT_CARD_VALIDATION code', () => {
    const err = new AgentCardValidationError('http://agent', 'missing name');
    expect(err.code).toBe('AGENT_CARD_VALIDATION');
  });

  it('exposes agentUrl and validationMessage', () => {
    const err = new AgentCardValidationError('http://agent:9000', 'missing name field');
    expect(err.agentUrl).toBe('http://agent:9000');
    expect(err.validationMessage).toBe('missing name field');
  });
});
