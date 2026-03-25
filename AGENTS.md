# Agent Coordination

Use `WORK_QUEUE.org` as the canonical shared task tracker for this repository
when that file exists in the local worktree. It is intentionally local-only
and is not tracked in git.

## Required Workflow

1. Read `WORK_QUEUE.org` before starting substantial work, if present.
2. Claim an existing task or add a new task there before editing code.
3. Update the task's `STATUS`, `ASSIGNEE`, `BRANCH`, `LAST_COMMIT`, and
   `UPDATED_AT` fields as work progresses.
4. Append a log entry whenever the task is claimed, paused, handed off,
   changes branch, or materially changes scope.
5. Use `WORKTREE` as `LAST_COMMIT` for uncommitted changes.
6. Run `npm audit --package-lock-only` whenever `package.json` changes and
   address or document the results before handing work off.

## Coordination Rules

- Do not create parallel ad hoc task lists in other files.
- Keep task history append-only; never rewrite another agent's log entry.
- Leave blocked or review-ready tasks in a resumable state with factual notes.
- Prefer one task per coherent unit of work rather than batching unrelated
  changes together.
