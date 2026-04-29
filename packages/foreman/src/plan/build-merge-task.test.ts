import { describe, it, expect } from 'vitest';
import { buildMergeTask } from './build-merge-task.js';
import { TaskPayload } from '@foreman-stack/shared';

const BASE_INPUTS = {
  baseBranch: 'main',
  branchesToMerge: [
    { subtaskId: 's1', branchRef: 'foreman/task-aaa', description: 'add feature X' },
  ],
  cwd: '/repo',
  originatorIntent: 'add feature X and tests',
};

describe('buildMergeTask', () => {
  it('throws when branchesToMerge is empty', () => {
    expect(() => buildMergeTask({ ...BASE_INPUTS, branchesToMerge: [] })).toThrow(
      'cannot build merge task with no branches',
    );
  });

  it('builds a valid TaskPayload for a single branch', () => {
    const payload = buildMergeTask(BASE_INPUTS);
    expect(() => TaskPayload.parse(payload)).not.toThrow();
    expect(payload.description).toContain('foreman/task-aaa');
    expect(payload.description).toContain('main');
    expect(payload.base_branch).toBe('main');
    expect(payload.cwd).toBe('/repo');
    expect(payload.originator_intent).toBe('add feature X and tests');
    expect(payload.max_delegation_depth).toBe(0);
    expect(payload.timeout_sec).toBe(600);
  });

  it('builds a valid TaskPayload for multiple branches in order', () => {
    const inputs = {
      ...BASE_INPUTS,
      branchesToMerge: [
        { subtaskId: 's1', branchRef: 'foreman/task-aaa', description: 'feature A' },
        { subtaskId: 's2', branchRef: 'foreman/task-bbb', description: 'feature B' },
        { subtaskId: 's3', branchRef: 'foreman/task-ccc', description: 'feature C' },
      ],
    };
    const payload = buildMergeTask(inputs);
    expect(() => TaskPayload.parse(payload)).not.toThrow();
    const aIdx = payload.description.indexOf('foreman/task-aaa');
    const bIdx = payload.description.indexOf('foreman/task-bbb');
    const cIdx = payload.description.indexOf('foreman/task-ccc');
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
    expect(payload.description).toContain('1. `foreman/task-aaa`');
    expect(payload.description).toContain('2. `foreman/task-bbb`');
    expect(payload.description).toContain('3. `foreman/task-ccc`');
  });

  it('includes all required TaskPayload fields', () => {
    const payload = buildMergeTask(BASE_INPUTS);
    expect(payload.description).toBeTruthy();
    expect(payload.expected_output).toBeTruthy();
    expect(payload.inputs.constraints.length).toBeGreaterThan(0);
    expect(payload.injected_mcps).toEqual([]);
    expect(payload.parent_task_id).toBeNull();
  });

  it('description contains git merge instruction', () => {
    const payload = buildMergeTask(BASE_INPUTS);
    expect(payload.description).toContain('git merge --no-commit --no-ff');
    expect(payload.description).toContain('git merge --abort');
    expect(payload.description).toContain('git worktree remove --force');
  });
});
