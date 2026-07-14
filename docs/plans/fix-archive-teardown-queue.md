# Plan — Deferred, serialized archive teardown (rapid multi-archive slowness)

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement follow-up on fix/cannot-reach-api — "requests queue getting crowded and slow when archiving multiple tasks one right after the other" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/cannot-reach-api |
| Base SHA | bd1ef73 (waves build on the toast fix) |
| Mode | **Autonomous** — grill/approval gates bypassed; assumptions in §8 |

## 1. Objective & success criteria

`POST /tasks/:id/archive` responds in milliseconds regardless of worktree size; archiving N tasks back-to-back never contends on git locks; archive→unarchive / archive→start / archive→delete races stay correct. Typecheck + full `bun test` green.

## 2. Context & constraints

- `archiveTask` (`src/bun/orchestrator.ts`) awaits, before responding: `dropSession`/`dropCodexSession` (blocking `Bun.spawnSync` tmux kill), `killTerminalsForTask`, `detachWorktree` (`git status` dirty check → `git worktree remove --force` → `git worktree prune` → async `rm` of the tree). Multi-second on real worktrees.
- Rapid successive archives: each POST waits its own teardown; concurrent teardowns of tasks in the same source repo contend on git's locks (`worktree remove`/`prune` mutate `.git/worktrees` + config) — detach is best-effort, so contention silently strands worktrees.
- `unarchiveTask` restores only when `!existsSync(worktreePath)`; `startTask` auto-unarchives and calls `prepareWorkdir`; `deleteTask` re-runs the same teardown shape then deletes the row. All three race a deferred teardown unless they await it.
- Teardown ordering is load-bearing: sessions/shells cwd'd inside the worktree must die before `git worktree remove` (documented at both call sites).
- Fleet rule: never enumerate-and-kill `agetor-*` tmux sessions; every kill must be keyed to a task id from this instance's own DB (prior incident entry 5af0b527). The boot sweep below respects this.
- Boot: `index.ts:120` calls `reconcileOrphans()` (sync).

## 3. Approach & key decisions

**Defer + serialize.** Archive flips the DB row and returns immediately; the heavy teardown runs in a background queue. One global FIFO chain serializes all teardowns (eliminates same-repo git-lock contention — simplest correct granularity; per-repo chains rejected as needless complexity for a single-user app). A `Map<taskId, Promise>` exposes per-task completion so the three racing operations can await it:

- `unarchiveTask` awaits the task's pending teardown before its `existsSync` restore check.
- `startTask` awaits it before `prepareWorkdir`.
- `deleteTask` routes its own teardown *through* the queue and still awaits it (DELETE semantics unchanged, but now serialized against in-flight archive teardowns).

**Crash/quit safety.** Previously `dropSession` ran synchronously inside the request, so quitting right after archiving couldn't leak a session. With deferral, quit-before-teardown leaks the tmux session and the worktree dir. Fix: a boot-time sweep — for every task in *our own DB* with `archivedAt != null && worktreePath && existsSync(worktreePath)`, enqueue the same teardown job. This also heals the pre-existing crash-mid-archive gap. Session kills remain keyed to own task ids.

Alternative considered: converting the tmux `spawnSync` kills to async — still recommended as a separate follow-up; inside the background queue their ~10ms stalls are acceptable.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| U1 | Teardown queue in orchestrator: `enqueueTeardown(taskId, job)` (global FIFO chain, errors warn-logged, per-task pending map), `pendingTeardown(taskId)` export; archiveTask returns immediately after row flip + enqueue; unarchive/start await pending; deleteTask teardown routed through queue (still awaited); `sweepArchivedTeardowns()` export; one-line call in index.ts after `reconcileOrphans()` | `src/bun/orchestrator.ts`, `src/bun/index.ts` | — | typecheck green; ordering (sessions→terminals→worktree) preserved inside the job |

## 5. Work breakdown — test tasks

| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| UT1 | New `src/bun/orchestrator-archive-teardown.test.ts`: archive returns before worktree gone + `pendingTeardown` resolves to removal; archive→unarchive restores the worktree; two same-repo tasks archived back-to-back both tear down cleanly; boot sweep removes a stranded archived worktree | `src/bun/orchestrator-archive-teardown.test.ts` | U1 |

## 6. Execution waves

Wave 1: U1 (single agent — one file owns the logic). Barrier: typecheck + commit. Wave 2: UT1 + code review (opus) in parallel (review is read-only). Then full suite + fixes.

## 7. Blast radius & risks

- Archive response no longer proves teardown happened — UI only reads `archivedAt`, unaffected. Disk reclaim is eventual.
- Quit with queued teardowns → healed at next boot by the sweep. Confirm-on-quit doesn't wait for the queue (acceptable: sessions/worktrees are recoverable state).
- `deleteTask` now waits behind earlier queued teardowns — slightly slower under burst, but correct and lock-safe.
- `unarchive` under a burst waits for the whole chain up to its task — bounded by the burst the user just created.
- Global chain means one wedged git op delays later teardowns; existing `git()` timeouts bound each step.

## 8. Open questions / assumptions (autonomous mode)

1. **Assumed** eventual disk reclaim is acceptable (archive returns before the worktree is removed).
2. **Assumed** a single global teardown chain (not per-repo) is the right granularity for a single-user app.
3. **Assumed** the boot sweep enqueuing kills keyed to own archived task ids is compatible with the shared-tmux-socket safety rule (it is keyed, never enumerated).
4. tmux `spawnSync`→async conversion remains out of scope (tracked follow-up).
