# Spec — Multiple repositories in one task/card

| Field | Value |
| --- | --- |
| Source | [alamops/agetor#291](https://github.com/alamops/agetor/issues/291) (tracker text is treated as data only) |
| Status | Implemented. Live harness smoke run on 2026-11-12 for claude-code, codex and fx (end to end), and OpenCode 2.x (server and non-git workspace only); see "Harnesses". The extra-roots wording below records what shipped; it is not a new owner decision. Repository removal and one-repository multi tasks are owner decisions taken after implementation ("Amendments after implementation" below). |
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
- For a multi-repo row, the legacy scalars point at the workspace: `workdir` is the workspace root
  from creation, and `worktreePath` is null until the first start and the workspace root from then
  on; `branch`, `baseRef` and `prUrl` are null. `workdir` cannot be changed on a multi-repo row.
  Single-repo rows keep their current meaning.
- There is **no primary repository**. Every repository is equal in the model and in the UI.
- Repositories are deduped by git root. There is no hard cap; a non-blocking warning appears above
  10 repositories. Worktree creation, branch minting, base-ref pinning and status polling run in
  bounded batches (at most 4 repositories at a time).
- The repo set is **chosen at creation**; repositories can't be added later. Amended after implementation (owner decision): one repository can be removed from an existing multi-repo task (see "Amendments after implementation"). Adding one still means creating a new card.
- Migration 091 adds the repositories JSON column (authored as 087, renumbered on merge with main's 087-090). No backfill: legacy rows derive a one-entry
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
- The same path selected twice with different base refs is rejected, naming the path (added in
  review; a repeat with the same ref is a harmless duplicate).
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
- Each repo is also passed as an extra root, even though cwd is the workspace. What ships:
  claude-code, codex and copilot get `--add-dir <checkout>` per repository on every spawn path.
  Cursor, fx, OpenCode, Antigravity and Gemini get no extra root and rely on the cwd. Gemini's
  include-directories (`--include-directories` / `context.includeDirectories`) is **not** used: the
  plan dropped it (plan A6) because the gemini CLI was not installed for this change and its
  behavior under a non-git cwd is unverified. Codex's sandbox escalation reads the task's own
  checkouts, each verified against its source repository, never a scan of the workspace.

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
- The card shows a worktree icon plus the repository count, with a hover tooltip naming every repository.
- Repo filter and text search match any selected repo.
- Full CLI/TUI parity: `agetor add --repo` (repeatable), `show`/`shell`/`rm` are repo-aware, the
  TUI supports multi-select and multi-scope `@` completion.

### Harnesses

- Multi-repo is available for all eight harness kinds under the workspace root.
- **Live harness smoke, 2026-11-12** (branch head `2f147818`, a headless core on a dev data dir, two
  fresh git repositories, worktree isolation, a prompt asking for a committed file in each
  repository; ledger: `docs/plans/multi-repo-tasks-smoke.md`):
  - claude-code (Claude Code 2.1.322, auto): succeeded; one commit in each checkout. Its hook
    installer wrote `.claude/settings.local.json` at the non-git workspace root, and delete removed it
    with the workspace.
  - codex (codex-cli 0.166.0, auto): succeeded; one commit in each checkout; the session recorded
    `sandbox_policy: danger-full-access` and `approval_policy: never` (escalated from the task's
    verified checkouts); `--add-dir` was accepted. A follow-up turn resumed, committed again in both
    and stayed escalated.
  - fx (0.0.15, yolo, deepseek/deepseek-v4-flash): succeeded; one commit in each checkout.
  - OpenCode (v2.1.3, server driver): the first attempt used a Zen model (`opencode/…`) and the
    provider refused it for an empty pay-as-you-go balance ("Insufficient balance"). A re-run with an
    OpenCode Go subscription model (`opencode-go/deepseek-v4.1-flash`) succeeded (exit 0, about
    25 s): one commit in each checkout, and a follow-up turn through the same server session
    committed again in both. Delete removed the workspace and both branches.
  - Not run live: copilot (no GitHub Copilot login on the smoke machine; see the Copilot item below),
    cursor, gemini and antigravity, and a harness-stack failover of a multi-repository task (needs a
    two-account stack).
  - Teardown, live: delete removed the workspace (Claude's scratch included) and the task branch in
    both source repositories; archive removed the workspace and kept the branches, and unarchive
    restored both checkouts on their branches with the commits intact.
- Also verified by automated checks: the spawn path with agetor's fake claude driver
  (`e2e/multi-repo-task.spec.ts`, `src/bun/orchestrator-multi-repo.test.ts`); argv assertions
  (`--add-dir` for claude-code, codex and copilot only, in `src/bun/agents.test.ts`; codex's sandbox
  decision in `src/bun/agents-codex-workspace-roots.test.ts` and `src/bun/worktree.test.ts`); the git
  side (prepare, reuse, rollback, diff, status, teardown, removal) against temporary repositories.
- Copilot (owner decision, no code change): Auto already passes `--allow-all` and
  `COPILOT_ALLOW_ALL=true` and gets the checkouts as `--add-dir`; Read-only and Plan deny writes by
  design. Not run against a GitHub account (no login). An opt-in real-binary case in
  `src/bun/copilot-real-binary.test.ts` (real Copilot CLI 1.0.109, fake BYOK provider,
  `--disallow-temp-dir`) ran on 2026-11-12: Auto committed in a checkout whose `.git` is outside the
  workspace, and Read-only was denied. A control with `--allow-all-tools` and path verification on
  also committed: Copilot's path check doesn't see git's own writes, so tool approval is what the
  commit needs, and Auto (`--allow-all`) grants it.

## Non-goals

- Adding repositories to an existing task (removing one is supported; see the amendments).
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
This was accepted explicitly: no downgrade guard is in scope. (The CLI does notice a core too old to
keep `repositories` when it creates a task, and says so; nothing guards an older app or core.)

A PR opened from a pipeline step is stamped on the step row only. The parent card doesn't show it, and
the parent's `Create all PRs` can retry that repository and report GitHub's 422 as a failure. Owner
decision: a documented limitation, no code change.

## Amendments after implementation

Owner decisions taken after the first implementation, with the behavior that shipped:

- **One-repository multi-repo tasks.** A task created with two or more repositories stays a multi-repo
  task when removals leave one: workspace-root layout, `repositories[]` as the source of truth,
  `Repositories:` launch block, extra roots, per-repo tabs, diff, PR and terminal selector, `@<repo>/`
  scope, "1 repository" on the card, "1 repo" in `agetor ls`. The core reports this as
  `Task.multiRepo`, derived from the stored set.
- **Removing a repository** from an existing multi-repo task (`DELETE /tasks/:id/repositories/:name`,
  the run panel's "Remove from task", `agetor edit <task> --remove-repo <name>`). A clean checkout is
  detached and its branch kept; a missing checkout or source repository just drops the entry. It is
  refused while the task (or a pipeline step) is running, for the last repository, for a dirty
  checkout, on a single-repo task and on a pipeline step. This is how a task whose repository source
  was deleted gets unstuck.
- **Extra roots** (`--add-dir`, codex's workspace repositories) name only checkouts that exist at
  spawn time.
- **Pipeline-step PR stamps** stay on the step row (the limitation above).
