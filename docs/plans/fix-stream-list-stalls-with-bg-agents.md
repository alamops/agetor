# Plan — Keep the task-details stream live & truthful across background-agent turns

| Field | Value |
| --- | --- |
| Date | 2026-07-09 |
| Source | /implement — "stream messages list in task details stops updating by itself, or wrongly streams / wrongly gets updates; perhaps due to having agents running" + screenshot forensics on task `cb537f02` |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/a12b321d0e5f-after-many-bg-tasks-stream-messages-list |
| Base SHA | 3d9811b6f87e00121ee100119fa82c3ec3b86332 (clean tree at Phase 4 start) |

## 1. Objective & success criteria

When a claude-code main agent hands work to background agents and later auto-resumes (task-notification continuation), the task-details panel must keep rendering the main stream live, run status must reflect reality, and the kanban card must not get stuck (neither frozen in `review` while work continues, nor pinned in `running` forever by stale subagent rows).

Success =
1. Main tab keeps updating live after a run resolves while the same session keeps emitting (no `rebuilt`-mask freeze).
2. A post-`end_turn` auto-continuation opens a **new run row** (`origin: "continuation"`): heartbeat on, events attributed to it, resolves on its own end_turn.
3. A continuation (or a newly-discovered running subagent) pulls a `review` card back to `running`.
4. A tmux session dying **during a #92 hold** is detected (death-watch armed while held) → subagents orphaned, hold released.
5. Subagent completion detection hardened: parent's task-notification marks the named subagent settled; boot reconciliation orphans running subagent rows whose session is gone.
6. `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (Phase 1 findings, verified)

- **Freeze mechanism (frontend, primary symptom).** `RunPanel.tsx:487-503` — when `latestRun.status !== "running"`, a one-time JSONL rebuild snapshot is stored in `rebuilt`; `displayedEvents` (`RunPanel.tsx:539-544`) filters out ALL live main events whose `runId` is in `rebuiltRunIds` (`RunPanel.tsx:505-516`, matched by `claudeSessionId` — so it also masks future runs of the same session). Nothing clears `rebuilt` except the local composer's `send()`/`sendCommitPush()`. DB forensics: 502/570 events of the screenshot's run were persisted after `ended_at` — data flows, UI hides it. The rebuild exists because *older* agetor mappers truncated tool inputs at 500 chars; the current mapper does not truncate.
- **Premature resolution (backend trigger).** Claude legitimately emits `end_turn` when delegating to background tasks and auto-resumes later via a synthetic `user` line with `origin.kind: "task-notification"` (`claude-tmux.ts:479-494`) or `queue-operation` (`claude-tmux.ts:669-694`). `isEndTurnContinuation` (`claude-tmux.ts:383-395`) doesn't treat these as continuations, and the 800ms idle-fire (`claude-tmux.ts:1389`, `2049-2057`) confirms the staged end_turn. This resolution is *by design* per the #92 decision ("the turn genuinely resolved; only the column should wait") — we keep it.
- **Orphaned continuation events.** After `popEndOfTurn` (`claude-tmux.ts:1395-1416`) drains the queue, later lines dispatch through the stale `state.lastChunk` (`claude-tmux.ts:1904-1908`) → persisted+broadcast under the already-`succeeded` runId. No heartbeat, no Stop handle, "TURN COMPLETE" renders mid-work.
- **#92 hold gaps.** Hold predicate is DB-derived (`orchestrator.ts:743-748` + `isHeldByBackgroundAgents`); engage races subagent discovery (fast-poll 600ms / slow-poll 4s / best-effort fs.watch, `claude-subagents.ts:53-59, 348-382, 446-481`) — end_turn at ~800ms can beat discovery → no hold. The #88 death-watch is gated on `turnInFlight` (`claude-tmux.ts:~2718-2742`) and goes idle exactly when a hold starts → a session dying during a hold is never detected. Headless idle-shutdown (`headless.ts:36-48`) is also blind to holds (noted; low priority here).
- **Stale subagent rows (prod evidence).** 2 of 8 subagent rows for task `cb537f02` stuck `running` (last events 8–14 min old). Under #92's no-watchdog rule that pins the card in `running` until Stop/restart.
- **Follow-up-run template.** `sendTurnInExistingSession`'s idle branch (`orchestrator.ts:1242-1277`) is the pattern for continuation runs: `runs.insert` (inherited `claudeSessionId`), `tasks.update({column:"running", runId})`, `emitGlobal(column)`, `makeChunkHandler`, `registerActiveRun`, `attachDoneHandler`. Continuation differs only in *not* pasting keystrokes and in the run's `origin`.
- **Conventions.** Injected-setter seams already exist between orchestrator ↔ claude-subagents (#92); tests must save/restore injected setters (peer entry `b7ff666a`). Migrations: numbered SQL + `migrations/index.ts` text-import append-only. Frontend has NO DOM test harness — only pure-helper unit tests; UI behavior verified via `bun run dev:hmr`. Tests importing db/orchestrator must set `AGETOR_DATA_DIR` to a mkdtemp in `beforeAll`.

## 3. Approach & key decisions (owner-confirmed in Phase 2)

1. **Full package** (frontend un-freeze + continuation runs + hold robustness) — owner picked.
2. **Continuation = new auto run row** (owner picked). Respects #92's "the run genuinely succeeded" decision; mirrors the existing one-row-per-turn invariant. Rejected: suppressing end_turn (contradicts #92 decision), reopening the succeeded run (falsifies history).
3. **Harden detection, no wall-clock watchdog** (owner picked, consistent with prior owner decision): settle signals = parent task-notification naming the agent, session death (now detectable during holds), boot reconciliation.
4. **Pull-back to `running`** (owner picked): continuation runs always set column `running`; a newly-running subagent row pulls the card back **only from `review`** (never from `done`/`blocked`/`ready` — those states encode user intent or errors).
5. Frontend fix = **clear `rebuilt` when a newer live main event arrives for a masked run** (fall back to live events; re-rebuild happens naturally when the newest run next resolves). Rejected: re-running the JSONL rebuild per live batch (expensive, racy); splicing live tail onto the snapshot (two representations, fragile dedup).

## 4. Work breakdown — implementation tasks

### Wave 1 (parallel, file-disjoint)

**T1 — Frontend un-freeze** — owns `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/rebuilt-mask.ts` (new).
Extract a pure helper (new file) deciding "does this incoming event invalidate the rebuilt snapshot?": given the snapshot metadata `{ sessionId, maxLiveEventIdAtSnapshot }` and an incoming event `{ id, runId, subagentId }` plus the current `rebuiltRunIds` set → boolean. In RunPanel: when storing `rebuilt`, also store the max id across current `mainEvents`; in the SSE delivery path (the batched flush that appends to `events`), if any appended main-stream event has `id > maxLiveEventIdAtSnapshot` and `runId ∈ rebuiltRunIds` → `setRebuilt(null)` (and clear `rebuildNote`). The rebuild effect must NOT immediately re-fire and re-mask: it currently only depends on `latestRun` fields, and after clearing, `latestRun` is unchanged — verify this holds and leave a comment. Acceptance: with a finished run whose session keeps emitting, live events render; when the newest run later resolves, the rebuild snapshot returns.

**T2 — Driver seams (claude-tmux)** — owns `src/bun/claude-tmux.ts` only.
(a) **Continuation adoption**: module-level injected factory `setContinuationRunFactory(fn: (taskId: string) => ContinuationHooks | null)` with `ContinuationHooks = { onChunk: ChunkSink; onAdopted: (handle: { done: Promise<number>; kill: () => void; writeInput: (line: string) => boolean }) => void }`. In `dispatchLine`, when a **new** (non-replayed — must pass the `seenLineUuids` dedup) content line (`user`/`assistant`/`thinking`/`tool_use`/`tool_result` mapped kinds) arrives while `!turnInFlight(state)` and the queue is empty: call the factory; on non-null, push a fresh turn slot wired to `hooks.onChunk`, resolve its `done` on that continuation's own end_turn (normal staging/idle-fire semantics apply), call `hooks.onAdopted(handle)` **before** dispatching the triggering line so registration precedes the first chunk; the triggering line then routes to the new slot. On null factory result, keep today's `lastChunk` fallback. Map the task-notification line itself to a `status` chunk (e.g. `background task finished — continuing`) rather than a fake user bubble.
(b) **Death-watch during hold**: injected `setHeldSessionProbe(fn: (taskId: string) => boolean)`; arm/keep the death-watch loop when `turnInFlight(state) || heldProbe(taskId)`. Existing two-miss threshold and death handling unchanged — on death the existing `signalSessionDeath` path already orphans subagents (#92).
(c) **Background-task settle signal**: injected `setBackgroundTaskSettledHandler(fn: (taskId: string, agentId: string) => void)`; when parsing a task-notification line, extract the finishing background agent/task id (inspect real transcripts under `~/.claude/projects/` for the exact shape — e.g. the screenshot task's session; be tolerant of absent ids) and invoke the handler. Follow the file's existing injected-setter idiom.

**T3 — DB layer + subagent watcher** — owns `src/bun/db.ts`, `src/bun/claude-subagents.ts`, `src/bun/migrations/0NN_run_origin.sql` (new; next free number), `src/bun/migrations/index.ts`, `src/shared/types.ts`.
(a) Migration: `ALTER TABLE runs ADD COLUMN origin TEXT` (`NULL` = user-initiated, `'continuation'` = auto). Thread through `runs.insert`/row mapping/`Run` type in shared types (optional field).
(b) `subagents` helpers: `markSettledById(agentId, status)` (idempotent: only flips rows still `running`; sets `ended_at`), plus whatever `orphanRunning*` variants the boot pass extension needs (check what #92 already added and extend, don't duplicate).
(c) Watcher: injected `setParkedDiscoveryHandler(fn: (taskId: string) => void)` — invoked when `discover()` inserts a running row (or flips one back to running) — orchestrator decides pull-back. Ensure the watcher keeps tailing while ANY running subagent row exists for the task (verify #92's module-level registry already guarantees this; fix if the watcher is torn down on parent-run resolution when the hold never engaged).
(d) `fireSettle` path: expose a settle entry point that `markSettledById` triggers so `maybeReleaseHeldTask` runs (wired by T4).

### Wave 2 (after wave 1 lands)

**T4 — Orchestrator + server wiring** — owns `src/bun/orchestrator.ts`, `src/bun/server.ts`.
(a) `startContinuationRun(taskId)`: mirror the idle branch (`orchestrator.ts:1242-1277`) minus `sendTurn`/user-line: insert run row with `origin:"continuation"` + inherited `claudeSessionId`, `tasks.update({column:"running", runId})` + `emitGlobal(column)` (pull-back from any prior column — continuations always run), emit a `status` chunk `auto-continued after background task`, return `ContinuationHooks` whose `onAdopted` does `registerActiveRun` + `attachDoneHandler`. Wire via `setContinuationRunFactory` at module init; return null for unknown/archived tasks.
(b) Wire `setHeldSessionProbe(taskId => isHeldByBackgroundAgents(taskId))` (already exists from #92 — reuse, don't re-derive).
(c) Wire `setBackgroundTaskSettledHandler` → `subagents.markSettledById(agentId, "completed")` → settle/`maybeReleaseHeldTask`.
(d) Wire `setParkedDiscoveryHandler` → pull card back to `running` **iff** `task.column === "review"` and its latest run `succeeded`; emit column GlobalEvent + a status event on the run.
(e) Boot reconciliation: extend the #92 boot pass — orphan `running` subagent rows whose task has no live tmux session; release/settle held tasks accordingly.
(f) `server.ts`: include `origin` in run serialization (and anything `/tasks/:id/subagents` needs for the settled statuses).

**T5 — Frontend polish** — owns `src/mainview/components/kanban/RunPanel.tsx` (wave 2 so it can't collide with T1).
Label continuation runs in the runs list (small "auto" chip off `run.origin === "continuation"`); sanity-check the heartbeat and Stop gating work with continuation runs (they should fall out of `status === "running"` + `active` registration untouched).

## 5. Work breakdown — test tasks (Phase 6, file-disjoint)

- **TT1** `src/mainview/lib/rebuilt-mask.test.ts` — pure-helper coverage: newer masked-run event invalidates; subagent events never invalidate; older/other-run events don't. (Covers T1.)
- **TT2** `src/bun/claude-continuation.test.ts` (new) — fake-driver/JSONL-fixture test: turn resolves → new content lines → factory called once, slot adopted, chunks route to new sink, continuation resolves on its own end_turn; replayed (deduped) lines do NOT trigger; null factory falls back to lastChunk. (Covers T2a.)
- **TT3** `src/bun/claude-tmux-death.test.ts` (extend existing) — death-watch stays armed while heldProbe true; session death during hold → sentinel + orphan path. Save/restore injected setters (peer gotcha `b7ff666a`). (Covers T2b.)
- **TT4** `src/bun/subagent-settle.test.ts` (new) — markSettledById idempotency; task-notification handler settles row + releases hold; parked-discovery pull-back only from `review`; boot pass orphans dead-session rows. (Covers T3/T4 c-e.)
- **TT5** `src/bun/orchestrator-continuation.test.ts` (new) — startContinuationRun end-to-end with fake driver: run row origin, column pull-back, active registration, done handling, follow-up fold into continuation run. (Covers T4a.)
- Migration smoke: covered by existing `migrate.test.ts` conventions — TT4 or TT5 asserts `origin` round-trips; don't edit applied migrations.

## 6. Execution waves

- Wave 1: T1 ∥ T2 ∥ T3 (disjoint: mainview files / claude-tmux.ts / db+subagents+migrations+shared-types) → typecheck checkpoint + commit.
- Wave 2: T4 ∥ T5 (orchestrator+server / RunPanel) → typecheck checkpoint + commit.
- Phase 5 review → Phase 6 tests TT1–TT5 (parallel, disjoint new/extended files) → Phase 7 run `bun test` + `bun run typecheck` → Phase 8 fixes.

## 7. Blast radius & risks

- `claude-tmux.ts` is the subtlest surface (staging/idle-fire/dedup/reattach). Continuation detection MUST ignore replayed lines (reattach re-tails from offset 0) or reattach would spawn phantom continuation runs — the `seenLineUuids` gate is the guard.
- Continuation-run creation changes `task.runId` → interacts with fold-vs-idle branch in `sendTurnInExistingSession` (desirable: follow-ups during a continuation fold into it) and with `/tasks/:id/runs` polling UI.
- Pull-back must not fight the user: only `review → running`, and only when triggered by genuinely-new activity.
- rebuilt-mask clear removes the truncation-repair view while a session is live; acceptable since current mapper doesn't truncate — the repair snapshot returns when the newest run resolves.
- Codex is inert by construction everywhere here (no subagents rows, no JSONL continuation lines) — assert nothing regresses via existing codex tests.
- Death-watch now probes `tmux has-session` during holds — slightly more tmux traffic; two-miss threshold already tolerates transients (#88).

## 8. Open questions / assumptions

- Task-notification JSONL shape: assumed to carry the finishing agent/background-task id; T2c must verify against real transcripts (claude 2.1.x) and degrade gracefully (no id → no settle signal, other signals still work).
- Assumed continuation turns should always pull the card to `running` regardless of prior column except archived (owner approved pull-back for `review`; continuation-run creation itself mirrors follow-up-turn behavior which already moves any column to `running`).
- Headless idle-shutdown hold-blindness (`headless.ts`) noted but OUT of scope this branch (surface in final report).
- Event-dedup key-collision under same-millisecond fan-out (webview finding 5) judged secondary; not addressed here.
