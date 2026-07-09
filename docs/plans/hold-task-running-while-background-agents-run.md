# Plan — Hold a task in `running` while its background agents are still running

| Field | Value |
| --- | --- |
| Date | 2026-07-09 |
| Source | `/implement` — "if the task has bg tasks running, keep the task in `running`, don't consider it as done moving to review column as is happening today" |
| Config | AGENTS_CONFIG.yml (balanced; `implementation` overridden to `opus` for T4 per `allow_orchestrator_override`) |
| Branch | `agetor/d12b32ddc722-bg-tasks-keep-task-running` (already a feature branch — no new branch) |
| Base SHA | `5df9a2ee26a150ee9ac398d3ac3d7be16b97b742` (tree clean at start) |

## 1. Objective & success criteria

When a claude-code task's main turn ends with `end_turn` but the session still has
**background/sub agents in flight**, the task card must stay in `running` instead of
jumping to `review`. It moves to `review` only once the last background agent finishes.

Success criteria:

1. Main turn succeeds + ≥1 `subagents` row for the task has `status='running'` → task stays `column='running'`; the run row is still recorded `succeeded`.
2. The last background agent completing flips the task `running → review` automatically, emitting the usual `column` GlobalEvent.
3. Main turn succeeds + no running subagents → unchanged behavior (`review` immediately).
4. Codex tasks are entirely unaffected.
5. `cancelled → ready` and `apiError`/`sessionDied → blocked` still win outright, even with subagents running.
6. A task can never be stranded in `running`: session death, session disposal, and boot reconciliation all release the hold.
7. The board card shows a "N background agents" badge while any subagent is running.

## 2. Context & constraints (grounded findings)

- **The single choke point** is `attachDoneHandler` (`src/bun/orchestrator.ts:611-665`). Its `.then()` computes
  `nextColumn = wasCancelled ? "ready" : (wasApiError||wasSessionDied) ? "blocked" : newStatus === "succeeded" ? "review" : "ready"` (`orchestrator.ts:647-650`) and calls `updateColumn` (`orchestrator.ts:158-170`). Both drivers (`claude-tmux.ts` `popEndOfTurn:1395`, `codex-tmux.ts` `resolveCodexDone:329`) feed the same `agent.done` promise. Neither driver knows about columns.
- **Subagent state already exists.** `claude-subagents.ts` tails `<sessionId>/subagents/agent-<id>.jsonl` and persists rows in the `subagents` table (`migrations/022_subagents.sql`, `db.ts:657-685`). `SubagentStatus` (`shared/types.ts:712-717`) is `running | completed | failed | cancelled | orphaned`, but **only `running` and `completed` are ever written** — the other three are dead states.
- **Finish detection** is `checkDone` (`claude-subagents.ts:330-339`): `sawEndOfTurn && now - lastAppendAt > DONE_IDLE_MS (1500)` → `completed` + `emitLifecycle(fs, "finished")`.
- **Codex writes no subagent rows** (`grep subagent src/bun/codex-tmux.ts` → 0 hits). A gate keyed on the `subagents` table is inert for codex by construction — no `kind` special-casing needed.
- **`claude-subagents.ts` must not import `orchestrator.ts`** (documented cycle avoidance at `claude-subagents.ts:65-70`). The existing escape hatch is the injected `setSubagentEmitter` sink (`claude-subagents.ts:72-74`, registered at `orchestrator.ts:115`). We follow that exact pattern for the release hook.
- **The watcher is armed on `SessionState`** (`claude-tmux.ts:2774-2775`, inside `attachTailer`) and detached by `disposeSessionState` (`claude-tmux.ts:3592-3593`) and `signalSessionDeath` (`claude-tmux.ts:2705-2706`). `detach()` deliberately touches no tmux and no DB.
- **Sync vs async subagents are indistinguishable today** — `isAsync` / `run_in_background` / `async_launched` are parsed nowhere in `src/`. Per owner decision we gate on *any* running row (see §3).
- **Test gotcha (fleet knowledge, verified 2026-06-30):** `bun test` runs every `*.test.ts` in one process sharing one SQLite DB, and `reconcileOrphans` scans `runs WHERE status='running'` **globally**. A new test that leaves a `running` run row passes alone but breaks `reconcile.test.ts` in the full run. **Seed runs as `status:'succeeded'` with `endedAt` set.**

## 3. Approach & key decisions

**Derive the hold from DB state; never from an in-memory map.** A task is "held" iff:

```
task.column === 'running'
  && task.runId != null
  && runs.get(task.runId).status === 'succeeded'
  && subagents.hasRunning(task.id)
```

This makes the release check a pure, idempotent function of persisted state — restart-safe, and immune to the settle-vs-completion ordering race (whichever of the gate and the hook runs second observes consistent state and does the right thing).

Owner decisions taken in Phase 2:

| Question | Decision | Consequence |
| --- | --- | --- |
| Stuck guard | **Release on session death / detach**, no watchdog timeout | `signalSessionDeath` + `disposeSessionState` + boot reconcile orphan any still-`running` rows. A wedged-but-alive bg agent still holds — accepted. |
| Which subagents | **Any `status='running'` row** | No new parsing of claude's internal, version-unstable JSONL shape. Sync `Task` subagents block the parent's `end_turn` inline, so they're rarely running at settle time; when the 1500ms-vs-800ms race does bite, the hook releases within ~700ms. |
| Other outcomes | **Only gate `succeeded → review`** | `cancelled → ready` and `apiError`/`sessionDied → blocked` unchanged — those need attention now and must not hide behind a churning bg agent. |
| UI scope | **Badge on the card** | `GET /tasks` gains a derived `runningSubagents` count; `TaskCard` renders a pill. |

**Alternatives rejected:**
- *Reuse `holdUntilIdle` (`claude-tmux.ts:1181-1188`).* Its contract is "wait for the session to go JSONL-idle, then fire" — exactly wrong here, since a background agent can run for minutes while the main session is silent. It also self-clears inside `popEndOfTurn`, the very function we'd be gating.
- *Gate inside the driver (`popEndOfTurn`).* Would make the turn never resolve, stranding the run row in `running` and breaking follow-up turns. The run genuinely succeeded; only the **column** should wait.
- *An in-memory `deferredReview` map in the orchestrator.* Lost on restart, and needs careful invalidation. The DB-derived predicate above is strictly simpler.
- *Parse `run_in_background` to hold only for async agents.* Couples us to an internal format claude's own docs warn is version-unstable, for a race that self-heals in under a second.

**Double-attach hazard.** The boot pass may want to arm a subagent watcher for a task that has no `SessionState` (its run already `succeeded`, so `reattachSession` skips it). Two live watchers on one task would double-emit over SSE (the `(run_id, line_uuid)` partial unique index blocks the DB dupes, but not the emit). Fix: `attachSubagentWatcher` keeps a module-level `Map<taskId, handle>` and detaches any prior handle for the same task before returning a new one. This makes double-attach structurally impossible for *both* callers.

## 4. Work breakdown — implementation tasks

All six tasks own **disjoint files** and run in **one wave**. Contracts below are exact so agents can compile against each other's not-yet-written code.

---

### T1 — Shared types + DB helpers
**Owns:** `src/shared/types.ts`, `src/bun/db.ts`
**Goal:** add the derived `Task.runningSubagents` field and the three `subagents` queries the rest of the change needs.

Contract to expose:
```ts
// shared/types.ts — on the Task interface. Server-derived, never persisted,
// never patchable (it is not a column, so PATCH's allow-list is unaffected).
/** Count of this task's subagents currently `status:"running"`. Derived per
 *  request by the server; absent on payloads that don't join the subagents table. */
runningSubagents?: number;

// db.ts — on the exported `subagents` object
hasRunning(taskId: string): boolean;
/** Flip every `running` row for this task to `orphaned` (endedAt = now).
 *  Returns the affected rows so the caller can emit `finished` lifecycle events. */
orphanRunning(taskId: string, now: number): Subagent[];
/** taskId → count of `running` rows. One grouped query for the board poll. */
runningCountsByTask(): Map<string, number>;
```
**Acceptance:** `bun run typecheck` clean; `hasRunning` returns `false` for an unknown task id; `orphanRunning` is a no-op returning `[]` when nothing is running.

---

### T2 — Subagent watcher: registry, orphaning, settle hook
**Owns:** `src/bun/claude-subagents.ts`
**Goal:** let the orchestrator learn when a task's last subagent finishes, and give session teardown a way to release the hold — without importing `orchestrator.ts`.

1. **Settle hook**, mirroring `setSubagentEmitter` exactly:
   ```ts
   let settleFn: ((taskId: string) => void) | null = null;
   export function setSubagentSettleHook(fn: ((taskId: string) => void) | null): void { settleFn = fn; }
   ```
   Call `settleFn?.(taskId)` **after** each `emitLifecycle(fs, "finished")` in `checkDone` (`claude-subagents.ts:330-339`), i.e. after the DB write, so the orchestrator's predicate reads fresh state.
2. **`orphanRunningSubagents(taskId: string): void`** — new export. Calls `subagentsDb.orphanRunning(taskId, Date.now())`, emits a `finished` lifecycle event per affected row, then `settleFn?.(taskId)`. Must be safe to call for a task with no watcher and no rows. It must **not** touch tmux.
3. **Module-level watcher registry.** `const watchers = new Map<string, SubagentWatcherHandle>()`. `attachSubagentWatcher` detaches + deletes any existing handle for `taskId` before building the new one, and registers itself. `detach()` removes its own entry. Add `export function detachWatcherFor(taskId: string): void`.
4. Keep everything defensive: a DB hiccup must never crash the poll timer (existing `cycle()` try/catch).

**Acceptance:** `attachSubagentWatcher` called twice for one task leaves exactly one live timer; `orphanRunningSubagents` on a clean task is a silent no-op; existing `claude-subagents.test.ts` still passes.

---

### T3 — Release the hold on session death / disposal
**Owns:** `src/bun/claude-tmux.ts`
**Goal:** honor the owner's "release on session death / detach" rule.

Call `orphanRunningSubagents(state.taskId)` (imported from `./claude-subagents.ts`) from:
- `signalSessionDeath` (`claude-tmux.ts:2676-2707`), right after `state.subagentWatcher?.detach()` (line 2705).
- `disposeSessionState` (`claude-tmux.ts:3579-3593`), right after its `detach()` (line 3592).

**Verify each `disposeSessionState` call site before wiring** (`claude-tmux.ts:2877`, `3139`, `3568`): 2877/3139 clear this instance's *own* stale session immediately before `tmux new-session`, so orphaning the previous session's subagent rows is correct; 3568 is `dropSession` (delete/archive/agent-switch), where the rows are about to be cascade-deleted or are genuinely dead. If any call site turns out to run on a *live* session that will keep writing, do **not** orphan there — report it instead of guessing.

**Boundaries:** do not change `popEndOfTurn`, `firePendingEndTurn`, `holdUntilIdle`, or any turn-resolution logic. The turn still resolves normally; only the column waits.

**Acceptance:** typecheck clean; no change to turn-resolution behavior; `claude-tmux.test.ts` + `claude-tmux-queue.test.ts` still pass.

---

### T4 — The gate, the release, and boot reconciliation  *(runner: opus)*
**Owns:** `src/bun/orchestrator.ts`
**Goal:** the heart of the change.

1. **Predicate + release**, near `updateColumn`:
   ```ts
   /** A task is "held" when its terminal run succeeded but background agents
    *  are still running. Derived purely from the DB so it survives a restart. */
   function isHeldByBackgroundAgents(taskId: string): boolean;
   /** Idempotent: flip a held task to `review` once its last subagent finishes.
    *  No-ops if the user moved the card, or a newer run is in flight. */
   function maybeReleaseHeldTask(taskId: string): void;
   ```
   `maybeReleaseHeldTask` must bail unless `task.column === "running"`, `task.runId` is set, `runs.get(task.runId)?.status === "succeeded"`, and `!subagents.hasRunning(taskId)`. Then `updateColumn(taskId, task.runId, "review")`.
2. **Register the hook** next to `setSubagentEmitter(emit)` (`orchestrator.ts:115`):
   `setSubagentSettleHook(maybeReleaseHeldTask);`
3. **The gate** in `attachDoneHandler`'s `.then()` (`orchestrator.ts:643-652`). Only the `succeeded` branch changes:
   ```ts
   if (isTerminalRun) {
     const holdForSubagents = !wasCancelled && !wasApiError && !wasSessionDied
       && newStatus === "succeeded" && subagents.hasRunning(taskId);
     if (holdForSubagents) {
       // Leave the card in `running`. `maybeReleaseHeldTask` (fired by the
       // subagent settle hook) moves it to `review` when the last one finishes.
       onChunk-equivalent: emit a `status` chunk so the stream explains the wait.
     } else {
       const nextColumn: ColumnId = /* unchanged ternary */;
       updateColumn(taskId, runId, nextColumn);
     }
   }
   ```
   Ordering matters: `runs.update(runId, { status: newStatus, ... })` (line 632) already ran, so a concurrent hook firing right now sees `succeeded` and can release correctly. Emit an informational `status` event (e.g. `background agents still running (N) — holding in running`) via `emit(...)` so the run stream explains why the card hasn't moved. Still `emitGlobal({kind:"run-status", status:"succeeded"})` — the *run* did succeed.
   Leave the `.catch()` branch (`orchestrator.ts:666-680`) untouched: it only produces `ready`/`blocked`, neither of which is gated.
4. **Boot reconciliation**, at the end of `reconcileOrphans` (`orchestrator.ts:269-424`), after the existing `running`-run pass. For every task with `column === 'running'` whose terminal run is **not** `running` and which `subagents.hasRunning(...)`:
   - If the task's claude tmux session is alive (`sessionExistsByName(sessionNameFor(taskId))`, already imported) → re-arm the watcher so the still-live background agent can finish and release:
     `attachSubagentWatcher({ taskId, jsonlPath: jsonlPathFor(cwd, run.claudeSessionId, harness?.home ?? null) })`
     (skip if `claudeSessionId` is null; `attachSubagentWatcher`'s registry from T2 makes this safe against a later reattach).
   - Else → `orphanRunningSubagents(taskId)`, which fires the settle hook and releases the card to `review`.

   Add the count of released/re-armed tasks to the existing return value's semantics only if trivial; otherwise leave the return value alone and just log.

**Acceptance:** all five behavioral criteria in §1 (1–5) provable by unit test; `orchestrator.test.ts` + `reconcile.test.ts` still pass.

---

### T5 — Expose the count over HTTP
**Owns:** `src/bun/server.ts`
**Goal:** the board poll carries the badge data.

In the `GET /tasks` handler (`server.ts:~865`), join the counts once per request:
```ts
const counts = subagents.runningCountsByTask();
return json(tasks.list().map((t) => ({ ...t, runningSubagents: counts.get(t.id) ?? 0 })));
```
Do the same for any single-task read route if one exists (search for `tasks.get(` in route handlers). **Do not** add `runningSubagents` to the `PATCH /tasks/:id` allow-list — it is derived, not stored.

**Acceptance:** `GET /tasks` returns `runningSubagents: 0` for every task on a clean DB; typecheck clean.

---

### T6 — Board badge
**Owns:** `src/mainview/components/kanban/TaskCard.tsx`
**Goal:** show "N background agents" while any subagent is running.

Render a small pill (match the existing badge/pill idiom already in the file — do not invent new tokens or add a dependency) when `(task.runningSubagents ?? 0) > 0`. Singular/plural the label. It should read naturally next to the existing `running`-column affordances (the card already shows a Stop button when `column === "running" || column === "blocked"`, `TaskCard.tsx:47,148-151`).

**Boundaries:** `TaskCard.tsx` only. Do not touch `App.tsx`, `RunPanel.tsx`, `subagent-tabs.ts`, or `api.ts` — the 2s `/tasks` poll already refreshes the field.

**Acceptance:** badge absent when the count is 0 or undefined; dark-mode styling consistent with the surrounding card.

---

## 5. Work breakdown — test tasks

### TT1 — Orchestrator hold/release (`src/bun/subagent-hold.test.ts`, new file) — covers T1, T4
- Succeeded run + a `running` subagent row → task stays `running`.
- Then flip that row `completed` and call the settle hook → task becomes `review`.
- Succeeded run + no subagent rows → `review` immediately (regression guard).
- `cancelled` / `apiError` / `sessionDied` with a `running` subagent → `ready` / `blocked` / `blocked` (hold does not apply).
- Codex task with no subagent rows → `review` (gate inert).
- `maybeReleaseHeldTask` no-ops when the user has moved the card out of `running`, and when a newer run is in flight.

**Follow `orchestrator.test.ts:1-17`'s module-top env setup** (`AGETOR_DATA_DIR` = `mkdtemp`, `AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_CLAUDE_BIN`/`AGETOR_TMUX_BIN` = `/bin/echo`) and pass `isolation: "none"` on every `createTask`.
**Critical:** seed run rows as `status:'succeeded'` with `endedAt` set. A leftover `status:'running'` run row passes in isolation but breaks `reconcile.test.ts` in the combined `bun test`, because `reconcileOrphans` scans running runs globally across the shared DB.

### TT2 — Watcher orphaning + settle hook (extend `src/bun/claude-subagents.test.ts`) — covers T2
- `orphanRunningSubagents` flips `running` → `orphaned`, sets `endedAt`, emits one `finished` lifecycle event per row, and calls the settle hook once.
- No-op (no events, no hook) when nothing is running.
- `attachSubagentWatcher` twice for one task → the first handle is detached; only one watcher remains.
- Existing `manual: true` + `pump(now)` idiom; do not introduce real timers.

### TT3 — Boot reconciliation (extend or sibling of `src/bun/reconcile.test.ts`) — covers T4 §4
- Task in `running`, terminal run `succeeded`, one `running` subagent row, no live tmux session → after `reconcileOrphans()` the subagent is `orphaned` and the task is `review`.
- Same but the run row is `running` → untouched by the new pass (the existing orphan path owns it).

## 6. Execution waves

- **Wave 1** — T1, T2, T3, T4, T5, T6 in parallel (six disjoint files, contracts fixed above). Barrier: `bun run typecheck`, then commit.
- **Wave 2** — code review of the Wave-1 diff (Phase 5, opus).
- **Wave 3** — TT1, TT2, TT3 in parallel (three disjoint test files). Barrier: `bun test`.
- **Wave 4** — fixes for review must-fixes + test failures; re-run `bun test` to green.

## 7. Blast radius & risks

| Risk | Mitigation |
| --- | --- |
| A wedged-but-alive background agent holds the card indefinitely | Accepted by owner (no watchdog). Session death, disposal, and boot all release. Stop still works — the card keeps its Stop button in `running`. |
| Sync `Task` subagent still `running` at settle (1500ms `DONE_IDLE_MS` vs 800ms `END_TURN_IDLE_FIRE_MS`) → card briefly held | Self-heals: `checkDone` fires the settle hook ~700ms later and releases to `review`. Covered by TT1. |
| Two subagent watchers double-emit over SSE | T2's module-level registry makes double-attach structurally impossible. |
| New test leaves a `running` run row → breaks `reconcile.test.ts` in the combined run only | Called out explicitly in TT1; seed runs terminal. |
| `runningSubagents` mistaken for a patchable column | It's derived per-request in `server.ts`, never written by `tasks.update`; PATCH allow-list untouched. |
| Codex regressions | Gate keys off the `subagents` table, which codex never writes. TT1 asserts a codex task resolves to `review`. |
| Orphaning at a `disposeSessionState` call site that owns a *live* session | T3 requires verifying all three call sites and reporting rather than guessing. |

**Rollback:** the gate is one `if` in `attachDoneHandler`. Reverting T4 restores today's behavior; T1/T2/T3/T5/T6 are additive and inert without it.

## 8. What actually shipped — deviations from this plan

1. **§7 claimed "Stop still works" on a held task. It did not.** `attachDoneHandler` runs `active.delete(runId)` before parking the card, and `cancelRun` begins `if (!h) return false` — so Stop was a silent no-op on exactly the task it was meant to rescue. Fixed by giving `cancelRun` a held-task branch (interrupt by session name, orphan the rows, release to `review`) and adding `interruptTaskSession` to `claude-tmux.ts`, which addresses the session by its deterministic name and so works with no `SessionState` (as after a boot re-arm).
2. **`disposeSessionState` was parameterized rather than unconditionally orphaning.** T3 verified all three call sites and found `reattachSession`'s defensive pre-dispose may refer to a *live* session that will keep writing. It takes `orphanSubagents = false`; only `spawnClaudeViaTmux` and `dropSession` — both provably preceded by a `killTaskSession` — pass `true`.
3. **`dropSession` now also releases when there is no `SessionState`.** A task held across a restart has a boot-armed watcher but no session state, so delete/archive would have leaked its poll timer.
4. **The boot pass releases (rather than skips) a held task whose run has a null `claudeSessionId`.** No watch path can be derived, so nothing would ever observe those agents finishing — treating it like a dead session is the only non-stranding option.
5. **`setSubagentEmitter` / `setSubagentSettleHook` now return the previous value.** Not in the original plan. `bun test` shares one process; a test that reset them to `null` un-wired the orchestrator for every later file, and the task could never reach `review`. Tests save and restore.
6. **`db.runningCountForTask`** added so the hold's status message doesn't scan every row via `runningCountsByTask()`.

## 9. Open questions / assumptions

- **Assumed** the `status` chunk emitted when holding (`background agents still running (N) …`) needs no new sentinel constant — it's informational, not pattern-matched by `makeChunkHandler`. If review disagrees, promote it to `shared/types.ts`.
- **Assumed** `GET /tasks` is the only route the board reads task rows from. T5 must grep for other `tasks.list()` / `tasks.get()` route handlers and cover them.
- **Deferred:** distinguishing async (`run_in_background`) from sync `Task` subagents. Not needed for this behavior; revisit if the sub-second hold on sync subagents ever proves visible.
- **Deferred:** surfacing `failed` / `cancelled` subagent statuses (still dead states after this change; we only add `orphaned`).
- **Deliberate:** the badge renders in *every* column, not just `running`. If a background agent resumes after the card reached `review`, its row flips back to `running` and the badge reappears on a Review card. The count is truthful and surfaces the anomaly rather than hiding it; nothing pulls the card back to `running`. Revisit if it reads as noise.
- **Known cosmetic:** deleting a held task emits one transient `column → review` GlobalEvent (via `dropSession` → orphan → settle hook) microseconds before the row is deleted.
- **Not done:** no real-app smoke test (`bun run dev`). Verified by 789 unit/integration tests only.
