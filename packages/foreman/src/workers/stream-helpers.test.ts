import { describe, it, expect } from 'vitest';
import { extractToolActivityTitle } from './stream-helpers.js';
import type { StreamEvent } from '@foreman-stack/shared';

function makeStatusEvent(state: string, message?: unknown): StreamEvent {
  return { type: 'status', taskId: 'test', data: { state, message }, timestamp: '' };
}

describe('extractToolActivityTitle', () => {
  it('returns title for Read File', () => {
    expect(extractToolActivityTitle(makeStatusEvent('working', 'Read File'))).toBe('Read File');
  });

  it('returns title for Edit with path', () => {
    expect(
      extractToolActivityTitle(makeStatusEvent('working', 'Edit deployment/.../auth.yaml')),
    ).toBe('Edit deployment/.../auth.yaml');
  });

  it('returns null for bare toolCallId', () => {
    expect(extractToolActivityTitle(makeStatusEvent('working', 'toolu_01ABCdef'))).toBeNull();
  });

  it('returns null for toolu with underscores and dashes', () => {
    expect(extractToolActivityTitle(makeStatusEvent('working', 'toolu_A1-B2_C3'))).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractToolActivityTitle(makeStatusEvent('working', ''))).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(extractToolActivityTitle(makeStatusEvent('working', '   '))).toBeNull();
  });

  it('returns null for non-working state', () => {
    expect(extractToolActivityTitle(makeStatusEvent('completed', 'Read File'))).toBeNull();
  });

  it('returns null for input-required state', () => {
    expect(extractToolActivityTitle(makeStatusEvent('input-required', 'Read File'))).toBeNull();
  });

  it('returns null for non-status event type', () => {
    const event: StreamEvent = {
      type: 'message',
      taskId: 'test',
      data: { state: 'working', message: 'Read File' },
      timestamp: '',
    };
    expect(extractToolActivityTitle(event)).toBeNull();
  });

  it('returns null when message is not a string', () => {
    expect(extractToolActivityTitle(makeStatusEvent('working', { text: 'Read File' }))).toBeNull();
  });

  it('returns null when data is null', () => {
    const event: StreamEvent = { type: 'status', taskId: 'test', data: null, timestamp: '' };
    expect(extractToolActivityTitle(event)).toBeNull();
  });
});
