import * as http from 'node:http';
import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type {
  A2AServer,
  AgentCardMetadata,
  PermissionDecision,
  PermissionRequest,
  StreamEvent,
  TaskHandler,
  TaskResult,
} from '@foreman-stack/shared';
import { ProxyAgentExecutor } from './executor.js';
import { buildSdkAgentCard } from './mappers.js';
import { logger } from '../logger.js';

export class DefaultA2AServer implements A2AServer {
  private executor!: ProxyAgentExecutor;
  private readonly app: express.Application;
  private server?: http.Server;
  private taskHandlerFn?: TaskHandler;

  constructor() {
    this.app = express();
    this.app.use(express.json());
  }

  register(agentCard: AgentCardMetadata): void {
    if (!this.taskHandlerFn) {
      throw new Error('Call onTask() before register()');
    }
    const sdkCard = buildSdkAgentCard(agentCard);
    this.executor = new ProxyAgentExecutor(this.taskHandlerFn, agentCard.url);
    const requestHandler = new DefaultRequestHandler(sdkCard, new InMemoryTaskStore(), this.executor);

    // Mount agent card at the SDK-defined path
    this.app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
    this.app.post(
      '/a2a/jsonrpc',
      jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
    );
  }

  onTask(handler: TaskHandler): void {
    this.taskHandlerFn = handler;
  }

  sendUpdate(taskId: string, update: StreamEvent): void {
    this.executor.sendUpdate(taskId, update);
  }

  completeTask(taskId: string, result: TaskResult): void {
    this.executor.completeTask(taskId, result);
  }

  setCancelFn(taskId: string, fn: () => void): void {
    this.executor.setCancelFn(taskId, fn);
  }

  async requestInput(
    taskId: string,
    request: PermissionRequest,
    opts: { timeoutMs: number },
  ): Promise<PermissionDecision> {
    return this.executor.requestInput(taskId, request, opts);
  }

  listen(bindAddr: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port } = parseBindAddr(bindAddr);
      this.server = http.createServer(this.app);
      this.server.listen(port, host, () => {
        logger.info({ bindAddr }, 'A2A server listening');
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function parseBindAddr(bindAddr: string): { host: string; port: number } {
  // IPv6: [::1]:4000
  if (bindAddr.startsWith('[')) {
    const closeBracket = bindAddr.indexOf(']');
    const host = bindAddr.slice(1, closeBracket);
    const port = parseInt(bindAddr.slice(closeBracket + 2), 10);
    return { host, port };
  }
  // IPv4/hostname: 127.0.0.1:4000
  const lastColon = bindAddr.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: bindAddr, port: 4000 };
  }
  return {
    host: bindAddr.slice(0, lastColon),
    port: parseInt(bindAddr.slice(lastColon + 1), 10),
  };
}
