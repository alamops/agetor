# Plan — Adopt continuations on the task-notification line (fix "card in Review while claude still works")

| Field | Value |
| --- | --- |
| Date | 2026-07-10 |
| Source | /implement: "tasks are being moved to Review after bg agents complete but still has loading indicator" + owner screenshot (claude TUI footer still spinning) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/f00ff7864feb-task-is-being-moving-to-review-even-with |
| Base SHA | 1e28eb6140f2f066fd2b6a258b1a28972c6d571b |

## 1. Objective & success criteria

When a claude-code task's background agents finish and claude auto-continues, the kanban card must reflect the live session for the *entire* continuation — including the (potentially minutes-long) extended-thinking window before the first assistant content line hits the JSONL. Success:

1. On the `<task-notification>` JSONL line, a continuation run is adopted immediately (card in `running`, Stop works, heartbeat on) instead of waiting for the first assistant content line.
2. If claude never actually continues after a notification, a watchdog settles the adopted run after 10 minutes of no content, releasing the card to `review` (owner-chosen guard).
3. After an agetor restart, a `review`/`done`-column task with a stuck `running` subagent row is reconciled (watcher re-armed if the session is alive, rows orphaned if not) — today it is invisible to boot reconciliation and stuck forever.
4. Claude's TUI spinner footer (`✱ Scurrying… (1m 13s · ↓ 3.7k tokens · esc to interrupt)`) never renders inside a TmuxPromptCard's pane excerpt.
5. `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (grounded findings)

- **Root cause (primary symptom):** the last subagent settles via its own ~1.5s JSONL-idle heuristic (`claude-subagents.ts` `checkDone`, DONE_IDLE_MS) or via the notification's agent-id extraction → `maybeReleaseHeldTask` (`orchestrator.ts:242-248`) flips the card to `review`. Continuation adoption (`claude-tmux.ts:2119-2141`) requires `isContinuationContentEvent(evt)` (`claude-tmux.ts:564-575`), which is explicitly false for `origin.kind === "task-notification"` / `isMeta` lines — so during extended thinking there is **no** `runs`/`subagents` row tracking the genuinely-live session, for an unbounded window.
- The `<task-notification>` line is a reliable, early, latency-free signal that claude noticed the background work finished; today it only drives the (pre-dedup, idempotent) settle block at `claude-tmux.ts:2086-2092` (`taskNotificationContent` / `extractTaskNotificationAgentId` / `fireBackgroundTaskSettled`).
- **dispatchLine ordering (`claude-tmux.ts:2024-2148`):** (1) pendingEndTurn staging/confirm `:2045-2066` → (2) bg settle block (pre-dedup) `:2086-2092` → (3) dedup early-return `:2098-2108` → (4) continuation adoption (post-dedup) `:2119-2141`. Adoption registers the run with the orchestrator **before** the triggering line dispatches.
- **Owner-approved prior decisions honored:** continuations are NEW run rows (`runs.origin='continuation'`) adopted via `setContinuationRunFactory` — never reopen the resolved run (decision 2026-07-09). The hold predicate is DB-derived, no in-memory map (decision 2026-07-09). Boot reconciliation must never enumerate-and-kill `agetor-*` sessions — only reattach or orphan DB rows (shared tmux socket).
- **Boot blind spot (confirmed bug #2):** `reconcileOrphans`' held-task pass scans only `SELECT id FROM tasks WHERE "column"='running'` (`orchestrator.ts:540-542`). A `review`-column task with a `running` subagents row after a restart never gets a watcher re-armed nor its rows orphaned → permanently stuck badge/tab dot (`Task.runningSubagents` is a live DB derivation, `server.ts:918-921`, honestly reporting a dead row).
- **Cosmetic bug #3:** the runtime pane scraper captures the last 12 pane lines verbatim into `tmux_prompt` interactions; `PROMPT_NOISE_RE` (`RunPanel.tsx:~3157-3165`) strips hint lines but not the spinner footer, so literal "✱ Scurrying…" text can render inside prompt cards.
- **Known-good machinery not to disturb:** end-turn fingerprint staging is per-message-id and cannot coalesce a continuation's own end_turn (verified); `fireParkedDiscovery` → `pullBackParkedTask` already handles a subagent resuming after `review` (#95); `holdUntilIdle` is exclusively for folded follow-ups.

## 3. Approach & key decisions

- **Adopt on notification (owner decision):** extend adoption eligibility to a provably-NEW task-notification line, keeping every existing guard (`continuationRunFactory` set, `!turnInFlight`, empty `turnQueue`, `!state.onEndOfTurn`). Reuse `startContinuationRun` unchanged — the trigger moves earlier; the modeling (new run row, `origin='continuation'`) stays per the standing decision.
- **Kill the review→running flicker:** today, the notification line's settle block runs before adoption would, so `maybeReleaseHeldTask` can flip to `review` microseconds before adoption pulls back to `running`. Restructure `dispatchLine` so adoption-on-notification is evaluated **before** the settle block for new (non-replayed) lines: extract the adoption block into a helper and call it between the staging block and the settle block, gated on an explicit `uuid && !seenLineUuids.has(uuid)` check (it now sits above the dedup return; replayed lines must still never adopt). Content-line adoption keeps working through the same helper at the same effective position.
- **Watchdog (owner decision):** `CONTINUATION_WATCHDOG_MS = 10 * 60_000` (module const, test-injectable like the other timing knobs). Armed on SessionState only when adoption was triggered by a notification (content-triggered adoption needs none — content already arrived). Reset on a subsequent notification (another wake signal). Cleared when the first content line reaches the adopted turn, when the turn resolves normally, and in `disposeSessionState`. On fire — if the adopted slot is still the active turn with no content observed — emit a `status` chunk ("no continuation followed the background task; settling") and resolve the slot as success through the same path the end-turn idle-fire uses, so `attachDoneHandler` → hold gate → `review` runs normally.
- **Old-run-done vs adoption interleaving (must verify, not assume):** the notification line both confirms `pendingEndTurn` (main run resolves in a `.then()` **microtask**) and now synchronously adopts. The old run's done-handler must not flip the column to `review` when `task.runId` already points at the newer running continuation. Verify the existing gate in `attachDoneHandler` covers this (task.runId/staleness or `maybeReleaseHeldTask`-style DB re-derivation); if not, add the guard. A regression test for exactly this interleaving is mandatory (task T-A below).
- **Boot pass (owner scope):** widen the held-task pass source set from `tasks WHERE column='running'` to "tasks having any `running` subagents row" (new db helper, e.g. `subagents.taskIdsWithRunning()`). For `column='running'` tasks, behavior is unchanged (still gated on `isHeldByBackgroundAgents`). For any other column: same branch structure as `orchestrator.ts:550-573` — session alive **and** a `claudeSessionId` available → `attachSubagentWatcher`; otherwise `orphanRunningSubagents` (its settle hook fires `maybeReleaseHeldTask`, which safely bails for non-running columns). No kills, ever. Skip non-claude-code agents as today.
- **Noise filter:** extract the prompt-noise pattern list from `RunPanel.tsx` into `src/mainview/lib/prompt-noise.ts` (repo convention: testable logic lives in `lib/` because there is no DOM harness), add a spinner-footer pattern (spinner glyph optional + `\w+…` verb + parenthesized elapsed/tokens/esc-to-interrupt tail), keep all existing patterns byte-identical, and unit-test positives + negatives.

**Alternatives rejected:** grace-delay before release (any fixed delay loses to extended thinking); "continuation pending" flag holding the release with no run row (no Stop affordance, no heartbeat, invents a second hold mechanism alongside the DB-derived one); reopening the succeeded run (contradicts standing decision).

## 4. Work breakdown — implementation (Wave 1, all file-disjoint)

- **T1 — notification adoption + watchdog.** Owns `src/bun/claude-tmux.ts` ONLY. Extract/reorder the adoption helper per §3; extend eligibility to new task-notification lines; add `continuationWatchdog` state + arm/reset/clear/fire per §3; clear in `disposeSessionState`. Acceptance: notification line with no turn in flight → run adopted before the line dispatches, no `review` GlobalEvent emitted in between; watchdog wiring exported/injectable enough to unit-test.
- **T2 — boot pass widening.** Owns `src/bun/orchestrator.ts` + `src/bun/db.ts`. New db helper for task-ids-with-running-subagents; widen the pass per §3 preserving the `column='running'` behavior byte-for-byte; update the summary log line. Acceptance: a `review` task with a running subagent row and a dead session gets its rows orphaned at boot; with a live session + claudeSessionId it gets a watcher re-armed; `column='running'` behavior unchanged.
- **T3 — spinner noise filter.** Owns `src/mainview/components/kanban/RunPanel.tsx` + new `src/mainview/lib/prompt-noise.ts`. Extract patterns, add spinner-footer pattern, re-import from RunPanel. Acceptance: `"✱ Scurrying… (1m 13s · ↓ 3.7k tokens)"`, `"* Reticulating… (3s · esc to interrupt)"` filtered; modal body/choice lines (e.g. `"1. Yes, run it"`, `"Do you want to proceed?"`) not filtered.

No two tasks touch the same file → one wave, fully parallel.

## 5. Work breakdown — test tasks (Phase 6)

- **T-A** (covers T1) — extend `src/bun/claude-continuation.test.ts`: adoption fires on a new notification line (card `running`, run `origin='continuation'`); no adoption on replayed notification lines (seeded `seenLineUuids`); no `review` column event between settle and adoption for the same line; watchdog fires after fake-timer 10min with no content → run `succeeded`, card `review`; watchdog cancelled by a content line; watchdog reset by a second notification; the old-run-microtask interleaving regression from §3. Owns that test file only.
- **T-B** (covers T2) — extend the reconcile/boot test file (`src/bun/reconcile.test.ts` or wherever `reconcileOrphans`' held-task pass is tested — discover, then own that file): review-column stuck row orphaned on boot (dead session); watcher re-armed (live session, real-tmux test pattern already exists there); running-column behavior unchanged.
- **T-C** (covers T3) — new `src/mainview/lib/prompt-noise.test.ts`. Owns that file only.

Test tasks are file-disjoint from each other and from Wave 1 (which is already committed by then).

## 6. Execution waves

1. Wave 1: T1 ∥ T2 ∥ T3 → typecheck + commit.
2. Phase 5: code review of the full diff vs base SHA.
3. Wave 2 (Phase 6): T-A ∥ T-B ∥ T-C → commit.
4. Phase 7: `bun test` + `bun run typecheck` (background agent). Phase 8 fix loop if needed (≤3 rounds).

## 7. Blast radius & risks

- `dispatchLine` is the hottest path in claude-tmux; the reorder moves adoption above the settle block — replay safety now rests on the explicit seen-uuid guard instead of block position. Mitigate with the replay test in T-A.
- Watchdog false-fire during >10min silent thinking: accepted by owner (explicit choice of "adopt + watchdog" over "no watchdog"). The consequence is the pre-fix behavior (card in `review` while claude works), not a broken session — the eventual content line re-adopts a fresh continuation run and pulls the card back.
- Boot-pass widening touches restart reconciliation — the no-kill invariant must hold (only `attachSubagentWatcher` / `orphanRunningSubagents`, both DB/watcher-level).
- `bun test` currently at 789+ passing; shared-process test leaks have bitten before (injected setters, module-level env) — test tasks must save/restore any injected factories/timers.

## 8. Open questions / assumptions

- Assumption: a `<task-notification>` line reliably precedes any auto-continuation (it is the wake signal itself). If claude versions change the JSONL shape, `taskNotificationContent` already centralizes detection.
- Assumption: 10min watchdog constant needs no env override for now (module const, test-injectable).
- Codex remains inert by construction throughout (writes no subagents rows; factory rejects non-claude-code).
