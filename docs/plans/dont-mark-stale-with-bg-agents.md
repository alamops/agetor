# Plan — Don't consider tasks/sessions stale while background agents/workflows are running

| Field | Value |
| --- | --- |
| Date | 2026-08-13 |
| Source | agetor task prompt: "don't let tasks/sessions be considered stale if they have bg agents/workflows running" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/dont-let-sessions-be-considered-stale-wh |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 (tree clean at start) |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (owner not present); every assumption logged in §8 |

## 1. Objective & success criteria

A task whose main turn has ended but whose background agents (subagents) or Claude Code Workflows are still running must not be classified as stale/idle anywhere in agetor. Success:

- `GET /worktrees` never reports `staleReasons: ["inactive"]` for a task with a `running` subagent row, regardless of `task.updatedAt` age.
- The headless CLI daemon does not idle-shutdown while any subagent row is `running`, even with zero `running` runs and zero attached clients.
- The existing idle-session reaper behavior is unchanged (it is already guarded).
- Typecheck green; full `bun test` green; new negative-guard tests exist for both fixed surfaces.

## 2. Context & constraints (Phase 1 findings, verified against HEAD)

- **Running-bg-work source of truth**: `subagents.hasRunning(taskId)` — `src/bun/db.ts:1180-1185`, `SELECT 1 FROM subagents WHERE task_id = ? AND status = 'running' LIMIT 1`. All parent kinds (`subagent`, `bg_session`, `workflow`, `workflow_agent`) share the table, so workflow container rows are covered automatically (`db.ts:1106`). DB-only, so the answer survives restarts.
- **Already guarded (no change)**: `reapIdleSessions` — `src/bun/orchestrator.ts:2868-2884` checks `subagents.hasRunning(task.id)` independently of the column-scoped `isTaskHeldByBackgroundAgents` wrapper, and re-checks a fresh row right before the kill (TOCTOU close). Both entry points (`index.ts:139-146`, `headless.ts:82-93`) share it.
- **Gap A — worktree "inactive" flag**: `listWorktrees`, `src/bun/orchestrator.ts:3013` — `if (!runActive && Date.now() - task.updatedAt > WORKTREE_STALE_AFTER_MS)`. `runActive` is only `active.has(task.runId)` (in-flight main turn). A succeeded run leaves `active` immediately while bg agents keep working → flagged `"inactive"` after 7 days of `updatedAt` age. No test covers running-subagent + old `updatedAt` (`worktrees-list.test.ts:130-155` back-dates via raw SQL with no subagent rows).
- **Gap B — headless daemon idle-shutdown**: `src/bun/headless.ts:135` — `if (hasRunningRuns() || attachedClientCount() > 0)` resets the idle clock; `hasRunningRuns` (`headless.ts:37-49`) queries only `runs.status = 'running'`. In the held state (main run succeeded, bg agents/workflows still working) with no attached client, the daemon exits after `IDLE_TIMEOUT_MS` (default 5 min) — killing the process that watches/settles those agents. Higher-impact than Gap A (5 min vs 7 days).
- **Wedged-row backstop keeps the guard honest**: `STALE_SUBAGENT_SETTLE_MS` (`claude-subagents.ts:212-235`, default 10 min, `AGETOR_SUBAGENT_STALE_MS`) settles a `running` row whose transcript goes quiet — so neither guard can be pinned open forever by a wedged row *while a watcher is attached*. Rows whose session is gone are orphaned by boot reconciliation (`subagents.orphanRunning`).
- **Test conventions**: top-level `process.env.AGETOR_DATA_DIR = mkdtempSync(...)` before any `./db.ts` import; fake drivers via `AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_TMUX_BIN=/bin/echo`; time simulated by back-dating stored timestamps (raw SQL for `updated_at` — `tasks.update()` force-overwrites it); negative-guard tests named "does not …".

## 3. Approach & key decisions

- **Guard predicate = `subagents.hasRunning` / a new task-agnostic `hasAnyRunning`, as-is semantics (any running row, all kinds).** Consistent with the reaper's proven guard; workflow containers are included for free. Alternative (per-row activity timestamps) rejected — the 10-min settle backstop already bounds false-holds. *(Decision rests on reaper precedent + verified `PARENT_KINDS` sharing, not new measurement.)*
- **Gap A fix**: add `!subagents.hasRunning(task.id)` to the `"inactive"` condition, ordered **after** the age check so the per-row query only runs for age-eligible rows (the list is fetched on open/Refresh). Update the docstring (`orchestrator.ts:2976-2977`). Do **not** reuse `isTaskHeldByBackgroundAgents` — its `column === "running"` scoping is the documented blind spot.
- **Gap B fix**: new `subagents.hasAnyRunning(): boolean` in `db.ts` (`SELECT 1 FROM subagents WHERE status = 'running' LIMIT 1`), and the daemon idle predicate becomes `hasRunningWork() || attachedClientCount() > 0` where `hasRunningWork` = running runs OR any running subagent row, wrapped in the same non-throwing try/catch style as today's `hasRunningRuns`. Export the predicate (or its subagent half) so it is unit-testable without booting the daemon / hitting `process.exit`. Update the `IDLE_TIMEOUT_MS` doc comment.
- **Out of scope (deliberate)**: `enqueueArchiveTeardown` / `sweepArchivedTeardowns`. Archive is an explicit user action whose contract (docstring `orchestrator.ts:2556-2579`) is that no background shell outlives it; the active-run guard already blocks archiving held tasks without `stopRun: true`, and `stopRun: true` is an explicit stop-everything opt-in. A `hasRunning` bail there could deadlock teardown against rows the archive itself just orphaned.
- **No UI change**: the Worktrees page consumes `stale`/`staleReasons` verbatim; suppressing the flag server-side is sufficient. (Optional follow-up: expose a `heldByBackgroundAgents` field for UI explanation — not needed for correctness.)

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| I1 | `subagents.hasAnyRunning()` db helper; Gap A guard in `listWorktrees` + docstring; Gap B guard in daemon idle predicate (testable export) + comments | `src/bun/db.ts`, `src/bun/orchestrator.ts`, `src/bun/headless.ts` | — | Typecheck green; behavior per §3 |

Single agent, single wave — the three edits are tiny and the db helper is consumed by the headless edit, so splitting would manufacture a dependency across agents.

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | (a) worktrees: "does not flag inactive while a subagent/workflow row is running" (back-dated `updated_at` + running row → no `"inactive"`; settle row → `"inactive"` appears; also cover a `parent_kind='workflow'` container row). (b) daemon predicate: unit tests for `hasAnyRunning`/exported idle-work predicate (running subagent row keeps it truthy with zero running runs; settled/orphaned rows don't). | `src/bun/worktrees-list.test.ts`, new `src/bun/headless-idle.test.ts` (or extend `daemon-boot.test.ts` if it already imports headless) | I1 | Tests pass; follow existing bootstrap conventions |

**E2E: not applicable.** Both surfaces are backend classification/lifecycle predicates with no new user-visible flow; the Playwright suite drives the webview, which consumes `staleReasons` unchanged. Unit/integration tests against the real SQLite db (the repo's standard) exercise the full changed path. Recorded per plan discipline, not silently skipped.

## 6. Execution waves

- Wave 1: I1 (one agent). Checkpoint: typecheck + commit.
- Phase 5: code review (opus) on `git diff <base>...HEAD`.
- Wave 2: T1 (one agent) after review triage. Commit.
- Phase 7: full `bun test` + `bun run typecheck` (haiku background agent).

## 7. Blast radius & risks

- `listWorktrees` gains ≤1 indexed-ish query per age-eligible row — negligible (list is fetched on dialog open/Refresh, and the age branch is rare).
- Daemon: a permanently-`running` subagent row would keep the daemon alive. The 10-min watcher staleness backstop (`STALE_SUBAGENT_SETTLE_MS`) only covers file-backed rows with a live watcher — it does **not** bound workflow container rows (deliberately exempt, settled only by their completion notification or user action) or rows left behind by an `AGETOR_TRACK_SUBAGENTS=0` no-op watcher. Those are instead bounded by `SUBAGENT_HOLD_MAX_MS` (6h, `src/bun/headless.ts`): `hasRunningWork` ignores subagent rows started before that cutoff, so a wedged row can hold the daemon for at most 6h. Past that ceiling the daemon may idle-exit exactly as it did before this feature: the detached tmux session survives, and the next boot's `reconcileOrphans` reattaches or orphans it. Actual bound = 10-min backstop for file-backed rows with a live watcher, 6h ceiling for everything else. Boot reconciliation also orphans rows whose session is gone. `AGETOR_DAEMON_IDLE_MS=0` (stay-up) semantics untouched.
- Reaper untouched; archive/teardown untouched (see §3).
- `WorktreeInfo` shape unchanged → no webview/CLI drift (`Dashboard.test.tsx` guards CLI constants, unaffected).

## 8. Open questions / assumptions (autonomous mode)

1. **Scope** = Gap A + Gap B only; reaper already compliant; archive teardown deliberately excluded (rationale §3).
2. **Guard semantics**: any `running` row (current `hasRunning`), no per-row granularity.
3. **No UI surfacing** of "held by background agents" on the Worktrees page in this change.
4. **No env override** added for `WORKTREE_STALE_AFTER_MS` — tests back-date `updated_at` via SQL, so no time-injection knob is needed.
5. Gates bypassed under autonomous mode; a human should review this section plus §3's out-of-scope call.
