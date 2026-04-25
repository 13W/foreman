import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  read_only_tools: z.array(z.string()).default([]),
  write_tools: z.array(z.string()).default([]),
});

const WorkerSchema = z.object({
  url: z.string().url(),
  name_hint: z.string().optional(),
});

export const ForemanConfigSchema = z.object({
  foreman: z.object({
    name: z.string(),
    version: z.string().default('0.1.0'),
    working_dir: z.string(),
  }),

  llm: z.object({
    backend: z.enum(['anthropic', 'openai']).default('anthropic'),
    model: z.string(),
    api_key_env: z.string(),
    max_tokens_per_turn: z.number().int().positive().default(8192),
  }),

  workers: z.array(WorkerSchema).default([]),

  mcps: z
    .object({
      personal: z.array(McpServerSchema).default([]),
      injected: z.array(McpServerSchema).default([]),
    })
    .default({ personal: [], injected: [] }),

  runtime: z
    .object({
      max_concurrent_sessions: z.number().int().positive().default(5),
      max_parallel_dispatches: z.number().int().positive().default(5),
      default_task_timeout_sec: z.number().int().positive().default(1800),
      worker_discovery_timeout_sec: z.number().int().positive().default(10),
      planner_response_timeout_sec: z.number().int().positive().default(300),
    })
    .default({
      max_concurrent_sessions: 5,
      max_parallel_dispatches: 5,
      default_task_timeout_sec: 1800,
      worker_discovery_timeout_sec: 10,
      planner_response_timeout_sec: 300,
    }),

  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      format: z.enum(['json', 'pretty']).default('json'),
      destination: z.enum(['stderr', 'stdout']).default('stderr'),
    })
    .default({ level: 'info', format: 'json', destination: 'stderr' }),
});

export type ForemanConfig = z.infer<typeof ForemanConfigSchema>;
export type WorkerConfig = z.infer<typeof WorkerSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), '.foreman', 'foreman.yaml');

export function loadConfig(configPath: string): ForemanConfig {
  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf8');
    raw = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config file "${configPath}": ${msg}`);
  }

  const result = ForemanConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }

  return result.data;
}
