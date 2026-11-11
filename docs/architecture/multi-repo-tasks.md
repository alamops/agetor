# Multi-repository tasks (issue #291)

One task/card can work on two or more registered repositories. Each repository
gets its own linked git worktree and branch **inside one per-task workspace
directory**; a single agent conversation runs at that workspace root and every
surface (card, run panel, diff, terminals, Worktrees page, PRs, pipelines, CLI,
TUI) carries the repository dimension.

## Data model

`Task.repositories: TaskRepository[]` (`src/shared/types.ts`) is the source of
truth for a multi-repository row:

```ts
interface TaskRepository {
  path: string;            // selected project path (may be a subdirectory)
  name: string;            // workspace subdirectory (sanitized basename, uniquified)
  branch: string | null;   // branch agetor pinned for this repo
  branchSource: "created" | "existing";
  worktreePath: string | null;
  baseRef: string | null;  // pinned sha in this repo
  checkoutBranch: string | null;
  prUrl: string | null;    // first PR opened from this repo
}
```

- **Multi rows** (2+ entries) store the JSON in `tasks.repositories` (migration
  087). `workdir` and `worktreePath` both point at the workspace root
  `<dataDir>/worktrees/<task-id>`; `branch`, `baseRef`, `prUrl` and the scalar
  `checkoutBranch` are `null`. `issue_repo_path` names the repository whose
  remote matches `issueUrl` — only its PR gets `Closes #N`.
- **Single rows** store `'[]'` and `toTask` derives exactly one entry from the
  scalar columns, so those stay authoritative as they update. No backfill.
- `repositories`/`issue_repo_path` are server-managed: written by `createTask`,
  `tasks.setRepositories`, `tasks.setRepositoryPrUrl` and
  `tasks.setRepositoryCheckout`; skipped by the generic `tasks.update` SET
  clause; never bump `updated_at`; `PATCH /tasks/:id` 400s the field. The set is
  fixed at creation (the owner deferred editing).

## Creation

`POST /tasks` accepts `repositories: [{ path, baseRef? }]` (`path` absolute).
`createTask`:

1. Validates every path is inside a git repo, collecting **all** failures
   (`resolveRepositorySet`, `src/bun/task-repos.ts`).
2. Dedupes by git root, keeping the first selected path for that root.
   A selection that collapses to one root uses the ordinary single-repo layout.
3. Rejects 2+ entries with `isolation: "none"` or `existingBranch`.
4. Resolves each repository's base ref to a sha and pins a branch per
   repository through `ensureUniqueBranch` against **that repository's own
   refs** (plus names other not-yet-started tasks hold), so a branch left
   behind by an archived task gets the per-repository `-N` fallback instead of
   being silently re-attached. Repositories share the desired name when it is
   free everywhere.
5. Matches `issueUrl` against every repository's remote.
6. Inserts `workdir = <dataDir>/worktrees/<task-id>` and the entries with
   `branch` pinned but `worktreePath` null.

The route declares `repositories[].path` in `ROUTE_POLICY`, so the CLI caller's
path gate probes every selected path (`PathParam.itemField`).

## Preparation, runtime and the workspace mirror

`prepareTaskWorkdir` (`src/bun/worktree.ts`) delegates to `prepareWorkdir`
unchanged for ≤1 repository. For 2+ it resolves the workspace with
`workspacePathFor` — the task's mirrored `worktreePath`/`workdir` when it is a
*strict direct child* of `<dataDir>/worktrees` (the root itself and deeper
paths are refused, so a corrupt row can never make teardown rmdir the managed
directory), else `<WORKTREES_DIR>/<task-id>` — and creates one linked worktree
per repository via `prepareRepoWorktree` (`MULTI_REPO_CONCURRENCY`, 4 at a
time), reusing an existing entry's checkout without creating or switching
anything. A recorded path that is no longer a linked worktree of that
repository is not reused (it would start the agent in a broken cwd); a real
checkout still sitting at the deterministic target is adopted instead of
deleted, and only a stale non-worktree child is cleared before
`git worktree add` so a failed attempt/teardown cannot permanently block the
next start. A pipeline step row copies its parent's workspace, so it reuses the
same workspace instead of materializing an empty
`<WORKTREES_DIR>/<step-id>`. It is **all-or-nothing**: every failure is
collected, worktrees/branches materialized in this attempt are rolled back
(including an `rm` fallback when `git worktree remove` fails, mirroring
`removeOneWorktree`; the branch is only deleted when this attempt minted it),
reused ones are left alone, and the error names every failed repository. A repository that already holds the shared branch gets
a per-repo `-N` fallback; `takenBranches` is keyed by the selected project path,
and the per-repository lookup falls back to the git root so a subdirectory
selection still sees the pin.

`startTask` spawns the agent with `cwd = workspace`, persists the materialized
entries with `tasks.setRepositories`, and appends the launch block

```
Repositories:
- frontend: /…/worktrees/<task-id>/frontend (branch feature/auth)
- backend: /…/worktrees/<task-id>/backend (branch feature/auth)
```

after the user prompt and before the references block. This block is the only
machine-added text for a multi task; a single-repo launch prompt is
byte-identical to before. Flag-capable harnesses (claude-code, codex, copilot)
also get `--add-dir <workspace>/<repo>` for every entry; cursor/fx/opencode rely
on the cwd (the workspace is not itself a git repo). `spawnAgentOrFail` injects
those directories from the task row on **every** spawn path (first launch,
follow-up, swap, retry), so a resumed codex/copilot turn keeps the same roots.

Because `workdir`/`worktreePath` mirror the workspace, every existing
`worktreePath ?? workdir` cwd site (terminals at the workspace root, `@`
expansion, markdown resolution, open-in-Finder) works unchanged. Terminals may
also open inside one repository (`POST /tasks/:id/terminals { repo }`).

## Diff, status and PRs

- `GET /tasks/:id/diff?repo=<name>` computes that repository's diff against its
  own `baseRef`; omitted defaults to the first entry; an unknown name 400s.
  `agetor diff <task-id>` prints every repository in labelled sections (JSON:
  an array) and `--repo <name>` narrows it to one, so the CLI never silently
  shows only `repositories[0]`.
- `GET /tasks/:id/diff/blob?...&repo=` reads the matching worktree.
- `GET /tasks/:id/git-status` returns one batched body: each repository's
  status in `repositories[]`, with the top-level fields mirroring the first for
  old clients. One request per 5 s poll, bounded at `MULTI_REPO_CONCURRENCY`
  (4) concurrent repositories — the same constant worktree preparation uses.
- `agetor ls --repo`/`--workdir` matches the task's `workdir` or any selected
  repository's path/workspace name; a multi task's `workdir` is the workspace
  root, so matching only that never found its repositories.
- `POST /github/pull-create` matches the task's entry by worktree path (then
  selected path) and stamps only that entry; first write wins; `task.prUrl`
  stays null. The run panel's "Create all PRs" walks the repositories that have
  no PR yet (`repositoriesNeedingPr`), best-effort, appending `Closes #N` only
  for `issueRepoPath`; a second press never duplicates a stamped repository.

## Teardown, Worktrees page and ids

Archive/delete are per repository and best-effort: a dirty checkout is kept
(with its branch and the workspace directory), clean ones are detached, and the
workspace is removed only when empty. Before detaching, archive records each
repository's live checkout with `tasks.setRepositoryCheckout` so unarchive
re-attaches onto the same branches. Branch teardown is planned per repository
(`TaskTeardownPreview.repositories`), with the top-level fields mirroring the
first; delete passes that plan to `removeWorktree`, so a branch a repository's
checkout drifted onto is removed in the repository that owns it.

A multi row's Worktrees id is `<taskId>__<repo-slug>`. Task ids are UUIDs and
contain no underscore, so the first `__` is the boundary. `resolveWorktreeRef`
is the single id-to-path guard for `DELETE /worktrees/:id` and
`GET /worktrees/:id/git-status`: every segment must be a safe basename, and the
final path must be a direct child of its parent, itself a direct child of
`WORKTREES_DIR`. `listWorktrees` emits one row per repository
(`repoName`, `workdir = entry.path`), skips the workspace root, and expands an
orphaned workspace directory only when a child's `.git` is a linked-worktree
pointer with exactly one segment after `.git/worktrees/` (`gitdir:
<repo>/.git/worktrees/<id>`). A submodule never qualifies: inside a linked
worktree git writes `<repo>/.git/worktrees/<id>/modules/<sub>` (and in a main
checkout `.git/modules/<sub>`), so its deeper or different tail does not split
a legacy single-repository worktree into rows.

Teardown is serialized per selected repository path: `enqueueTeardownMany`
acquires every entry's `path` key in sorted order (no deadlock), so two tasks
that selected the same path never run `git worktree` operations concurrently.
(Keys are the paths the tasks stored, not their resolved git roots, so two
subdirectory selections under one root are not serialized against each other.)

## Surfaces

- **New Task / issue dialog** — `RepositoriesDialog` selects two or more
  projects (add folder, per-repo base, remove, dedupe by git root, non-blocking
  warning above 10). One repository keeps today's inline project/branch/base,
  and the dialog offers **no** per-repository base input for it (a second,
  ignored control silently discarded what the user typed); 2+ shows a summary
  and forces worktree isolation. Saving a selection that promotes a different
  first repository resets the inline base ref, exactly like the ProjectPicker.
- **`@` files** — client-side union over one `/files/index` per repository
  scope, entries prefixed `<name>/`, plus a `<name>/` root row per repository
  so `@frontend` itself resolves (highlight, warning and the CLI advisory
  pre-check all agree with send-time expansion). No new server listing route;
  workspace containment is unchanged.
- **Capability discovery** — `/agent-discovery` (project commands, skills,
  MCP servers and custom agents) is unioned over the same per-repository
  scopes as `@`: the webview composer, the run panel, the CLI (`agetor
  commands`, the `@`-warning exemption) and the TUI all issue one discovery
  call per repository and merge by command name / extension insert. The
  non-git workspace root is never a discovery scope, so every selected
  repository contributes.
- **Card** — a worktree icon + repository count with a hover tooltip naming
  every repository, instead of the single workdir/branch line. Board text
  search and the project filter match any repository.
- **Diff dialog** — one tab per repository; compose-from-diff labels the
  selected lines with the workspace prefix (`<name>/src/a.ts`) and its `@`
  suggestions union every repository, because the message is delivered to the
  agent at the workspace root.
- **Run panel** — repository tab selects the per-repo status, PR head, PR path
  and terminal cwd; commit & push uses the aggregate prompt.
- **Pipelines** — a multi parent copies its set onto every step row and owns
  teardown; steps never detach a shared worktree.
- **CLI/TUI** — `agetor add --repo <path[=ref]>` (repeatable) and the
  interactive wizard's repository multi-select (each picked repository can
  carry its own base ref; `--repo`/`--workdir` skip the picker), `show` prints
  the repository block, `shell [--repo <name>]` (the task id works with or
  without the flag), `rm` names each repository's own branch removals (and
  `--json` carries `repositories[]`), `ls` shows a count, and the TUI `@`
  listing unions the scopes with prefixes. `agetor add` without `--start`
  runs the advisory `@` pre-check against the same per-repository scopes.

## Intentional limits

- Create-only repository set; 2+ requires worktree isolation; no per-repo
  `existingBranch`; no hard cap (warning above 10); no per-repo branch
  configuration; one agent conversation, not one per repository.
- An older build sees the workspace as `workdir`/`worktreePath` and may orphan
  secondary worktrees; there is no downgrade guard.
- Gemini's `context.includeDirectories` settings write is not performed; its
  layout is supported through the workspace cwd only.
