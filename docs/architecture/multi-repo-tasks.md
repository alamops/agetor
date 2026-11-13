# Multi-repository tasks (issue #291)

One task/card can work on two or more registered repositories. Each repository
gets its own linked git worktree and branch **inside one per-task workspace
directory**; a single agent conversation runs at that workspace root and every
surface (card, run panel, diff, terminals, Worktrees page, PRs, pipelines, CLI,
TUI) carries the repository dimension. A single-repository task is unchanged.
A task created with two or more repositories stays a multi-repository task
when repositories are later removed, even down to one (see "Removing a
repository").

The subsystem docs hold the parts of this contract that belong to them:
[security.md](security.md) (path gate, desktop-only route, workspace-root I/O,
codex writable roots), [persistence.md](persistence.md) (columns, writers,
migration 087), [task-lifecycle.md](task-lifecycle.md) (create, start, PATCH,
delete, archive, unarchive, boot sweep), [pipelines.md](pipelines.md) (multi
parents and steps), [harness-codex.md](harness-codex.md) (sandbox escalation),
[at-file-references.md](at-file-references.md) and
[prompt-composer.md](prompt-composer.md) (multi-scope `@` and discovery), and
[run-panel.md](run-panel.md) (repository tabs, Create all PRs). This doc is the
whole feature in one place.

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

- **Multi or single is `Task.multiRepo`**, not the entry count. `toTask`
  (`db.ts`) derives it: true exactly when the stored `repositories` column is
  non-empty, because only a multi row stores its set. It has no column of its
  own, is not patchable and never bumps `updated_at`; it is optional in the
  type. Every multi/single decision goes through `isMultiRepoTask`
  (`src/shared/multi-repo.ts`), which is `task.multiRepo ?? (count > 1)`; the
  count fallback keeps an older core's JSON, which has no `multiRepo`, working.
  A count is read directly only where a count is meant (the CLI's "2+
  repositories requested" at create time).
- **Multi rows** store the JSON in `tasks.repositories` (migration 087): two or
  more entries at creation, and at least one after removals. A one-repository
  multi task keeps the whole multi contract: the workspace-root layout, the
  `Repositories:` launch block, the extra roots, the per-repository tabs, diff,
  PR and terminal selector, the `@<repo>/` scope, "1 repository" on the card
  and "1 repo" in `agetor ls`.
  `workdir` is the workspace root `<dataDir>/worktrees/<task-id>` from
  creation. `worktreePath` is `null` until the first start materializes the
  workspace, and from then on is that same root. `branch`, `baseRef`, `prUrl`
  and the scalar `checkoutBranch` are `null`. `issue_repo_path` names the
  repository whose remote matches `issueUrl` — only its PR gets `Closes #N`.
- **Single rows** store `'[]'`, and `toTask` derives exactly one entry from the
  scalar columns through the shared `repositoriesForTask`
  (`src/shared/multi-repo.ts`, the same derivation the webview and CLI use), so
  those columns stay authoritative as they update. No backfill.
- `repositories`/`issue_repo_path` are server-managed: written by `createTask`,
  `tasks.setRepositories`, `tasks.setRepositoryPrUrl`,
  `tasks.setRepositoryCheckout` and `tasks.clearIssueRepoPath`; skipped by the
  generic `tasks.update` SET clause; never bump `updated_at`; not in the PATCH
  allow-list. Repositories are chosen at creation and can't be added later;
  the only change afterwards is removing one
  (`DELETE /tasks/:id/repositories/:name`, below). `PATCH /tasks/:id` refuses
  `repositories` with a 400 that points at that route, and refuses any change
  to a multi row's `workdir` with a 400, even before the first start
  (re-sending the same value is accepted).
- `tasks.setRepositories` never demotes a multi row and never regrows one: on
  a multi row it keeps only incoming entries whose workspace name the row
  still stores, so a prepare snapshot taken before a removal can't write the
  removed entry back; any non-empty result is stored (one entry included) and
  an empty one leaves the row untouched. On a single row a one-entry set
  still stores `'[]'`.
- `tasks.setRepositories` is called with a snapshot taken before awaits, so it
  keeps a stored `prUrl` and `checkoutBranch` over the incoming one. A fresh
  checkout reading is recorded separately through `setRepositoryCheckout`
  (compare-then-write by workspace name), which, like `setCheckoutBranch`,
  mirrors a pipeline step's write onto its parent's same-named entry in the
  same transaction.

## Creation

`POST /tasks` accepts `repositories: [{ path, baseRef? }]` (`path` absolute).
There is no hard cap on the count (owner decision, grill #14): the dialog warns
above 10, and every per-repository fan-out runs in bounded batches instead —
branch minting, preparation, `pinMissingRepositoryBaseRefs` and git status at
`MULTI_REPO_CONCURRENCY` (4), create-time base-ref resolution one repository
at a time, root lookups at `PIN_ROOT_CONCURRENCY` (4), and
the webview's per-repository requests at `MULTI_SCOPE_CONCURRENCY` (2). A CLI
request's path gate probes at most `MAX_GATED_VALUES` (256) paths, a security
bound rather than a product cap. `createTask`:

1. Refuses the same path selected twice with different effective base refs
   (its own, else the task-level default, else `HEAD`), naming the path. A
   repeat that resolves to the same ref is a harmless duplicate.
2. Validates every path is inside a git repo, collecting **all** failures
   (`resolveRepositorySet`, `src/bun/task-repos.ts`).
3. Dedupes by git root, keeping the first selected path for that root.
   A selection that collapses to one root uses the ordinary single-repo layout
   with the same base-ref precedence: an entry pin wins, then the task-level
   default, then that repository's HEAD.
4. Rejects 2+ entries with `isolation: "none"` or `existingBranch`.
5. Resolves each repository's base ref to a sha and pins a branch per
   repository through `ensureUniqueBranch` against **that repository's own
   refs** (plus names other not-yet-started tasks hold), at most
   `MULTI_REPO_CONCURRENCY` at a time, so a branch left behind by an archived
   task gets the per-repository `-N` fallback instead of being silently
   re-attached. Repositories share the desired name when it is free
   everywhere. The ordinary single-repository path folds the same pin map
   (every other task's `branch` and `repositories[].branch`), so a same-title
   single task created after a not-yet-started multi task gets the `-N` variant
   instead of later attaching to that task's branch and commits. Every pin is
   keyed by both the selected path and its resolved git root, so two tasks that
   selected sibling subdirectories of one repository still see each other's
   pins. Root lookups run through a bounded pool (`PIN_ROOT_CONCURRENCY`) and
   only for the multi-repository lookups that query by `[path, root]`; the
   single path folds every value and never resolves a root.
   `GET /projects/branches` hides both kinds of pin. An entry's own
   `repositories[].baseRef` (`--repo <path>=<ref>`) wins; a task-level
   `baseRef` (CLI `--base-ref`) is the default for entries without one;
   omitted both means that repository's HEAD.
6. Matches `issueUrl` against every repository's remote.
7. Inserts `workdir = <dataDir>/worktrees/<task-id>`, `worktreePath = null`,
   and the entries with `branch` pinned but `worktreePath` null.

A single-repository create with `existingBranch` treats a live (non-archived)
multi row's entry in the same repository holding that branch as a collision,
the same as a single row's `branch`.

The route declares `repositories[].path` in `ROUTE_POLICY`, so the CLI caller's
path gate probes every selected path (`PathParam.itemField`,
[security.md](security.md)).

## Preparation

`prepareTaskWorkdir` (`src/bun/worktree.ts`) delegates to `prepareWorkdir`
unchanged for a single-repository task. For a multi task (`isMultiRepoTask`,
a one-repository multi task included), it prepares under the workspace root,
and the result carries `repositories` exactly when this path ran (callers test
its presence, never its length):

- **Serialized per task.** Multi-repository prepares of one task id run one
  at a time (`withTaskPrepareLock`): start, `sendInput`'s restore, unarchive,
  a terminal open and the pipeline runner can all prepare the same task, and
  an overlapping loser's rollback would otherwise remove a checkout the winner
  had just adopted. A later caller waits and then takes the reuse path. The
  single-repository path takes no lock.
- **Workspace.** `workspacePathFor` accepts the row's mirrored
  `worktreePath ?? workdir` only when it is exactly `<WORKTREES_DIR>/<task.id>`
  or, for a pipeline step, `<WORKTREES_DIR>/<pipelineParentId>`; anything else
  (the managed root itself, a deeper path, another task's workspace) falls
  back to `<WORKTREES_DIR>/<task-id>`. A step therefore reuses its parent's
  workspace instead of materializing an empty `<WORKTREES_DIR>/<step-id>`.
- **One checkout per repository** at `<workspace>/<name>` via
  `prepareRepoWorktree`, at most `MULTI_REPO_CONCURRENCY` (4) at a time.
- **Reuse is proved by git common dir** (`isCheckoutOfRepo`): a directory is a
  checkout of the entry's repository when its toplevel is that directory and
  its common dir equals the source repository's. This holds when the selected
  repository is itself a linked worktree, a worktree of a bare repository, or
  reached through a symlink. A reused checkout is reported as it is; nothing is
  created or switched.
  - A recorded `worktreePath` whose branch can't be read and that is not proved
    to be a checkout, but still holds a `.git` entry, fails that repository
    with an error naming the path and is left untouched (it may hold
    uncommitted work).
  - A recorded path with no `.git` at all is not a checkout; the deterministic
    target is used instead.
  - A checkout of this repository already sitting at the deterministic target
    (a prepare that materialized but was never persisted) is adopted, and the
    entry records its live branch, not the create-time pin.
  - Before `git worktree add`, a leftover at the target is cleared only when it
    has no `.git` entry (`clearWorkspaceChild`). Any other `.git`-bearing
    target is refused with an error. The `.git` check goes through
    task-dir-fs (`taskDirLexists`), and a failed check counts as "has `.git`".
- **All-or-nothing.** Every failure is collected and the error names every
  failed repository. Checkouts materialized in this attempt are rolled back
  (`git worktree remove --force`, then an `rm` fallback inside
  `WORKTREES_DIR`), and a branch is deleted only when this attempt minted it.
  A worker that throws after it started materializing still triggers the
  rollback: its target is removed only when proved to be a checkout of that
  repository, and its branch is kept. Reused checkouts are left alone. A
  repository that already holds the shared branch gets a per-repo `-N`
  fallback; `takenBranches` is keyed by both the selected project path and the
  repository's git root.
- **Result.** `cwd` is the workspace. Warnings are prefixed `<repo name>: `.
  `PreparedWorkdir.unknownCheckouts` lists the repositories whose live branch
  read failed; their `checkoutBranch` in the result is the input snapshot, so
  `recordPreparedRepositoryCheckouts` skips them and the stored value is kept.
- `pinMissingRepositoryBaseRefs` fills an entry with no pinned `baseRef` from
  that repository's HEAD, at most `MULTI_REPO_CONCURRENCY` at a time.

`startTaskInner` records the materialized entries (`tasks.setRepositories` plus
`recordPreparedRepositoryCheckouts`) right after a successful multi prepare,
before the `@`-expansion and budget checks, so an early return can't leave
checkouts on disk that the row doesn't name; the `persist` transaction writes
them again with the workspace mirror.

## Runtime

`startTask` spawns the agent with `cwd = workspace` and launches with the text
`composeRunPrompt` (`src/shared/launch-prompt.ts`) builds: the agent profile's
preamble, the user prompt, then for a multi task the block

```
Repositories:
- frontend: /…/worktrees/<task-id>/frontend (branch feature/auth)
- backend: /…/worktrees/<task-id>/backend (branch feature/auth)
```

and then the references block. The block is decided by the task
(`repositoriesPromptBlock({ multiRepo, repositories })`), not the entry count,
so a one-repository multi task still gets it (its cwd is the workspace root).
This block is the only machine-added text for a multi task; a single-repo
launch prompt is byte-identical to before. The
pipeline runner measures a step prompt with the same function
(`stepLaunchPromptOverage`), so the budget it checks is the text that is sent.

Every checkout sits inside the workspace, so the agent can reach each one
through its cwd. The workspace root is not a git repository, though, and some
CLIs scope their working roots per git repository, so `spawnAgentOrFail` also
names each materialized checkout (`withTaskRepositoryRoots`, on **every** spawn
path: first launch, follow-up, swap, retry). Only checkouts that exist on disk
at spawn time are named: one whose directory is gone (its source repository
was deleted, a hand-removed checkout) is left out of both lists below, because
some CLIs refuse an `--add-dir` that names a missing path.

- `extraDirectories` becomes `--add-dir <workspace>/<repo>` for claude-code,
  codex and copilot. Cursor, fx, OpenCode, Gemini and Antigravity get no extra
  flag and rely on the cwd. Gemini's `--include-directories` /
  `context.includeDirectories` is not used (see "Intentional limits").
- Copilot needs no escalation of its own: in Auto it already runs with
  `--allow-all` and `COPILOT_ALLOW_ALL=true` (full access, writes under each
  source repository's `.git/worktrees` included) and gets every checkout as
  `--add-dir`; Read-only and Plan deny writes by design, in any repository, the
  same as for a single-repository task
  ([harness-copilot.md](harness-copilot.md)). The opt-in real-binary case in
  `src/bun/copilot-real-binary.test.ts` ran against Copilot CLI 1.0.109 with a
  fake provider: Auto committed in a checkout whose `.git` is outside the
  workspace and every `--add-dir`, and Read-only was denied. A control with
  `--allow-all-tools` but path verification on committed too, so Copilot's
  path check doesn't see git's own writes; tool approval is what matters. Not
  run against a GitHub account (no login on the smoke machine).
- `codexWorkspaceRepos` pairs each checkout with its source repository for
  codex's sandbox decision. `gitWritableRoots` grants a checkout's git common
  dir only when the checkout is strictly inside the cwd, its toplevel is that
  path and its common dir equals the source repository's; nothing is
  discovered by scanning the workspace ([harness-codex.md](harness-codex.md)).

A single-repository task gets its `opts` back untouched, so its argv is
unchanged. When no checkout exists at spawn time a multi task's `opts` are
returned untouched too.

Because `workdir` (and, once started, `worktreePath`) is the workspace, every
existing `worktreePath ?? workdir` cwd site (terminals at the workspace root,
`@` expansion, markdown resolution, open-in-Finder) works unchanged. A
never-started multi task has no workspace on disk yet; the run panel's
open-folder action says so instead of failing.

Terminals may also open inside one repository (`POST /tasks/:id/terminals
{ repo }`). An unknown `repo` is refused before anything is prepared; a `null`
or non-object JSON body reads as an empty body. A single-repository task
ignores `repo`.

A worktree-isolated pipeline step never materializes its own checkout (start,
follow-up and terminal open all refuse); for a multi step that requires the
workspace root **and** every repository checkout to exist.

## Diff, status and PRs

- `GET /tasks/:id/diff?repo=<name>` computes that repository's diff against its
  own `baseRef`; omitted defaults to the first entry; an unknown name 400s.
  `agetor diff <task-id>` prints every repository in labelled sections (JSON:
  an array) and `--repo <name>` narrows it to one, so the CLI never silently
  shows only `repositories[0]`. A repository whose diff fails gets a section
  naming the error (JSON: `{ repo, error }`), the others still print, and the
  command exits non-zero.
- `GET /tasks/:id/diff/blob?...&repo=` reads the matching worktree.
- `GET /tasks/:id/git-status` returns one batched body: each repository's
  status in `repositories[]`, with the top-level fields copied from the first
  repository for old clients. One request per 5 s poll, bounded at
  `MULTI_REPO_CONCURRENCY` (4) concurrent repositories.
- `agetor ls --repo`/`--workdir` matches the task's `workdir` or any selected
  repository's path/workspace name; `agetor ls --search` and the board search
  also match each repository's branch and last-seen checkout branch.
- `POST /github/pull-create` matches the task's entry by worktree path (then
  selected path) and stamps only that entry; first write wins; `task.prUrl`
  stays null. The run panel's "Create all PRs" walks the repositories that have
  no PR yet and are pushed, best-effort, appending `Closes #N` only for
  `issueRepoPath` ([run-panel.md](run-panel.md) has the in-flight rules).
- A PR opened from a pipeline step's panel is stamped on the **step** row only
  (single and multi alike; `body.taskId` names the step). The parent card does
  not show it, and the parent's "Create all PRs" still counts that repository
  as having no PR, so it can try it again and show GitHub's 422 ("a pull
  request already exists") as that repository's failure. Owner decision: a
  documented limitation, no code change.
- PR proposal prefill is repository-scoped: the single "Create PR" chip only
  accepts the active repository's `Repository:` block, and "Create all PRs"
  attributes an unlabeled proposal only when exactly one repository is being
  targeted (`latestProposalForRepository` / `latestProposalsForTargets`).
- "Resolve Conflicts" for a per-repository PR sends a prompt that names that
  checkout's absolute path (the run's cwd is the non-git workspace root) and
  runs every git command inside it; the single-repository prompt is unchanged.
- `agetor commit`'s heads-up note is computed over every repository: any
  dirty repository means no note, "push only" when all are clean and one is
  ahead, "nothing to commit or push" only when every repository is clean and
  level; an uninspectable repository next to clean ones suppresses the note.

## Removing a repository

`DELETE /tasks/:id/repositories/:name` (`removeTaskRepository` in
`orchestrator.ts`) removes one repository from a multi task. It is how a task
gets unstuck when one repository's source was deleted: until then every
follow-up's restore fails on that repository; once it is removed, the next
follow-up or start prepares only what remains. `ROUTE_POLICY` makes it
`app+cli` with no `pathParams` (`:name` is a workspace name, not a path).

- **Answers.** `200 { task }` on success; `404 { error }` for an unknown task
  or repository name; `409 { error, code }` when refused:
  - `running`: the task has a live or starting run, or (pipeline parent) a
    step is running or its pipeline run is `running`;
  - `last-repository`: it is the task's only repository;
  - `dirty`: the checkout exists and has uncommitted changes, or its status
    can't be read; the message names the checkout, and nothing is touched;
  - `not-multi`: the task is a single-repository task;
  - `pipeline-step`: steps share the parent's checkouts, so remove it on the
    pipeline task;
  - `detach-failed`: the checkout was clean but is still on disk after the
    removal; nothing on the row changed.
- **Effect** (`detachRepositoryForRemoval`, `worktree.ts`). The checkout is
  located with archive's owned-path checks (`locateRepositoryCheckout`). A
  clean checkout whose source repository still exists is detached with
  `git worktree remove --force` and `git worktree prune` (an owned-path `rm`
  fallback after); the branch is **always kept**, since it may hold the
  user's commits. A missing checkout drops the entry after a best-effort
  `git worktree prune` in the source. A missing source repository (gone from
  disk, or no longer a git repository) drops the entry and leaves the
  directory alone, since git can't vouch for it; a stored path that is not
  agetor's owned shape is likewise left alone and the entry dropped.
- **Row writes**, in one transaction: the remaining set through
  `tasks.setRepositories`; `tasks.clearIssueRepoPath` when `issueRepoPath`
  named the removed repository (no remaining PR claims `Closes #N`); and, for
  a pipeline parent, the same removal on every step row that still lists the
  repository, so a resumed step doesn't refuse over a checkout that is gone on
  purpose.
- **Status line.** `removed repository <name> from this task (branch <branch>
  kept)` (without the branch clause when the entry had none) goes on the
  task's latest run; for a pipeline parent, on its latest step's run; to the
  console when nothing has run yet.
- **Serialization.** The job runs behind any teardown queued on the task's
  repository paths (the same FIFO keys as `enqueueTeardownMany`) and the
  task's own pending teardown or removal, becomes the tail of those keys, and
  then takes the task's prepare lock (`withTaskPrepareLock`), so no prepare is
  mid-flight on the checkout. `pendingTeardown` awaits in-flight removals too
  (kept apart from `teardowns`, so a removal never reads as "archive/delete is
  taking this task away"), and `startTask` re-reads a multi row after that
  wait, so start, follow-up, unarchive and terminal open all see the new set.
  Refusals are checked once up front and again inside the job.
- **Archived tasks** can lose a repository too (there is usually nothing to
  detach). Archive, delete and teardown later see only what remains.
- **Copies.** When an agent profile is duplicated with its tasks
  (`duplicateAgentProfile`), a one-repository multi task is copied through
  `createTask` with its one remaining repository, which creates an ordinary
  single-repository task (it never inherits the old workspace root as its
  `workdir`).

## Teardown, Worktrees page and ids

Archive/delete are per repository and best-effort: a dirty checkout is kept
(with its branch and the workspace directory), clean ones are detached, and the
workspace is removed only when it holds nothing else. Before detaching, archive
records each repository's live checkout with `tasks.setRepositoryCheckout` so
unarchive re-attaches onto the same branches.

- **Which checkout is touched** (`locateRepositoryCheckout`). A recorded
  `worktreePath` is used only when it is exactly
  `<WORKTREES_DIR>/<task-id or pipeline-parent-id>/<entry name>`
  (`isOwnedRepositoryCheckoutPath`: lexically inside, no `.`/`..` segments);
  anything else is refused and never touched (detach reports `failed` for
  that repository, delete skips it). An entry with no recorded path falls back
  to `<workspace>/<name>`, removed or detached only when git proves it is a
  checkout of that entry's repository.
- **A repository whose source is gone.** `repoRoot` re-checks the disk on
  every call (a source deleted after its first lookup drops its cached root
  instead of answering from the cache; a git spawn in a missing cwd throws and
  used to abort the whole teardown job). With no root, git can't vouch for the
  checkout, which may hold the only copy of uncommitted work, so it is left on
  disk and the other repositories tear down as usual: archive's per-repository
  detach reports `{ removed: false, reason: "source-missing" }` for it, even
  when forced from the Worktrees page; delete skips it; the delete preview
  plans no branches for it. The workspace root then stays, since it is not
  empty. `WorktreeTeardownResult.reason` carries `source-missing`, and the
  Worktrees page says the source repository no longer exists and the checkout
  was kept (`triageDeleteOutcome`,
  `src/mainview/components/worktrees/worktree-delete-intent.ts`). To drop such
  a repository from a live task instead, remove it ("Removing a repository").
- **The workspace root** is never wiped recursively. `removeWorkspaceIfEmpty`
  removes agetor's own `.claude/settings.local.json` scratch, then the empty
  `.claude`, then the empty root, and keeps everything else. The check and the
  delete run through task-dir-fs (`taskDirWorkspaceHasOnlyScratch`,
  `removeTaskDirWorkspaceIfOnlyScratch`): always a child process that `cd -P`s
  into the verified directory, compares `pwd -P`, and uses relative `rm` and
  `/bin/rmdir`, disclaimed when the switch is on ([security.md](security.md)).
- **Branch plan.** Branch teardown is planned per repository
  (`TaskTeardownPreview.repositories`). The preview's top-level fields
  summarize for old clients: `branches` is the deduplicated union of every
  repository's branches, `excluded` concatenates every repository's
  exclusions, `liveBranch` and `source` are the first repository's, and
  `taskBranch` is null. Delete passes the per-repository plan to
  `removeWorktree`, so a branch a repository's checkout drifted onto is removed
  in the repository that owns it. A never-materialized entry plans nothing.
- **Branches other tasks hold** (`branchesHeldByOtherTasks`, used by both the
  single and multi plans) include every other row's `repositories[].branch` and
  `checkoutBranch` in the same repository, archived rows included, pipeline
  step rows excluded. A multi row's workspace root is never resolved as a git
  repository.
- **Unarchive** restores a multi task only when it was materialized at least
  once: a task archived before it ever started has nothing to restore, and
  unarchiving it creates no worktree or branch. A later start or follow-up
  materializes it as usual.
- **Boot sweep.** `sweepArchivedTeardowns` also re-enqueues an archived multi
  task whose checkouts are all gone but whose root holds only agetor's scratch.
  That check reads inside the workspace, so it runs asynchronously through
  task-dir-fs, and such a job is enqueued once it answers and is not counted in
  the returned number.

The Worktrees page's "Archive & delete" is task-scoped even when opened from one
repository row: it force-detaches every repository's checkout. Its confirm
therefore fetches the git status of every row belonging to the task (not just
the clicked one, bounded) and names each dirty or unreadable checkout, so a
clean row can't silently discard a sibling repository's uncommitted work.

A multi row's Worktrees id is `<taskId>__<repo-slug>`. Task ids are UUIDs and
contain no underscore, so the first `__` is the boundary. `resolveWorktreeRef`
is the single id-to-path guard for `DELETE /worktrees/:id` and
`GET /worktrees/:id/git-status`: every segment must be a safe basename, and the
final path must be a direct child of its parent, itself a direct child of
`WORKTREES_DIR`. `deleteOrphanWorktree` refuses **any** id whose task id still
has a row, nested names included (a nested name under a live single task
resolves inside its worktree, and a case variant can name a live checkout on a
case-insensitive volume); only that task's own archive/delete teardown removes
anything under its directory. `listWorktrees` emits one row per repository
(`repoName`, `workdir = entry.path`) and skips the workspace root while any
repository checkout exists. When every checkout is gone but the root survives
because it holds agent files, it emits that root as a task-backed row
(`id = taskId`, no `repoName`) so the page can still show it and retry the
teardown. Deleting that row reports `reason: "workspace-not-empty"` when the
root survives on user/agent files rather than the silent `already-absent`
success that left the row in place. It expands an orphaned workspace directory
only when a child's `.git` is a linked-worktree pointer with exactly one
segment after `.git/worktrees/` (`gitdir: <repo>/.git/worktrees/<id>`). A
submodule never qualifies: inside a linked worktree git writes
`<repo>/.git/worktrees/<id>/modules/<sub>` (and in a main checkout
`.git/modules/<sub>`), so its deeper or different tail does not split a legacy
single-repository worktree into rows.

Teardown is serialized per selected repository path: `enqueueTeardownMany`
acquires every entry's `path` key in sorted order (no deadlock), so two tasks
that selected the same path never run `git worktree` operations concurrently.
(Keys are the paths the tasks stored, not their resolved git roots, so two
subdirectory selections under one root are not serialized against each other.)

## Surfaces

- **New Task / issue dialog** — `RepositoriesDialog` selects two or more
  projects (add folder, per-repo base, remove, dedupe by git root, non-blocking
  warning above 10). One repository keeps today's inline project/branch/base,
  and the dialog offers **no** per-repository base input for it. The inline
  base ref seeds the first entry when the dialog opens, so adding a second
  repository keeps it; saving back down to one repository hands that entry's
  base ref back to the inline picker, and promoting a different first
  repository resets it (or takes that entry's own pin). Entries that collapse
  onto one git root keep a base ref set on any of them; two different base
  refs on one root block the save with a message naming both. Closing the
  dialog while its git-root lookup is in flight drops the result. 2+ shows a
  summary and forces worktree isolation.
- **`@` files** — client-side union over one `/files/index` per repository
  scope, entries prefixed `<name>/`, plus a `<name>/` root row per repository
  so `@frontend` itself resolves. Named scopes are passed only for a multi
  task, so their presence decides (`multiScopesOrNull`), never a count: a
  multi task left with one repository still lists and inserts `<name>/…`.
  Listing, search and discovery requests run
  at most `MULTI_SCOPE_CONCURRENCY` (2) at a time, the run panel holds the
  listing and discovery until the task's event stream is ready, a focus refresh skips repositories
  listed in the last `FOCUS_REFRESH_MIN_AGE_MS` (5 s), and a newer
  `searchProjectFileScopes` call aborts the previous one
  ([at-file-references.md](at-file-references.md)). No new server listing
  route; workspace containment is unchanged.
- **Capability discovery** — `/agent-discovery` (project commands, skills,
  MCP servers and custom agents) is called once per repository scope. The
  webview (composer and run panel) and `agetor commands` merge the results
  through the one implementation in `src/shared/agent-capabilities.ts`
  (`mergeAgentCapabilities`, first occurrence of a command name / extension
  insert wins); the CLI/TUI `@`-warning exemption unions the extension names
  of every scope. The non-git workspace root is never a discovery scope.
- **Card** — a worktree icon + repository count ("1 repository" /
  "N repositories", `repositoryCountLabel`) with a hover tooltip naming
  every repository, instead of the single workdir/branch line. Board text
  search matches any repository's name, path, branch and last-seen checkout;
  the project filter matches any repository.
- **Diff dialog** — one tab per repository; compose-from-diff labels the
  selected lines with the workspace prefix (`<name>/src/a.ts`) and its `@`
  suggestions union every repository, because the message is delivered to the
  agent at the workspace root.
- **Run panel** — repository tab selects the per-repo status, PR head, PR path
  and terminal cwd; commit & push uses the aggregate prompt
  ([run-panel.md](run-panel.md)). The task details list gains a
  **Repositories** row with one block per repository: name, selected path,
  branch (with drift: `on <live> (drifted from <branch>)`, from the git-status
  poll or the last-seen checkout), short base sha, checkout path or "not
  created yet", and the PR link. Each block has **Remove from task**, which
  confirms first ("Remove <name> from this task?": the checkout is detached,
  the branch is kept in the source with its commits, uncommitted changes block
  the removal, and it can't be undone from here) and toasts the core's message
  on a refusal. It is disabled, with the reason as its tooltip, while the task
  is running or blocked or has a run id, on a pipeline step, and when only one
  repository is left (`removeRepositoryBlockReason`,
  `src/mainview/lib/repo-removal.ts`); a dirty checkout or a running pipeline
  step is only known to the core. A repository whose per-repository git status
  comes back `ignored` (its checkout, or before the first run its source, is
  missing or unreadable) is marked with a warning on its tab and its details
  block (`repositoryProblem`), so the one to remove is easy to find.
- **Pipelines** — a multi parent copies its set onto every step row and owns
  teardown; steps never detach a shared worktree ([pipelines.md](pipelines.md)).
- **CLI/TUI** — `agetor add --repo <path[=ref]>` (repeatable) and the
  interactive wizard's repository multi-select (each picked repository can
  carry its own base ref, whose prompt shows the `--base-ref` default;
  `--repo`/`--workdir` skip the picker). With `--repo` present, `--workdir` is
  the first repository; a path named twice counts once (a duplicate's `=ref`
  fills in a missing ref). One kept repository is sent as an ordinary task
  (`workdir` + base ref, no `repositories`), so `--isolation none` on a plain
  folder still works; `--isolation none` with two or more repositories is a
  usage error. After create, the CLI fails with "core is too old" when a core
  dropped the `repositories` field (and tells the user to remove the task it
  made), and notes when the core merged selections that share a git root. An
  interactive `--issue` add matched from the current directory offers the
  other projects as "also work in" repositories, the issue's repository first.
  `show` prints the repository block with per-repository checkout drift,
  `shell [--repo <name>]` (works on single tasks too, and names the entry's
  branch), `rm` names each repository's own branch removals (and `--json`
  carries `repositories[]`), `ls` shows a count ("1 repo" for a multi task
  left with one), and the TUI `@` listing unions the scopes with prefixes
  (multi decided by `isMultiRepoTask`, so one named scope still gets the
  `<name>/` prefix). `agetor add` without `--start` runs the advisory `@`
  pre-check against the same per-repository scopes.
  `agetor edit <task> --remove-repo <name>` (repeatable) calls the removal
  route once per name, in the order given, after `--detach-profile` and before
  the PATCH of any other flag; each success prints
  `✓ removed repository <name> from <short id> (branch <branch> kept)` (names
  through `escapeControlChars`; `--json` prints only the final task), and the
  first refusal fails the command with the core's message.

## Intentional limits

- Repositories can't be added after creation; one can be removed (above), the
  last one never. 2+ at creation requires worktree isolation; no per-repo
  `existingBranch`; no per-repo branch configuration; one agent conversation,
  not one per repository.
- No hard cap on the repository count: a non-blocking warning above 10, and
  bounded batches for every per-repository fan-out (above). A very large
  selection is slow to prepare, not refused.
- An older build sees the workspace as `workdir`/`worktreePath` and may orphan
  secondary worktrees; the core has no downgrade guard. The CLI does detect an
  older core at create time (above), but an older app or core reading a
  multi row is not guarded. An older core also decides multi by count, so it
  reads a one-repository multi row as a single-repository task at the
  workspace root.
- Gemini gets no extra roots: its `--include-directories` /
  `context.includeDirectories` is not used, because the gemini CLI was not
  installed for this change and the flag's behavior under a non-git cwd is
  unverified. It runs through the workspace cwd only.
- A pipeline step's PR stamp stays on the step row; the parent's "Create all
  PRs" can retry that repository and show GitHub's 422 (owner decision,
  "Diff, status and PRs" above).
- Live harness smoke (2026-11-12, two fresh repositories, worktree
  isolation): claude-code, codex (first turn and a follow-up, both escalated
  to full access from the task's checkouts) and fx ran end to end and
  committed in each checkout; OpenCode 2.x (agetor-owned server, an OpenCode
  Go subscription model, after a first attempt hit an empty Zen balance) ran
  end to end at the non-git workspace directory, committed in each checkout and
  again on a follow-up turn through the same server session. Copilot was not
  run against a GitHub account (no login), but its real binary passed the
  opt-in multi-repo case with a fake provider, and a harness-stack failover of
  a multi task was not run. Cursor, Gemini and Antigravity were not run. Details:
  `docs/plans/multi-repo-tasks-smoke.md` ("Live harness smoke matrix").
