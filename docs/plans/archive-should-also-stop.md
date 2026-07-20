# Plan — Archive stops the running agent (confirm → stop → archive)

| Field | Value |
| --- | --- |
| Date | 2026-07-20 |
| Source | /implement conversation — "archive should also stop the current agent, with a confirmation dialog" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/archive-should-also-stop |
| Base SHA | 7e1bf09ad55d990c2be38d36fba6a2a117ca13b9 |

## 1. Objective & success criteria

Archiving a task that has an in-flight agent run must no longer fail with the toast
`"task is still running — cancel the run before archiving"`. Instead:

- Every archive entry point that can hit a running task shows a **confirmation dialog** stating the agent will be stopped.
- On confirm, the server **stops the run** (kill active handle, cancel pending interactions; for the "held by background agents" state: interrupt session + orphan subagents) and **archives** in one call.
- Archive appears on **running/blocked** task cards and the run panel, not only Done — so the user never has to move/stop a ticket first just to archive it.
- Archiving without the stop flag on a running task still errors (server-side guard remains the backstop).

Success = new orchestrator tests green, full `bun test` + `bun run typecheck` green, all three entry points behave as above.

## 2. Context & constraints (Phase 1 findings)

- **Guard/toast source:** `src/bun/orchestrator.ts:1891-1893` — `if (task.runId && active.has(task.runId)) return { error: "task is still running — cancel the run before archiving" }`. Unconditional; `force` only bypasses the Done-column gate at `orchestrator.ts:1883-1885`.
- **Stop model:** `deleteTask` (`orchestrator.ts:1966-1998`) kills the active handle + `cancelPendingForTask(taskId, …)` before teardown. `cancelRun` (`orchestrator.ts:1184-1214`) additionally handles the **held-by-background-agents** state (no `active` handle): `cancelPendingForTask` + `interruptTaskSession(taskId)` + `orphanRunningSubagents(taskId)`. Peer knowledge entry (68504e80) confirms: never assume `active.get(task.runId)` exists for a card that looks busy — `isHeldByBackgroundAgents(taskId)` (`orchestrator.ts:320-325`) is the second running-ish state.
- **Cancel semantics:** marking every handle of the task `cancelled = true` before `.kill()` is what makes `attachDoneHandler` record `cancelled` (not `failed`) and settle the column to `ready` (`orchestrator.ts:984-988`). Post-archive column moves are invisible (UI keys off `archivedAt != null`) and actually desirable on unarchive (task reappears in `ready`).
- **Archive teardown is already deferred + serialized** (`enqueueTeardown`; docs/plans/fix-archive-teardown-queue.md) and drops tmux sessions anyway — the kill-before-archive step just makes the stop *deliberate and immediate*, with correct `cancelled` bookkeeping instead of a session yanked out from under a live run.
- **UI entry points today:** Archive button gated to `column === "done"` at `TaskCard.tsx:182-186` and `RunPanel.tsx:1173-1177`; App handler `archive()` at `App.tsx:497-508` (errors via custom `ErrorToast`). Worktrees page "Archive & delete" (`WorktreesDialog.tsx:267-292`) already calls `archiveTask(id, { force: true })` inside a `useConfirm()` dialog and surfaces errors via sonner `toast.error` — this is the path that produces today's toast on a running task.
- **Confirm primitive:** `src/mainview/components/ui/confirm.tsx` (`useConfirm()` + provider), already used by `del()` in `App.tsx:520-538` and by WorktreesDialog.
- **Tests:** `src/bun/orchestrator-archive-teardown.test.ts` is the model (temp `AGETOR_DATA_DIR`, `isolation: "none"` or temp git repo, dynamic import of orchestrator).

## 3. Approach & key decisions

1. **Server API: add `stopRun?: boolean` to `archiveTask` opts** (and the `POST /tasks/:id/archive` body). Chosen over "UI calls `/runs/:id/cancel` then archives" because cancel→archive from the client is racy (cancel is async; the archive guard would still see the active handle) and `deleteTask` already proves the kill-inline-then-teardown shape works.
2. **`stopRun` covers both running states.** With `stopRun: true`:
   - active handle: mark all of the task's handles `cancelled = true`, `cancelPendingForTask`, `kill()` (mirrors `cancelRun`'s active branch);
   - held-by-bg-agents: `cancelPendingForTask` + `interruptTaskSession` + `orphanRunningSubagents` (mirrors `cancelRun`'s held branch). Prefer factoring a small `stopTaskRun(taskId)` helper (or reuse `cancelRun(task.runId)`) so archive and Stop can't drift.
   - neither state (nothing to stop): proceed to archive normally — `stopRun` is then a no-op, not an error.
3. **Column gate untouched; new UI paths send `force: true` + `stopRun: true`.** `force` already means "archive from a non-Done column" (Worktrees uses it). The board's running-card archive sends both after confirmation. The Done-column archive path is completely unchanged.
4. **Without `stopRun`, the running guard stays** (same error string) — backstop against un-confirmed archives from stale clients.
5. **Confirmation lives in the UI** (per request): running/blocked archive always confirms via `useConfirm()` with destructive variant and copy like *"An agent is still working on this task. Archiving will stop it."* Worktrees' existing confirm gets that sentence appended when `runActive`.
6. **Post-kill settling is left async.** Archive stamps `archivedAt` immediately after issuing the stop; `attachDoneHandler` later records the run `cancelled` and parks the column at `ready` under the archive — harmless while archived, correct on unarchive. No new waiting/polling.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | `archiveTask` gains `stopRun`: stop active/held runs (cancelled-flag + kill / interrupt + orphan + cancelPending), keep guard when absent; `server.ts` archive route parses `stopRun` from body | `src/bun/orchestrator.ts`, `src/bun/server.ts` | — | Running task + `stopRun` archives with run→`cancelled`; without `stopRun` returns the existing error; held task + `stopRun` interrupts + orphans then archives |
| I2 | Webview: `api.archiveTask(id, opts)` carries `stopRun`; App `archive()` confirms + passes `{force,stopRun}` for running/blocked tasks; Archive shown on running/blocked in TaskCard + RunPanel; Worktrees confirm mentions the stop and passes `stopRun` | `src/mainview/lib/api.ts`, `src/mainview/App.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/worktrees/WorktreesDialog.tsx` | contract from I1 (field name `stopRun`, fixed here) | Archive visible on running card/panel; confirm dialog precedes it; Worktrees "Archive & delete" on a running task no longer errors |

Both tasks are file-disjoint → one wave, two agents.

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| T1 | Orchestrator tests: (a) running + no `stopRun` → error unchanged; (b) running + `stopRun` → handle killed, cancelled flag set, pending interactions cancelled, `archivedAt` set; (c) held-by-bg-agents + `stopRun` → interrupt/orphan invoked, archived; (d) `stopRun` on an idle task → plain archive | new `src/bun/orchestrator-archive-stop.test.ts` (mirror setup of `orchestrator-archive-teardown.test.ts`; fake driver / injected setters per `claude-subagents.test.ts` idiom) | I1 |

UI changes are covered by typecheck + existing patterns (no webview test harness in repo).

## 6. Execution waves

- **Wave 1:** I1 ∥ I2 (disjoint files; contract pinned in §3).
- **Barrier**, then Phase 5 review (opus) on `git diff 7e1bf09...HEAD`.
- **Wave 2:** T1 (single agent), then run `bun test` + `bun run typecheck` (haiku), fix loop if needed.

## 7. Blast radius & risks

- `archiveTask` callers: archive route only. `force` semantics unchanged → Worktrees existing calls keep working even before I2 lands.
- Killing the handle sets `cancelled` → `attachDoneHandler` path already exercised by `cancelRun`; the only new interleaving is "task already archived when the done-handler fires" — column write is cosmetic under archive (UI filters on `archivedAt`), and unarchive→`ready` is sensible. Watch that the done-handler doesn't null out anything unarchive depends on (it clears `runId`; unarchive doesn't need it).
- `enqueueTeardown` runs after the kill; `dropSession` on an already-killed session is idempotent (guarded by `sessionExists`).
- Codex: one-shot turn — active handle kill covers mid-turn; between turns there's no session and `stopRun` is a no-op. No codex-specific branch needed.
- Stale/older webview build calling archive without `stopRun` on a running task: still gets the guard error — no behavior regression.

## 8. Open questions / assumptions

- Confirm-dialog copy finalized by I2 within the stated intent (title `Archive "<title>"?`, destructive confirm label "Stop & archive").
- Blocked-column tasks usually have no active run; archive from blocked simply confirms and archives (stop is a no-op). Accepted.
- Board archive confirmation is only added for running/blocked tasks; Done-column archive stays one-click as today.
