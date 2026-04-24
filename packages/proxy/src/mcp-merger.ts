export class McpNameCollisionError extends Error {
  constructor(
    public readonly mcpName: string,
    public readonly sources: 'personal' | 'injected' | 'both',
  ) {
    super(`MCP name '${mcpName}' collision in ${sources} sources. Rename or remove one.`);
    this.name = 'McpNameCollisionError';
  }
}

export function validatePersonalMcps(mcps: Array<{ name: string }>): void {
  const seen = new Set<string>();
  for (const mcp of mcps) {
    if (seen.has(mcp.name)) {
      throw new McpNameCollisionError(mcp.name, 'personal');
    }
    seen.add(mcp.name);
  }
}

export function mergeMcps<T extends { name: string }>(personal: T[], injected: T[]): T[] {
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
