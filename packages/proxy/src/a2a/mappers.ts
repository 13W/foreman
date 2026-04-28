import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TaskPayload } from '@foreman-stack/shared';
import type {
  AgentCardMetadata,
  PermissionDecision,
  PermissionRequest,
  StreamEvent,
  TaskResult,
} from '@foreman-stack/shared';
import type { AgentCard } from '@a2a-js/sdk';
import type { ContentBlock, PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { ProxyConfig } from '../config.js';
import type { WorktreeResult } from '../worktree-manager.js';
import type { PromptEvent } from '@foreman-stack/shared';
import { BaseBranchNotFoundError } from '../worktree-manager.js';
import { McpNameCollisionError } from '../mcp-merger.js';
import { PoolExhaustedError } from '../subprocess-pool.js';
import { PermissionTimeoutError } from '@foreman-stack/shared';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class MissingBaseBranchError extends Error {
  constructor() {
    super('Base branch must be non-empty');
    this.name = 'MissingBaseBranchError';
  }
}

export class InvalidPayloadError extends Error {
  constructor(detail: string) {
    super(`Invalid task payload: ${detail}`);
    this.name = 'InvalidPayloadError';
  }
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(config: ProxyConfig, payload: TaskPayload): ContentBlock[] {
  const lines: string[] = [];

  lines.push('=== Role ===', config.role.description, '');
  lines.push('=== Originator Intent ===', payload.originator_intent, '');
  lines.push('=== Task ===', payload.description, '');

  if (payload.expected_output) {
    lines.push('=== Expected Output ===', payload.expected_output, '');
  }

  if (payload.inputs.relevant_files.length > 0) {
    lines.push('=== Relevant Files ===', payload.inputs.relevant_files.join('\n'), '');
  }

  if (payload.inputs.constraints.length > 0) {
    lines.push('=== Constraints ===', payload.inputs.constraints.join('\n'), '');
  }

  if (payload.inputs.context_from_prior_tasks.length > 0) {
    lines.push(
      '=== Prior Task Context ===',
      payload.inputs.context_from_prior_tasks.map((c) => `[${c.task_id}] ${c.summary}`).join('\n'),
      '',
    );
  }

  return [{ type: 'text' as const, text: lines.join('\n').trim() }];
}

// ---------------------------------------------------------------------------
// mapPromptEventToStreamEvent
// ---------------------------------------------------------------------------

export function mapPromptEventToStreamEvent(event: PromptEvent): StreamEvent | null {
  switch (event.kind) {
    case 'agent_message_chunk':
      return {
        type: 'message',
        taskId: '',
        data: {
          kind: 'message',
          parts: [
            {
              kind: 'text',
              text: event.content.type === 'text' ? event.content.text : '',
            },
          ],
        },
      };
    case 'tool_call':
      return {
        type: 'status',
        taskId: '',
        data: { state: 'working', message: (event.update as any).title ?? (event.update as any).toolCallId },
      };
    case 'tool_call_update':
      return {
        type: 'status',
        taskId: '',
        data: { state: 'working', message: event.update.title ?? event.update.toolCallId },
      };
    case 'plan':
      return {
        type: 'status',
        taskId: '',
        data: {
          kind: 'message',
          messageId: randomUUID(),
          parts: [{ kind: 'data', data: { entries: event.entries } }],
          role: 'agent',
        },
      };
    case 'stop':
    case 'permission_request':
      return null;
  }
}

// ---------------------------------------------------------------------------
// buildTaskResult
// ---------------------------------------------------------------------------

type StopReasonString = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'timeout' | string;

export function buildTaskResult(
  stopReason: StopReasonString,
  worktreeResult: WorktreeResult,
  outputText = '',
): TaskResult {
  let status: 'completed' | 'failed' | 'cancelled';
  let stop_reason: string;

  switch (stopReason) {
    case 'end_turn':
      status = 'completed';
      stop_reason = 'end_turn';
      break;
    case 'cancelled':
      status = 'cancelled';
      stop_reason = 'cancelled';
      break;
    case 'max_tokens':
      status = 'failed';
      stop_reason = 'max_tokens';
      logger.warn({ stopReason }, 'Agent response truncated at max_tokens');
      break;
    case 'refusal':
      status = 'failed';
      stop_reason = 'refusal';
      break;
    default:
      status = 'failed';
      stop_reason = 'timeout';
  }

  return {
    status,
    stop_reason: stop_reason as any,
    summary: outputText,
    branch_ref: worktreeResult.branchName,
    session_transcript_ref: '',
    error: null,
  };
}

// ---------------------------------------------------------------------------
// buildErrorTaskResult
// ---------------------------------------------------------------------------

export function buildErrorTaskResult(err: unknown, worktreeResult?: WorktreeResult): TaskResult {
  const message = err instanceof Error ? err.message : String(err);
  const branch_ref = worktreeResult?.branchName ?? '';

  if (err instanceof MissingBaseBranchError) {
    return { status: 'failed', stop_reason: null, summary: '', branch_ref, session_transcript_ref: '', error: { code: 'missing_base_branch', message } };
  }
  if (err instanceof BaseBranchNotFoundError) {
    return { status: 'failed', stop_reason: null, summary: '', branch_ref, session_transcript_ref: '', error: { code: 'base_branch_not_found', message } };
  }
  if (err instanceof McpNameCollisionError) {
    return { status: 'failed', stop_reason: null, summary: '', branch_ref, session_transcript_ref: '', error: { code: 'mcp_name_collision', message } };
  }
  if (err instanceof PoolExhaustedError) {
    return { status: 'failed', stop_reason: null, summary: '', branch_ref, session_transcript_ref: '', error: { code: 'proxy_busy', message } };
  }
  if (err instanceof PermissionTimeoutError) {
    return { status: 'failed', stop_reason: 'timeout', summary: '', branch_ref, session_transcript_ref: '', error: { code: 'permission_timeout', message } };
  }
  return { status: 'failed', stop_reason: 'subprocess_crash', summary: '', branch_ref, session_transcript_ref: '', error: { code: 'internal_error', message } };
}

// ---------------------------------------------------------------------------
// Zod schema for PermissionDecision
// ---------------------------------------------------------------------------

const PermissionDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow_once') }),
  z.object({ kind: z.literal('allow_always') }),
  z.object({ kind: z.literal('reject_once') }),
  z.object({ kind: z.literal('reject_always') }),
  z.object({ kind: z.literal('cancelled') }),
]);

// ---------------------------------------------------------------------------
// parsePermissionDecision
// ---------------------------------------------------------------------------

export function parsePermissionDecision(message: import('@a2a-js/sdk').Message): PermissionDecision {
  for (const part of message.parts) {
    if (part.kind === 'data') {
      const result = PermissionDecisionSchema.safeParse(part.data);
      if (result.success) return result.data;
    }
  }
  for (const part of message.parts) {
    if (part.kind === 'text') {
      try {
        const parsed = JSON.parse(part.text);
        const result = PermissionDecisionSchema.safeParse(parsed);
        if (result.success) return result.data;
      } catch {
        // fall through
      }
    }
  }
  logger.warn({ parts: message.parts }, 'invalid permission decision response; defaulting to reject_once');
  return { kind: 'reject_once' };
}

// ---------------------------------------------------------------------------
// parseTaskPayload
// ---------------------------------------------------------------------------

export function parseTaskPayload(message: import('@a2a-js/sdk').Message): TaskPayload {
  for (const part of message.parts) {
    if (part.kind === 'data') {
      const result = TaskPayload.safeParse(part.data);
      if (result.success) return result.data;
    }
  }
  for (const part of message.parts) {
    if (part.kind === 'text') {
      try {
        const parsed = JSON.parse(part.text);
        const result = TaskPayload.safeParse(parsed);
        if (result.success) return result.data;
      } catch {
        // fall through
      }
    }
  }
  throw new InvalidPayloadError('no valid TaskPayload found in message parts');
}

// ---------------------------------------------------------------------------
// mapDecisionToAcpResponse
// ---------------------------------------------------------------------------

export function mapDecisionToAcpResponse(
  decision: PermissionDecision,
  options: PermissionOption[],
): RequestPermissionResponse {
  if (decision.kind === 'cancelled') {
    return { outcome: { outcome: 'cancelled' } };
  }
  const option = options.find((o) => o.kind === decision.kind);
  if (!option) {
    logger.warn({ decision, options }, 'agent did not provide option for decision kind; defaulting to cancelled');
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

// ---------------------------------------------------------------------------
// mapToPermissionRequest
// ---------------------------------------------------------------------------

export function mapToPermissionRequest(request: import('@foreman-stack/shared').ACPPermissionRequest): PermissionRequest {
  let message: string;
  if (request.type === 'fs.read') message = `Read access requested: ${request.path ?? '(unknown path)'}`;
  else if (request.type === 'fs.write') message = `Write access requested: ${request.path ?? '(unknown path)'}`;
  else message = `Terminal command requested: ${request.command ?? '(unknown command)'}`;

  return {
    type: request.type as import('@foreman-stack/shared').PermissionRequestType,
    path: request.path,
    command: request.command,
    message,
  };
}

// ---------------------------------------------------------------------------
// buildSdkAgentCard
// ---------------------------------------------------------------------------

export function buildSdkAgentCard(metadata: AgentCardMetadata): AgentCard {
  return {
    name: metadata.name,
    description: metadata.description ?? '',
    url: metadata.url,
    version: metadata.version,
    protocolVersion: '0.3.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: metadata.skills ?? [],
  };
}
