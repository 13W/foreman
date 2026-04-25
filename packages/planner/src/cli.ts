#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createLogger } from './logger.js';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';
import { PlannerServer } from './server.js';
import { SessionManager } from './session.js';
import { StubStrategy } from './strategy.stub.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    `Usage: foreman-planner [--config <path>]\n\n` +
      `Options:\n` +
      `  -c, --config <path>  Path to planner.yaml (default: ~/.foreman/planner.yaml)\n` +
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

const logger = createLogger(config.logging);

logger.info(
  {
    name: config.planner.name,
    version: config.planner.version,
    configPath,
  },
  'Starting foreman-planner',
);

const strategy = new StubStrategy();
const sessionManager = new SessionManager(strategy);
const server = new PlannerServer(config, sessionManager, logger);

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received signal, shutting down');
  try {
    await server.shutdown();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

server.start().catch((err) => {
  logger.error({ err }, 'Fatal error in planner server');
  process.exit(1);
});
