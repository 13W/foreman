import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ForemanConfig } from './config.js';
import { createLogger } from './logger.js';
import { DefaultACPAgentServer } from './acp/server.js';

/**
 * Foreman stub — wires the ACP server with placeholder handlers.
 *
 * Real orchestration logic (LLMLoop, WorkerCatalog, DispatchManager, SessionManager,
 * PlanExecutor, PlannerSessionManager) is implemented in t4.7-min and later subtasks.
 */
export class Foreman {
  private readonly config: ForemanConfig;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly acpServer: DefaultACPAgentServer;

  constructor(config: ForemanConfig) {
    this.config = config;
    this.logger = createLogger(config.logging);
    this.acpServer = new DefaultACPAgentServer();
  }

  async start(): Promise<void> {
    const { config, logger, acpServer } = this;

    logger.info({ name: config.foreman.name, version: config.foreman.version }, 'Foreman starting');

    acpServer.onInitialize(() => {
      logger.info('ACP initialize received');
    });

    acpServer.onSessionNew((sessionId) => {
      logger.info({ sessionId }, 'ACP session/new received');
    });

    acpServer.onPrompt(async (sessionId, _content: ContentBlock[]) => {
      logger.info({ sessionId }, 'ACP session/prompt received — stub response');
      // TODO(t4.7-min): replace stub with real LLMLoop + orchestration
      await acpServer.sendUpdate(sessionId, [
        {
          type: 'text',
          text: 'Foreman is starting up; full functionality comes in t4.7.',
        },
      ]);
    });

    acpServer.onCancel((sessionId) => {
      logger.info({ sessionId }, 'ACP session/cancel received');
    });

    logger.info('Listening for ACP connections on stdio');
    await acpServer.listen();
  }

  async shutdown(): Promise<void> {
    this.logger.info('Foreman shutting down');
    // TODO(t4.7-min): cancel active A2A dispatches, close planner sessions
  }
}
