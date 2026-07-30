# Plan — Reduce Agetor CPU and Memory

| Field | Value |
| --- | --- |
| Date | 2026-07-29 |
| Source | /implement "Agetor is using a bunch of memory and CPU… a bunch of `node` processes" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/reduce-agetor-cpu-and-memory |
| Base SHA | ce9177b34816982f2aeebbba15fefb8dde8bd827 |

## 1. Objective & success criteria

Make Agetor stop accumulating idle agent processes and stop doing unbounded/continuous background work.

Success criteria:
- No claude REPL (the "node" processes, ~300–500MB each) survives more than ~30min past its last activity when no turn is in flight and no prompt is pending. Follow-ups on reaped tasks still work via `claude --resume`.
- The Bun main process's idle CPU drops materially (target: from ~3.7% toward <1% with no running tasks) — per-session timers stop multiplying with lingering sessions, hot routes stop doing per-row scans.
- Opening a task with thousands of events replays a bounded recent window (~800 events) instead of full history; "Load earlier" pages backward on demand.
- The webview stops re-rendering the full board every 2s when nothing changed, and pauses polling while the window is hidden.
- `bun run typecheck` and `bun test` green.

Owner decisions (recorded 2026-07-29): reap after ~30min idle; history cap **with** "Load earlier" button; disk/worktree/DB retention **out of scope** (peer task owns the Worktrees stale-modal surface).

## 2. Context & constraints (grounded findings)

**Root cause A — sessions and their timers only die on delete/archive/agent-switch.**
- `attachDoneHandler` (`orchestrator.ts:956-1022`) never drops the session on run finish; app quit (`index.ts:323`) never touches tmux. Idle REPLs live forever (observed: two ~23h-old sessions, 6 total, 280–520MB RSS each).
- Each lingering claude session keeps running: `scrapeTimer` — sync `Bun.spawnSync(tmux capture-pane)` every 2–10s (`claude-tmux.ts:3407,3236,972`); `pollTimer` — 400ms JSONL stat backstop (`claude-tmux.ts:3634`); `deathTimer` — 400ms (idle-gated, cheap; `claude-tmux.ts:3591-3620`); subagent watcher — `readdirSync` every 4s (`claude-subagents.ts:69-73,636-641`). All disposed only via `disposeSessionState` from `dropSession`.
- The scraper must NEVER be fully stopped while a session lives: native AskUserQuestion writes no JSONL — a prior bug (knowledge entry 6e8074e3) was caused by hard-stopping the idle scraper. Bounding session lifetime via the reaper is the fix, not stopping the scraper.
- Resume path already exists: `sendClaudeTurn` (`orchestrator.ts:1504`) falls back to `spawnResumedSession` (`orchestrator.ts:1681`) using persisted `runs.claude_session_id` → `claude --resume <id>` (`agents.ts:305-306`). Kill must go through `dropSession` (dispose-then-kill) so `hasSessionState` turns false and the death-watch can't misfire.
- HARD RULE: never enumerate-and-kill `agetor-*` sessions (shared tmux socket; commits 3204c4f, b9fcd68). Every kill keyed to a task id from THIS instance's DB.
- Codex needs no reaping — sessions are one-shot per turn and self-dispose (`codex-tmux.ts:329-342`).

**Root cause B — hot routes do full-history synchronous work.**
- `GET /tasks` every 2s: `tasks.list()` (`db.ts:195-201`) joins all tasks × all runs (2,131), and `toTask` (`db.ts:153-182`) calls `countPendingForTask` + `countTerminals` per row (two linear map scans × 289 tasks per poll).
- SSE replay `runs.eventsForTask` (`db.ts:738-749`) has no LIMIT (worst task: 4,764 events; 134k rows / 201MB total) and `runs.task_id` has no index (only `idx_run_events_run` exists).

**Root cause C — webview renders everything, always.**
- `App.tsx:122-128,168`: unconditional 2s `setTasks(list)` with fresh identities, no equality guard; `setSelected(fresh)` force-renders the open RunPanel every tick (`App.tsx:178-182`). No `React.memo` on `Column`/`TaskCard`; handlers (`App.tsx:463-562`) re-created every render. `/harnesses` poll every 15s (`App.tsx:129-135,169`). No visibility gating anywhere.
- RunPanel: 2s `/runs` poll (`RunPanel.tsx:362-374`) and 2s `/subagents` poll (`RunPanel.tsx:380-400`) run even for finished tasks / hidden window. `events` state unbounded (`RunPanel.tsx:258,436`). June fixes (memoized blocks, section useMemo, rAF-batched buffer with visibility flush — `lib/event-buffer.ts`) are present; keep them intact.
- Prior bug constraint: WKWebView suspends rAF when occluded (knowledge entry 2955efba) — any visibility gating MUST refresh immediately on `visibilitychange`→visible/focus, mirroring the existing `flushNow` wiring (`RunPanel.tsx:474-477`).

## 3. Approach & key decisions

1. **Idle-session reaper** (solves RAM + most idle CPU at once): a periodic orchestrator sweep, candidates strictly from own DB, killed via `dropSession`. Covers both in-memory sessions (live `SessionState`) and orphan-alive sessions with no in-memory state (post-restart done/review tasks — the 23h-old case) by probing `sessionLiveness(sessionNameFor(task.id))` per own-DB task id (allowed: keyed probe, not an enumerate sweep).
   - Idle source: new `lastActivityAtFor(taskId)` on `SessionState` (bumped on JSONL bytes, scrape change, turn start/end, user paste); fallback `task.updatedAt` when no in-memory state.
   - Guards (all must pass): agent is claude-code; task not archived-pending; `!active.has(task.runId)`; not held by background agents; zero pending interactions for the task; idle ≥ `IDLE_SESSION_REAP_MS` (30min). Re-check guards immediately before the kill.
   - Emits a `status` event on the task's latest run ("session hibernated after idle — next message resumes it") for visibility.
   - Cadence: sweep every 5min (`index.ts` interval, after `reconcileOrphans` at boot). Never touches codex sessions.
2. **Session timer hygiene** (for the ≤30min window a session is alive but idle): back the 400ms `pollTimer` off to 5s after 30s of JSONL quiet (fs.watch stays primary; any watch event or turn start resets to 400ms). Slow the subagent watcher to 10s when idle with no subagents ever discovered. Scraper ladder unchanged (AskUserQuestion constraint). Death watch unchanged.
3. **Route/db work**: compute pending-interaction and terminal counts as grouped maps once per `/tasks` request instead of per-row scans; add migration `026_runs_task_id_index.sql` (`CREATE INDEX idx_runs_task ON runs(task_id)`); `eventsForTask` gains `{ beforeId?, limit? }` — SSE replay sends only the most recent `EVENTS_REPLAY_LIMIT` (800) events plus a `replay_meta` frame (earliest replayed event id + hasMore); new route `GET /tasks/:id/events/page?beforeId=&limit=` returns older pages (raw JSON array, newest-last).
4. **Webview**: equality-guard `setTasks`/`setSelected` (per-task shallow compare on `updatedAt`+identity fields, keep previous object identities for unchanged tasks); `React.memo` on `Column`+`TaskCard` with `useCallback` handlers; pause all polls when `document.hidden`, immediate refresh on visible/focus; RunPanel stops `/runs`+`/subagents` polls when the latest run is terminal and no subagent is running (SSE + visibility-return re-arm); consume `replay_meta` → "Load earlier" button prepends pages; cap live `events` growth at `EVENTS_WINDOW_MAX` (3000) by trimming oldest and marking hasMore.
5. Shared constants/types (`IDLE_SESSION_REAP_MS`, `EVENTS_REPLAY_LIMIT`, `EVENTS_WINDOW_MAX`, `replay_meta` type) land in `src/shared/types.ts` in a pre-wave commit by the orchestrator so no two agents touch that file.

Alternatives considered: replacing 2s polling with pure SSE push (bigger blast radius, App.tsx already keeps `selected` in sync from polls — deferred); stopping the idle scraper entirely (rejected — regresses the post-review AskUserQuestion bug); keep-N-warm LRU sessions (unneeded complexity at 30min threshold).

## 4. Work breakdown — implementation tasks

**Wave 0 (orchestrator inline):**
- **T0** — shared constants/types. Owns: `src/shared/types.ts` only. Add `IDLE_SESSION_REAP_MS`, `SESSION_REAP_SWEEP_MS`, `EVENTS_REPLAY_LIMIT`, `EVENTS_WINDOW_MAX`, `TASK_EVENTS_REPLAY_META` type/marker. Acceptance: typecheck green.

**Wave 1 (3 agents, disjoint):**
- **T1 — session timer hygiene + idle metadata.** Owns: `src/bun/claude-tmux.ts`, `src/bun/claude-subagents.ts`. Add `lastActivityAt` tracking on `SessionState` + export `sessionIdleInfo(taskId): { idleMs: number } | null`; pollTimer idle backoff (400ms→5s after 30s quiet, reset on watch event/turn); subagent watcher idle backoff (→10s). Must NOT change scraper ladder, death watch, or any kill path. Acceptance: exports exactly `sessionIdleInfo` as specified; existing tests pass.
- **T2 — routes + db paging.** Owns: `src/bun/server.ts`, `src/bun/db.ts`, `src/bun/interactions.ts`, `src/bun/terminals.ts`, `src/bun/migrations/026_runs_task_id_index.sql`, `src/bun/migrations/index.ts`. Grouped `pendingCountsByTask()` / `terminalCountsByTask()` consumed by the `/tasks` route via `tasks.list()` (thread maps into `toTask` or map after); migration for `idx_runs_task`; `eventsForTask(taskId, { beforeId, limit })`; SSE replay capped at `EVENTS_REPLAY_LIMIT` + `replay_meta` first frame; new route `GET /tasks/:id/events/page`. Do not touch orchestrator.ts.
- **T3 — webview board.** Owns: `src/mainview/App.tsx`, `src/mainview/components/kanban/Column.tsx`, `src/mainview/components/kanban/TaskCard.tsx`. Equality guard preserving object identity for unchanged tasks; memo + useCallback; visibility gating of `/tasks` + `/harnesses` polls with immediate-refresh-on-visible. Do not touch RunPanel.

**Wave 2 (2 agents, disjoint; depends on Wave 1):**
- **T4 — idle-session reaper.** Owns: `src/bun/orchestrator.ts`, `src/bun/index.ts`. `reapIdleSessions()` per §3.1 (uses T1's `sessionIdleInfo`, existing `dropSession`, `sessionLiveness`, `sessionNameFor`, `interactions.countPendingForTask`, `subagents.hasRunning`); wire 5min interval + post-boot sweep in `index.ts`; status event on reap. Never enumerate tmux; never touch codex.
- **T5 — RunPanel history window + poll gating.** Owns: `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/api.ts`. Consume `replay_meta`; "Load earlier" button → `GET /tasks/:id/events/page` prepend (keep dedup + section memo correctness); cap live `events` at `EVENTS_WINDOW_MAX`; stop `/runs` + `/subagents` polls when latest run terminal & no running subagents (re-arm on SSE run-status/subagent events and on visibility return); visibility-gate both polls.

## 5. Work breakdown — test tasks

- **TT1** (covers T4): `src/bun/session-reaper.test.ts` — reaper guards: skips in-flight run, pending interaction, held-by-subagents, young session; reaps stale one (fake driver `AGETOR_CLAUDE_DRIVER=fake`, temp `AGETOR_DATA_DIR`, no real tmux); reap → `hasSessionState` false → follow-up routes to resume path.
- **TT2** (covers T2): `src/bun/db-events-paging.test.ts` — `eventsForTask` limit/beforeId semantics, replay meta boundary (exactly-limit, fewer-than-limit, paging to exhaustion), migration applies idempotently.
- Webview has no test harness in-repo — T3/T5 verified by typecheck + `bunx vite build` + manual smoke.

## 6. Execution waves

- Wave 0: T0 (orchestrator, inline) → commit.
- Wave 1: T1 ∥ T2 ∥ T3 → typecheck + test → commit.
- Wave 2: T4 ∥ T5 → typecheck + test → commit.
- Then: review (opus) → tests creation (TT1 ∥ TT2, sonnet) → run (haiku) → fixes.

## 7. Blast radius & risks

- Reaper kills a session the user was about to reply to → mitigated by 30min threshold + pending-interaction/in-flight guards + status event + working `--resume` fallback; worst case is a few seconds' cold start.
- Legacy tasks with no `claude_session_id` on any run degrade to a fresh context-less session after reap (`orchestrator.ts:1674-1676` already tolerates) — reaper logs a warning status in that case.
- Replay cap: DiffDialog/compose flows read live state, not replay — unaffected. Dedup keys (`event-dedup.ts` caps) remain valid with windowed events.
- Poll gating on hidden window: must not regress the "freezes until nudge" fix — every gate pairs with an immediate visible/focus refresh.
- `bun test` on shared tmux socket: reaper tests must use the fake driver / test socket (`AGETOR_TMUX_SOCKET`), temp data dir — never the user's real socket/repo.
- Peer overlap: a peer task is fixing the Worktrees stale-modal delete button — this plan does not touch `worktrees/*` UI or `archiveTask`/`deleteTask` semantics.

## 8. Open questions / assumptions

- Assumed 800 as the replay window and 3000 as the live cap (owner approved "cap + load earlier" without exact numbers; constants centralized in T0, trivial to tune).
- Assumed reap sweep every 5min is fine (not asked; bounded staleness 30–35min).
- Assumed emitting a status event on reap is desirable visibility (investigation recommendation; harmless).
