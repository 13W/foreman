import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { registerProcess } from './cleanup.js';
import YAML from 'yaml';
import type { AgentSkill } from '@foreman-stack/shared';

const execFileAsync = promisify(execFile);

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface SpawnProxyOpts {
  scriptPath: string;
  name?: string;
  description?: string;
  skills?: AgentSkill[];
}

export async function spawnProxy(opts: SpawnProxyOpts) {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const name = opts.name || 'test-agent';
  const description = opts.description || 'A test agent';
  const skills = opts.skills || [];
  const tempDir = join(tmpdir(), `foreman-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });

  // Initialize dummy git repo so worktrees can be created
  await execFileAsync('git', ['init'], { cwd: tempDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: tempDir });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial commit'], { cwd: tempDir });
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: tempDir });

  // Resolve fake-acp-agent.js path robustly
  let fakeAgentPath = join(import.meta.dirname, '..', 'fixtures', 'fake-acp-agent.js');
  if (!existsSync(fakeAgentPath)) {
    // If running from src, look in dist
    fakeAgentPath = join(import.meta.dirname, '..', '..', 'dist', 'fixtures', 'fake-acp-agent.js');
  }

  const configPath = join(tempDir, 'proxy.yaml');
  const config = {
    proxy: {
      name,
      version: '0.1.0',
      bind: `127.0.0.1:${port}`,
    },
    role: {
      description,
      skills,
    },
    wrapped_agent: {
      command: 'node',
      args: [
        fakeAgentPath,
        opts.scriptPath,
      ],
      startup_timeout_sec: 10,
    },
    worktrees: {
      base_dir: join(tempDir, 'worktrees'),
      default_base_branch: 'main',
    },
    logging: {
      level: 'debug',
    },
  };

  writeFileSync(configPath, YAML.stringify(config));

  const proxyBin = join(import.meta.dirname, '..', '..', '..', 'proxy', 'dist', 'cli.js');
  const child = spawn('node', [proxyBin, '--config', configPath], {
    cwd: tempDir,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, A2A_RACE_DELAY_MS: '500' },
  });

  registerProcess(child);

  // Wait a bit for proxy to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return { url, child, tempDir };
}
