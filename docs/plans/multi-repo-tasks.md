# Plan — Multiple repositories in one task/card (#291)

| Field | Value |
| --- | --- |
| Date | 2026-11-10 |
| Source | `docs/specs/multi-repo-tasks.md` (decided spec), `docs/plans/multi-repo-tasks-grill.md` (2 rounds, 30/30 decisions), `docs/plans/multi-repo-tasks-investigation.md` (evidence P1–P10), [alamops/agetor#291](https://github.com/alamops/agetor/issues/291) |
| Flags | none |
| Gates | grilled + decided by the owner (round-1/answers.json, round-2/answers.json); spec committed at `8e308518`; plan self-approved for pipeline execution — owner review happens at the handoff before code lands |
| Status | implemented; live harness smoke run 2026-11-12 (T17 below): claude-code, codex and fx end to end; OpenCode 2.x end to end on a re-run with an OpenCode Go model (the first attempt's Zen balance was empty); copilot not run live (no login), its Auto permissions confirmed from the CLI's `--help` and an opt-in real-binary case added, pending a run; cursor and harness failover not run. Repository removal and one-repository multi tasks were added after implementation by owner decision (§3.5). Ledger: `docs/plans/multi-repo-tasks-smoke.md` |
| Branch | `feature/issue-291-feature-request-support-multip` |
| Base SHA | `8e308518fd4db2630a1b866522548f786b4d80ec` (`8e308518`, decision record; `c45fd806` is main) |

## 1. Objective & success criteria

**Objective.** One task/card can be created against two or more registered repositories. Each repository gets its own git worktree and branch inside a per-task workspace root; one agent conversation runs at that root and sees every repository; the card, run panel, diff dialog, terminals, Worktrees page, pipelines, issue-created tasks, CLI and TUI all carry the repository dimension; each repository's PR is stored on its own entry.

Every criterion below names the production path that produces it and the test that drives that path.

| # | Criterion (from `docs/specs/multi-repo-tasks.md` §Acceptance) | Production path | Proof |
| --- | --- | --- | --- |
| 1 | Create a card with 3 repos; 3 worktrees and 3 branches exist under the workspace. | `POST /tasks` → `orchestrator.createTask` → `tasks.insert`; `POST /tasks/:id/start` → `startTaskInner` → `prepareTaskWorkdir` → `prepareRepoWorktree` → `tasks.setRepositories` | `src/bun/orchestrator-multi-repo.test.ts`, `src/bun/worktree.test.ts`, e2e `multi-repo-task.spec.ts` |
| 2 | One fake-driver agent run sees all 3 repos in its cwd and prompt. | `startTaskInner` spawns with `cwd = workspace`; launch prompt appends the `Repositories:` block; `spawnAgentOrFail` adds per-repo extra roots | `src/bun/orchestrator-multi-repo.test.ts` (first user event + `cwd`), e2e |
| 3 | Each repo's diff/status is separate; the batched status endpoint returns all 3 in one response. | `GET /tasks/:id/diff?repo=` → `getTaskDiff(task, repo)`; `GET /tasks/:id/git-status` → `taskGitStatusForDir` per entry in one response | `src/bun/server-multi-repo.test.ts`; the e2e spec covers only the diff half |
| 4 | Each repo's PR URL stamps its own `repositories[]` entry; only the issue repo gets `Closes #N`. | `POST /github/pull-create` → `tasks.setRepositoryPrUrl`; RunPanel prefill uses `task.issueRepoPath` | `src/bun/pull-create-task-url.test.ts` (no e2e coverage) |
| 5 | Archive detaches all clean worktrees; a dirty repo is kept with its branch; the task archives. | `POST /tasks/:id/archive` → `enqueueArchiveTeardown` → `detachWorktree` (multi-aware) | `src/bun/orchestrator-multi-repo.test.ts`, e2e |
| 6 | Single-repo tasks and existing on-disk worktrees are unchanged. | `prepareTaskWorkdir` dispatches to the untouched `prepareWorkdir` path for `repositories.length <= 1` | `src/bun/worktree.test.ts` (116 existing tests), `src/bun/orchestrator.test.ts` |
| 7 | New path-bearing fields are covered by route-policy; nested worktree ids are confined to `<dataDir>/worktrees`. | `POST /tasks` `repositories[].path` gate; `resolveWorktreeRef` two-level guard | `src/bun/route-policy.test.ts`, `src/bun/worktrees-list.test.ts`, `src/bun/worktree-git-status.test.ts` |
| 8 | Docs (`CLAUDE.md`, lifecycle, at-file, pipelines, prompt-composer, security, persistence) reflect the behavior. | T15 | reviewed diff |
| — | The reported behavior is reproduced before code changes. | scratch probe below; permanent regression `src/bun/multi-repo-repro.test.ts` | probe output recorded in the handoff; test red on base, green after T4 |

**Reproduction (pre-flight, before wave 1).** The investigation already proved P1 (multi-repo payload is silently dropped and exactly one worktree is materialized). Re-run it as a scratch file outside the repo:

```ts
// $TMPDIR/multi-repo-repro.ts — run with `bun` from the repo root, with AGETOR_DATA_DIR set to a mkdtemp dir.
// Create two temp git repos a and b, then:
//   const res = await createTask({ title, prompt, workdir: a, isolation: "worktree",
//     repositories: [{ path: a }, { path: b }] } as never);
//   print res.task.repositories, res.task.workdir, res.task.worktreePath,
//         existsSync(<dataDir>/worktrees/<id>/<slug>)
// Expected on base: repositories undefined, workdir = a, one worktree at either
// <dataDir>/worktrees/<id> (today) and no per-repo subdirectory.
```

Record the output in the implementation handoff. T4 then lands `src/bun/multi-repo-repro.test.ts` as the permanent assertion; it must be observed failing at `8e308518` on its own assertion (not on a missing import), and passing after T4.

## 2. Context & constraints

### 2.1 The ask and the decided contract

- Issue #291 asks for six things: select multiple repositories, one worktree/branch per repository, one agent that can modify all of them, shared context, per-repo change tracking, and separate PRs per repository. The spec at `docs/specs/multi-repo-tasks.md` is the binding contract; the grill record at `docs/plans/multi-repo-tasks-grill.md` is the decision source. Read both before starting.
- Key owner decisions that shape every task: per-task workspace root (`<dataDir>/worktrees/<task-id>/<repo-slug>`); multi-repo requires worktree isolation; create-only repository set; all-or-nothing worktree creation with every failed repo named; one shared branch name with per-repo fallback; no primary repository; dedupe by git root, no cap, warning above 10; archive is best-effort per repo; aggregate commit/push with per-repo best-effort PRs; the `Repositories:` launch-prompt paragraph; full CLI/TUI parity; all eight harness kinds layout-supported.

### 2.2 Current code — the single-repository spine

All anchors verified at `8e308518`.

- **Data model.** `Task` (`src/shared/types.ts:1878`) has one `workdir` (`:1890`), `isolation` (`:1892`), `branch` (`:1900`), `branchSource` (`:1908`), `worktreePath` (`:1910`), `baseRef` (`:1917`), `prUrl` (`:1926`), `issueUrl` (`:1935`), `checkoutBranch` (`:2217`). `TaskRow` (`src/bun/db.ts:85`), `toTask` (`:1002`), `TASKS_SELECT` (`:1099`), `tasks.insert` (`:1207`), `tasks.update` (`:1249`) mirror them one-to-one.
- **Related shapes.** `WorktreeInfo` (`src/shared/types.ts:2340`), `TaskTeardownPreview` (`:2430`), `TaskGitStatus` (`:2451`), `TaskDiff` (`:4947`), `Project` (`:6388`), `commitPushPrompt` (`:6359`).
- **Creation.** `CreateTaskInput` (`src/bun/orchestrator.ts:10904`) is `Partial<Task>` plus knobs; `POST /tasks` spreads the JSON body straight in (`src/bun/server.ts:5843`), so an unknown key is silently ignored. `createTask` (`:11015`) computes one `workdir` (`:11030`), one `workdirRoot` (`:11038`), one base sha (`:11070`), one planned branch (`:11259`), one insert (`:11298`).
- **Worktree lifecycle.** `worktreePath(task)` is `<WORKTREES_DIR>/<task.id>` (`src/bun/worktree.ts:842`). `PreparedWorkdir` (`:881`), `prepareWorkdir` (`:948`), `getTaskDiff` (`:1177`), `getTaskDiffBlob` (`:1330`), `removeWorktree` (`:1453`), `detachWorktree` (`:1531`), `parseWorktreeGitPointer` (`:860`).
- **Orchestrator.** `startTask` (`src/bun/orchestrator.ts:2068`), `startTaskInner` (`:2109`), `sendInput` (`:6978`), `sendInputInner` (`:7104`), `createTask` (`:11015`), `archiveTask` (`:11544`), `unarchiveTask` (`:11707`), `teardownBranchesForTask` (`:11760`), `deleteTask` (`:11813`), `discardRefusedWorktree` (`:11962`), `sweepArchivedTeardowns` (`:12003`), `listWorktrees` (`:12209`), `resolveWorktreeDir` (`:12289`), `deleteOrphanWorktree` (`:12317`), `worktreeGitStatus` (`:12390`). The teardown FIFO is `enqueueTeardown` (`:423`), keyed by `task.workdir`.
- **Server.** `ALLOWED_PATCH_FIELDS` (`src/bun/server.ts:611`), `/github/pull-create` (`:3210`), `/tasks` (`:5741`), `/worktrees` (`:6634`), `/tasks/:id/diff` (`:6678`), `/tasks/:id/diff/blob` (`:6697`), `/tasks/:id/git-status` (`:6870`), `/tasks/:id/teardown-preview` (`:6920`).
- **Route policy.** `QUERY_DIR` / `QUERY_WORKDIR` / `BODY_WORKDIR` (`src/bun/route-policy.ts:113-118`), `/tasks` POST/PATCH (`:368-375`), `/files/index` (`:415`), `pathValues`/`collectPathValues` (`:598-626`), pinned path-param list in `src/bun/route-policy.test.ts:634`.
- **Pipelines.** `refreshParentWorktree` (`src/bun/pipeline-runner.ts:984`), `propagateWorktreeToActiveSteps` (`:1038`), step-row insert copying `workdir`/`branch`/`worktreePath`/`baseRef` (`:1377`).
- **Terminals.** `src/bun/terminals.ts:202` prepares one workdir and spawns one shell.
- **Harnesses.** `buildCommand` (`src/bun/agents.ts:652`), `SpawnAgentArgs` (`:3972`), `spawnAgent` (`:4185`). Evidence P4/P5/P6: Cursor and fx ACP servers advertise no `additionalDirectories`; both accept a non-git cwd as `session/new`; fx refuses reads outside cwd. That is why the workspace root, not a primary repo cwd, is the only universal layout.
- **Webview.** `ProjectPicker` single-select (`src/mainview/components/kanban/ProjectPicker.tsx:39`); `NewTaskForm` one `workdir` (`:243`), one `useWorktreeOptions` (`:248`), one `fileScope` (`:293`), one payload (`:630`); `WorktreeOptions` hook (`src/mainview/components/kanban/WorktreeOptions.tsx:100`); `CreateTaskFromIssueDialog` one project (`:81`); DiffDialog one scope (`src/mainview/components/kanban/DiffDialog.tsx:508`); RunPanel one git-status poll (`:2910`), one commit prompt (`:3621`), one PR head (`:3684`), one scope (`:3851`); TaskCard one project line (`src/mainview/components/kanban/TaskCard.tsx:336`); App filter/search (`src/mainview/App.tsx:1912`, `:1918`); context menu (`src/mainview/lib/task-context-menu.ts:161`); Worktrees page (`src/mainview/components/worktrees/WorktreesDialog.tsx:119`).
- **CLI/TUI.** `agetor add --workdir` (`src/cli/commands/add.ts:114`), `show` one workdir (`src/cli/commands/show.ts:84`), `shell` one dir (`src/cli/commands/shell.ts:20`), `rm` one branch list (`src/cli/commands/lifecycle.ts:219`), TUI `@` completion (`src/cli/tui/at-complete.ts:30`), Dashboard compose scope (`src/cli/tui/Dashboard.tsx:196`).

### 2.3 Repo rules that bear on this change

| Rule | Path | Consequence for this plan |
| --- | --- | --- |
| Every route needs a `ROUTE_POLICY` entry; a CLI-reachable route taking a filesystem path declares `pathParams` or an explained `pathParamsExempt`. | `CLAUDE.md` "Security and process boundaries"; `src/bun/route-policy.ts`; `src/bun/route-policy.test.ts` | `repositories[].path` is gated for the CLI caller; `POST /tasks` policy extended; no path-bearing field ships ungated. |
| Every spawn goes through `coreSpawn`/`coreSpawnSync`; worktree creation uses the existing `git()` helper. | `CLAUDE.md`; `src/bun/core-spawn-allowlist.test.ts` | No new spawn path. |
| Server-managed task columns are skipped by the generic `tasks.update` SET clause, are not patchable, and never bump `updated_at`. | `CLAUDE.md` "Data"; `docs/architecture/persistence.md` | `repositories` and `issue_repo_path` are server-managed; targeted writers only. |
| Migrations are append-only; next number is 087. | `CLAUDE.md` "Migrations"; `src/bun/migrations/index.ts` | `087_task_repositories.sql` + index entry; never edit 086. |
| `src/shared/` stays free of runtime imports from either process. | `CLAUDE.md`; `src/shared/file-scope.ts` | New repo/slug/prompt/file-scope helpers are pure. |
| Bun main thread is shared; no unbounded synchronous loops in spawn/restore paths. | `CLAUDE.md` "Runtime"; `docs/architecture/core-responsiveness.md` | Worktree preparation and status polling use bounded concurrency (4). |
| WKWebView has about six connections per host, two permanent SSE. | `CLAUDE.md` "Runtime" | One batched git-status request per poll; one `@` fetch per repo scope, no per-repo event stream. |
| Agetor never adds its own text to a message; only the reference block, the agent-instructions wrapper, the issue-thread warning, and the pipeline prompt/handoff are machine-added. | `CLAUDE.md` line 93; `docs/architecture/pasted-content.md` | The `Repositories:` paragraph is a documented new exception; T15 amends CLAUDE.md and the prompt-text tests cover it. |
| A subsystem doc is updated in the same change. | `CLAUDE.md` line 5; topic map | T15 updates the listed docs and adds `docs/architecture/multi-repo-tasks.md`. |
| Agents run with full user privileges in the task's cwd; there is no sandbox. | `CLAUDE.md` | Every repo worktree must stay inside the task directory; no sibling workspace layout. |

### 2.4 Live facts checked in this step

- `git rev-parse HEAD` → `8e308518`; branch `feature/issue-291-feature-request-support-multip`; working tree clean before this plan.
- `src/bun/migrations/index.ts` ends at `086_normalize_cursor_fable_5_2`; `bun test src/bun/migrate.test.ts` → 63 pass, 0 fail (so 087 is the correct next id).
- `node_modules` is present; Bun 1.3.10; git 2.54.0 (Apple Git-157).
- Installed harness binaries: `claude`, `codex`, `cursor-agent`, `fx`, `opencode`. Absent: `gemini`, `agy`, `copilot`. Cursor's account hit a plan limit during the investigation (P7).
- E2E harness exists: `e2e/fixtures.ts` provisions a per-worker headless backend with its own `AGETOR_DATA_DIR`, fake drivers, `AGETOR_GITHUB_API_BASE` → `backend.githubStubPort`; `e2e/github-stub.ts` is the stub server; `e2e/issue-task.spec.ts` has the `initRepo` recipe.

## 3. Approach & key decisions

### 3.1 The workspace is the task's cwd and its legacy mirror

For a multi-repo task, `workdir` and (once the task has started; it is null before) `worktreePath` both point at `<WORKTREES_DIR>/<task-id>` (the workspace root), and `branch`, `baseRef`, `prUrl`, `checkoutBranch` are null. `repositories[]` is the source of truth. This is the owner's round-2 decision and it has a deliberate payoff: every existing `task.worktreePath ?? task.workdir` cwd site (25+ in `orchestrator.ts`, plus `terminals.ts`, `pipeline-runner.ts`, `hook-installer.ts`, `shortenTaskPaths`, markdown/handoff resolution) already resolves to the workspace root without an edit. Only the paths that treat `workdir` as a *source repository* must change (prepare, teardown, repo status), and they now iterate `repositories[]`.

Alternatives rejected:

- **Keep `worktreePath` as the first repo's worktree and add a `workspacePath` column.** Every cwd site would need a new helper or a migration of 25+ call sites, and an old client would still tear down only one repo. The owner chose the mirror; there is no primary.
- **Primary repo cwd + extra directories.** Not universal: Cursor, fx and OpenCode cannot add roots (P4/P6), and `@` references into sibling dirs would fail `resolveAtPath` containment (P3).
- **A `task_repos` child table.** The set is create-only and read with the task on every 2s poll. A JSON column on `tasks` avoids a join, a write path and a migration backfill; there is no query that needs a per-repo index. If a future feature edits the set or queries by repo, a table can be introduced then.
- **A separate `workspaces/` root.** The nested layout keeps `task-dir-fs`, `resolveAtPath` containment and the existing `rm -rf` ownership boundary intact. A sibling root would widen every guard.

### 3.2 The contract shapes

```ts
// src/shared/types.ts — one entry per selected repository. Server-managed after create.
export interface TaskRepository {
  /** The registered project path the user selected (not necessarily the git root). */
  path: string;
  /** Workspace subdirectory name: sanitized basename of `path`, uniquified on collision. */
  name: string;
  /** Branch agetor created for this repository (never an existing branch in v1). */
  branch: string | null;
  branchSource: "created" | "existing";
  /** This repository's linked worktree, under the workspace; null until materialized. */
  worktreePath: string | null;
  /** Pinned base sha resolved at create time in this repository. */
  baseRef: string | null;
  /** Last-seen live checkout in this worktree. */
  checkoutBranch: string | null;
  /** First PR opened from this repository; never overwritten. */
  prUrl: string | null;
}

// Input shape (POST /tasks body `repositories[]`); only these fields are read.
export interface TaskRepositoryInput {
  path: string;
  baseRef?: string;
}
```

`Task` additions (optional at the type level for fixture compatibility, always set by `toTask`):

```ts
repositories?: TaskRepository[]; // 2+ for a multi-repo row; a derived one-entry array for every legacy row
issueRepoPath?: string | null;   // repositories[].path whose remote matches issueUrl; only its PR gets Closes #N
```

The create input must not inherit the server-managed shapes: `CreateTaskInput` becomes `Omit<Partial<Task>, "repositories" | "issueRepoPath">` plus `repositories?: TaskRepositoryInput[]`. `createTask` rebuilds every entry from `{path, baseRef}` and never trusts a client-supplied `worktreePath`, `checkoutBranch`, `prUrl` or `branchSource`.

Additive API shapes (all optional, so old callers compile):

```ts
export interface TaskRepoGitStatus extends TaskGitStatus { name: string; path: string }
export interface TaskGitStatus { /* today's fields */ repositories?: TaskRepoGitStatus[] }
export interface TaskDiff { /* today's fields */ repo?: string | null }
export interface TaskTeardownPreview { /* today's fields */ repositories?: RepoTeardownPlan[] }
export interface RepoTeardownPlan {
  name: string; path: string; branches: string[]; liveBranch: string | null;
  taskBranch: string | null; source: TaskTeardownPreview["source"];
  excluded: TaskTeardownPreview["excluded"];
}
export interface WorktreeInfo { /* today's fields */ repoName?: string | null }
export interface TerminalTab { /* today's fields */ repoName?: string | null }
```

Migration 087 (append-only; add the entry to `src/bun/migrations/index.ts`):

```sql
ALTER TABLE tasks ADD COLUMN repositories TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN issue_repo_path TEXT;
```

Storage rule: **single-repo rows store `repositories = '[]'` and derive the one-entry array in `toTask`** so the scalar columns (branch, worktreePath, checkoutBranch, prUrl) remain the one source of truth as they update. Multi-repo rows store the JSON; their scalars are the workspace mirror. No backfill. `tasks.insert` writes `'[]'` unless `t.repositories.length > 1`; `tasks.update` skips both columns; `tasks.setRepositories`, `tasks.setRepositoryPrUrl` and `tasks.setRepositoryCheckout` are targeted `UPDATE`s that parse the JSON, change one value, and never bump `updated_at`.

Launch prompt (only when `repositories.length > 1`; a single-repo launch is byte-identical to today):

```
Repositories:
- frontend: /abs/.agetor/worktrees/<task-id>/frontend (branch feature/auth)
- backend: /abs/.agetor/worktrees/<task-id>/backend (branch feature/auth)
```

It is appended after `composeLaunchPrompt(...)` and before `appendReferences(...)`; the block is a documented exception to the prompt-text rule.

### 3.3 Preparation, teardown and diff dispatch

```ts
// src/bun/worktree.ts
export async function prepareTaskWorkdir(task: Task, opts?: { takenBranches?: Map<string, Set<string>> }): Promise<PrepareResult>;
export async function getTaskDiff(task: Task, repoName?: string | null): Promise<TaskDiff>;
export async function getTaskDiffBlob(task: Task, relPath: string, side: "old" | "new", repoName?: string | null): Promise<...>;
```

- `prepareTaskWorkdir` returns `prepareWorkdir(task, opts)` unchanged when `repositories.length <= 1`; otherwise it makes the workspace, prepares each entry through a new exported `prepareRepoWorktree` (the extracted body of today's `prepareWorkdir`; it receives the source path, branch, base ref and the target `<workspace>/<slug>` path), and returns `cwd = workspace`, `worktreePath = workspace`, `branch = null`, `repositories = entries`.
- All-or-nothing: attempt every repo, collect every failure, then roll back worktrees (and branches) created in this attempt and return an error naming every failed repo. A reused worktree is not rolled back.
- `prepareRepoWorktree` keeps today's reuse/drift/re-attach/collision semantics per repo; the shared branch name is attempted first, and a repo that already has that name checked out (or already has that ref — e.g. an archived task's leftover) gets a unique `-2` variant (the per-repo fallback). `takenBranches` keys every pin by both the selected project path and its resolved git root, so a name held in repo A never forces a rename in repo B, while two tasks that selected sibling subdirectories of one repository still see each other's pin.
- Teardown is per repo. `removeWorktree` and `detachWorktree` keep their exported names and become multi-aware in place (additive options only): they iterate `task.repositories`, use `repoRoot(entry.path)` and `entry.worktreePath`, keep dirty worktrees and branches, and remove the workspace directory only when it is empty. Delete passes `TaskTeardownPreview.repositories` to `removeWorktree` so each repo's own branches are removed. `detachWorktree`'s result gains optional per-repo outcomes. `teardownBranchesForTask` returns one plan per repo plus the union at the top level.
- `getTaskDiff(task, repo)` defaults to `repositories[0]` when `repo` is omitted; unknown names return a friendly note (the route 400s). `base` is that repo's `baseRef`.
- `enqueueTeardown` gains `enqueueTeardownMany(taskId, keys, job)`: it reads every key's tail synchronously, waits on all of them, sets every tail to the combined promise, and loops. Sorted keys prevent deadlock; per-repo jobs only ever acquire one key. Single-repo keys stay `task.workdir`.

### 3.4 Nested worktree ids and the Worktrees page

- A multi-repo row is `<taskId>__<repo-slug>` (opaque, one URL path segment). Parse at the first `__`; task ids are UUIDs and contain no underscore, so the slug may contain `__`.
- `resolveWorktreeRef(id)` replaces `resolveWorktreeDir` and returns either a direct child or a two-level `<WORKTREES_DIR>/<taskId>/<slug>`. Every segment must be non-empty, not `.`/`..`, contain no `/` or `\`, and equal its `basename`; the final path must be a direct child of its parent and the parent a direct child of `WORKTREES_DIR`.
- `deleteOrphanWorktree` and `worktreeGitStatus` share that guard. A nested orphan delete removes only that subdirectory, prunes its source repo, and removes the parent workspace only when it is empty. An owned row still routes deletion to archiving the task.
- `listWorktrees` emits one row per repo for a multi task (`repoName`, per-repo `branch`, `workdir = entry.path`), skips the workspace root as a row, and expands an orphan workspace directory into per-repo rows when its children are git worktrees.

### 3.5 What is intentionally not built

- No repository editing after create (owner decision). `PATCH /tasks/:id` rejects `repositories` with a clear 400; the UI never exposes it. **Amended after implementation (owner decision):** one repository can be removed from a multi task through `DELETE /tasks/:id/repositories/:name` (run panel "Remove from task", `agetor edit --remove-repo`), and a task created with 2+ repositories stays multi down to one (`Task.multiRepo`); adding a repository still needs a new task. The PATCH 400 now points at the removal route. Contract: `docs/architecture/multi-repo-tasks.md`.
- No multi-repo `isolation: "none"`; no per-repo `existingBranch`; no hard cap; no downgrade guard; no per-repo branch config; no coordinator/child agents. These are recorded in §9 as out of scope with the owner decision.
- No new server file-listing route. `@` and capability discovery stay client-side unions over one `/files/index` and one `/agent-discovery` call per repo scope. This preserves `listProjectFiles`'s git-repo contract and `resolveAtPath`'s workspace containment.

## 4. Work breakdown — implementation tasks

Assumption for ownership: each task owns the listed files exclusively within its wave. Files touched by later waves are called out.

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Shared contract and pure helpers | `src/shared/types.ts`, `src/shared/multi-repo.ts` (new), `src/shared/file-scope.ts`, `src/shared/multi-repo.test.ts` (new), `src/shared/file-scope.test.ts` (new) | — | `TaskRepository`/`TaskRepositoryInput` exported; `isMultiRepoTask` true only for 2+; `uniqueRepoSlugs` deterministic and safe; `formatRepositoriesPrompt` exact; `fileScopesForTask` single vs multi pre/post; `commitPushPrompt` single byte-identical, multi lists every repo | tests | imported by T2, T3, T4, T7, T8, T9, T10, T11, T12, T14 |
| T2 | Persistence | `src/bun/migrations/087_task_repositories.sql` (new), `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/db-repositories.test.ts` (new), `src/bun/migrate.test.ts` | T1 | Migration applies to an 086 DB and is last; multi insert round-trips; single insert stores `[]` and `toTask` derives one entry; malformed JSON falls back; generic `tasks.update` never touches the columns; `setRepositories`/`setRepositoryPrUrl`/`setRepositoryCheckout` are the only writers and never bump `updated_at`; PR stamp is first-write-wins | migration, data | `db.ts` module load; `tasks.*` calls in the orchestrator |
| T3 | Worktree engine and repo-set validation helpers | `src/bun/worktree.ts`, `src/bun/task-repos.ts` (new: `resolveRepositorySet(input, { resolveRoot })`, `repoBranchPlan`, `branchHeldByOtherTask`, `lexicallyInsideRoot`, `repositoriesForTask` — no import of `worktree.ts`, so there is no cycle), `src/bun/worktree.test.ts`, `src/bun/task-repos.test.ts` (new) | T1, T2 | Existing 116 worktree tests pass byte-identically; single `prepareWorkdir` unchanged; multi prepares one worktree/branch per repo under the workspace; reuse does not create or switch; partial failure rolls back and names every failed repo; shared branch fallback; per-repo diff/blob; multi remove/detach keeps dirty repos and branches | state, trust, tests | `prepareTaskWorkdir` called by T4, T5, T6, T7; `resolveRepositorySet`/`repoBranchPlan` by T4; `getTaskDiff` by T7 |
| T4 | Create, start, send, unarchive, duplicate | `src/bun/orchestrator.ts`, `src/bun/duplicate-agent-profile.ts`, `src/bun/multi-repo-repro.test.ts` (new), `src/bun/orchestrator-multi-repo.test.ts` (new), `src/bun/duplicate-agent-profile.test.ts` | T1, T2, T3 | Repro test red on base and green after; 3-repo create pins workspace, 3 entries, 3 branches/baseRefs; dedupe by git root collapses to single layout; all bad repos listed and nothing inserted; `isolation:none`/`existingBranch` with 2+ rejected 400; issue URL matched against every repo and `issueRepoPath` stored; start persists worktrees and appends the prompt block once before references; spawn cwd is workspace and extra repo directories ride `SpawnAgentArgs`; drift/restore status lines are per repo; send restores a missing repo; unarchive restores; duplicate copies the set | data, state, trust | `POST /tasks`, `POST /tasks/:id/start`, `POST /runs/:id/input`, `POST /tasks/:id/unarchive` via T7 |
| T5 | Runtime surfaces: pipeline, terminals, harness extra roots | `src/bun/pipeline-runner.ts`, `src/bun/terminals.ts`, `src/bun/agents.ts`, `src/bun/pipeline-runner.test.ts`, `src/bun/terminals.test.ts`, `src/bun/agents.test.ts` | T1, T3 | Pipeline parent multi → every step row copies repositories/workspace and reuses that workspace (never a private `<step-id>` one), never owns teardown; refresh/retry restores all repos; gemini overage includes the block; terminal default cwd workspace and `repo` selector cwd worktree; `spawnAgentOrFail` injects the task's sibling worktrees as `opts.extraDirectories` on every spawn path and `buildCommand` adds `--add-dir` for claude/codex/copilot only; cursor/fx/opencode ignore it | state, concurrency | pipeline runner entry points; `POST /tasks/:id/terminals`; `spawnAgentOrFail` |
| T6 | Lifecycle: teardown, list, nested ids, FIFO | `src/bun/orchestrator.ts`, `src/bun/worktrees-list.test.ts`, `src/bun/worktree-git-status.test.ts`, `src/bun/server-teardown-preview.test.ts` | T4, T3 | One Worktrees row per repo with `taskId__slug`; traversal ids rejected; nested orphan delete confined; per-repo status/base; teardown preview per repo; delete removes all; archive records each repo's live checkout (never reads the non-git workspace), detaches clean, keeps dirty + branch, still archives; terminal-refused cleanup is per repo; already-archived re-enqueue and boot sweep; multi-key FIFO serializes same-repo jobs and never deadlocks | data, state, trust | `POST /tasks/:id/archive`, `DELETE /tasks/:id`, `GET /worktrees`, `DELETE /worktrees/:id`, `GET /worktrees/:id/git-status`, boot sweep |
| T7 | Server routes and policy wiring | `src/bun/server.ts`, `src/bun/route-policy.ts`, `src/bun/route-policy.test.ts`, `src/bun/server-multi-repo.test.ts` (new), `src/bun/pull-create-task-url.test.ts` | T1, T2, T3, T4 | `POST /tasks` sanitizes `repositories` and rejects a relative entry path; CLI path gate covers `repositories[].path`; PATCH rejects the set; `diff`/`diff/blob` accept `repo`; git-status returns `repositories[]` for every repo in one response (top-level mirrors the first for old clients); pull-create stamps the matching entry and never `task.prUrl`; `GET /projects/repo-root`; terminals `repo`; every route has a policy; pinned policy tests updated | trust, data | server boot route table |
| T8 | Create surfaces: Repositories dialog, New Task, issue dialog | `src/mainview/components/kanban/RepositoriesDialog.tsx` (new), `src/mainview/lib/repo-selection.ts` (new), `src/mainview/lib/repo-selection.test.ts` (new), `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/WorktreeOptions.tsx`, `src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`, `src/mainview/lib/worktree-payload.ts` | T1, T7 | One repo keeps today's inline project/branch/base; 2+ shows summary + Manage, forces worktree isolation, sends `repositories`; dialog multi-selects, adds a folder, per-repo base, remove, dedupes by git root, warns above 10; issue dialog pre-selects and locks the issue repo and allows extras; changing the ProjectPicker while 2+ are selected collapses back to that one repo | tests, state | New Task sidebar; Git Integration issue modal |
| T9 | API client and multi-scope composer plumbing | `src/mainview/lib/api.ts`, `src/mainview/lib/use-project-files.ts`, `src/mainview/components/kanban/PromptComposer.tsx`, `src/mainview/components/kanban/AtFileAutocomplete.tsx`, `src/mainview/components/kanban/AtHighlightBackdrop.tsx` | T1, T7 | `api.createTask` accepts `repositories`; `getTaskDiff`/`getTaskDiffBlob`/`getTaskGitStatus` carry repo; `getProjectRepoRoot`; `createTerminal(repo)`; `useProjectFiles` accepts 1..N scopes, prefixes merged entries with the slug, keeps per-dir cache, single scope byte-identical; `useAgentCapabilities` unions per scope; `@frontend/src/a.ts` inserts and highlights | tests | RunPanel, DiffDialog, NewTaskForm, issue dialog, CLI/TUI |
| T10 | Card, board filters, app shell, context menu | `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/App.tsx`, `src/mainview/lib/task-context-menu.ts`, `src/mainview/lib/context-menu.ts`, `src/mainview/components/ui/context-menu.tsx`, `src/mainview/lib/task-context-menu.test.ts`, `src/mainview/lib/context-menu.test.ts` | T1, T7, T9, T11 (interface pin) | Multi card shows a worktree icon + repository count with a hover tooltip (no workdir/branch line); repo filter and text search match any repo; open-in-finder/view-PR use the repo path; context menu offers a flat per-repository entry (`Copy <repo> branch`, `Copy <repo> worktree path`, `View <repo> pull request`) for each repository — no nested submenu, so the existing one-level renderer is unchanged; single-repo card byte-identical | tests | board render |
| T11 | Run panel and diff dialog per-repo surfaces | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/DiffDialog.tsx`, `src/mainview/lib/diff-selection.ts` | T1, T7, T9 | Diff dialog tabs per repo, fetches that repo, blob `repo`, compose-from-diff prefixes `name/`; RunPanel project block lists each repo with branch/status, terminal repo selector, file scopes; commit & push for multi uses the aggregate prompt (T12); single UI unchanged | tests | RunPanel/DiffDialog |
| T12 | Aggregate commit/push and Create all PRs | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/pr-proposal.ts`, `src/mainview/lib/pr-proposal.test.ts` | T11, T1 | Multi commit prompt lists every repo/branch and asks for one labeled proposal per repo; parser returns per-repo proposals and tolerates missing ones; Create all PRs walks repos with per-repo best-effort (calls `api.pullCreate` directly, so RunPanel's prop interface is unchanged), appends `Closes #N` only for `issueRepoPath`, stamps per repo, shows per-repo failure/retry; single flow unchanged | tests, external | RunPanel |
| T13 | Worktrees page grouping | `src/mainview/components/worktrees/WorktreesDialog.tsx` | T6 | One row per repo grouped under its task; nested id actions; filters/sort; owned row archives the task; orphan row deletes only that repo dir; no duplicate ids | tests | Worktrees dialog |
| T14 | CLI/TUI parity | `src/cli/api-client.ts`, `src/cli/commands/add.ts`, `src/cli/commands/show.ts`, `src/cli/commands/shell.ts`, `src/cli/commands/lifecycle.ts`, `src/cli/commands/ls.ts`, `src/cli/at-warn.ts`, `src/cli/tui/at-complete.ts`, `src/cli/tui/Dashboard.tsx`, `src/cli/commands/add.test.ts`, `src/cli/commands/show.test.ts`, `src/cli/commands/shell.test.ts`, `src/cli/commands/rm.test.ts`, `src/cli/tui/at-complete.test.ts` | T1, T7 | `agetor add --repo path[=ref]` repeatable and the interactive wizard's repository multi-select (one optional base-ref prompt per repository when 2+ are picked; `--repo`/`--workdir` skip the picker) are the CLI's multi-repository surfaces; `show` prints the repo block; `shell <id>` and `shell --repo <name>`; `rm` preview per repo; `ls` shows a repo count; TUI multi-select and multi-scope `@` completion with prefixes; the pre-`--start` advisory `@` pre-check lists every repository scope, never the non-git workspace root | tests | CLI entry points / TUI |
| T15 | Docs | `CLAUDE.md`, `docs/architecture/multi-repo-tasks.md` (new), `docs/architecture/task-lifecycle.md`, `docs/architecture/at-file-references.md`, `docs/architecture/pipelines.md`, `docs/architecture/prompt-composer.md`, `docs/architecture/security.md`, `docs/architecture/persistence.md`, `docs/architecture/issue-tasks.md`, `docs/architecture/run-panel.md`, `docs/architecture/task-context-menu.md`, `docs/architecture/testing-seams.md` | all behavior | Every doc names the new layout, data, prompt exception, gates, and teardown rules; topic map includes the new doc; no stale "one workdir" claim | tests | docs |
| T16 | End-to-end spec | `e2e/multi-repo-task.spec.ts` (new) | T6, T7, T8, T10, T11, T12 | Create via the real New Task UI and its `Repositories` dialog (multi-select, per-repository base ref, same-git-root dedupe), fake-driver run, two worktrees/branches, per-repo diff tabs, aggregate commit chip with only a sibling dirty, archive keeps the branches. The issue dialog's locked repository is covered in `e2e/issue-task.spec.ts`. Per-repo PR stamping is covered by `pull-create-task-url.test.ts`, not e2e. | tests | Playwright |
| T17 | Verification, smoke matrix, final status | `docs/plans/multi-repo-tasks.md` (status only), `docs/plans/multi-repo-tasks-smoke.md` (new) | all | `bun run typecheck` green; `bun test` green; e2e spec green; live smoke for installed/credentialed harnesses recorded with commands and versions; plan status updated; final commit includes `Fixes #291`. **Status:** typecheck, focused suites, the full suite and the e2e specs are recorded in the smoke ledger per review round. Live smoke run 2026-11-12: claude-code 2.1.322, codex-cli 0.166.0 (incl. a follow-up turn and the sandbox escalation) and fx 0.0.15 committed in each checkout; OpenCode v2.1.3's first attempt was refused by the Zen provider (empty balance), and a re-run with `opencode-go/deepseek-v4.1-flash` committed in each checkout, plus `smoke-2` from a follow-up turn; copilot not run live (no login): Auto's `--allow-all` confirmed from Copilot CLI 1.0.109's `--help` to disable path verification, and an opt-in real-binary multi-repo case added to `src/bun/copilot-real-binary.test.ts`, pending a run; cursor, gemini, antigravity and a harness failover not run | tests | CI/commands |

### 4.1 Detailed acceptance for the four riskiest tasks

**T3 — prepare/rollback.**
- Given two repos A and B with pinned branches and base shas, when `prepareTaskWorkdir(multiTask)` runs, then `<workspace>/A` and `<workspace>/B` are linked worktrees (each `.git` is a pointer file), `git -C A rev-parse --abbrev-ref HEAD` is A's branch, and the return is `{ cwd: workspace, worktreePath: workspace, branch: null, repositories: [...] }`.
- Given a second call, when the worktrees exist, then no `git worktree add` runs, no checkout is performed, and the returned entries keep their recorded branches.
- Given repo B has an unresolvable base or a non-git path, when prepare runs, then repo A's newly created worktree and branch are removed, B's error and A's error (if any) both appear in the message, and no directory remains under the workspace.
- Given the shared branch is checked out in repo B's main checkout, when prepare runs, then B gets a unique `-2` name (or a clear hard error if it is an `existing` branch, which multi never is), and the returned entry reports the actual name.

**T4 — create validation.**
- Given 3 paths where one is missing, one is not a git repo, and one has a bad base ref, when `createTask` runs, then the result is `{ error }` naming all three and `tasks.list()` is unchanged.
- Given two paths under one git root, when `createTask` runs, then it stores one repository (the first selected path) and uses the single-repo layout.
- Given a `repositories` array with 2 entries and `isolation: "none"`, when `createTask` runs, then it returns the "multi-repo requires worktree isolation" error and inserts nothing.
- Given `existingBranch` with 2 entries, then 400 with a clear message.
- Given an ``issueUrl`` that matches the second repo's remote, when create runs, then `task.issueRepoPath === repositories[1].path`; if it matches none, the create fails.
- Given a started task, when the launch prompt is assembled, then the `Repositories:` block appears once with every name/path/branch, after the user prompt and before the references block; a one-repo task's prompt is byte-identical to `8e308518`.

**T6 — archive/delete.**
- Given two clean worktrees, when `archiveTask` runs with `awaitTeardown`, then both are detached, the workspace is removed, both branches still exist, and the result is `removed: true`.
- Given one clean and one dirty repo, when archive runs, then the clean one is detached, the dirty one and the workspace remain, the dirty branch remains, the result is `removed: false, reason: "dirty"` (with per-repo outcomes), and the task is archived.
- Given `DELETE /tasks/:id`, when it runs, then every repo worktree and every created branch is removed and the workspace is gone.
- Given two archived tasks sharing one source repo, when both teardown jobs are enqueued, then their per-repo jobs never overlap in that repo (a test-only counter), and two jobs with overlapping key sets do not deadlock.

**T7 — route gate.**
- Given a CLI-token request to `POST /tasks` with `repositories: [{ path: "<protected path>" }]`, when the gate runs, then it answers 403 `path-not-accessible` before `createTask`; the app token is never gated.
- Given `POST /tasks` with `repositories` not an array, or an entry missing `path`, then 400. There is no product cap on the array length (owner decision); creation uses bounded concurrency, and the client shows a non-blocking warning above 10.
- Given `PATCH /tasks/:id` with `repositories`, then 400 "fixed at creation — create a new task". (As shipped after the removal amendment, the 400 points at `DELETE /tasks/:id/repositories/:name` instead.)
- Given a multi task with a PR URL on `backend`, when `POST /github/pull-create` is called with `path = backend worktree`, then only the backend entry is stamped; `task.prUrl` stays null; a second call does not overwrite.

## 5. Work breakdown — test tasks

The implementation tasks own their focused new test files; the large existing suites are extended in the same task that changes their module, so two agents never edit one test file in one wave. The matrix below is the coverage contract.

| Test task | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| TT1 | unit (shared) | TaskRepository/slug/prompt/file-scope/commit prompt | `src/shared/multi-repo.test.ts` (T1), `src/shared/file-scope.test.ts` (T1) | Every helper has a happy path, a boundary (0/1/2 repos, duplicate basenames, invalid chars) and a negative case; single-repo prompt equals the pre-change text |
| TT2 | unit/integration (DB) | migration, round-trip, fallback, targeted writers | `src/bun/db-repositories.test.ts` (T2), `src/bun/migrate.test.ts` (T2) | 087 applies to 086 and is last; raw column is `[]` for single; malformed JSON reads as one entry; `updated_at` unchanged by targeted writers |
| TT3 | unit (worktree) | prepare/reuse/rollback/fallback/diff/remove/detach | `src/bun/worktree.test.ts` (T3), `src/bun/task-repos.test.ts` (T3) | Existing 116 pass; every T3 scenario above is asserted; a test that simply calls a new helper without asserting two worktrees is not enough |
| TT4 | integration (orchestrator) | create/start/send/unarchive/duplicate/archive/delete | `src/bun/multi-repo-repro.test.ts` (T4), `src/bun/orchestrator-multi-repo.test.ts` (T4), `src/bun/duplicate-agent-profile.test.ts` (T4) | The repro test fails on its own repository assertion at base; lifecycle scenarios assert two worktrees, branches, prompt block and cleanup |
| TT5 | integration (routes) | POST/PATCH/diff/status/PR/repo-root/policy | `src/bun/server-multi-repo.test.ts` (T7), `src/bun/route-policy.test.ts` (T7), `src/bun/pull-create-task-url.test.ts` (T7) | CLI gate 403 and app bypass; 400 shapes; per-repo stamp; every new/changed route has a policy entry |
| TT6 | integration (runtime) | pipeline/terminals/agents | `src/bun/pipeline-runner.test.ts` (T5), `src/bun/terminals.test.ts` (T5), `src/bun/agents.test.ts` (T5) | Step copy/teardown; terminal cwd; `--add-dir` only for the flag kinds |
| TT7 | integration (lifecycle) | worktrees list/status/teardown preview | `src/bun/worktrees-list.test.ts` (T6), `src/bun/worktree-git-status.test.ts` (T6), `src/bun/server-teardown-preview.test.ts` (T6) | Nested ids, traversal refusals, per-repo rows/plans |
| TT8 | unit (webview) | repo selection, context menu, PR proposals | `src/mainview/lib/repo-selection.test.ts` (T8), `src/mainview/lib/task-context-menu.test.ts` (T10), `src/mainview/lib/pr-proposal.test.ts` (T12) | Selection dedupe/warning; flat per-repository entries; multi proposal parse, missing labels and `repositoriesNeedingPr`. Diff-tab plumbing has no separate pure helper, so it is covered by the e2e spec rather than a `diff-selection` unit file. |
| TT9 | unit (CLI) | add/show/shell/rm/TUI completion | `src/cli/commands/add.test.ts` (T14), `src/cli/commands/show.test.ts` (T14), `src/cli/commands/shell.test.ts` (T14), `src/cli/commands/rm.test.ts` (T14), `src/cli/tui/at-complete.test.ts` (T14) | Repeatable `--repo`; the wizard's multi-select + per-repo base refs + `--repo`-skips-picker paths; multi payload; `shell <id>` with and without `--repo`; per-repo `rm` preview; re-exported multi-scope completion. The Dashboard's multi-scope listing is exercised by the TUI build/typecheck and the shared `fileScopesForTask` test. |
| TT10 | e2e | full user flow | `e2e/multi-repo-task.spec.ts` (T16) | Criterion table §1 rows 1 and 5, plus the diff half of row 3 — status and PRs are unit/integration only |
| TT11 | verification | whole suite + smoke | plan/smoke doc (T17) | Typecheck, unit, e2e and the recorded smoke matrix |

**E2e applicability: applies.** The change has a user-visible flow (New Task dialog → card → run panel → diff → PR) and crosses process boundaries (webview → HTTP → Bun → git subprocesses → filesystem). The repo already has a Playwright harness, so no new infrastructure is planned.

**Run recipe.**

```bash
bun install --frozen-lockfile                     # node_modules is present in this worktree; skip if so
bun run typecheck
bun test                                          # full unit/integration suite (~4 min)
bun test src/bun/worktree.test.ts src/bun/orchestrator-multi-repo.test.ts src/bun/server-multi-repo.test.ts
bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts
```

- Playwright's `playwright.config.ts` starts Vite; `e2e/fixtures.ts` provisions one headless Bun backend per worker with its own `AGETOR_DATA_DIR`, port and token, and sets the fake drivers and `AGETOR_GITHUB_API_BASE`.
- The spec creates two throwaway git repos with `initRepo` (the `e2e/issue-task.spec.ts` recipe), registers them through the real `POST /projects`, starts the shared GitHub stub on `backend.githubStubPort`, and uses the fake `claude` driver.
- No credentials are required. Native pickers use the `AGETOR_FAKE_PICK_REFS_DIR` seam.
- Test hygiene: set `AGETOR_DATA_DIR` at the top level of any new test importing `db.ts`/`orchestrator.ts`; use `rmTestDataDir`; snapshot/restore harness rows with `snapshotHarnessState()` if a test mutates them.

## 6. Execution waves

Each wave ends with a checkpoint commit and a green tree (typecheck + the focused suites; full `bun test` at the slice boundaries). A wave is invalid if any path appears twice in it.

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 0 — reproduce | scratch probe (no repo file; not a task) | Output recorded: multi-repo payload dropped, one worktree. No code changed. |
| 1 — contract | T1 | `bun test src/shared/multi-repo.test.ts src/shared/file-scope.test.ts`; typecheck |
| 2 — storage + engine | T2, T3 | `bun test src/bun/db-repositories.test.ts src/bun/migrate.test.ts src/bun/worktree.test.ts src/bun/task-repos.test.ts`; typecheck |
| 3 — orchestration | T4, T5 | `bun test src/bun/multi-repo-repro.test.ts src/bun/orchestrator-multi-repo.test.ts src/bun/pipeline-runner.test.ts src/bun/terminals.test.ts src/bun/agents.test.ts`; typecheck |
| 4 — lifecycle + API | T6, T7 | `bun test src/bun/worktrees-list.test.ts src/bun/worktree-git-status.test.ts src/bun/server-multi-repo.test.ts src/bun/route-policy.test.ts src/bun/pull-create-task-url.test.ts`; `bun test` |
| 5 — creation surfaces + CLI | T8, T9, T13, T14 | focused webview/CLI tests; typecheck; `bun test` |
| 6 — detail UI + shell | T10, T11 | focused webview tests; typecheck; `bun test` |
| 7 — aggregate PR | T12 | focused RunPanel/parser tests; typecheck; `bun test` |
| 8 — docs + e2e | T15, T16 | e2e spec; docs links checked |
| 9 — verify | T17 | full `bun test`, typecheck, e2e, smoke matrix; final commit |

**Delivery slices.** If review is split, the natural stack is: **A** = waves 1–4 (data, worktrees, orchestration, routes; multi-repo works through the API and CLI core), **B** = waves 5–7 (webview), **C** = waves 8–9 (docs, e2e, verification). Each slice is wired and green on its own. The pipeline asks for one local commit; a single squashed commit whose message includes `Fixes #291` is the expected end state.

**Pre-flight before wave 1.** Run the scratch reproduction from §1 and keep its output. Do not edit source before that. The permanent assertion is T4's `multi-repo-repro.test.ts`.

**Hot spots.** `src/bun/orchestrator.ts` is owned by T4 (wave 3) and T6 (wave 4) — sequential, never parallel. `src/mainview/components/kanban/RunPanel.tsx` is owned by T11 (wave 6) and T12 (wave 7) — sequential. `src/bun/route-policy.ts`/`route-policy.test.ts` are T7 only. `src/shared/types.ts` is T1 only. `src/bun/server.ts` is T7 only. `src/bun/worktree.ts` is T3 only.

## 7. Invariants, runtime shape & risks

### 7.1 Invariants and their single enforcement point

- **The repository set is fixed at creation, except for removals.** `createTask` is the only writer of `repositories` at creation; `tasks.setRepositories` is the only runtime writer (it never demotes a multi row nor re-adds a removed entry); `removeTaskRepository` is the only way to shrink the set; `PATCH /tasks/:id` rejects the field. Every path reads `task.repositories`, and every multi/single decision reads `isMultiRepoTask` (`Task.multiRepo`).
- **No primary repository.** No code chooses a "main" repo; `repositories[0]` is only the default for a diff request that omits `repo` and for form display.
- **One cwd per task.** For a multi-repo task the agent, terminals, `@` expansion, markdown/handoff resolution and the card's open-in-Finder all use `task.worktreePath ?? task.workdir` (the workspace). No code spawns at `repositories[].path`.
- **Every worktree path is under `WORKTREES_DIR`.** `prepareTaskWorkdir` constructs `<WORKTREES_DIR>/<task-id>/<slug>` and `prepareRepoWorktree` receives it; `resolveWorktreeRef` is the only id-to-path guard for `DELETE /worktrees/:id` and `GET /worktrees/:id/git-status`.
- **Every path-bearing request field is gated for the CLI caller.** `ROUTE_POLICY` is the single table; `POST /tasks` declares `body.workdir` and `body.repositories[].path`; `/projects/repo-root` declares `query.path`.
- **All spawns go through `coreSpawn`/`coreSpawnSync`.** Worktree creation uses `git()`; no new raw spawn.
- **Server-managed columns.** `repositories` and `issue_repo_path` are written by their targeted methods, skipped by `tasks.update`, and never bump `updated_at`.
- **First-write-wins PR stamp.** `tasks.setRepositoryPrUrl` refuses to overwrite a non-null entry; `POST /github/pull-create` matches the task's repo by worktree path before stamping.
- **Prompt rule.** A single-repo launch prompt is byte-identical; the `Repositories:` block exists only for a multi task (one repository left after removals included) and is the only new machine-added text, documented as an exception.
- **All-or-nothing prepare, best-effort teardown.** `prepareTaskWorkdir` rolls back created worktrees on any failure; archive/delete never block the card on one repo.
- **Bounded work.** Prepare and status run at concurrency 4 per task; one batched git-status response per poll; one `@` listing request per repo scope, not per keystroke.

### 7.2 Runtime shape

- One Bun core process per app (or a headless core), one SQLite DB, one board poll every 2 s, one run-panel git-status poll every 5 s. A multi-repo git-status response contains every repo in one JSON body; the webview does not open a connection per repo.
- Worktree preparation is awaited inside `startTaskInner` before the spawn; N repos cost N `git worktree add` spawns, bounded at 4 concurrent. The spawn response budget (`SPAWN_RESPONSE_BUDGET_MS`) is unchanged; a slow multi prepare may return `pending: true` exactly like today.
- Teardown uses the per-source-repo FIFO. Multi jobs acquire every source-repo key with `enqueueTeardownMany` (the workspace directory itself is unique per task, so it needs no FIFO key) and clean the workspace inside the job; the boot sweep re-enqueues after a crash between the archive DB flip and the job. A crash between create and start leaves a DB row with pinned repos and no workspace; a later start materializes it.
- Rollback is a code revert, not a down migration. Multi-repo worktrees created on disk stay until the task is deleted or archived; an older build sees the workspace as `workdir`/`worktreePath` and may orphan secondary worktrees (accepted, §9).
- No kill switch: the feature ships enabled. The only per-task opt-out is selecting one repository, which uses today's path.

### 7.3 Risks and blast radius

| Risk | Why it matters | Mitigation / task |
| --- | --- | --- |
| Worktree lifecycle correctness | N worktrees multiply partial-materialization, dirty, branch-collision and teardown modes; a bug can strand commits or delete a checkout | T3/T6, all-or-nothing prepare, per-repo dirty checks, existing worktree tests, e2e archive |
| Path traversal / TCC | Nested ids and `repositories[].path` widen `rm -rf` and the CLI path gate | `resolveWorktreeRef` single guard; `itemField` gate; route-policy tests; no sibling workspace |
| Harness divergence | The workspace is not a git repo; project-config discovery, Codex sandbox and Cursor/fx root-set behavior differ | Layout is the only universal option (P4/P5); `--add-dir` for flag kinds; smoke matrix in T17 |
| `@` references | A `@src/a.ts` from repo A is ambiguous; a wrong cwd breaks every token | Per-repo scopes + slug prefix; `resolveAtPath` containment unchanged; composer tests |
| UI scope creep | New Task is already dense; RunPanel is 9k lines | One shared dialog; one repo keeps today's form; RunPanel split across T11/T12; explicit test ids |
| Poll cost | 5 repos × git subprocesses per 5 s poll | One batched endpoint, concurrency 4, no per-repo SSE, bounded by the existing 5 s poll |
| Pipeline copy | A missed copy gives a step a private worktree | T5 copies `repositories` at insert and on refresh; parent owns teardown; tests |
| PR attribution | A stamp on the wrong entry silently loses "View PR" | Match by worktree path; first-write-wins; per-repo tests |
| Backward compatibility | Older builds see the workspace and may orphan secondary worktrees | Owner accepted; documented in CLAUDE.md and the plan |

**Callers and propagation.** `prepareWorkdir` has five callers (start, send restore, unarchive, terminal open, pipeline refresh); all move to `prepareTaskWorkdir`. The 25+ `worktreePath ?? workdir` cwd sites stay correct because of the workspace mirror. `removeWorktree`/`detachWorktree`/`teardownBranchesForTask`/`discardRefusedWorktree`/`enqueueTeardown`/`sweepArchivedTeardowns`/`listWorktrees`/`deleteOrphanWorktree`/`worktreeGitStatus` move to per-repo. `duplicateAgentProfile`, `pipeline-runner`, `terminals`, `agents`, `server`, the webview and CLI are the other propagation surfaces. `project-files.ts`, `commands.ts`, `md-image.ts`, `handoff-*` and `shortenTaskPaths` need **no** code change: every path is under the workspace, so the existing fold/resolve root still works; T17 verifies this rather than editing them.

**Cross-repo dependencies.** None. The GitHub stub and the e2e fixture are local test seams.

## 8. Open questions / assumptions

**Unratified one-way doors: none.** Both one-way doors were answered in grill round 2 (`isolation-none-final`, `legacy-columns`). The choices below are plan-level, reversible implementation details, not owner decisions.

| # | Assumption / choice | What we proceed on | Why | Confidence |
| --- | --- | --- | --- | --- |
| A1 | `issueRepoPath` shape | Top-level `task.issueRepoPath: string \| null` holding the matching `repositories[].path`, not a per-repo boolean/URL | One comparison at PR prefill; survives slug/name changes; insert-only so no writer complexity | high |
| A2 | Single-repo storage | Store `repositories = '[]'` for single-repo rows and derive one entry in `toTask`; no backfill | The scalar columns stay authoritative as they update; no migration of every row; no stale JSON for legacy rows | high |
| A3 | Repository identity | `path` is the selected project path (may be a subdirectory); git operations resolve `repoRoot(path)`; dedupe groups by that root | Keeps the Project filter and display honest; dedupe still collapses one repo | high |
| A4 | Slug | `name` is the sanitized basename of the first selected path for that root, uniquified `-2`, `-3`; shared helper used by client and server | The workspace directory must be predictable to the client for `@` prefixes and the warning count | high |
| A5 | Diff default | A multi-repo diff request without `repo` returns `repositories[0]`; the UI always passes a tab's repo | Keeps the route additive and lets old callers show something | high |
| A6 | Extra roots | Add `--add-dir` for claude-code, codex and copilot (flag supports it); do not write Gemini `includeDirectories`; cursor/fx/opencode rely on cwd | Vendor evidence P4/P6/P9; Gemini is uninstalled and smoke-pending | medium |
| A7 | `@` listing | Client-side union over one `/files/index` per repo scope with a `<slug>/` prefix; no new server listing route | Reuses the git-repo contract and `resolveAtPath` containment; avoids a workspace-root listing exception | high |
| A8 | Branch fallback visibility | The form's shared branch field is a request; actual per-repo names come back in the create response and are shown in the card/run panel/Repositories dialog | The server is authoritative; a pre-create preview would need a second validation endpoint | medium |
| A9 | Prompt block | Only for 2+ repos; appended after the user prompt and before references; single-repo prompt byte-identical | Avoids touching every existing prompt and every transcript assertion | high |
| A10 | Aggregate PR format | Agents print `Repository: <name>` before each proposal; the parser tolerates a missing label only when exactly one repo has a proposal | One parser, deterministic per-repo routing | medium |
| A11 | No hard cap | Enforced only by the non-blocking >10 warning and bounded concurrency; a huge selection may be slow. The CLI path gate's existing 256-value safety limit still applies to a CLI request, which is a security bound, not a product cap. | Owner decision; a cap would be a follow-up | high |
| A12 | Smoke matrix | Live-smoke claude/codex/fx/opencode where credentials allow; cursor is plan-limited; gemini/agy/copilot are absent. **Run 2026-11-12:** claude/codex/fx end to end; opencode end to end on a re-run with a Go subscription model (the first attempt hit an empty Zen balance); copilot not run live (no login; flags confirmed from its `--help`, opt-in real-binary case pending a run); cursor not run | Available binaries checked 2026-11-10 | high |

**Owner-visible limitations to state in the PR body.** Repositories can't be added after creation (a repository can be removed; adding one needs a new card); a PR opened from a pipeline step is stamped on the step only, so the parent's "Create all PRs" can retry it and show GitHub's 422; multi-repo requires worktree isolation; no per-repo `existingBranch`; an older build sees the workspace and may orphan secondary worktrees; no downgrade guard. If the owner rejects the `Repositories:` paragraph exception, the fallback is the existing references block, but that would contradict round 2 `prompt-block-format`.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Workspace root, per-repo worktrees, one agent conversation | in this run | T3, T4 |
| `repositories[]` column (087) + legacy read fallback + workspace mirror | in this run | T1, T2 |
| Create-time validation, dedupe by git root, no cap, >10 warning, bounded batches | in this run | T3, T4, T8 |
| Shared branch + per-repo base + per-repo fallback | in this run | T3, T4 |
| Shared `Repositories` dialog in New Task and issue dialog | in this run | T8 |
| `Repositories:` launch-prompt block + prompt-text rule amendment + tests | in this run | T1, T4, T15 |
| Per-repo diff/status, batched git-status, terminals at workspace, extra roots | in this run | T5, T7, T9, T11 |
| Aggregate commit/push + per-repo best-effort PR + issue attribution | in this run | T1, T7, T12 |
| Archive/delete per repo, dirty preservation, nested Worktrees rows/ids | in this run | T3, T6, T13 |
| Pipeline parent multi-repo + step copy + parent-owned teardown | in this run | T5 |
| Card worktree icon + count tooltip, diff tabs, filters/search, per-repo context menu | in this run | T10, T11 |
| Full CLI/TUI parity | in this run | T14 |
| Harness support for all eight + smoke matrix for installed/credentialed kinds | layout support in this run; live smoke run 2026-11-12 for claude/codex/fx/opencode (end to end; opencode on a re-run with a Go subscription model) | T5, T17; cursor plan-limited and not run, gemini/agy absent; copilot has no login here (not run live; flags confirmed from its `--help`, opt-in real-binary case pending a run) |
| Docs updates | in this run | T15 |
| `prepareWorkdir`'s five callers | in this run (dispatch) | T4, T5, T6 |
| 25+ `worktreePath ?? workdir` cwd sites | in this run (no per-site edit; workspace mirror) | T4, T6, T17 |
| `teardownTails` keying / multi-key FIFO | in this run | T6 |
| `listWorktrees` / `resolveWorktreeDir` / `deleteOrphanWorktree` / `worktreeGitStatus` | in this run | T6 |
| `route-policy` `repositories[].path` gate | in this run | T7 |
| `tasks.insert/update/toTask` server-managed treatment | in this run | T2 |
| `duplicateAgentProfile` copy | in this run | T4 |
| `discardRefusedWorktree` / `sweepArchivedTeardowns` | in this run | T6 |
| `hook-installer` workspace settings location | verify only (no code change) — verified live 2026-11-12: Claude Code wrote `.claude/settings.local.json` at the non-git workspace root, and delete removed it with the workspace | T17 smoke |
| `harness-failover.ts` / `orchestrator-opencode-server.ts` cwd | verify only (workspace mirror) — OpenCode 2.x server ran a multi task end to end live at the non-git workspace directory (2026-11-12 re-run, `opencode-go/deepseek-v4.1-flash`, including a follow-up turn); a harness failover of a multi task is **not yet verified** (needs a two-account stack) | T17 smoke; failover pending |
| `shortenTaskPaths` / `md-image` / handoff artifact roots | no change; verify | T17; the workspace is the fold/candidate root |
| `listProjectFiles` non-git workspace listing | avoided | Per-repo scopes (A7); no server change |
| `commands.ts` capability discovery | no server change; client union | T9 |
| TUI `@` completion and dashboard compose scope | in this run | T14 |
| E2E multi-repo spec | in this run | T16 |
| Live smoke for gemini/copilot/antigravity | out of scope for this change | Owner accepted "layout-supported, smoke-pending" (round 1 #harness-scope); no binaries/accounts here |
| Editing the repo set after creation | removing one repository: in this change (owner decision after implementation); adding one: out of scope (owner-deferred) | Round 1 #repo-set-editing + round 2 #create-only-confirm; amended by the owner |
| Multi-repo `isolation: "none"` | out of scope | Round 2 #isolation-none-final |
| Per-repo `existingBranch` | out of scope | Round 2 #existing-branch-multi |
| Downgrade guard / down migration | out of scope | Round 2 #legacy-columns |
| Copy/sync live checkouts into the workspace | out of scope | Round 2 #isolation-none-final |
| Hard cap on repository count | out of scope (owner-deferred) | Round 1 #repo-identity-cap + round 2 #dedupe-no-cap — warning only |
| Per-repo branch names from each project's config | out of scope | Round 1 #branch-base — shared name with fallback |
| Coordinator + one agent per repo | out of scope | Round 1 #agent-architecture — one conversation |
| Compatibility mirror of one repo in the legacy columns | out of scope | Round 2 #legacy-columns — no primary |
| Gemini `context.includeDirectories` settings write | out of scope (smoke-pending) | A6; add a follow-up if a Gemini account shows a need |
| Old clients / older builds seeing a multi row | accepted limitation | Round 2 #legacy-columns; documented in CLAUDE.md |
