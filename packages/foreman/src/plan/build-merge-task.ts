import type { TaskPayload } from '@foreman-stack/shared';

export interface MergeTaskInputs {
  baseBranch: string;
  branchesToMerge: Array<{ subtaskId: string; branchRef: string; description: string }>;
  cwd: string;
  originatorIntent: string;
}

/**
 * Compose a TaskPayload that instructs a worker to sequentially merge multiple branches
 * into the base branch, with up-front conflict detection and worktree cleanup on success.
 *
 * Throws if branchesToMerge is empty.
 */
export function buildMergeTask(inputs: MergeTaskInputs): TaskPayload {
  const { baseBranch, branchesToMerge, cwd, originatorIntent } = inputs;

  if (branchesToMerge.length === 0) {
    throw new Error('cannot build merge task with no branches');
  }

  const branchList = branchesToMerge
    .map((b, i) => `${i + 1}. \`${b.branchRef}\` — ${b.description}`)
    .join('\n');

  const description = `
Sequentially merge the following completed worker branches into \`${baseBranch}\`:

${branchList}

Steps:

1. Ensure you are on the \`${baseBranch}\` branch in \`${cwd}\`. Run \`git checkout ${baseBranch}\` if needed.

2. For each branch listed above, in order:
   a. Run \`git merge --no-commit --no-ff <branch_ref>\`.
   b. If the merge has conflicts (exit code != 0 or "CONFLICT" in stderr/stdout):
      - Run \`git merge --abort\` to clean up.
      - Stop the loop — do NOT proceed to subsequent branches.
      - Report the conflicting branch_ref and the files that conflicted.
      - Do NOT remove any worktrees.
   c. If the merge is clean, run \`git commit -m "merge: <subtask description>"\` to record the merge.
   d. After successful merge, remove the worktree for that branch:
      \`git worktree list\` to find the path; then \`git worktree remove --force <path>\`.

3. After ALL branches merge cleanly, output a summary with the list of merged branches.

If a merge conflicts:
- Output a summary that names the conflicting branch and lists the conflict files.
- Do NOT delete or modify any worktrees in this case.
- Other (already-merged) branches in the current run keep their merges; only the conflicting one and any later ones are skipped.

Use only Read, Bash, and Glob tools. Do not modify file contents — only run git commands.
`.trim();

  return {
    description,
    expected_output:
      'A merge report: either "all branches merged cleanly into <base>" or "conflict on <branch>, files: ...".',
    inputs: {
      relevant_files: [],
      constraints: [
        'Use only Bash and Read tools.',
        'Do NOT edit file contents — git operations only.',
        'On conflict: abort, do not delete worktrees, do not proceed to next branch.',
        "On success: remove the merged branch's worktree via git worktree remove --force.",
      ],
      context_from_prior_tasks: [],
    },
    originator_intent: originatorIntent,
    max_delegation_depth: 0,
    parent_task_id: null,
    base_branch: baseBranch,
    timeout_sec: 600,
    injected_mcps: [],
    cwd,
  };
}
