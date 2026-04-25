import {
  AgentSideConnection,
  ndJsonStream,
  Agent,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Logger } from 'pino';
import { SessionManager } from './session.js';
import { PlannerConfig } from './config.js';

export class PlannerServer implements Agent {
  private connection: AgentSideConnection | null = null;

  constructor(
    private config: PlannerConfig,
    private sessionManager: SessionManager,
    private logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.logger.info('Starting ACP planner server');

    const stream = ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    );

    this.connection = new AgentSideConnection(() => this, stream);
    
    // Wait for connection to close
    await this.connection.closed;
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down ACP planner server');
  }

  // ACP Agent implementation
  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.logger.debug({ request }, 'Received initialize request');
    return {
      protocolVersion: request.protocolVersion,
      agentCapabilities: {
        promptCapabilities: {
          // No streaming property in PromptCapabilities, just audio/etc.
        },
      },
      agentInfo: {
        name: this.config.planner.name,
        version: this.config.planner.version,
      },
    };
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    this.logger.debug({ request }, 'Received newSession request');
    const sessionId = randomUUID();
    this.sessionManager.createSession(sessionId);
    return {
      sessionId,
    };
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    this.logger.debug({ request }, 'Received prompt request');
    const { sessionId, prompt } = request;

    try {
      const responseText = await this.sessionManager.handlePrompt(sessionId, prompt);
      
      // Send the content via notification before returning the response
      if (this.connection) {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: responseText,
            },
          },
        });
      }

      return {
        stopReason: 'end_turn',
      };
    } catch (err) {
      this.logger.error({ err, sessionId }, 'Error handling prompt');
      throw err;
    }
  }

  async cancel(notification: CancelNotification): Promise<void> {
    this.logger.debug({ notification }, 'Received cancel notification');
    const { sessionId } = notification;
    this.sessionManager.removeSession(sessionId);
  }

  // Other methods from Agent interface can be left as undefined if not used
  async authenticate() { return {}; }
}
