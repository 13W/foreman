import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const PlannerConfigSchema = z.object({
  planner: z
    .object({
      name: z.string().default('foreman-planner'),
      version: z.string().default('0.1.0'),
      strategy: z.enum(['anthropic', 'stub']).default('anthropic'),
    })
    .default({ name: 'foreman-planner', version: '0.1.0', strategy: 'anthropic' }),
  llm: z.object({
    model: z.string(),
    api_key_env: z.string().default('ANTHROPIC_API_KEY'),
    max_tokens_per_plan: z.number().int().positive().default(16000),
    max_validation_retries: z.number().int().nonnegative().default(2),
  }),
  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      format: z.enum(['json', 'pretty']).default('json'),
      destination: z.enum(['stderr', 'stdout']).default('stderr'),
    })
    .default({ level: 'info', format: 'json', destination: 'stderr' }),
});

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), '.foreman', 'planner.yaml');

export function loadConfig(configPath: string): PlannerConfig {
  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf8');
    raw = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config file "${configPath}": ${msg}`);
  }

  const result = PlannerConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }

  return result.data;
}
