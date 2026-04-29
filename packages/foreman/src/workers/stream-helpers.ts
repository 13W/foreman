import type { PermissionRequest, StreamEvent, TaskResult } from '@foreman-stack/shared';
import { TaskResult as TaskResultSchema } from '@foreman-stack/shared';

function isPermissionRequestPart(part: unknown): boolean {
  const p = part as Record<string, unknown> | null | undefined;
  if (!p || p['kind'] !== 'data') return false;
  const data = p['data'] as Record<string, unknown> | null | undefined;
  return (
    !!data &&
    typeof data['type'] === 'string' &&
    ['fs.read', 'fs.write', 'terminal.create'].includes(data['type'])
  );
}

export function isPermissionEvent(event: StreamEvent): boolean {
  if (event.type === 'message') {
    const data = event.data as Record<string, unknown> | null | undefined;
    const parts = data?.['parts'];
    if (!Array.isArray(parts)) return false;
    return parts.some(isPermissionRequestPart);
  }
  if (event.type === 'status') {
    const data = event.data as Record<string, unknown> | null | undefined;
    if (data?.['state'] !== 'input-required') return false;
    const message = data['message'] as Record<string, unknown> | null | undefined;
    const parts = message?.['parts'];
    if (!Array.isArray(parts)) return false;
    return parts.some(isPermissionRequestPart);
  }
  return false;
}

export function extractPermissionRequest(event: StreamEvent): PermissionRequest | null {
  let parts: unknown[];
  if (event.type === 'message') {
    const data = event.data as Record<string, unknown> | null | undefined;
    parts = (data?.['parts'] as unknown[]) ?? [];
  } else if (event.type === 'status') {
    const data = event.data as Record<string, unknown> | null | undefined;
    const message = data?.['message'] as Record<string, unknown> | null | undefined;
    parts = (message?.['parts'] as unknown[]) ?? [];
  } else {
    return null;
  }
  for (const part of parts) {
    if (isPermissionRequestPart(part)) {
      const p = part as Record<string, unknown>;
      const d = p['data'] as Record<string, unknown>;
      return {
        type: d['type'] as PermissionRequest['type'],
        path: d['path'] as string | undefined,
        command: d['command'] as string | undefined,
        message: (d['message'] as string | undefined) ?? '',
      };
    }
  }
  return null;
}

export function extractStatusResult(event: StreamEvent): TaskResult | null {
  const data = event.data as Record<string, unknown> | null | undefined;
  if (!data?.['final']) return null;
  const message = data['message'] as Record<string, unknown> | null | undefined;
  if (!message) return null;
  const parts = (message['parts'] as unknown[]) ?? [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'data' && p['data']) {
      const parsed = TaskResultSchema.safeParse(p['data']);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

/**
 * Extract a TaskResult embedded in a permissive follow-up event.
 * Workers in permissive mode emit input-required (final: false) with the
 * completed TaskResult in parts instead of immediately terminating. This helper
 * lets callers detect and extract the result so they can cancel the task.
 */
export function extractFollowUpResult(event: StreamEvent): TaskResult | null {
  if (event.type !== 'status') return null;
  const data = event.data as Record<string, unknown> | null | undefined;
  if (data?.['state'] !== 'input-required' || data?.['final'] !== false) return null;
  const message = data['message'] as Record<string, unknown> | null | undefined;
  const parts = (message?.['parts'] as unknown[]) ?? [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'data' && p['data']) {
      const parsed = TaskResultSchema.safeParse(p['data']);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

export function extractArtifactText(event: StreamEvent): string {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts = (data?.['parts'] as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (!p) continue;
    if (p['kind'] === 'text') {
      chunks.push(String(p['text'] ?? ''));
    } else if (p['kind'] === 'data') {
      chunks.push(JSON.stringify(p['data']));
    }
  }
  return chunks.join('');
}

export function extractMessageText(event: StreamEvent): string {
  const data = event.data as Record<string, unknown> | null | undefined;
  const parts = (data?.['parts'] as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as Record<string, unknown> | null | undefined;
    if (p?.['kind'] === 'text' && !isPermissionRequestPart(p)) {
      chunks.push(String(p['text'] ?? ''));
    }
  }
  return chunks.join('');
}

/**
 * Parses a worker tool-call activity title from a StreamEvent's status data.
 *
 * Returns the human-readable title if the status is a working event with a
 * useful title. Returns null for bare toolCallIds (toolu_xxx) or non-tool status.
 */
export function extractToolActivityTitle(event: StreamEvent): string | null {
  if (event.type !== 'status') return null;
  const data = event.data as Record<string, unknown> | null | undefined;
  if (!data) return null;
  if (data['state'] !== 'working') return null;

  // Resolve title from flat shape (data.message = string) or
  // double-wrapped shape (data.message = {state, message: string}).
  let titleSource: unknown = data['message'];
  if (titleSource && typeof titleSource === 'object') {
    const inner = titleSource as Record<string, unknown>;
    titleSource = inner['message'];
  }

  if (typeof titleSource !== 'string') return null;
  if (!titleSource.trim()) return null;

  // Filter out bare toolCallId strings emitted as update markers
  if (/^toolu_[A-Za-z0-9_-]+$/.test(titleSource)) return null;

  return titleSource;
}
