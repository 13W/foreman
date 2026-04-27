#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createLogger, configureLevel } from './logger.js';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';
import { ProxyServer } from './proxy-server.js';
import { DefaultA2AServer } from './a2a/server.js';
import { SubprocessPool } from './subprocess-pool.js';
import { WorktreeManager } from './worktree-manager.js';
import { DefaultACPClientManager } from './acp/client.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    `Usage: foreman-proxy [--config <path>]\n\n` +
      `Options:\n` +
      `  -c, --config <path>  Path to proxy.yaml (default: ~/.foreman/proxy.yaml)\n` +
      `  -h, --help           Show this help\n`,
  );
  process.exit(0);
}

const configPath = values.config ?? DEFAULT_CONFIG_PATH;

// Bootstrap logger before config so we can log parse errors
const bootstrapLogger = createLogger();

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  bootstrapLogger.error({ err, configPath }, 'Failed to load config');
  process.exit(1);
}

configureLevel(config.logging.level);
const logger = createLogger(config.logging);

logger.info(
  {
    name: config.proxy.name,
    version: config.proxy.version,
    bind: config.proxy.bind,
    configPath,
  },
  'Starting foreman-proxy',
);

const acpClientManager = new DefaultACPClientManager();
const subprocessPool = new SubprocessPool(config, acpClientManager);
const worktreeManager = new WorktreeManager(config);
const a2aServer = new DefaultA2AServer();
const server = new ProxyServer(config, a2aServer, subprocessPool, worktreeManager, acpClientManager, logger);
const shutdownTimeout = config.runtime.task_hard_timeout_sec > 0 ? 30_000 : 30_000;

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Received signal, shutting down');

  const timer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, shutdownTimeout);
  timer.unref();

  try {
    await server.shutdown();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }

  clearTimeout(timer);
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

server.start().catch((err) => {
  logger.error({ err }, 'Fatal error in proxy server');
  process.exit(1);
});
