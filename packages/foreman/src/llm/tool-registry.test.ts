import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from './tool-registry.js';
import type { LLMToolDefinition } from './client.js';

const noop = async () => 'ok';

function def(name: string): LLMToolDefinition {
  return { name, description: '', inputSchema: {} };
}

describe('ToolRegistry', () => {
  it('registers and lists tools', () => {
    const r = new ToolRegistry();
    r.register('get_stuff', def('get_stuff'), noop);
    r.register('create_pr', def('create_pr'), noop);
    const tools = r.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain('get_stuff');
    expect(tools.map((t) => t.name)).toContain('create_pr');
  });

  describe('isReadOnly prefix heuristic', () => {
    const cases: [string, boolean][] = [
      ['get_file', true],
      ['list_tasks', true],
      ['search_code', true],
      ['read_doc', true],
      ['find_issues', true],
      ['query_db', true],
      ['show_status', true],
      ['check_health', true],
      ['describe_schema', true],
      ['fetch_data', true],
      ['create_issue', false],
      ['update_file', false],
      ['delete_branch', false],
      ['compute_score', false],
      ['send_message', false],
    ];
    it.each(cases)('isReadOnly(%s) === %s', (name, expected) => {
      const r = new ToolRegistry();
      r.register(name, def(name), noop);
      expect(r.isReadOnly(name)).toBe(expected);
    });
  });

  it('returns false for isReadOnly on unknown tool', () => {
    expect(new ToolRegistry().isReadOnly('nonexistent')).toBe(false);
  });

  it('auto-approves read-only tools without escalation callback', async () => {
    const r = new ToolRegistry();
    const handler = vi.fn().mockResolvedValue('result');
    r.register('get_data', def('get_data'), handler);
    const result = await r.invoke('get_data', { q: 1 });
    expect(result).toBe('result');
    expect(handler).toHaveBeenCalledWith({ q: 1 }, undefined);
  });

  it('throws for write tool without escalation callback', async () => {
    const r = new ToolRegistry();
    r.register('create_pr', def('create_pr'), noop);
    await expect(r.invoke('create_pr', {})).rejects.toThrow('no escalation callback');
  });

  it('executes write tool when escalation approves', async () => {
    const r = new ToolRegistry();
    const handler = vi.fn().mockResolvedValue('pr-123');
    r.register('create_pr', def('create_pr'), handler);
    r.setEscalationCallback(async () => true);
    expect(await r.invoke('create_pr', { title: 'fix' })).toBe('pr-123');
  });

  it('throws when escalation denies write tool', async () => {
    const r = new ToolRegistry();
    r.register('delete_branch', def('delete_branch'), noop);
    r.setEscalationCallback(async () => false);
    await expect(r.invoke('delete_branch', {})).rejects.toThrow('denied');
  });

  it('throws for unknown tool', async () => {
    await expect(new ToolRegistry().invoke('nonexistent', {})).rejects.toThrow('Unknown tool');
  });

  it('passes AbortSignal to handler', async () => {
    const r = new ToolRegistry();
    const handler = vi.fn().mockResolvedValue('done');
    r.register('get_x', def('get_x'), handler);
    const signal = new AbortController().signal;
    await r.invoke('get_x', {}, signal);
    expect(handler).toHaveBeenCalledWith({}, signal);
  });

  describe('explicit overrides', () => {
    it('forceReadOnly makes write-named tool read-only', async () => {
      const r = new ToolRegistry();
      r.register('compute_score', def('compute_score'), noop, { forceReadOnly: true });
      expect(r.isReadOnly('compute_score')).toBe(true);
      await expect(r.invoke('compute_score', {})).resolves.toBe('ok');
    });

    it('forceWrite escalates read-prefixed tool', async () => {
      const r = new ToolRegistry();
      r.register('get_secret', def('get_secret'), noop, { forceWrite: true });
      expect(r.isReadOnly('get_secret')).toBe(false);
      await expect(r.invoke('get_secret', {})).rejects.toThrow('no escalation callback');
    });

    it('forceWrite takes precedence over forceReadOnly', async () => {
      const r = new ToolRegistry();
      r.register('get_x', def('get_x'), noop, { forceReadOnly: true, forceWrite: true });
      expect(r.isReadOnly('get_x')).toBe(false);
    });
  });

  it('replaces escalation callback when set twice', async () => {
    const r = new ToolRegistry();
    r.register('create_pr', def('create_pr'), noop);
    r.setEscalationCallback(async () => false);
    r.setEscalationCallback(async () => true);
    await expect(r.invoke('create_pr', {})).resolves.toBe('ok');
  });
});
