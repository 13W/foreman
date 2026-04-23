import { describe, expect, it } from 'vitest';
import * as a2a from './index.js';

describe('a2a barrel exports', () => {
  it('exports all error classes', () => {
    expect(a2a.A2AError).toBeDefined();
    expect(a2a.TaskNotFoundError).toBeDefined();
    expect(a2a.DispatchFailedError).toBeDefined();
    expect(a2a.PermissionTimeoutError).toBeDefined();
    expect(a2a.AgentCardValidationError).toBeDefined();
  });

  it('error classes are constructable', () => {
    expect(() => new a2a.A2AError('CODE', 'msg')).not.toThrow();
    expect(() => new a2a.TaskNotFoundError('task-1')).not.toThrow();
    expect(() => new a2a.DispatchFailedError('http://x', 'timeout')).not.toThrow();
    expect(() => new a2a.PermissionTimeoutError('task-1', 'req-1')).not.toThrow();
    expect(() => new a2a.AgentCardValidationError('http://x', 'bad card')).not.toThrow();
  });
});
