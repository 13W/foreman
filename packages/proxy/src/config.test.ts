import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, isLoopbackBind } from './config.js';

const VALID_CONFIG = `
proxy:
  name: "test-agent"
  bind: "127.0.0.1:7001"

wrapped_agent:
  command: "claude"
  args: ["--acp"]

role:
  description: "Test agent"

worktrees:
  base_dir: "/tmp/foreman-worktrees"
`;

function writeTmp(content: string): string {
  const dir = join(tmpdir(), `proxy-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'proxy.yaml');
  writeFileSync(path, content, 'utf8');
  return path;
}

// --- isLoopbackBind ---

describe('isLoopbackBind', () => {
  it.each(['127.0.0.1:7001', '127.0.0.1:80', 'localhost:7001', '[::1]:7001'])(
    'accepts loopback bind %s',
    (bind) => {
      expect(isLoopbackBind(bind)).toBe(true);
    },
  );

  it.each(['0.0.0.0:7001', '192.168.1.1:7001', '10.0.0.1:7001', '::0:7001'])(
    'rejects non-loopback bind %s',
    (bind) => {
      expect(isLoopbackBind(bind)).toBe(false);
    },
  );
});

// --- loadConfig: valid ---

describe('loadConfig — valid config', () => {
  let configPath: string;

  beforeEach(() => {
    configPath = writeTmp(VALID_CONFIG);
  });

  afterEach(() => {
    unlinkSync(configPath);
  });

  it('parses a minimal valid config', () => {
    const config = loadConfig(configPath);
    expect(config.proxy.name).toBe('test-agent');
    expect(config.proxy.bind).toBe('127.0.0.1:7001');
    expect(config.wrapped_agent.command).toBe('claude');
  });

  it('applies defaults for optional fields', () => {
    const config = loadConfig(configPath);
    expect(config.proxy.version).toBe('0.1.0');
    expect(config.wrapped_agent.startup_timeout_sec).toBe(30);
    expect(config.runtime.max_subprocesses).toBe(1);
    expect(config.runtime.max_sessions_per_subprocess).toBe(1);
    expect(config.runtime.task_hard_timeout_sec).toBe(3600);
    expect(config.logging.level).toBe('info');
    expect(config.logging.format).toBe('json');
    expect(config.logging.destination).toBe('stderr');
    expect(config.worktrees.cleanup_policy).toBe('never');
    expect(config.mcps.personal).toEqual([]);
    expect(config.role.skills).toEqual([]);
  });

  it('parses a full config with all fields', () => {
    const fullConfig = `
proxy:
  name: "full-agent"
  version: "1.0.0"
  bind: "localhost:9000"

wrapped_agent:
  command: "gemini"
  args: ["--acp", "--verbose"]
  env:
    API_KEY: "test"
  cwd_strategy: "worktree"
  startup_timeout_sec: 60

role:
  description: "Full test agent"
  skills:
    - id: "skill-1"
      name: "Skill One"
      description: "Does something"
      tags: ["a", "b"]
      examples: ["example 1"]

mcps:
  personal:
    - name: "ts-lsp"
      command: "typescript-language-server"
      args: ["--stdio"]

worktrees:
  base_dir: "/tmp/test-worktrees"
  branch_prefix: "test/task-"
  default_base_branch: "develop"
  cleanup_policy: "on_success"

runtime:
  max_subprocesses: 3
  max_sessions_per_subprocess: 5
  task_hard_timeout_sec: 7200

logging:
  level: "debug"
  format: "pretty"
  destination: "stdout"
`;
    const path = writeTmp(fullConfig);
    try {
      const config = loadConfig(path);
      expect(config.proxy.name).toBe('full-agent');
      expect(config.proxy.version).toBe('1.0.0');
      expect(config.proxy.bind).toBe('localhost:9000');
      expect(config.wrapped_agent.command).toBe('gemini');
      expect(config.wrapped_agent.env).toEqual({ API_KEY: 'test' });
      expect(config.role.skills).toHaveLength(1);
      expect(config.role.skills[0].id).toBe('skill-1');
      expect(config.mcps.personal).toHaveLength(1);
      expect(config.worktrees.cleanup_policy).toBe('on_success');
      expect(config.runtime.max_subprocesses).toBe(3);
      expect(config.logging.level).toBe('debug');
      expect(config.logging.format).toBe('pretty');
    } finally {
      unlinkSync(path);
    }
  });
});

// --- loadConfig: invalid ---

describe('loadConfig — invalid configs', () => {
  it('throws when config file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path/proxy.yaml')).toThrow(/Failed to read config file/);
  });

  it('throws when proxy.name is missing', () => {
    const path = writeTmp(`
proxy:
  bind: "127.0.0.1:7001"
wrapped_agent:
  command: "claude"
role:
  description: "test"
worktrees:
  base_dir: "/tmp"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws when bind is non-loopback', () => {
    const path = writeTmp(`
proxy:
  name: "test"
  bind: "0.0.0.0:7001"
wrapped_agent:
  command: "claude"
role:
  description: "test"
worktrees:
  base_dir: "/tmp"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws when wrapped_agent.command is missing', () => {
    const path = writeTmp(`
proxy:
  name: "test"
  bind: "127.0.0.1:7001"
wrapped_agent:
  args: []
role:
  description: "test"
worktrees:
  base_dir: "/tmp"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws when role.description is missing', () => {
    const path = writeTmp(`
proxy:
  name: "test"
  bind: "127.0.0.1:7001"
wrapped_agent:
  command: "claude"
role: {}
worktrees:
  base_dir: "/tmp"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws when worktrees.base_dir is missing', () => {
    const path = writeTmp(`
proxy:
  name: "test"
  bind: "127.0.0.1:7001"
wrapped_agent:
  command: "claude"
role:
  description: "test"
worktrees: {}
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });

  it('rejects invalid cleanup_policy values', () => {
    const path = writeTmp(`
proxy:
  name: "test"
  bind: "127.0.0.1:7001"
wrapped_agent:
  command: "claude"
role:
  description: "test"
worktrees:
  base_dir: "/tmp"
  cleanup_policy: "eventually"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });

  it('rejects invalid logging level', () => {
    const path = writeTmp(`
proxy:
  name: "test"
  bind: "127.0.0.1:7001"
wrapped_agent:
  command: "claude"
role:
  description: "test"
worktrees:
  base_dir: "/tmp"
logging:
  level: "verbose"
`);
    try {
      expect(() => loadConfig(path)).toThrow(/Config validation failed/);
    } finally {
      unlinkSync(path);
    }
  });
});
