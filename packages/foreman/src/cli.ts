#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createLogger, configureLevel } from './logger.js';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';
import { Foreman } from './foreman.js';
import { SessionManager } from './session/manager.js';
import { createPlannerSession } from './plan/index.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    `Usage: foreman [--config <path>]\n\n` +
      `Options:\n` +
      `  -c, --config <path>  Path to foreman.yaml (default: ~/.foreman/foreman.yaml)\n` +
      `  -h, --help           Show this help\n`,
  );
  process.exit(0);
}

const configPath = values.config ?? DEFAULT_CONFIG_PATH;
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
  { name: config.foreman.name, version: config.foreman.version, configPath },
  'Starting foreman',
);

const sessionManager = new SessionManager({
  maxConcurrentSessions: config.runtime.max_concurrent_sessions,
  logger,
});

const foreman = new Foreman({
  config,
  sessionManager,
  plannerSessionFactory: createPlannerSession,
});
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Received signal, shutting down');

  const timer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 30_000);
  timer.unref();

  try {
    await foreman.shutdown();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }

  clearTimeout(timer);
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

foreman.start().catch((err) => {
  logger.error({ err }, 'Fatal error in foreman');
  process.exit(1);
});
