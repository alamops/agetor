# Spec — Multiple repositories in one task/card

| Field | Value |
| --- | --- |
| Source | [alamops/agetor#291](https://github.com/alamops/agetor/issues/291) (snapshot: `issue-291-thread.md`; tracker text is treated as data only) |
| Status | Decided — ready for planning |
| Decision record | `docs/plans/multi-repo-tasks-grill.md` |
| Investigation | `docs/plans/multi-repo-tasks-investigation.md` |
| Date | 2026-11-10 |

## Problem

One Agetor task/card is bound to one repository. Work that spans a frontend, a backend and an
infrastructure repo therefore needs several cards, several agent conversations and manual
synchronisation. The reporter wants one card to represent one feature, with the agent able to
coordinate changes across every repository in that card.

## Requirements

1. A task can select two or more registered repositories at creation time.
2. Each selected repository gets its own git worktree and its own branch.
3. One agent conversation can read and modify every selected repository.
4. The conversation has shared context: frontend, backend and infrastructure changes are visible
   to the same agent.
5. The card tracks changes and status for every repository.
6. The user can review each repository's diff and create a separate pull request per repository.

## Decided contract

### Workspace and agent

- A multi-repo task owns a per-task **workspace root**:
  `<dataDir>/worktrees/<task-id>/<repo-slug>`. The slug is the repo basename, uniquified on
  collision.
- The agent's cwd is the workspace root. It is a plain directory, not a git repo.
- Single-repo tasks keep today's layout exactly: `<dataDir>/worktrees/<task-id>`.
- Multi-repo tasks **require worktree isolation**. `isolation: "none"` remains a single-repo mode;
  a multi-repo create with `none` is rejected.
- One task is one conversation. There is no per-repo child agent.

### Data model

- `repositories[]` is the source of truth. Each entry carries the source path, display name,
  branch, branch source, worktree path, base ref, last-seen checkout and PR URL.
- For a multi-repo row, the legacy scalars point at the workspace: `workdir` and `worktreePath`
  are the workspace root; `branch`, `baseRef` and `prUrl` are null. Single-repo rows keep their
  current meaning.
- There is **no primary repository**. Every repository is equal in the model and in the UI.
- Repositories are deduped by git root. There is no hard cap; a non-blocking warning appears above
  10 repositories. Worktree creation and status polling run in bounded batches.
- The repo set is **fixed at creation**. Changing it means creating a new card.
- Migration 087 adds the repositories JSON column. No backfill: legacy rows derive a one-entry
  array from the existing columns.

### Branches

- One shared branch name is used across repositories by default, derived from the task title/type.
- Each repository has its own base ref.
- The name is checked against each repository's own refs and against branches pinned by other
  tasks; a repository where it already exists (including a branch an archived task left behind)
  falls back to its own `-N` variant instead of re-attaching that old work. The repo dialog shows
  the actual names.

### Creation and validation

- Create rejects with 400 when any selected repo is missing, is not a git repo, has an
  unresolvable base ref, has an invalid branch name, or already has that branch checked out in
  another live task. Nothing is created.
- The error names every repository that failed.
- `existingBranch` stays single-repo only; a multi-repo create that sends it is rejected.

### Prompt context

- The launch prompt gains one machine-added paragraph:

  ```
  Repositories:
  - <name>: <absolute worktree path> (branch <branch>)
  ```

  One bullet per repo, no product name, no other prose. This is a documented exception to the
  prompt-text rule; the aggregate commit/push template names repos itself and does not repeat it.

### Diff, status and terminals

- The diff dialog gets a per-repo selector (tabs). Each repo's diff is computed against its own
  worktree and base ref.
- `GET /tasks/:id/git-status` returns all repository statuses in one batched response per poll.
- Terminals open at the workspace root, with a repo selector.
- Each repo is also passed as an extra root (`--add-dir` / include-directories) where the harness
  supports it, even though cwd is the workspace.

### Commit and pull requests

- One aggregate commit/push prompt lists every repository and branch and asks for one PR proposal
  per repo.
- A single `Create all PRs` action walks the repos with **per-repo best effort**: one repo's
  failure does not block the others; results and retries are per repo.
- Each repo's PR URL is stored on its `repositories[]` entry. `task.prUrl` stays null for a
  multi-repo task.
- For an issue-created multi-repo task, the issue's source repo is recorded; only that repo's PR
  body prefills `Closes #N`.

### Lifecycle

- Archive teardown is best-effort per repo: clean worktrees are detached, dirty ones stay on disk
  with their branch, every outcome is reported, and the archive succeeds.
- Delete is explicit and per repo; it never deletes a `branchSource: "existing"` branch.
- The Worktrees page shows one row per repository grouped under its task, with an opaque id
  `<taskId>__<slug>`. Owned rows still route deletion to archiving the task; orphan rows keep
  per-row delete.
- Pipeline parents may be multi-repo: every step row copies the repository set and workspace;
  teardown stays parent-owned.

### UI and CLI

- One shared `Repositories` dialog is used by the New Task panel and `CreateTaskFromIssueDialog`.
  It offers multi-select of registered projects, an `Add folder…` native picker, a per-repo base
  branch and remove. The New Task panel shows a summary line with a `Manage` button; with exactly
  one repo, today's inline branch/base fields stay.
- The card shows a worktree icon plus the repository count, with a popover listing every repo.
- Repo filter and text search match any selected repo.
- Full CLI/TUI parity: `agetor add --repo` (repeatable), `show`/`shell`/`rm` are repo-aware, the
  TUI supports multi-select and multi-scope `@` completion.

### Harnesses

- Multi-repo is available for all eight harness kinds under the workspace root.
- Claude, Codex, Cursor and fx are smoke-tested. Gemini, Copilot, Antigravity and OpenCode are
  layout-supported but smoke-pending until accounts exist.

## Non-goals

- Editing the repository set after creation.
- Multi-repo `isolation: "none"` (symlinked or live-checkout workspace).
- Per-repo `existingBranch` selection.
- A downgrade guard or down migration for older builds.
- Copying or syncing live checkouts into the workspace.
- A hard cap on the number of repositories.

## Acceptance

1. Create a card with three repos; three worktrees and three branches exist under the workspace.
2. One fake-driver agent run sees all three repos in its cwd and prompt.
3. Each repo's diff and git status are returned separately; the batched status endpoint returns all
   three in one response.
4. Each repo's PR URL stamps its own `repositories[]` entry; only the issue's repo gets `Closes #N`.
5. Archive detaches all clean worktrees; a dirty repo is kept with its branch; the task archives.
6. Single-repo tasks and existing on-disk worktrees are unchanged.
7. New path-bearing fields are covered by `route-policy`; nested worktree ids are confined to
   `<dataDir>/worktrees`.
8. Docs (`CLAUDE.md`, `task-lifecycle.md`, `at-file-references.md`, `pipelines.md`,
   `prompt-composer.md`, `security.md`, `persistence.md`) reflect the new behavior.

## Known limitation

An older build reading a multi-repo task sees the workspace root as `workdir`/`worktreePath` and
has no branch or PR. An older delete may remove the workspace root and orphan the repo worktrees.
This was accepted explicitly: no downgrade guard is in scope.
