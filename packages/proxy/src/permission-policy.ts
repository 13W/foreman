import { realpathSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

export type PermissionDecision = 'approve' | 'escalate';

function resolveReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isWithinDirectory(filePath: string, dirPath: string): boolean {
  const realFile = resolveReal(filePath);
  const realDir = resolveReal(dirPath);
  const rel = relative(realDir, realFile);
  return rel === '' || (!rel.startsWith('..') && !relative(realDir, realFile).startsWith('/'));
}

export function evaluateFsPermission(path: string, worktreeRoot: string): PermissionDecision {
  return isWithinDirectory(path, worktreeRoot) ? 'approve' : 'escalate';
}

export function evaluateTerminalPermission(
  command: string,
  whitelist: string[],
): PermissionDecision {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  const commandBasename = basename(firstToken);
  return whitelist.includes(commandBasename) ? 'approve' : 'escalate';
}
