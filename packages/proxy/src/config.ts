import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopbackBind(bind: string): boolean {
  const lastColon = bind.lastIndexOf(':');
  if (lastColon === -1) return LOOPBACK_HOSTS.has(bind);
  const host = bind.startsWith('[')
    ? bind.slice(1, bind.lastIndexOf(']'))
    : bind.slice(0, lastColon);
  return LOOPBACK_HOSTS.has(host);
}

const BindSchema = z.string().refine(isLoopbackBind, {
  message:
    'Remote bind is not supported in MVP. Use port forwarding (ssh, socat, docker) for cross-machine setups.',
});

const AgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
});

// Proxy's MCP config: passthrough to wrapped_agent. Tool classification
// (read vs write) is the wrapped agent's concern, not the proxy's.
const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const ProxyConfigSchema = z.object({
  proxy: z.object({
    name: z.string(),
    version: z.string().default('0.1.0'),
    bind: BindSchema,
    /**
     * Controls task lifecycle on agent end_turn.
     * - strict (default): agent end_turn → A2A task transitions to completed/final.
     *   Use for one-shot worker tasks.
     * - permissive: agent end_turn → A2A task transitions to input-required, NOT
     *   final. Task stays alive awaiting follow-up sendMessage from the A2A
     *   client. Used for stateful plan-owner sessions where foreman queries
     *   the planner during execution.
     */
    terminal_mode: z.enum(['strict', 'permissive']).default('strict'),
  }),

  wrapped_agent: z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd_strategy: z.literal('worktree').default('worktree'),
    startup_timeout_sec: z.number().int().positive().default(30),
  }),

  role: z.object({
    description: z.string(),
    skills: z.array(AgentSkillSchema).default([]),
  }),

  mcps: z
    .object({
      personal: z.array(McpServerSchema).default([]),
    })
    .default({ personal: [] }),

  permissions: z
    .object({
      terminal_whitelist: z.array(z.string()).default([]),
      permission_timeout_sec: z.number().int().positive().default(300),
    })
    .default({ terminal_whitelist: [], permission_timeout_sec: 300 }),

  worktrees: z.object({
    base_dir: z.string(),
    branch_prefix: z.string().default('foreman/task-'),
    default_base_branch: z.string().default('main'),
    cleanup_policy: z.enum(['never', 'on_success', 'always', 'ttl']).default('never'),
  }),

  runtime: z
    .object({
      max_subprocesses: z.number().int().positive().default(1),
      max_sessions_per_subprocess: z.number().int().positive().default(1),
      task_hard_timeout_sec: z.number().int().positive().default(3600),
    })
    .default({
      max_subprocesses: 1,
      max_sessions_per_subprocess: 1,
      task_hard_timeout_sec: 3600,
    }),

  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      format: z.enum(['json', 'pretty']).default('json'),
      destination: z.enum(['stderr', 'stdout']).default('stderr'),
      msg_log_file: z.string().optional(),
    })
    .default({ level: 'info', format: 'json', destination: 'stderr' }),
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type AgentSkill = z.infer<typeof AgentSkillSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), '.foreman', 'proxy.yaml');

export function loadConfig(configPath: string): ProxyConfig {
  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf8');
    raw = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config file "${configPath}": ${msg}`);
  }

  const result = ProxyConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }

  return result.data;
}

export { isLoopbackBind };
