import { describe, it, expect } from 'vitest';
import { mergeMcps, validatePersonalMcps, McpNameCollisionError } from './mcp-merger.js';

function mcp(name: string) {
  return { name, command: `${name}-cmd`, args: [], env: {} };
}

describe('validatePersonalMcps', () => {
  it('passes with unique names', () => {
    expect(() => validatePersonalMcps([mcp('a'), mcp('b'), mcp('c')])).not.toThrow();
  });

  it('passes with empty array', () => {
    expect(() => validatePersonalMcps([])).not.toThrow();
  });

  it('passes with a single MCP', () => {
    expect(() => validatePersonalMcps([mcp('only')])).not.toThrow();
  });

  it('throws McpNameCollisionError for duplicate personal names', () => {
    expect(() => validatePersonalMcps([mcp('ts-lsp'), mcp('ts-lsp')])).toThrow(
      McpNameCollisionError,
    );
  });

  it('collision error has sources: personal', () => {
    try {
      validatePersonalMcps([mcp('dup'), mcp('dup')]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpNameCollisionError);
      expect((err as McpNameCollisionError).sources).toBe('personal');
    }
  });

  it('collision error exposes the duplicate MCP name', () => {
    try {
      validatePersonalMcps([mcp('ts-lsp'), mcp('other'), mcp('ts-lsp')]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpNameCollisionError);
      expect((err as McpNameCollisionError).mcpName).toBe('ts-lsp');
    }
  });
});

describe('mergeMcps', () => {
  it('returns empty list when both arrays are empty', () => {
    expect(mergeMcps([], [])).toEqual([]);
  });

  it('returns personal MCPs when injected is empty', () => {
    const result = mergeMcps([mcp('a'), mcp('b')], []);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.name)).toEqual(['a', 'b']);
  });

  it('returns injected MCPs when personal is empty', () => {
    const result = mergeMcps([], [mcp('x'), mcp('y')]);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.name)).toEqual(['x', 'y']);
  });

  it('merges personal and injected when no name collision', () => {
    const result = mergeMcps([mcp('a'), mcp('b')], [mcp('c'), mcp('d')]);
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.name)).toContain('a');
    expect(result.map((m) => m.name)).toContain('b');
    expect(result.map((m) => m.name)).toContain('c');
    expect(result.map((m) => m.name)).toContain('d');
  });

  it('preserves MCP server command/args/env details', () => {
    const server = {
      name: 'ts-lsp',
      command: 'typescript-language-server',
      args: ['--stdio'],
      env: { MY_VAR: 'value' },
    };
    const result = mergeMcps([server], []);
    expect(result[0]).toEqual(server);
  });

  it('throws McpNameCollisionError when personal and injected share a name', () => {
    expect(() => mergeMcps([mcp('shared')], [mcp('shared')])).toThrow(McpNameCollisionError);
  });

  it('personal vs injected collision has sources: both', () => {
    try {
      mergeMcps([mcp('clash')], [mcp('clash')]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpNameCollisionError);
      expect((err as McpNameCollisionError).sources).toBe('both');
      expect((err as McpNameCollisionError).mcpName).toBe('clash');
    }
  });

  it('throws McpNameCollisionError for duplicate names within injected', () => {
    expect(() => mergeMcps([], [mcp('dup'), mcp('dup')])).toThrow(McpNameCollisionError);
  });

  it('injected duplicate collision has sources: injected', () => {
    try {
      mergeMcps([], [mcp('dup'), mcp('dup')]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpNameCollisionError);
      expect((err as McpNameCollisionError).sources).toBe('injected');
      expect((err as McpNameCollisionError).mcpName).toBe('dup');
    }
  });

  it('detects injected duplicate even when personal is non-empty', () => {
    expect(() => mergeMcps([mcp('a')], [mcp('b'), mcp('b')])).toThrow(McpNameCollisionError);
  });

  it('personal+injected collision takes priority over injected duplicate when both present', () => {
    // 'x' in both personal and injected — collision type: both
    try {
      mergeMcps([mcp('x')], [mcp('x'), mcp('x')]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpNameCollisionError);
    }
  });
});
