import type { McpServer } from './config.js';

export class McpNameCollisionError extends Error {
  constructor(
    public readonly mcpName: string,
    public readonly sources: 'personal' | 'injected' | 'both',
  ) {
    super(
      `MCP name '${mcpName}' collision in ${sources} sources. Rename or remove one.`,
    );
    this.name = 'McpNameCollisionError';
  }
}

export function validatePersonalMcps(mcps: McpServer[]): void {
  const seen = new Set<string>();
  for (const mcp of mcps) {
    if (seen.has(mcp.name)) {
      throw new McpNameCollisionError(mcp.name, 'personal');
    }
    seen.add(mcp.name);
  }
}

export function mergeMcps(personal: McpServer[], injected: McpServer[]): McpServer[] {
  const injectedSeen = new Set<string>();
  for (const mcp of injected) {
    if (injectedSeen.has(mcp.name)) {
      throw new McpNameCollisionError(mcp.name, 'injected');
    }
    injectedSeen.add(mcp.name);
  }

  const personalNames = new Set(personal.map((m) => m.name));
  for (const mcp of injected) {
    if (personalNames.has(mcp.name)) {
      throw new McpNameCollisionError(mcp.name, 'both');
    }
  }

  return [...personal, ...injected];
}
