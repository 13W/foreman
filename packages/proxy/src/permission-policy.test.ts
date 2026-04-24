import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateFsPermission, evaluateTerminalPermission } from './permission-policy.js';

describe('evaluateFsPermission — path containment', () => {
  it('approves path within worktree root', () => {
    expect(evaluateFsPermission('/work/task1/src/foo.ts', '/work/task1')).toBe('approve');
  });

  it('approves the worktree root itself', () => {
    expect(evaluateFsPermission('/work/task1', '/work/task1')).toBe('approve');
  });

  it('approves deeply nested path within worktree', () => {
    expect(evaluateFsPermission('/work/task1/a/b/c/d.txt', '/work/task1')).toBe('approve');
  });

  it('escalates path outside worktree root', () => {
    expect(evaluateFsPermission('/etc/passwd', '/work/task1')).toBe('escalate');
  });

  it('escalates sibling directory', () => {
    expect(evaluateFsPermission('/work/task2/file.ts', '/work/task1')).toBe('escalate');
  });

  it('escalates path traversal attempt (/work/task1/../task2/secret)', () => {
    expect(evaluateFsPermission('/work/task1/../task2/secret', '/work/task1')).toBe('escalate');
  });

  it('escalates home directory', () => {
    expect(evaluateFsPermission('/home/user/.ssh/id_rsa', '/work/task1')).toBe('escalate');
  });
});

describe('evaluateFsPermission — symlink handling', () => {
  it('approves symlink whose realpath resolves within worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'perm-test-'));
    const realDir = join(root, 'real');
    mkdirSync(realDir);
    const linkPath = join(root, 'link');
    symlinkSync(realDir, linkPath);

    expect(evaluateFsPermission(linkPath, root)).toBe('approve');
  });

  it('escalates symlink whose realpath resolves outside worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'perm-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const linkPath = join(root, 'escape');
    symlinkSync(outside, linkPath);

    expect(evaluateFsPermission(linkPath, root)).toBe('escalate');
  });
});

describe('evaluateTerminalPermission — whitelist matching', () => {
  it('approves command basename in whitelist', () => {
    expect(evaluateTerminalPermission('pnpm test', ['pnpm', 'npm'])).toBe('approve');
  });

  it('escalates command not in whitelist', () => {
    expect(evaluateTerminalPermission('rm -rf /', ['pnpm'])).toBe('escalate');
  });

  it('escalates all commands when whitelist is empty', () => {
    expect(evaluateTerminalPermission('git status', [])).toBe('escalate');
  });

  it('handles command with no args', () => {
    expect(evaluateTerminalPermission('git', ['git'])).toBe('approve');
  });

  it('strips full path prefix — /usr/bin/pnpm matches pnpm whitelist entry', () => {
    expect(evaluateTerminalPermission('/usr/bin/pnpm install', ['pnpm'])).toBe('approve');
  });

  it('escalates /usr/bin/rm when rm is not in whitelist', () => {
    expect(evaluateTerminalPermission('/usr/bin/rm -rf /', ['pnpm'])).toBe('escalate');
  });

  it('is case-sensitive for command matching', () => {
    expect(evaluateTerminalPermission('PNPM test', ['pnpm'])).toBe('escalate');
  });

  it('handles leading whitespace in command string', () => {
    expect(evaluateTerminalPermission('  pnpm test', ['pnpm'])).toBe('approve');
  });

  it('handles tab-separated command', () => {
    expect(evaluateTerminalPermission('\tpnpm\ttest', ['pnpm'])).toBe('approve');
  });

  it('approves any whitelisted single-word command', () => {
    const whitelist = ['npm', 'pnpm', 'cargo', 'go', 'python', 'pytest', 'git'];
    for (const cmd of whitelist) {
      expect(evaluateTerminalPermission(cmd, whitelist)).toBe('approve');
    }
  });
});
