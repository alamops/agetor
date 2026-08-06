# Plan — Orphan-prune queue routing + live git staleness signals

| Field | Value |
| --- | --- |
| Date | 2026-07-17 |
| Source | /implement task: "routing the orphan-delete prune through the teardown queue, and optional live git dirty/ahead/merged staleness signals (kept out of the bulk list to avoid a subprocess fan-out per poll)" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/stale-worktrees |
| Base SHA | 7982137 |
| Mode | Interactive — grill answered by owner (merged-target + surface); proceeding to implement |

## 1. Objective & success criteria

Two follow-ups to the Worktrees page:

1. **Orphan-prune through the queue** — `deleteOrphanWorktree`'s `rm` + `git worktree prune` must run on the per-source-repo teardown FIFO (`enqueueTeardown`), like `deleteTask`, so an orphan cleanup can't contend on git's `.git/worktrees/.lock` with a concurrent same-repo archive/delete. Error reporting to the caller is preserved.
2. **Live git signals** — an on-demand, per-worktree `{ dirty, ahead, merged, ignored }` status (NOT in the bulk `GET /worktrees` poll — that stays fs+DB-only). The Worktrees page auto-fetches these for its rows on open/refresh with a bounded concurrency cap (~5) and shows dirty / ahead / merged badges.

Success: `bun run typecheck` green, `bun test` green including new backend tests for the merged helper, the per-worktree git-status resolution/confinement, and the queued orphan prune.

## 2. Context & constraints (from investigation)

- `enqueueTeardown(taskId, key, job)` (`orchestrator.ts:167-190`) chains `job` onto a per-`key` FIFO; `key` is the source `workdir` (git lock domain). It **swallows job errors** (`.catch` logs, the returned promise still resolves) — so to keep returning `{ error }` on a failed `rm`, the job must record success/failure into a closure the caller reads after awaiting.
- `deleteOrphanWorktree` (`orchestrator.ts:2128-2171`) currently: validates id + confinement (`basename(dirPath) === id`), refuses live task ids, `await pendingTeardown(id)`, parses `sourceRoot` from the `.git` pointer, `rm`s the dir, then calls `pruneWorktrees(sourceRoot)` **directly** (line 2168) — the bit to move onto the queue.
- Git helpers in `worktree.ts`: `hasUncommittedChanges(dir)` → `boolean|null` (`:63`), `getAheadCount(dir, baseRef)` → `number|null` (`:91`), the private `git()` wrapper (`:31`, 30s timeout, non-throwing). **No "merged" helper exists** (grep confirmed) — must be built.
- Existing on-demand pattern: `GET /tasks/:id/git-status` (`server.ts:3280`) returns `{ hasChanges, ahead, ignored }`, composing the two helpers with `Promise.all`; client `api.getTaskGitStatus` (`api.ts:1069`). The new per-worktree endpoint mirrors this shape + adds `merged`.
- `listWorktrees` id == dir basename == task id; a worktree shares the source repo's refs via its common git dir, so `origin/HEAD`/`main`/`master` and `merge-base --is-ancestor` all resolve correctly with `cwd` = the worktree dir.
- `WorktreesDialog.tsx` (458 lines) already has `worktrees: WorktreeInfo[]` state, per-row rendering (`sorted.map`, badges at ~:411-431), `busyIds`, refresh, and filters/sort — the git-status cache + badges slot into the existing row.
- Test conventions: `worktrees-list.test.ts` / `orchestrator-archive-teardown.test.ts` — top-level `AGETOR_DATA_DIR` mkdtemp, fake-driver env, local `makeRepo()`, dynamic imports, `finally` cleanup.

## 3. Approach & key decisions

**Merged semantics** (owner-chosen): `merged` = is the worktree's `HEAD` an ancestor of the **source repo's default branch**. Resolve default via `git rev-parse --abbrev-ref origin/HEAD` → else first of `main`/`master` that exists (`git show-ref --verify --quiet refs/heads/<b>`) → else null (merged reported as `null`/unknown, never a false "merged"). Then `git merge-base --is-ancestor HEAD <default>`: exit 0 → `true`, exit 1 → `false`, other → `null`. Runs with `cwd` = the worktree dir.

**On-demand endpoint**: new `orchestrator.worktreeGitStatus(id)` centralizes dir/baseRef resolution + the same `basename(dirPath) === id` confinement as `deleteOrphanWorktree` (factor the confinement into a small local `resolveWorktreeDir(id)` helper shared by both, so the guard can't drift). For a task-backed id → the task's `worktreePath ?? workdir` + `task.baseRef`; for an orphan id → `join(WORKTREES_DIR, id)` + `baseRef = null`. Composes `hasUncommittedChanges` + `getAheadCount` + the new `isMergedIntoDefaultBranch`. Route: `GET /worktrees/:id/git-status` → `{ dirty, ahead, merged, ignored }` (`ignored: true` when the dir isn't inspectable, mirroring the task endpoint; on ignored we skip ahead/merged).

**Queued prune**: `deleteOrphanWorktree` keeps the id-validation + live-task refusal + `await pendingTeardown(id)` up front, then wraps **both** the `rm` and the `prune` in one `enqueueTeardown(id, sourceRoot ?? dirPath, job)` and awaits it. The job records `{ ok }` / `{ error }` into a closure var; the function returns that after the await, so error reporting is unchanged. Keying by `sourceRoot` puts the prune on the same FIFO as that repo's archive/delete teardowns (the whole point); when the source repo is unknowable (`sourceRoot` null) there's no shared lock domain, so key by `dirPath` (a private chain — behaves like today).

**Frontend auto-fetch**: on open and on Refresh, kick a bounded-concurrency (cap 5) pool that fetches `getWorktreeGitStatus(w.id)` for every worktree in the current list, storing results in a `Map<id, WorktreeGitStatus | { loading: true }>` keyed also by a refresh nonce so Refresh re-runs. Rows render dirty / ahead / merged badges (or a small spinner while loading, nothing on `ignored`). Fetching the full loaded list (not visibility-tracked) is simpler and equivalent here — the list is the whole on-disk worktree set, already small by construction.

**Alternatives considered**: (a) merged vs the pinned `baseRef` — rejected by owner (always "not merged"); (b) putting git signals in the bulk `GET /worktrees` — rejected by the task itself (subprocess fan-out per 5s poll); (c) per-row manual "Check git" button — owner chose auto-fetch instead; (d) reusing `/tasks/:id/git-status` — rejected: it's task-only (no orphans) and lacks `merged`.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Backend: `WorktreeGitStatus` type; `isMergedIntoDefaultBranch` helper; `worktreeGitStatus(id)` + shared `resolveWorktreeDir(id)` confinement; route `GET /worktrees/:id/git-status`; move `deleteOrphanWorktree` rm+prune onto `enqueueTeardown` preserving error return | `src/shared/types.ts`, `src/bun/worktree.ts`, `src/bun/orchestrator.ts`, `src/bun/server.ts` | — | Endpoint returns dirty/ahead/merged/ignored; prune runs on the FIFO; error paths intact |
| T2 | Frontend: `api.getWorktreeGitStatus`; auto-fetch pool (cap 5) on open/refresh; dirty/ahead/merged badges + per-row loading in `WorktreesDialog` | `src/mainview/lib/api.ts`, `src/mainview/components/worktrees/WorktreesDialog.tsx` | T1 contract (fixed in brief) | Badges appear per row after open; bounded fan-out; no refetch storm on filter/sort |

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| TT1 | Backend tests: `isMergedIntoDefaultBranch` (fresh worktree at main tip → merged; +1 commit → not merged; default-branch resolution main/master); `worktreeGitStatus` (clean vs dirty; ahead count; orphan dir; `.`-confinement → error, not a crash); `deleteOrphanWorktree` still ok + dir gone with prune now queued (happy path + a concurrent same-repo teardown both settle) | `src/bun/worktree-git-status.test.ts` (new) | T1 |

## 6. Execution waves

- **Wave 1**: T1 + T2 in parallel (disjoint files; T2 imports the `WorktreeGitStatus` type T1 adds — contract fixed in both briefs; typecheck at the barrier).
- **Wave 2**: TT1 (after review).

## 7. Blast radius & risks

- `deleteOrphanWorktree` behavior must stay identical from the caller's view (still returns `{ ok } | { error }`) — the closure-captured result is the load-bearing detail; covered by the existing orphan-delete tests plus TT1.
- New git subprocesses are **on-demand only** — the 5s bulk poll stays fs+DB-only (unchanged). Per-open fan-out is capped at 5 concurrent and bounded by the (small) worktree count.
- `merged` never false-positives: unknown default branch or a git error → `null`, rendered as "unknown", never "merged".
- No teardown-ordering change for archive/delete; no tmux enumeration; `pendingTeardown` await retained.

## 8. Open questions / assumptions

1. **Auto-fetch scope**: fetch for the full loaded worktree list on open/refresh (cap 5), not literal viewport-visibility tracking — equivalent here since the list is the whole on-disk set, and it avoids refetch churn when filtering/sorting. (Assumption; trivially narrowable later.)
2. **Merged for orphans**: computed the same way (refs reachable via the `.git` pointer's common dir); `null` if the pointer/refs can't be resolved.
3. **`ahead` for orphans**: `baseRef` is null → `getAheadCount` returns its unknown-but-not-blocking `0`. Acceptable; the dirty/merged badges carry the signal.
