import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from './manager.js';
import { SessionLimitError } from './errors.js';
import { SessionState } from './state.js';
import type { DispatchHandle } from '../workers/task-handle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandle(cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)): DispatchHandle {
  return { taskId: 'ignored', agentUrl: 'ignored', cancel } as unknown as DispatchHandle;
}

function makeManager(max = 3): SessionManager {
  return new SessionManager({ maxConcurrentSessions: max });
}

// ---------------------------------------------------------------------------
// SessionState — construction shape
// ---------------------------------------------------------------------------

describe('SessionState', () => {
  it('initialises all fields correctly', () => {
    const before = Date.now();
    const state = new SessionState('s1', '/work');
    const after = Date.now();

    expect(state.sessionId).toBe('s1');
    expect(state.cwd).toBe('/work');
    expect(state.createdAt).toBeGreaterThanOrEqual(before);
    expect(state.createdAt).toBeLessThanOrEqual(after);
    expect(state.conversationHistory).toEqual([]);
    expect(state.activeDispatchHandles.size).toBe(0);
    expect(state.pendingPermissionRequests.size).toBe(0);
    expect(state.planOwnerRef).toBeNull();
    expect(state.activePlan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeManager(3);
  });

  it('create() + get() round-trip returns the same SessionState', () => {
    const state = manager.create('s1', '/cwd');

    expect(state).toBeInstanceOf(SessionState);
    expect(manager.get('s1')).toBe(state);
  });

  it('create() at limit throws SessionLimitError', () => {
    manager.create('s1', '/a');
    manager.create('s2', '/b');
    manager.create('s3', '/c');

    expect(() => manager.create('s4', '/d')).toThrow(SessionLimitError);
    expect(() => manager.create('s4', '/d')).toThrow('Session limit reached (3)');
  });

  it('size() reflects current session count', () => {
    expect(manager.size()).toBe(0);
    manager.create('s1', '/a');
    expect(manager.size()).toBe(1);
    manager.create('s2', '/b');
    expect(manager.size()).toBe(2);
  });

  it('close() cancels all active dispatch handles', async () => {
    const state = manager.create('s1', '/cwd');
    const h1 = makeHandle();
    const h2 = makeHandle();
    state.activeDispatchHandles.set('task-1', h1);
    state.activeDispatchHandles.set('task-2', h2);

    await manager.close('s1');

    expect(h1.cancel).toHaveBeenCalledOnce();
    expect(h2.cancel).toHaveBeenCalledOnce();
  });

  it('close() is idempotent — second call is a no-op', async () => {
    const state = manager.create('s1', '/cwd');
    const h1 = makeHandle();
    state.activeDispatchHandles.set('task-1', h1);

    await manager.close('s1');
    await manager.close('s1'); // second call

    expect(h1.cancel).toHaveBeenCalledOnce();
  });

  it('close() swallows errors from handle.cancel() and does not throw', async () => {
    const state = manager.create('s1', '/cwd');
    const failCancel = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('network gone'));
    state.activeDispatchHandles.set('task-1', makeHandle(failCancel));

    await expect(manager.close('s1')).resolves.toBeUndefined();
    expect(failCancel).toHaveBeenCalledOnce();
  });

  it('after close(), get() returns null', async () => {
    manager.create('s1', '/cwd');
    await manager.close('s1');

    expect(manager.get('s1')).toBeNull();
  });

  it('after close(), size() decrements', async () => {
    manager.create('s1', '/a');
    manager.create('s2', '/b');

    await manager.close('s1');

    expect(manager.size()).toBe(1);
  });

  it('close() on unknown sessionId is a no-op', async () => {
    await expect(manager.close('nonexistent')).resolves.toBeUndefined();
  });

  it('create() slot opens again after close()', async () => {
    const m = makeManager(1);
    m.create('s1', '/a');
    await m.close('s1');
    expect(() => m.create('s2', '/b')).not.toThrow();
  });
});
