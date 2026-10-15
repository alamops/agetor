# Investigation — Non-blocking session restore (sending to a long-idle task freezes every other task and pipeline)

| Field | Value |
| --- | --- |
| Date | 2026-10-14 |
| Change | Sending a message to a long-idle (reaped) claude task "restores" it; while that runs, other task panels sit on `Loading messages…`, the board stops updating and pipeline views don't render. Decide what makes the restore non-blocking for every other operation in Agetor. |
| Agents | 0 (pipeline step forbids subagents — all reading and spikes done inline) |
| Flags | none |
| Branch | `fix/fix-agetor-blocking-after-restoring-idle` off `163c2a2` (main) |
| Prior art | `docs/plans/task-details-blank-while-session-restores.md` (#230, merged 2026-09-16) — left its §8 Q1 open: "why does the packaged app's resume resolve 5–31 s late while headless resolves in 38 ms". **This investigation answers Q1.** |

## 0. One-paragraph verdict

The restore is not slow; the **whole Bun main process is frozen** for the duration. On a claude resume (and on every fresh claude spawn and every boot reattach), `attachTailer` → `attachSubagentWatcher` rehydrates every subagent row the task ever had and, for each one, runs `runs.seenLineUuidsForSubagent(id)` — `SELECT line_uuid FROM run_events WHERE subagent_id = ? AND line_uuid IS NOT NULL`. `run_events.subagent_id` has **no usable index** (the only index carrying it is `(run_id, IFNULL(subagent_id,''), line_uuid)`, so the planner does `SCAN … USING INDEX run_events_run_sub_line_uuid` — a full walk of the 97 MB partial index). On the owner's 4.56 GB production DB one scan costs 1.2 s warm / 4.6 s cold, and `bun:sqlite` runs it synchronously on the main thread, inside the spawn path, *after* #230's three timed launch stages and *before* the `ready` status line. A session that spawned 96 subagents therefore blocks the process for ~105 s; nothing else — HTTP routes, SSE, other sessions' JSONL tailers, tmux ops, pipeline runner — runs until it finishes. The previous fix (bounded spawn await, stream-first panel) could not help because it assumed an idle server starved by a held connection; here the server itself is busy.

## 1. What we know

### 1.1 The send path and where the freeze sits
- `POST /runs/:id/input` → `sendInput` (`src/bun/orchestrator.ts:3363`). Before any per-kind dispatch it awaits `pendingTeardown`, may **restore a missing worktree** via `prepareWorkdir` (`:3415`, async git, unbounded hold on the HTTP response), expands `@` tokens, then for claude calls `sendClaudeTurn` (`:5343`) → `sessionLiveness` probe → dead session → `spawnResumedSession` (`:5780`). That inserts the run row, flips the column to `running`, emits the `user` chunk and the `resuming claude session …` status (`:5841`), then races the spawn against `SPAWN_RESPONSE_BUDGET_MS` = 1.5 s (`:5924`, constant at `src/shared/types.ts:4459`) and answers `{ delivered: true, runId, pending: true }` if it hasn't settled — the #230 design, intact and working.
- The detached continuation runs `spawnAgentOrFail` (`:1064`) → `spawnAgent` (`src/bun/agents.ts:2454`) → `spawnClaudeViaTmux` (`src/bun/claude-tmux.ts:7932`). The three awaited pre-launch stages (`killTaskSession`, `ensureInstalledForCwd`, `ensureDisclaimedServer` + `tmux new-session`) are timed (`:7983–7998`) and emit `session launch took …` past 5 s. **That breadcrumb has never fired on the owner's machine** (zero rows in `run_events`), and the installed `/Applications/Agetor.app` bundle does contain it — so the three stages are fast; the time is elsewhere.
- After the stages, the boot IIFE calls `waitForJsonlAt` (`:3345`; returns immediately on a resume since the file exists), then **`attachTailer(state)` and only then the `ready` status** (`:8475–8476`). `attachTailer` (`:7810`) → `attachSubagentWatcher` (`:7831`, impl `src/bun/claude-subagents.ts:1628`), whose rehydrate loop iterates `subagentsDb.listForTask(taskId)` — every row, any status — and seeds `seen: runs.seenLineUuidsForSubagent(row.id)` per row (`:1908`), plus `hasLineUuidPrefixForSubagent` for monitor rows (`:1841`; same unindexed shape). This loop is synchronous by design (comment at `~:1740`: "runs synchronously inside reattachSession/the spawn IIFE").
- The query: `src/bun/db.ts:2889–2896`; its sibling `hasLineUuidPrefixForSubagent` `:2903–2908`. Index inventory on `run_events`: `idx_run_events_run (run_id, id)`, `run_events_run_sub_line_uuid (run_id, IFNULL(subagent_id,''), line_uuid) WHERE line_uuid IS NOT NULL` (migration `022_subagents.sql`), `idx_run_events_user_history (stream, id DESC) WHERE subagent_id IS NULL` (`039`). Nothing leads with `subagent_id`.
- Same loop, same cost, on three more entry points: every **fresh claude spawn** (`startTaskInner` → `spawnAgentOrFail` → `attachTailer`), **boot reconciliation** (`reconcileOrphans` → `reattachSession` `src/bun/claude-tmux.ts:8521` → `attachTailer`; seeded at `orchestrator.ts:823–861`), and the boot **held-task re-arm** that calls `attachSubagentWatcher` directly (`orchestrator.ts:987`, `:1020`). Boot with N live sessions pays N × (subagents × scan).
- Introduced by #81 (`4b650dc`, 2026-07-01, "track background agents as read-only stream tabs"), extended by #89 and #193. It was instant then: the cost is proportional to `run_events` size, which has since grown to 897,304 rows / 3.85 GB.
- Kill switch exists: `AGETOR_TRACK_SUBAGENTS=0` disables the watcher entirely (`claude-subagents.ts:366`; `WORKFLOWS`/`BG_SHELLS`/`MONITORS` flags at `:380/:394/:410`). It is an env var, not a preference, so the packaged app can't flip it.

### 1.2 Production evidence (read-only queries on `~/.agetor/agetor.sqlite`, 2026-10-14)
- DB 4.56 GB (+3.4 MB WAL). `run_events` 897,304 rows, 3.85 GB of `data`; 866,037 rows carry a `line_uuid`, 466,301 of them subagent rows. `runs` 10,711; `tasks` 1,310 (1,227 archived — events are never pruned, no retention code exists); `subagents` 5,902 (top tasks: 208, 140, 109, 107, 80, 78 rows).
- Resume gap (`resuming claude session …` → `claude session … ready`, same run) with the number of events **other runs** wrote during the gap and in the 2 s after it:

| Started (EDT) | Gap | Subagents on that session | Other-run writes during gap | Other-run writes in next 2 s |
| --- | --- | --- | --- | --- |
| 10-14 19:20:54 | **105.0 s** | 96 (dir) | 0 | 39 |
| 10-14 19:20:42 | 0.03 s | 0 (no session dir) | 0 | 0 |
| 10-14 19:18:56 | 13.2 s | 4 | 0 | 4 |
| 10-14 17:37:09 | 0.1 s | 0 | 2 | 2 |
| 10-14 17:19:40 | 64.2 s | 58 | 3 (all within the first 0.3 s) | 92 |
| 10-14 16:58:53 | **209.1 s** | — | 1 | 221 |
| 10-14 15:56:25 | 77.6 s | — | 0 | 56 |
| 10-14 13:09:30 | 171.6 s | — | 0 | 110 |
| 10-13 23:10:52 | 129.2 s | — | 0 | 63 |
| 10-13 19:55:48 | 112.3 s | — | 0 | 287 |
| 10-13 18:17:04 | 113.2 s | — | 0 | 10 |

  Gap ≈ 1.1 s × subagent count. Every long gap has zero cross-run writes inside it and a burst right after: the process was stopped, not waiting. The screenshot in the task (`screenshot-2026-10-14_23-22-41-…png`, named in UTC by `server.ts:5931`) was taken at 19:22:41 EDT — **2 s after the 105 s window ended**; it shows a *codex* task (`Record Window or Application`) stuck on `Loading messages…` with `No runs yet for this task.` because neither `listRuns` nor the SSE replay could be answered.
- `pmset -g log` shows no sleep/wake in the window; the stall is not the machine napping. `/health` was never probed during it (no probe armed), but the DB evidence is sufficient.

### 1.3 Why the client looks the way it does
- Webview requests have **no per-request timeout**: `fetchWithRecovery` (`src/mainview/lib/net-retry.ts:132`) only aborts the `/health` probe (1.5 s) after a *transit* failure; a request the server accepted but never answers hangs forever. So `listRuns`/SSE replay/`GET /tasks`/`GET /tasks/:id/pipeline` all sit until the stall ends — `Loading messages…` (`RunPanel.tsx:3975`), a stale board (`App.tsx:645/783` polls dedupe in flight, so no error surfaces), a blank pipeline run view (`PipelineRunView.tsx`, 2 fetch sites). Nothing tells the user the core is busy.
- `RunPanel.tsx:4931` renders `No runs yet for this task.` on `runs.length === 0` without the `runsLoaded` gate that the transcript uses — so the two contradictory lines in the screenshot are a small, separate UI nit.
- The WKWebView ~6-connection budget from #230 still applies and compounds: every request issued during the stall holds a connection; after the stall they all complete in a burst.

### 1.4 Things that are fine (measured, so the plan doesn't chase them)
- The other hot DB paths on the same DB: panel replay walk (`eventsForTask` newest-first 3,000-row byte walk on the 75,277-event task) 40 ms; `lastUserEventId` 0 ms; biggest run's main-stream load 0 ms; the full `tasks` table read behind the 2 s board poll 10 ms; `seenLineUuidsForTask` (the main-stream seed, `db.ts:2875`) is run-indexed. The DB is not generally slow — one query shape is.
- The subagent watcher's first cycle re-reads every subagent transcript synchronously (`readAppendedSync` `claude-subagents.ts:712`, `cycle` `:3695` with `tailAll = firstCycle`) — measured 271 ms for 48 files / 99 MB plus 78 ms for the 29 MB main JSONL. Sub-second; not the problem. (It runs on the first `tick`, `:3782`, after `ready`.)
- `flush` (`claude-tmux.ts:4778`) reads the main JSONL asynchronously; `resumeJsonlOffset` (`:3384`) parks the cursor at EOF on resume, so the main stream is not replayed.
- No remaining `spawnSync`/`execSync` on the send/spawn path: `login-path.ts` runs once at boot (2 s cap), `git-provider.ts`'s `ssh -G` is 750 ms-capped and cached, `tmux()` moved off `spawnSync` in #213.
- `agetor` CLI, TUI and the webview all go through the same HTTP API, so they freeze identically; there is no second process that could keep serving.

## 2. What we proved (spikes, scratchpad only, read-only on real data)

| Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Is one `seenLineUuidsForSubagent` call expensive on the real DB? | **Yes** | `sqlite3 -readonly` count for one subagent: `real 4.62 s` cold, `real 1.21 s` warm; `EXPLAIN QUERY PLAN` → `SCAN run_events USING INDEX run_events_run_sub_line_uuid` (97 MB index) | sqlite3 CLI on `~/.agetor/agetor.sqlite` (4.56 GB) | shell, see §1.2 |
| Does 96 × that cost explain the 105 s gap? | **Yes** | 96 subagent rows × ~1.1 s = 105 s; 58 × 1.1 = 64 s (observed 64.2 s); 0 subagents → 30–100 ms | same | same |
| Does a partial index make it instant, and what does building it cost? | **Yes / cheap** | Scratch DB holding the 866,162 keyed rows (4 columns): without index 377 ms / 366 ms per call; `CREATE INDEX … ON run_events(subagent_id, line_uuid) WHERE subagent_id IS NOT NULL` built in 346 ms; after: `SEARCH … USING COVERING INDEX`, **0.1 ms / 0.0 ms** per call. Caveat: on the real table the build must scan 4.2 GB of row pages (a warm full-table pass measured 0.31 s on the index-only predicate; expect seconds-to-tens-of-seconds cold) — a one-time migration cost at boot | Bun 1.3.x `bun:sqlite` | `<scratchpad>/spikes/subagent-index/spike.ts` (`scratch.sqlite` beside it) |
| Do the no-migration query shapes work? | **Run-scoped: yes; batched: partial** | `WHERE run_id = ? AND subagent_id = ?` → 0.00 s (uses the unique index prefix). One batched per-task query (`JOIN runs … task_id = ? AND subagent_id IS NOT NULL`) → 3.16 s (96-subagent task) / 1.10 s (208-subagent task) — it reads every event row of the task, so it still blocks for seconds | sqlite3 CLI | shell |
| Is the first-cycle transcript replay a second stall? | **No** | read+`JSON.parse` of all 48 subagent JSONLs (99 MB, 11,266 lines): 271 ms; main JSONL (29 MB, 5,872 lines): 78 ms | Bun | `<scratchpad>/spikes/transcript-read/spike.ts` |
| Is the installed app the code I read? | **Yes** | `/Applications/Agetor.app/Contents/Resources/app/bun/index.js` contains `session launch took` (1), `raceSpawnBudget` (4), `seenLineUuidsForSubagent` (2) and the literal `WHERE subagent_id = ? AND line_uuid IS NOT NULL`; pid 775 is that bundle | — | — |

Not spiked (would need a throwaway dev instance against a DB copy + real claude launches on the owner's quota): an end-to-end `/health`-latency trace during a real resume. The DB timeline (§1.2) already shows the process-wide stop, so this was not load-bearing.

## 3. What we're assuming

- **The sqlite3 CLI timing transfers to `bun:sqlite` in the app.** Same engine and plan; the app's default `cache_size` is smaller than the CLI's, so in-app cost is the same or worse. If wrong, the gap/subagent correlation still stands on its own.
- **The webview's connection cap is 6 and unchanged** (from #230's observation). Only affects how the post-stall burst looks, not the root cause.
- **Nothing besides the subagent seeding scales with `run_events` size on the spawn path.** Audited every `FROM run_events` query in `db.ts` (§1.4): all others lead with `run_id`/`task_id` via an index. A new query added later with the same shape would reintroduce the stall — argues for an event-loop-lag breadcrumb (§4 Q3).
- **Subagent rows always carry the `run_id` their events were persisted under** (`FileState.runId` captured at discovery, `claude-subagents.ts`). This is what the run-scoped query rewrite depends on; rows with `run_id NULL` fall back to the task's current run and could miss history. The index approach has no such dependency.
- **Owner's data is representative**, not an outlier: 5,902 subagent rows across 1,310 tasks, several tasks with 100–200 subagents, and 10+ live sessions — any heavy claude user hits this within weeks.

## 4. What we must ask the owner (for Grilling)

1. **Fix shape.** (a) New migration adding a partial index on `run_events(subagent_id, line_uuid) WHERE subagent_id IS NOT NULL` — query untouched, 0.1 ms per seed, but a one-time index build over a 4.2 GB table on first boot after upgrade (seconds to tens of seconds, during which the splash sits; the migration runner applies it inside one transaction at module load). (b) Rewrite the seed as run-scoped (`run_id = ? AND subagent_id = ?`) — no migration, instant, but changes semantics for `run_id NULL` rows / cross-run resumes. (c) Both: index for correctness-preserving speed, plus a batched one-query seed. Which boot cost / semantic risk is acceptable? Recommendation: (a), optionally plus a progress line on the splash.
2. **Structural guarantee, not just this query.** Should the rehydrate loop also stop running synchronously inside the spawn path (e.g. seed lazily on first tail of each file, or yield between rows, or move the loop into the first `tick`), so the next O(DB) query cannot freeze the process even if it slips in?
3. **Observability.** #230's breadcrumb names a slow *stage*; this stall sat outside every timed stage and only the DB timeline revealed it. Do we want an event-loop-lag monitor in the core (sample a timer every ~500 ms; log/emit one `status`/console line naming the lag and the task being attached when it exceeds, say, 2 s)? Low cost; would have named this in one occurrence.
4. **Boot.** `reconcileOrphans` reattaches every live claude session sequentially with the same per-subagent cost (and the held-task re-arm at `orchestrator.ts:987/:1020` repeats it). Is "boot must not take minutes on a big DB" in scope for this run, or a follow-up? (The index fixes it for free; the lazy/yielding option would need the same treatment there.)
5. **Secondary holds on the send request.** `sendInput` still holds the HTTP response across `pendingTeardown`, a worktree restore (`git worktree add` on a big repo), the codex CLI-version probe and `sessionLiveness` before the bounded spawn begins. These don't freeze the core but do occupy one of the webview's ~6 connections. Bound them the same way (`pending: true` earlier), or leave as is?
6. **Client-side honesty during a stall.** Today a hung request shows `Loading messages…` forever and the board silently goes stale. Do we want a per-request timeout with a "core is busy" notice (and keep `retry: false` semantics for mutations), or is fixing the server enough? Also: fix the `No runs yet for this task.` gate (`RunPanel.tsx:4931`) to respect `runsLoaded`?
7. **Data retention.** 1,227 archived tasks keep 100 % of their events; the DB is 4.56 GB and every full-scan-shaped query scales with it. Prune/compact events for archived tasks (or cap per task), or leave retention out of this run? (Separate ticket is reasonable; flagging because it is the multiplier.)
8. **Acceptance bar.** Proposed: resuming/starting/reattaching a task with 200 subagent rows on a DB the size of the owner's emits `ready` within 2 s and never delays `/health` beyond 100 ms; pinned by a `bun:sqlite` unit test that seeds ~500 k keyed rows and asserts both the query plan (`SEARCH`, no `SCAN`) and wall time. The existing e2e (`e2e/task-switch-during-restore.spec.ts`) uses the fake driver, which never reaches `attachTailer`, so it cannot cover this — accept a unit/integration test as the regression pin, or do we want an e2e seam that runs the real watcher against a seeded DB?
9. **Kill switch as a preference?** `AGETOR_TRACK_SUBAGENTS=0` exists only as an env var. Worth a Settings toggle as an escape hatch, or no?

## 5. Completeness inventory

- **Callers of the slow query:** `runs.seenLineUuidsForSubagent` — `claude-subagents.ts:1908` (rehydrate loop, every row). `runs.hasLineUuidPrefixForSubagent` — `:1841` (rehydrate, monitor rows), `:1421` (per monitor event on a `completed` row). Both in `db.ts:2889–2908`.
- **Callers of the rehydrate loop (`attachSubagentWatcher`):** `claude-tmux.ts:7831` (`attachTailer` ← `spawnClaudeViaTmux:8475` fresh/resume, `reattachSession:~8575` boot); `orchestrator.ts:987`, `:1020` (boot held-task re-arm). Indirect: every path that spawns claude — `startTaskInner`, `spawnResumedSession`, pipeline step launches, `fx`-style none.
- **Propagation surface of a schema change:** `src/bun/migrations/` (next id `067_…`, append to `migrations/index.ts`), `db.ts` query text, the `run_events` type docs in `CLAUDE.md` (Persistence section lists indexes/columns), `docs/plans/task-details-blank-while-session-restores.md` §8 Q1 (now answered). No API/JSON shape changes.
- **Existing data a migration touches:** `run_events` 897 k rows (466 k with `subagent_id`), one index build; nothing to backfill. Dev DB `~/.agetor-dev` and test `mkdtemp` DBs get it on first open.
- **Docs/config describing current behavior:** `CLAUDE.md` (boot reconciliation + `seenLineUuids` paragraphs, Persistence section), `docs/plans/task-details-blank-while-session-restores.md` (§2 "The Bun server does not stall" — true for the case it measured, now needs a pointer), `docs/plans/fix-task-details-load-delay.md` (#213 sync-spawn removal).
- **Tests near the seam:** `src/bun/claude-subagents*.test.ts` (5 files, `manual: true` + `pump()`), `src/bun/db-events-*.test.ts`, `src/bun/orchestrator-spawn-budget.test.ts`, `src/bun/event-loop-responsiveness.test.ts` (drift harness from #213), `e2e/task-switch-during-restore.spec.ts` (fake driver — bypasses the watcher).
- **What the change would orphan:** nothing; the slow-launch breadcrumb stays useful for the stages it covers.

## 6. Runnability

- Start locally: `bun install` (fresh worktree), `bun run dev:hmr` (Vite + Electrobun; `AGETOR_DATA_DIR=$HOME/.agetor-dev` — never the prod dir); headless core for CLI/e2e via `src/bun/headless.ts`. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` first in agetor worktrees.
- Tests: `bun run typecheck`; `bun test` (set `AGETOR_DATA_DIR` to a `mkdtemp` dir in `beforeAll`; never `rmSync` a live `agetor.sqlite`); single file `bun test src/bun/claude-subagents.test.ts`. Known pre-existing failures on main: two tmux-socket tests + one reconcile-cancel test.
- E2E: Playwright, `bun node_modules/@playwright/test/cli.js test [spec]` — one run at a time; fixtures boot a headless daemon per worker with fake drivers (`AGETOR_CLAUDE_DRIVER=fake`, `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS`, `test.use({ backendEnv })`).
- Reproducing the stall for real needs a dev instance pointed at a copy of a large DB and a task with many subagent rows; a unit test can reproduce the query cost with ~500 k seeded rows.

## 7. Risks & blast radius

- **Migration on a 4.5 GB DB** runs inside the boot-time migration transaction: the app is unresponsive (splash) until the index exists; a crash mid-build rolls back and retries next boot. Needs a measured number before shipping (build on a copy of the owner's DB, cold cache) and possibly a progress hint.
- **Query rewrite risk:** run-scoped seeding can miss uuids persisted under a different `run_id` → duplicate subagent events on reattach (the DB-side unique index still blocks duplicate rows, but the in-memory emit dedupe would not).
- **Boot and pipelines:** the same loop runs at boot and on every pipeline step launch (steps are claude spawns); fixing the query fixes all three; a "yield between rows" change touches a loop whose synchronous-ness other code relies on (comment at `claude-subagents.ts:~1740`) — keep the DB-seeded `seen` semantics intact.
- **Rollback:** an added index is harmless to older builds; a query rewrite is a one-file revert.
- **Do not** add the index to the production DB by hand to "test" — the running app holds it; use a copy under the scratchpad or `~/.agetor-dev`.
