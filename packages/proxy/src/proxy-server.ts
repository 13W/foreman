// packages/proxy/src/proxy-server.ts
import type {
  A2AServer,
  ACPClientManager,
  ACPPermissionRequest,
  ContentBlock,
  PermissionDecision,
  PromptEvent,
  SessionHandle,
  StreamEvent,
  TaskHandle,
  TaskPayload,
  TaskResult,
} from '@foreman-stack/shared';
import type pino from 'pino';
import { evaluateFsPermission, evaluateTerminalPermission, type PolicyDecision } from './permission-policy.js';
import { mergeMcps, validatePersonalMcps } from './mcp-merger.js';
import { SubprocessPool } from './subprocess-pool.js';
import type { WorktreeResult } from './worktree-manager.js';
import { WorktreeManager } from './worktree-manager.js';
import type { ProxyConfig } from './config.js';
import { logger as defaultLogger } from './logger.js';
import {
  buildSystemPrompt,
  buildTaskResult,
  buildErrorTaskResult,
  mapPromptEventToStreamEvent,
  mapToPermissionRequest,
  MissingBaseBranchError,
} from './a2a/mappers.js';

export class ProxyServer {
  private readonly logger: pino.Logger;

  constructor(
    private readonly config: ProxyConfig,
    private readonly a2aServer: A2AServer,
    private readonly subprocessPool: SubprocessPool,
    private readonly worktreeManager: WorktreeManager,
    private readonly acpClientManager: ACPClientManager,
    logger?: pino.Logger,
  ) {
    this.logger = logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    validatePersonalMcps(this.config.mcps.personal);

    const agentCard = {
      name: this.config.proxy.name,
      url: `http://${this.config.proxy.bind}`,
      version: this.config.proxy.version,
      skills: this.config.role.skills as import('@a2a-js/sdk').AgentSkill[],
    };

    this.a2aServer.onTask((payload, handle) => this.handleTask(payload, handle));
    this.a2aServer.register(agentCard);
    await this.a2aServer.listen(this.config.proxy.bind);

    this.logger.info({ name: this.config.proxy.name, bind: this.config.proxy.bind }, 'ProxyServer started');
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.subprocessPool.shutdown(),
      this.a2aServer.close(),
    ]);
    this.logger.info('ProxyServer shut down');
  }

  private async handleTask(payload: TaskPayload, handle: TaskHandle): Promise<void> {
    const { taskId } = handle;
    const log = this.logger.child({ taskId });
    log.info({ description: payload.description.slice(0, 120) }, 'task received');

    // 1. Resolve base branch
    const baseBranch = payload.base_branch ?? this.config.worktrees.default_base_branch;
    if (!baseBranch) {
      await this.a2aServer.completeTask(taskId, buildErrorTaskResult(new MissingBaseBranchError()));
      return;
    }

    // 2. Create worktree
    let worktreeResult: WorktreeResult;
    try {
      worktreeResult = await this.worktreeManager.createForTask(taskId, baseBranch);
    } catch (err) {
      log.error({ err }, 'Failed to create worktree');
      await this.a2aServer.completeTask(taskId, buildErrorTaskResult(err));
      return;
    }

    // 3. Merge MCPs
    let mergedMcps;
    try {
      const personalAsSpec: import('@foreman-stack/shared').McpServerSpec[] = this.config.mcps.personal.map((m) => ({
        name: m.name,
        transport: 'stdio' as const,
        command: m.command,
        args: m.args,
        env: m.env,
      }));
      mergedMcps = mergeMcps(personalAsSpec, payload.injected_mcps);
    } catch (err) {
      log.error({ err }, 'MCP name collision');
      await this.worktreeManager.cleanup(taskId);
      await this.a2aServer.completeTask(taskId, buildErrorTaskResult(err, worktreeResult));
      return;
    }

    // 4. Acquire session
    let pooled;
    try {
      pooled = await this.subprocessPool.acquireSession(worktreeResult.worktreePath, mergedMcps);
    } catch (err) {
      log.error({ err }, 'Failed to acquire session from pool');
      await this.worktreeManager.cleanup(taskId);
      await this.a2aServer.completeTask(taskId, buildErrorTaskResult(err, worktreeResult));
      return;
    }

    // 5. Register cancel function BEFORE runPrompt
    this.a2aServer.setCancelFn(taskId, () => {
      this.acpClientManager.cancelSession(pooled.session).catch((err) => {
        log.warn({ err }, 'cancelSession error during cancelFn');
      });
    });

    // 6. Run the prompt loop
    let result: TaskResult = buildErrorTaskResult(new Error('unknown'), worktreeResult);
    let content: ContentBlock[] = buildSystemPrompt(this.config, payload);

    try {
      while (true) {
        const { stopReason, outputText } = await this.runPrompt(content, taskId, pooled.session, worktreeResult);
        result = buildTaskResult(stopReason, worktreeResult, outputText);

        if (this.config.proxy.terminal_mode !== 'permissive' || result.status !== 'completed') {
          break;
        }

        const followUpText = await this.a2aServer.requestFollowUp(taskId, result);
        if (followUpText === null) {
          log.info('no follow-up received, task done');
          result = buildTaskResult('cancelled', worktreeResult);
          break;
        }
        content = [{ type: 'text', text: followUpText }];
      }
    } catch (err) {
      log.error({ err }, 'runPrompt failed');
      result = buildErrorTaskResult(err, worktreeResult);
    } finally {
      await pooled.release();
      await this.worktreeManager.cleanup(
        taskId,
        result.status === 'completed' ? 'completed' : result.status,
      );
    }

    if (result.status === 'completed') {
      log.info({ stopReason: result.stop_reason }, 'task finished: completed');
    } else if (result.status === 'cancelled') {
      log.warn({ stopReason: result.stop_reason }, 'task finished: cancelled');
    } else {
      log.error({ stopReason: result.stop_reason, error: result.error }, 'task finished: failed');
    }
    await this.a2aServer.completeTask(taskId, result);
  }

  private async runPrompt(
    content: ContentBlock[],
    taskId: string,
    session: SessionHandle,
    worktreeResult: WorktreeResult,
  ): Promise<{ stopReason: string; outputText: string }> {
    const stream = this.acpClientManager.sendPrompt(session, content);
    let outputText = '';

    for await (const event of stream) {
      if (event.kind === 'permission_request') {
        await this.handlePermissionEvent(taskId, event, worktreeResult);
      } else if (event.kind === 'stop') {
        return { stopReason: event.reason, outputText };
      } else {
        if (event.kind === 'agent_message_chunk' && event.content.type === 'text') {
          outputText += event.content.text;
        }
        const mapped = mapPromptEventToStreamEvent(event);
        if (mapped) {
          await this.a2aServer.sendUpdate(taskId, { ...mapped, taskId } as StreamEvent);
        }
      }
    }
    this.logger.warn({ taskId }, 'ACP stream ended without stop event — task cancelled');
    return { stopReason: 'cancelled', outputText };
  }

  private async handlePermissionEvent(
    taskId: string,
    event: PromptEvent & { kind: 'permission_request' },
    worktreeResult: WorktreeResult,
  ): Promise<void> {
    const policy = this.evaluateProxyPolicy(event.request, worktreeResult.worktreePath);

    if (policy === 'approve') {
      await event.respond({ kind: 'allow_once' });
      return;
    }

    const timeoutMs = this.config.permissions.permission_timeout_sec * 1000;
    const permRequest = mapToPermissionRequest(event.request);
    let decision: PermissionDecision;
    try {
      decision = await this.a2aServer.requestInput(taskId, permRequest, { timeoutMs });
    } catch (_err) {
      decision = { kind: 'reject_once' };
    }
    await event.respond(decision);
  }

  private evaluateProxyPolicy(
    request: ACPPermissionRequest,
    worktreePath: string,
  ): PolicyDecision {
    if (request.type === 'fs.read' || request.type === 'fs.write') {
      return evaluateFsPermission(request.path ?? '', worktreePath);
    }
    if (request.type === 'terminal.create') {
      return evaluateTerminalPermission(
        request.command ?? '',
        this.config.permissions.terminal_whitelist,
      );
    }
    return 'escalate';
  }
}
