import type { LLMToolDefinition } from './client.js';

export type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;

// Returns true = approved, false = denied.
export type EscalationCallback = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

const READ_ONLY_PREFIX_RE =
  /^(get_|list_|search_|read_|find_|query_|show_|check_|describe_|fetch_)/;

interface RegistryEntry {
  definition: LLMToolDefinition;
  handler: ToolHandler;
  forceReadOnly?: boolean;
  forceWrite?: boolean;
}

export interface RegisterOptions {
  forceReadOnly?: boolean;
  forceWrite?: boolean;
}

export class ToolRegistry {
  private readonly _tools = new Map<string, RegistryEntry>();
  private _escalate: EscalationCallback | undefined;

  register(
    name: string,
    definition: LLMToolDefinition,
    handler: ToolHandler,
    opts?: RegisterOptions,
  ): void {
    this._tools.set(name, { definition, handler, ...opts });
  }

  setEscalationCallback(cb: EscalationCallback): void {
    this._escalate = cb;
  }

  listTools(): LLMToolDefinition[] {
    return [...this._tools.values()].map((e) => e.definition);
  }

  isReadOnly(name: string): boolean {
    const entry = this._tools.get(name);
    if (!entry) return false;
    if (entry.forceWrite) return false;
    if (entry.forceReadOnly) return true;
    return READ_ONLY_PREFIX_RE.test(name);
  }

  async invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const entry = this._tools.get(name);
    if (!entry) throw new Error(`Unknown tool: "${name}"`);

    if (!this.isReadOnly(name)) {
      if (!this._escalate) {
        throw new Error(
          `Tool "${name}" requires write permission but no escalation callback is set`,
        );
      }
      const approved = await this._escalate(name, args);
      if (!approved) {
        throw new Error(`Tool "${name}" was denied by permission escalation`);
      }
    }

    return entry.handler(args, signal);
  }
}
