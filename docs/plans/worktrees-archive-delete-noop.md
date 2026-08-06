# Plan — Worktrees page "Archive & delete" actually deletes

| Field | Value |
| --- | --- |
| Date | 2026-07-28 |
| Source | Bug report: "archive and delete button on the new stale modal seems to not be working… the worktree seems to not be cleaned up and the list doesn't refresh… not sure if it's because the task is already archived but not clean up" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | `fix/archive-and-delete-seems-to-not-be-worki` |
| Base SHA | `ce9177b34816982f2aeebbba15fefb8dde8bd827` (clean tree) |

## 1. Objective & success criteria

Clicking the trash icon on a **task-backed** row in the Worktrees dialog and confirming must, in every case:

1. Actually remove the worktree directory from disk — including when the task is **already archived** (today's headline failure) and when the checkout is **dirty**.
2. Keep the spinner up until removal has genuinely finished, then drop the row from the list on the very next refresh.
3. Tell the user when it *didn't* work, and why.
4. Warn **before** destroying uncommitted work, and never destroy the branch or the run/AI history.

Success = the reporter's existing stuck rows clear on one click, with no migration or one-off script.

## 2. Context & constraints (grounded)

Three independent defects compound into the reported symptom.

**D1 — already-archived is a total no-op.** `src/bun/orchestrator.ts:2003-2005`:

```ts
if (task.archivedAt != null) {
  return { task };            // returns BEFORE the enqueueTeardown at :2024
}
```

`listWorktrees` flags exactly this state as `staleReasons: ["archived"]` (`orchestrator.ts:2202`), rendered as *"archived, not cleaned up"* (`WorktreesDialog.tsx:49`). So the one row the page most wants you to clean is the one row the button cannot clean. The server returns `200` with the unchanged task (`server.ts:3120-3134`), the client refreshes, nothing has changed.

**D2 — a dirty worktree can never be detached.** `src/bun/worktree.ts:946-947`:

```ts
const dirty = await hasUncommittedChanges(task.worktreePath);
if (dirty !== false) return { removed: false, reason: "dirty" };
```

`hasUncommittedChanges` returns `boolean | null`, with `null` on missing dir / non-repo / failing `git status` (`worktree.ts:63-69`) — and `null !== false`, so **git errors are treated as dirty too**. `sweepArchivedTeardowns` (`orchestrator.ts:2132-2153`, called from `index.ts:126`) re-enqueues these every boot and they fail identically every boot, forever, with only a `console.warn` inside `enqueueTeardown`'s catch (`orchestrator.ts:184-186`). There is no force path from this page: `removeWorktree` does force (`worktree.ts:880-904`) but is only reachable via `deleteTask`, and `deleteOrphanWorktree` hard-refuses task-owned ids (`orchestrator.ts:2278-2280`).

**D3 — the outcome is computed, then discarded; the refresh races the teardown.** `detachWorktree` returns `{ removed, reason }` but both call sites drop it (`orchestrator.ts:2034`, `orchestrator.ts:2148`). Teardown is intentionally deferred and fire-and-forget (`void enqueueTeardown`, knowledge `7a0e88ac`), so `WorktreesDialog.tsx:288`'s `await refresh()` runs *before* removal completes — even on the happy path the row lingers until the 5s poll (`POLL_MS`, `WorktreesDialog.tsx:34`).

**Constraints that must survive the fix:**

- The per-workdir teardown queue is load-bearing (knowledge `7a0e88ac`): chains keyed by `task.workdir` keep same-repo `git worktree remove`/`prune` FIFO-serialized against git's locks. **Do not bypass `enqueueTeardown`.** Any new awaiting path routes *through* the queue, exactly as `deleteTask` (`orchestrator.ts:2095`) and `deleteOrphanWorktree` (`orchestrator.ts:2308`) already do.
- `enqueueTeardown` swallows job errors so the chain never breaks — the established idiom for getting a result out is a **closure-captured variable** read after awaiting the enqueued promise (`deleteOrphanWorktree`, per knowledge `a8549bc4`). Use that; don't change `enqueueTeardown`'s error contract.
- Archive semantics are *detach, not destroy*: the branch, commits, `runs`/`run_events`, and claude's JSONL transcript all survive so unarchive can rematerialize (`orchestrator.ts:1954-1964`, `unarchiveTask` at `:2058-2067`). **Force must discard only the uncommitted working tree — never `git branch -D`.**
- Teardown ordering inside a job is load-bearing: sessions/terminals cwd'd in the worktree die before `git worktree remove` (`orchestrator.ts:2028-2034`).
- The kanban archive button (`App.tsx:499-521`) must keep its fast fire-and-forget behavior. Only this explicit cleanup action opts into waiting.

## 3. Approach & key decisions

Owner decisions from the Phase 2 grill (all three as recommended):

| Decision | Choice |
| --- | --- |
| Dirty worktrees | **Warn in the dialog, then force.** Pre-fetch git status for the row, surface an explicit "uncommitted changes will be discarded" warning in the confirm, force on confirm. |
| Sync vs async | **Await and report.** Opt-in `awaitTeardown` flag on the archive route; spinner holds; response carries the detach outcome. |
| Backfill | **The fixed button clears them.** Fixing D1 is sufficient; no migration, no boot-time auto-force. |

Key design calls:

- **`detachWorktree(task, opts?: { force?: boolean })`** — `force` skips the `hasUncommittedChanges` gate only. It reuses the same `git worktree remove --force` + `prune` + confined `rm -rf` body, and still deliberately omits `git branch -D`. This keeps one code path rather than routing archive through `removeWorktree` (which *does* delete the branch and would break unarchive).
- **Re-enqueue on already-archived rather than early-returning.** `archiveTask` gains a shared `enqueueArchiveTeardown(task, { force })` helper, called from both the fresh-archive and the already-archived branches — and reused by `sweepArchivedTeardowns` so the three call sites can't drift. The already-archived branch only enqueues when the worktree is still on disk (the exact condition the boot sweep already uses, `orchestrator.ts:2140`), so an ordinary repeat-archive stays a cheap no-op.
- **Result plumbing via closure capture**, matching `deleteOrphanWorktree`. `archiveTask` returns `{ task, teardown? }` where `teardown` is only populated when `awaitTeardown` was requested.
- **`reason` triage on the client**: `"already-absent"` and `"no-worktree"` mean *nothing to remove* — treat as success, not failure. Only a genuinely failed removal toasts.
- **Rejected:** adding a new `WorktreeStaleReason` (e.g. `archived-dirty`). With force always available the dirty state is no longer a dead end, and the toast covers the residual failures — a new union member would ripple through `listWorktrees`, the shared types, the filter UI, and its tests for little gain.
- **Rejected:** auto-forcing in `sweepArchivedTeardowns`. Discarding uncommitted work with no human in the loop, at boot, is not a trade the owner asked for.

I write `src/shared/types.ts` myself before the fan-out, so the two implementation agents have a fixed contract and disjoint file sets.

## 4. Work breakdown — implementation tasks

**T0 (orchestrator, inline before the fan-out) — shared contract.**
Owns `src/shared/types.ts`. Adds:

```ts
/** Outcome of the worktree teardown an archive triggered … */
export interface WorktreeTeardownResult {
  removed: boolean;
  reason?: "dirty" | "no-worktree" | "already-absent" | "failed";
}
```

**T1 — backend: force detach, re-enqueue, await, report.**
Owns `src/bun/worktree.ts`, `src/bun/orchestrator.ts`, `src/bun/server.ts`.

- `detachWorktree(task, opts?: { force?: boolean })` — `force: true` skips the dirty gate; everything else unchanged; still no `git branch -D`.
- Extract `enqueueArchiveTeardown(task, opts)` from `archiveTask`'s existing deferred job; reuse in `sweepArchivedTeardowns`.
- `archiveTask(taskId, { force?, stopRun?, forceWorktree?, awaitTeardown? })` → `{ task, teardown? } | { error }`:
  - already-archived + `worktreePath` still on disk → enqueue teardown instead of bare-returning.
  - `awaitTeardown` → await the enqueued promise, return the closure-captured `WorktreeTeardownResult`.
  - `forceWorktree` → threaded to `detachWorktree`.
- `POST /tasks/:id/archive` parses `forceWorktree`/`awaitTeardown` off the body (same `=== true` idiom as `force`/`stopRun`, `server.ts:3122`), returns `{ ...task, teardown }`-shaped payload without breaking existing callers. Route needs `server.timeout(req, 0)` like `DELETE /tasks/:id` (`server.ts:3100-3107`) since it can now block on a real `git worktree remove`.

*Acceptance:* archiving an already-archived task with a live worktree removes the directory; a dirty worktree survives without `forceWorktree` and is removed with it; the branch survives both; `awaitTeardown` responses carry a truthful `removed`.

**T2 — client: warn, force, await, report.**
Owns `src/mainview/lib/api.ts`, `src/mainview/components/worktrees/WorktreesDialog.tsx`.

- `api.archiveTask(id, opts)` gains `forceWorktree`/`awaitTeardown`; return type carries optional `teardown`.
- `deleteTaskBacked`: fetch `api.getWorktreeGitStatus(w.id)` fresh before the confirm (the cached `gitStatus` map may be `"loading"`/absent); when `dirty && !ignored`, add a prominent warning to the confirm description and switch the confirm label to reflect discarding changes.
- Call with `{ force: true, stopRun: true, forceWorktree: true, awaitTeardown: true }`; keep `withBusy` up for the whole await.
- On `teardown.removed === false` with a real failure reason → `toast.error` naming the branch and reason. `already-absent`/`no-worktree` → silent success.
- Add `await refresh()` to the catch branch, matching `App.tsx:517-519`.
- Fix the confirm copy for an already-archived row: it currently promises the ticket "will be **archived**" when it already is.

*Acceptance:* one click clears a stuck archived row; a dirty row shows the warning first; a failure toasts instead of silently refreshing.

## 5. Work breakdown — test tasks

**T3 — backend tests.** Owns `src/bun/orchestrator-archive-teardown.test.ts`, `src/bun/worktree.test.ts`. Covers T1:
- `archiveTask` on an already-archived task with the worktree still on disk enqueues teardown and removes it (the regression test for D1).
- Repeat-archive with the worktree already gone stays a no-op (no spurious enqueue).
- `detachWorktree(task, { force: true })` removes a dirty worktree; the branch and its commits survive; without `force` the existing `{ removed: false, reason: "dirty" }` behavior is unchanged.
- `awaitTeardown: true` resolves only after the directory is gone and reports `removed: true`; the dirty-without-force path reports `removed: false, reason: "dirty"`.
- Steady-state regression: archive → dirty skip → `sweepArchivedTeardowns` → still stuck → explicit force clears it.

Setup idiom is fixed by the existing files: `process.env.AGETOR_DATA_DIR = mkdtempSync(...)` at **module top-level** before importing `db.ts`, and a throwaway `makeRepo()` git repo — never `process.cwd()`.

**T4 — client-logic tests.** Owns `src/mainview/components/worktrees/worktree-delete-intent.ts` + `.test.ts`. There are **zero** `.test.tsx` files in this app; the house pattern is to extract pure logic beside the component and unit-test that (`github-dialog-view.test.ts`). Extract the two decisions worth testing — confirm-copy/warning selection from `(WorktreeInfo, WorktreeGitStatus | null)`, and outcome triage from `WorktreeTeardownResult` → `silent | error(message)` — and test those.

## 6. Execution waves

- **Wave 0 (inline, me):** T0 — `src/shared/types.ts`.
- **Wave 1 (parallel, 2 agents):** T1 (bun) ‖ T2 (mainview). Disjoint files, contract fixed by T0.
- **Barrier:** typecheck + commit.
- **Wave 2:** code review of `ce9177b…HEAD`.
- **Wave 3 (parallel, 2 agents):** T3 ‖ T4. Disjoint files.
- **Wave 4:** run suite; fix to green.

T2 lands `worktree-delete-intent.ts`'s *usage*; T4 lands the file itself and its test — so T2's brief must specify that module's exact exported signatures, and T4 must not touch `WorktreesDialog.tsx`. Alternative if that proves awkward: T2 owns both the module and its usage, T4 owns only the `.test.ts`.

## 7. Blast radius & risks

| Risk | Mitigation |
| --- | --- |
| `archiveTask`'s signature/return shape changes and it has other callers | Only two webview call sites (`App.tsx:499`, `WorktreesDialog.tsx:287`) plus tests. New opts are optional and default to today's behavior; `teardown` is an added field, so `{ task }` consumers are unaffected. |
| Re-enqueue on already-archived fires on every kanban archive | Gated on `worktreePath && existsSync(worktreePath)` — the same condition the boot sweep uses. Ordinary repeat-archive is still a bare return. |
| `awaitTeardown` blocks the HTTP request behind same-repo teardowns | Exactly the tradeoff `deleteTask` already makes (`orchestrator.ts:2095`, `server.ts:3100-3107` sets `server.timeout(req, 0)`). Opt-in only; the kanban path stays async. |
| Force destroys uncommitted work | Requires an explicit confirm carrying a fresh, per-row git-status warning. Branch + commits + run history untouched. |
| Bypassing `enqueueTeardown` reintroduces the git-lock race | Explicitly forbidden in both agent briefs; the new path routes through the queue. |
| A `null` from `hasUncommittedChanges` (git error) now silently force-deletes | Force is only reachable from an explicit confirmed user action on this page, and only removes the checkout — the branch survives, so the work is recoverable. |

Rollback: revert the branch; no migration, no schema change, no persisted state.

## 8. Open questions / assumptions

- **Assumed** the confirm dialog is the right place for the dirty warning (rather than a second dialog) — follows directly from the owner's "warn in the dialog, then force" choice.
- **Assumed** `already-absent` / `no-worktree` count as success for toast purposes.
- **Assumed** the kanban archive button keeps fire-and-forget semantics; only the Worktrees page opts into `awaitTeardown`.
- **Not doing:** a new `WorktreeStaleReason`, boot-time auto-force, or any change to `enqueueTeardown`'s error-swallowing contract.
