import { describe, it, expect } from 'vitest';
import { isBlockedModeId, pickFallbackMode } from './mode-policy.js';

describe('isBlockedModeId', () => {
  it('matches "plan" exactly', () => {
    expect(isBlockedModeId('plan', ['plan'])).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isBlockedModeId('Plan_Mode', ['plan'])).toBe(true);
  });

  it('returns false for unrelated mode id', () => {
    expect(isBlockedModeId('default', ['plan'])).toBe(false);
  });

  it('matches substring within longer id', () => {
    expect(isBlockedModeId('planning_mode', ['plan'])).toBe(true);
  });

  it('returns false when patterns list is empty', () => {
    expect(isBlockedModeId('plan', [])).toBe(false);
  });
});

describe('pickFallbackMode', () => {
  it('returns the first non-blocked mode', () => {
    const modes = [
      { id: 'plan', name: 'Plan' },
      { id: 'normal', name: 'Normal' },
      { id: 'edit', name: 'Edit' },
    ];
    expect(pickFallbackMode(modes)).toBe('normal');
  });

  it('returns null when all modes are blocked', () => {
    expect(pickFallbackMode([{ id: 'plan', name: 'Plan' }], ['plan'])).toBeNull();
  });

  it('returns null for an empty modes array', () => {
    expect(pickFallbackMode([])).toBeNull();
  });

  it('skips multiple blocked modes before finding a fallback', () => {
    const modes = [
      { id: 'plan', name: 'Plan' },
      { id: 'planning_v2', name: 'Planning v2' },
      { id: 'default', name: 'Default' },
    ];
    expect(pickFallbackMode(modes)).toBe('default');
  });
});
