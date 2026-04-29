import { spawn, execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { registerProcess } from './cleanup.js';
import YAML from 'yaml';
import type { MockAnthropicServer } from './mock-anthropic-server.js';

const execFileAsync = promisify(execFile);

export interface SpawnForemanOpts {
  workers: { url: string; name_hint?: string }[];
  mockAnthropic?: MockAnthropicServer;
}

export async function spawnForeman(opts: SpawnForemanOpts) {
  const tempDir = join(tmpdir(), `foreman-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });

  // Initialize a git repo so workers can create worktrees in this directory
  await execFileAsync('git', ['init'], { cwd: tempDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: tempDir });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], { cwd: tempDir });
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: tempDir });

  const configPath = join(tempDir, 'foreman.yaml');
  const config = {
    foreman: {
      name: 'test-foreman',
      version: '0.1.0',
      working_dir: tempDir,
    },
    llm: {
      backend: 'anthropic',
      model: 'claude-sonnet-4-7',
      api_key_env: 'FAKE_API_KEY', // We use fake key for integration tests
    },
    workers: opts.workers,
    runtime: {
      max_concurrent_sessions: 5,
      max_parallel_dispatches: 5,
      default_task_timeout_sec: 1800,
    },
    logging: {
      level: 'debug',
    },
  };

  writeFileSync(configPath, YAML.stringify(config));

  const foremanBin = join(import.meta.dirname, '..', '..', '..', 'foreman', 'dist', 'cli.js');
  
  const env: Record<string, string> = { 
    ...process.env,
    FAKE_API_KEY: 'sk-fake-123',
  };

  if (opts.mockAnthropic) {
    const { url } = await opts.mockAnthropic.start();
    env.ANTHROPIC_BASE_URL = url;
  }

  const child = spawn('node', [foremanBin, '--config', configPath], {
    stdio: ['pipe', 'pipe', 'inherit'], // stdin/stdout piped for ACP, stderr inherited for logs
    env,
  });

  registerProcess(child);

  // Wait a bit for foreman to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  return { child, tempDir };
}
