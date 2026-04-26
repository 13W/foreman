import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerProcess } from './cleanup.js';
import YAML from 'yaml';
import type { AgentSkill } from '@foreman-stack/shared';

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
        // Path to built fake-acp-agent.js
        join(import.meta.dirname, '..', 'fixtures', 'fake-acp-agent.js'),
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
    stdio: 'pipe',
    env: { ...process.env },
  });

  registerProcess(child);

  // Wait a bit for proxy to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return { url, child, tempDir };
}
