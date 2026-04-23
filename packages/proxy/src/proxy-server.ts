import type { ProxyConfig } from './config.js';
import { logger as defaultLogger } from './logger.js';
import type pino from 'pino';

export class ProxyServer {
  private readonly config: ProxyConfig;
  private readonly logger: pino.Logger;

  constructor(config: ProxyConfig, logger?: pino.Logger) {
    this.config = config;
    this.logger = logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    this.logger.warn(
      { name: this.config.proxy.name, bind: this.config.proxy.bind },
      'ProxyServer.start() — not implemented',
    );
  }

  async shutdown(): Promise<void> {
    this.logger.info('ProxyServer.shutdown() — not implemented');
  }
}
