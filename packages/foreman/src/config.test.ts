import { describe, expect, it } from 'vitest';
import { ForemanConfigSchema } from './config.js';

const minimalValidConfig = {
  foreman: { name: 'test-foreman', working_dir: '/tmp/project' },
  llm: { model: 'claude-sonnet-4-7', api_key_env: 'ANTHROPIC_API_KEY' },
};

describe('ForemanConfigSchema', () => {
  it('accepts a minimal valid config with defaults applied', () => {
    const result = ForemanConfigSchema.safeParse(minimalValidConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.foreman.version).toBe('0.1.0');
    expect(result.data.llm.backend).toBe('anthropic');
    expect(result.data.llm.max_tokens_per_turn).toBe(8192);
    expect(result.data.workers).toEqual([]);
    expect(result.data.runtime.max_concurrent_sessions).toBe(5);
    expect(result.data.runtime.max_parallel_dispatches).toBe(5);
    expect(result.data.runtime.default_task_timeout_sec).toBe(1800);
    expect(result.data.runtime.worker_discovery_timeout_sec).toBe(10);
    expect(result.data.runtime.planner_response_timeout_sec).toBe(300);
    expect(result.data.logging.level).toBe('info');
    expect(result.data.logging.format).toBe('json');
    expect(result.data.logging.destination).toBe('stderr');
  });

  it('accepts a full config with all fields', () => {
    const result = ForemanConfigSchema.safeParse({
      foreman: { name: 'my-foreman', version: '0.2.0', working_dir: '/path/to/project' },
      llm: {
        backend: 'anthropic',
        model: 'claude-sonnet-4-7',
        api_key_env: 'ANTHROPIC_API_KEY',
        max_tokens_per_turn: 4096,
      },
      workers: [
        { url: 'http://127.0.0.1:7001', name_hint: 'refactorer' },
        { url: 'http://127.0.0.1:7002', name_hint: 'planner' },
      ],
      mcps: {
        personal: [{ name: 'github', command: 'gh-mcp', args: ['--stdio'] }],
        injected: [{ name: 'github', command: 'gh-mcp', args: ['--stdio'] }],
      },
      runtime: {
        max_concurrent_sessions: 3,
        max_parallel_dispatches: 10,
        default_task_timeout_sec: 3600,
        worker_discovery_timeout_sec: 15,
        planner_response_timeout_sec: 600,
      },
      logging: { level: 'debug', format: 'pretty', destination: 'stderr' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.workers).toHaveLength(2);
    expect(result.data.runtime.max_concurrent_sessions).toBe(3);
    expect(result.data.runtime.planner_response_timeout_sec).toBe(600);
  });

  it('rejects config missing foreman.name', () => {
    const result = ForemanConfigSchema.safeParse({
      foreman: { working_dir: '/tmp' },
      llm: { model: 'claude-sonnet-4-7', api_key_env: 'KEY' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects config missing llm.model', () => {
    const result = ForemanConfigSchema.safeParse({
      foreman: { name: 'x', working_dir: '/tmp' },
      llm: { api_key_env: 'KEY' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid worker URL', () => {
    const result = ForemanConfigSchema.safeParse({
      ...minimalValidConfig,
      workers: [{ url: 'not-a-url' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid runtime values (zero or negative)', () => {
    const result = ForemanConfigSchema.safeParse({
      ...minimalValidConfig,
      runtime: { max_concurrent_sessions: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid log level', () => {
    const result = ForemanConfigSchema.safeParse({
      ...minimalValidConfig,
      logging: { level: 'verbose' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown llm backend', () => {
    const result = ForemanConfigSchema.safeParse({
      ...minimalValidConfig,
      llm: { ...minimalValidConfig.llm, backend: 'groq' },
    });
    expect(result.success).toBe(false);
  });

  it('applies mcp defaults (empty arrays for args, env, tool overrides)', () => {
    const result = ForemanConfigSchema.safeParse({
      ...minimalValidConfig,
      mcps: {
        personal: [{ name: 'atlassian', command: 'atlassian-mcp' }],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const mcp = result.data.mcps.personal[0];
    expect(mcp.args).toEqual([]);
    expect(mcp.env).toEqual({});
    expect(mcp.read_only_tools).toEqual([]);
    expect(mcp.write_tools).toEqual([]);
  });
});
