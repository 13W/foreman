import { describe, expect, it } from 'vitest';
import { McpServerSpec } from './mcp.js';

describe('McpServerSpec', () => {
  it('parses a valid stdio MCP server spec', () => {
    const result = McpServerSpec.safeParse({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'token123' },
    });
    expect(result.success).toBe(true);
  });

  it('parses a valid sse MCP server spec', () => {
    const result = McpServerSpec.safeParse({
      name: 'my-server',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
    });
    expect(result.success).toBe(true);
  });

  it('parses a spec without optional fields', () => {
    const result = McpServerSpec.safeParse({
      name: 'minimal',
      transport: 'stdio',
      command: 'mcp-server',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toBeUndefined();
      expect(result.data.env).toBeUndefined();
    }
  });

  it('rejects missing name', () => {
    const result = McpServerSpec.safeParse({
      transport: 'stdio',
      command: 'mcp-server',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid transport', () => {
    const result = McpServerSpec.safeParse({
      name: 'bad',
      transport: 'websocket',
      command: 'mcp-server',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = McpServerSpec.safeParse({
      name: 'test',
      transport: 'stdio',
      command: 'mcp-server',
      unknownField: 'should fail',
    });
    expect(result.success).toBe(false);
  });
});
