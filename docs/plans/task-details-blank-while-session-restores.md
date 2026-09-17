# Plan — Task details blank while another task's session restores

| Field | Value |
| --- | --- |
| Date | 2026-09-16 |
| Source | `/implement` request: "fix agetor performance when opening a task details, while Agetor is working to restore an old session for another task … opening other task details modals is broken, opening a blank task details modal … it seems Agetor is working in single-thread" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | `fix/agetor-task-details-stuck-while-task-ses` |
| Base SHA | 857bef3 |

## 1. Objective & success criteria

Opening task B's details while task A is restoring a reaped claude session (`sendInput` → `spawnResumedSession` → `claude --resume`) must render B's transcript within ~1 s, independent of how long A's restore takes. Nothing that works today may regress (sending, folding, stop, delete, backlog, drafts, terminals, replay paging).

Done means:
1. `POST /runs/:id/input` and `POST /tasks/:id/start` never hold their HTTP response on a slow agent spawn — the response arrives once the run row and the user event are persisted (bounded wait, see §3.1).
2. The details panel establishes its event stream **first** on a task switch and carries **no state from the previous task** (`sending`, `runs`, busy flags, git/PR status, terminals).
3. The replay burst, the rebuild snapshot and the "Load earlier" page are bounded in **bytes**, not only in event count.
4. Polls never pile up: a tick is skipped while the previous request is in flight.
5. A slow launch is *visible*: the run gets one status line naming the slow stage, and the daemon log carries per-stage timings.
6. The regression is pinned by a Playwright spec (slow fake spawn on A, open B, B renders) and unit tests for every server change.
7. CLAUDE.md no longer claims `RunPanel` remounts per task.

## 2. Context & constraints (Phase 1 findings)

Measured, not inferred:

- **The Bun server does not stall.** Two spikes (headless daemon, real claude 2.1.273 + tmux 3.6a on a private socket): "resuming" → "session ready" in 24–38 ms, `POST /runs/:id/input` in 33–41 ms, 1,077 `/health` probes at 100 ms with a 28 ms max, both on PATH Bun 1.3.10 and the app's bundled Bun 1.3.13. `tmux` on the owner's shared socket: 5–10 ms per command; a pane flooding 13 MB at boot does not delay the launch client. PR #213's async conversion is present in the installed 0.1.8 bundle.
- **But the owner's app holds the send for the whole restore.** In `~/.agetor/agetor.sqlite`, 7 of the last 9 claude-code resumes show 4.9–31 s between the `resuming claude session …` and `claude session … ready` status rows (fresh starts: 0.6–3 s). Claude's own JSONL proves claude booted and wrote the prompt line 1.5–3.5 s after "resuming" (`src/bun/claude-tmux.ts:6605` `spawnClaudeViaTmux`; ready is emitted at `:7050`, microtasks after `tmux new-session` resolves because `waitForJsonlAt` (`:2866`) short-circuits on an existing file). So 20–28 s elapse inside the packaged app between issuing the spawn and its promise resolving — and `sendInput` (`src/bun/orchestrator.ts:2644`) awaits that chain, so the HTTP response is held just as long. Root cause of the delay itself is still open (§8 Q1); it does not reproduce headless.
- **The webview has a six-connection budget to the API host** (observed: WebKit's network process holds exactly 6 established connections to `127.0.0.1:4317` at rest). Two are permanent SSE streams (`/events`, `/app/events`, `src/mainview/lib/api.ts:1705,1731`), one is the open task's stream (`:1777`), one is a held `POST /runs/:id/input`, and a task switch fires ~8 one-shot requests (`RunPanel.tsx:748,801,859,1057,2347,2394` plus `useProjectFiles`/`useAgentCapabilities`/terminals/saved prompts) some of which spawn `git` and take seconds on a large repo. The owner's observation — board responsive, only the message stream blank, freed exactly when A's restore ends — matches B's `EventSource` queuing behind held connections.
- **`RunPanel` is one long-lived instance**, deliberately not keyed (`RunPanel.tsx:676` "no remount because we no longer key on task.id"; `App.tsx:1656` passes no `key`). CLAUDE.md line 121 says the opposite. The `[task.id]` reset effect (`RunPanel.tsx:680-713`) resets events/interactions/subagents/search/PR status but **not** `runs` (`:549`), `sending` (`:2056`), `sendHint`, `backlogBusy` (`:2249`), `resolvingConflicts` (`:2753`), `rebuildBusy` (`:573`), `prStatusLoading` (`:2366`), `gitStatus` (`:2282`), `editingId` (`:3694`); `TerminalsSection` (`:3157`, `:4270`) seeds its open state once and `TerminalView` keeps task A's sockets until B's terminal list resolves.
- **Replay is byte-unbounded.** `EVENTS_REPLAY_LIMIT` = 800 events (`src/shared/types.ts:3341`, used at `server.ts:5520`); on the owner's live tasks the 800-event window weighs 61 MB, 4.9 MB, 4.5 MB, 3.2 MB (single events up to 1.37 MB). `/runs/:id/rebuild-events` (`server.ts:5037`) is likewise count-capped only. `/tasks/:id/events/page` (`server.ts:5427`) too. Parsing is cheap (76 MB JSONL rebuild = 160 ms); shipping and rendering tens of MB is not.
- **Polls don't dedupe**: `App.tsx:467` (`listTasks` 2 s), `:473` (`refreshAgents` 15 s), `RunPanel.tsx:807` (`listRuns` 2 s), `:880` (`listSubagents` 2 s) fire unconditionally; `getTaskGitStatus` (`:2342`) is sequential per task but carries no `AbortController`.
- Prior art: `docs/plans/fix-task-details-load-delay.md` (#213) — its §8 declined a tmux-op timeout; `src/bun/event-loop-responsiveness.test.ts` is the drift-measurement harness; `PASTE_OUTCOME_TIMEOUT_MS` (`orchestrator.ts:4145`) is the precedent for a bounded await in `sendInput`.
- Test seams: `AGETOR_CLAUDE_DRIVER=fake` → `makeFakeAgent` (`src/bun/agents.ts:1109`, env seams `AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS`, `…_API_ERROR`, `…_SESSION_DIED`, prompt markers); e2e via `e2e/fixtures.ts` (`test`/`backend.apiBase`, headless daemon per worker, fake drivers). Run e2e with `bun node_modules/@playwright/test/cli.js test`, one run at a time.

## 3. Approach & key decisions

### 3.1 Bound the spawn await on the send/start request path (server)
`sendInput`'s claude idle branch (`sendClaudeTurn` → `spawnResumedSession`) and `startTaskInner`'s final `spawnAgentOrFail` race the spawn against `SPAWN_RESPONSE_BUDGET_MS` (1,500 ms, `src/shared/types.ts`). If the spawn settles first: unchanged behavior and result. If not: respond now with `{ delivered: true, runId, pending: true }` (start: `{ runId, pending: true }`) — the run row, the `running` column flip and the user event already exist, which is all the webview needs — and let the spawn continue detached:
- the `startingTaskIds` claim is held until the detached spawn settles (moved from `try/finally` around the await to the continuation), so a second message still folds/queues correctly;
- on settle, if the task was deleted meanwhile (`tasks.get` null) or the run is no longer the task's `runId`, drop the session (`dropSession`) and mark the run `failed`/`cancelled` — no leaked tmux session;
- `spawnAgentOrFail`'s existing failure handling (run `failed`, task `ready`, stderr chunk) is unchanged and now simply happens after the response.
Decision rests on evidence (§2: the held POST is what the owner sees) and on the precedent `PASTE_OUTCOME_TIMEOUT_MS`. Rejected: fully detaching (fast path would lose the synchronous `{error}` for spawn-time throws that tests pin, e.g. `orchestrator-fx.test.ts` spawn-throw hardening) and a tmux-op timeout (declined in #213; not needed here).

### 3.2 Make a slow launch observable (driver)
`spawnClaudeViaTmux` times its three awaited pre-launch stages (`killTaskSession`, `ensureInstalledForCwd`, `tmux new-session`); when the total exceeds `SLOW_LAUNCH_WARN_MS` (5 s) it logs the breakdown (`console.warn`) and emits one `status` chunk `session launch took Ns (kill Ns · settings Ns · tmux new-session Ns)`. This is what turns the owner's 25 s from a mystery into a named stage on the next occurrence; it never changes control flow.

### 3.3 Byte-budget the three history payloads (server + db)
`runs.eventsForTask` gains `maxBytes`: the id-first step also selects `LENGTH(data)`, walks newest → oldest accumulating bytes, and stops at the budget (always keeping at least `MIN_REPLAY_EVENTS` = 20 so a task whose newest event alone exceeds the budget still shows). `earliestId`/`hasMore` keep working, so "Load earlier" pages the rest. Applied to the SSE replay (`EVENTS_REPLAY_MAX_BYTES` = 4 MB), the events page (`EVENTS_PAGE_MAX_BYTES` = 2 MB) and `/runs/:id/rebuild-events` (slice from the end until `EVENTS_REPLAY_MAX_BYTES`). Individual events are never truncated (a truncation scheme would have to touch dedup keys, quoting, search and the CLI; ruled out as too wide for "don't break anything").

### 3.4 Stream-first, state-clean task switch (webview)
In `RunPanelBody`: (a) the `[task.id]` reset effect also resets `runs`, `sending`, `sendHint`, `backlogBusy`, `resolvingConflicts`, `rebuildBusy`, `prStatusLoading`, `gitStatus`, `editingId` (drafts keep their existing server-backed adopt logic — untouched); (b) the SSE subscription effect is declared **before** the one-shot fetch effects so its request is issued first on a switch; (c) non-essential requests on a switch — git status, PR mergeability, terminal list — wait for the stream's `replay_meta` (or 400 ms, whichever first) before firing; (d) `listRuns`/`listSubagents` ticks skip while their previous request is in flight; (e) the transcript distinguishes "runs not loaded yet" (skeleton: `Loading messages…`) from "no runs" and "waiting for first event"; (f) `<TerminalsSection key={task.id}>` so terminal tabs/sockets are per task (and the stale "RunPanel remounts" comment there is fixed). In `App.tsx`: `refresh`/`refreshAgents` skip a tick while in flight. No remount/keying of `RunPanel` — the owner asked for zero regressions and the draft/animation machinery depends on the single instance.

### 3.5 Docs
Fix CLAUDE.md line 121 (no `key`; the panel resets per-task state on switch), document the bounded spawn response (`pending: true`), the byte budgets and the slow-launch breadcrumb; append the measurements to this plan's §2.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exclusive) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Bounded spawn await + detached continuation + delete/cancel race guards for `sendClaudeTurn`/`spawnResumedSession` and `startTaskInner`; `SPAWN_RESPONSE_BUDGET_MS`, `SendInputResult.pending`, start result `pending` | `src/bun/orchestrator.ts`, `src/shared/types.ts` (new constants + result fields only) | — | fast path byte-identical; slow fake spawn → response < budget+100 ms with `pending: true`; run registers after; delete-mid-spawn leaves no session; `bun run typecheck` green |
| T2 | Slow-launch stage timing + one status breadcrumb + `console.warn` in `spawnClaudeViaTmux`; `SLOW_LAUNCH_WARN_MS` | `src/bun/claude-tmux.ts` | — | breadcrumb only when total > 5 s; unit test via injected timers/`__forTest` |
| T3 | Byte-budgeted `eventsForTask({limit, maxBytes})`, `hasEventsBefore` unchanged; SSE replay, events page and rebuild-events use budgets; `EVENTS_REPLAY_MAX_BYTES`, `EVENTS_PAGE_MAX_BYTES`, `MIN_REPLAY_EVENTS` | `src/bun/db.ts`, `src/bun/server.ts` (the three routes only), `src/shared/types.ts` (constants only — coordinate: T1 and T3 both append to types.ts → T3 runs in wave 2) | T1 (types.ts) | replay ≤ budget bytes, `hasMore` true when cut, ≥ 20 events always; rebuild window byte-capped |
| T4 | Fake-driver seam `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS` (awaited in `spawnAgent`'s fake claude branch before returning) | `src/bun/agents.ts` | — | unset → no delay; set → `spawnAgent` resolves after N ms |
| T5 | Webview task switch: reset list, stream-first ordering, deferred non-essential fetches, poll dedupe, loading skeleton, `TerminalsSection` keyed, comment fix | `src/mainview/components/kanban/RunPanel.tsx` | — | switching from a task with an in-flight send to another shows that task's Send enabled, runs of the new task only, skeleton until runs load |
| T6 | `App.tsx` poll dedupe (`listTasks`, `refreshAgents`); `api.ts` types for `pending` | `src/mainview/App.tsx`, `src/mainview/lib/api.ts` | — | a slow `/tasks` never stacks requests |
| T7 | CLAUDE.md corrections + plan §2 measurements + this plan's Branch/Base rows | `CLAUDE.md`, `docs/plans/task-details-blank-while-session-restores.md` | T1–T6 | text matches shipped behavior |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| U1 | unit (bun) | T1: fast path unchanged; slow spawn → `pending`, run registered later, second message folds, delete-mid-spawn cleanup, start route pending | `src/bun/orchestrator-spawn-budget.test.ts` (new) |
| U2 | unit | T3: byte budget walk, min-events floor, `hasMore`, page route, rebuild slice | `src/bun/db-events-byte-budget.test.ts` (new), `src/bun/server-rebuild-byte-budget.test.ts` (new) |
| U3 | unit | T2: breadcrumb threshold | `src/bun/claude-tmux-slow-launch.test.ts` (new) |
| U4 | unit | T4 seam | extend `src/bun/agents-fake-*.test.ts` pattern → `src/bun/agents-fake-spawn-delay.test.ts` (new) |
| E1 | e2e (Playwright) | The bug: backend with `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS=6000`; task A finished run (fake), send a follow-up to A, immediately open B (finished run); assert B's transcript renders its events within 2 s, B's Send is enabled, A's run still becomes `running`/settles; terminals section per task; poll dedupe not e2e-testable (unit via pure helper) | `e2e/task-switch-during-restore.spec.ts` (new) |

E2e applies: it is the only layer that exercises WebKit-free Chromium *and* the real HTTP/SSE stack together; the connection-cap itself can't be reproduced under Chromium, so E1 asserts the design (stream-first, bounded POST) rather than the cap. Run recipe (Phase 1): `bun node_modules/@playwright/test/cli.js test e2e/task-switch-during-restore.spec.ts` — fixtures boot `src/bun/headless.ts` with fake drivers; one Playwright run at a time.

## 6. Execution waves

- **Wave 1 (parallel, disjoint):** T1 (orchestrator.ts + types.ts), T2 (claude-tmux.ts), T4 (agents.ts), T5 (RunPanel.tsx), T6 (App.tsx + api.ts).
- **Barrier:** typecheck.
- **Wave 2:** T3 (db.ts + server.ts + types.ts constants) — after T1 so the two `types.ts` edits don't collide.
- **Wave 3:** T7 docs.
- **Tests (Phase 6, parallel, disjoint new files):** U1, U2, U3, U4, E1.

## 7. Blast radius & risks

- `SendInputResult`/start result gain an optional `pending` field — additive; CLI `agetor send`/`start` and the webview ignore unknown fields. The fast path is unchanged.
- Detached spawn vs `deleteTask`/`cancelRun`: guarded in T1 (post-settle ownership check); `cancelRun` on a not-yet-registered run keeps today's `false`.
- Byte budgets shrink the initial window for very large tasks — "Load earlier" still reaches everything; `MIN_REPLAY_EVENTS` guarantees content.
- Stream-first ordering changes effect order in `RunPanelBody` — every effect is keyed on `task.id` and independent; verified by E1 and the existing e2e suite.
- `TerminalsSection` keyed per task closes A's terminal sockets on switch (they reconnect on return via the existing list fetch) — intended.
- Rollback: each task is a separate commit; no migration.

## 8. Open questions / assumptions

- **Q1 (open, instrumented, not blocking):** why the packaged app's `tmux new-session` round-trip resolves 20–28 s late while headless resolves in 38 ms. T2's breadcrumb names the stage on the next occurrence; the owner's live probe (health/connection/main-thread sampler) is armed. If it turns out to be a stage agetor can shorten, that is a follow-up ticket with data; this run removes the *consequence* (held request → starved panel) regardless.
- Assumption: WebKit caps HTTP/1.1 connections per host at 6 (observed 6 at rest; not read from WebKit source). The fixes hold even if the cap differs.
- Assumption: no consumer depends on `sendInput` having finished the spawn before returning (audited: server route, CLI lifecycle/commit, plan approval, resolve-conflicts only read `delivered`/`runId`).

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Reset of every per-task state in `RunPanelBody` (`runs`, `sending`, `sendHint`, busy flags, `gitStatus`, `prStatusLoading`, `editingId`) | in this run — T5 |
| Terminals per task | in this run — T5 (owner: "make this part of this run") |
| Byte budget for SSE replay, events page, rebuild-events | in this run — T3 |
| Poll in-flight dedupe: RunPanel (`listRuns`, `listSubagents`) and App (`listTasks`, `refreshAgents`) | in this run — T5, T6 |
| Bounded spawn on `POST /tasks/:id/start` as well as `/runs/:id/input` | in this run — T1 |
| CLAUDE.md line 121 + `TerminalsSection` comment | in this run — T7, T5 |
| Slow-launch observability | in this run — T2 |
| Root cause of the packaged app's 25 s launch resolution | out of scope pending data — instrumented by T2 and the armed probe; separate ticket once a stage is named |
| Merging `/events` + `/app/events` into one SSE channel to free a connection slot | out of scope — changes a public channel the CLI/TUI also consume; separate ticket |
| Per-event truncation with "show full" | out of scope — total-byte windows achieve the goal without touching dedup/quote/search/CLI paths |
| tmux op timeout (#213 §8) | out of scope — declined by owner in #213, not needed here |
| Unmerged `381b6d1` (reaper breadcrumb spam on tmux 3.6a) | out of scope — different ticket |

## 10. Delivery record (2026-09-16)

Commits on `fix/agetor-task-details-stuck-while-task-ses` off `857bef3`: plan → wave 1 (T1, T2, T4, T5, T6) → wave 2 (T3) + docs → unit tests (U1–U4) → review fixes (opus, `code-review` skill: 2 must-fix, 5 should-fix, 6 nice-to-have, all applied) → e2e (E1).

Review fixes beyond the original breakdown: the loading skeleton yields to a replay that arrives before `listRuns`; every async panel handler (send, rebuild, backlog CRUD, commit-push, resolve-conflicts, drop, fx resume/cancel, ask-card withheld, load-earlier) captures its task id and skips state writes after a switch (`currentTaskIdRef`); `prStatusSeqRef` is bumped on switch; `TerminalsSection` mounts `TerminalView` only after the stream-ready gate; a poll kick that lands during an in-flight request is retried once; the ownership guard also trips on `archivedAt`; the continuation carries a `catch`; the slow-launch breadcrumb fires even when `tmux new-session` fails; the no-`limit` rebuild path is byte-capped (adds `hasMore: true` only when it cut); `agetor start`/`send` print a distinct line and carry `pending` in `--json`; `refreshProjects`/`onVisible` are deduped too.

Verification: `bun run typecheck` clean; `bun test` 5,247 pass / 0 fail / 3 environmental skips (247 files, 328 s); `e2e/task-switch-during-restore.spec.ts` 3 passed (48.9 s) — send to A under a 6 s fake spawn, open B, B renders within 2 s with Send enabled, A's follow-up still settles; API-level `pending: true` in under 3 s; terminals disclosure re-seeds per task. The e2e fixture gained an additive `backendEnv` test option (`test.use({ backendEnv: {...} })`) that feeds extra env to a spec's dedicated backend.

Still open (§8 Q1): the packaged app's 5–31 s `tmux new-session` resolution. T2's breadcrumb will name the stage on the next occurrence; the read-only probes armed on the owner's machine during this run (health latency, connection count, main-thread sampler) can be stopped with `pkill -f live-probe.ts; pkill -f sampler.sh; pkill -f conns.sh`.

Second review round (external reviewer, 5 findings, all applied): byte budgets now measure UTF-8 bytes (`LENGTH(CAST(data AS BLOB))`, `Buffer.byteLength`) instead of characters; Stop during the bounded-spawn pending window is honored via `pendingCancelRunIds` (run `cancelled`, task `ready`, agent never registered — pinned by a new unit test); the manual "Rebuild from session JSONL" path surfaces `hasMore` (note + "Load earlier"); `onVisible` guards the projects/harnesses refreshes too; the stream-ready gate is keyed by task id so a keyed child (`TerminalsSection`) mounting before the parent's reset effect can't inherit the previous task's readiness.

Third review round: the no-`limit` rebuild path is back to returning the complete history. Capping it (second round) dropped JSONL-only events past 4 MB with no way to page them back — "Load earlier" reads the persisted rows, not the JSONL — so the byte budget now applies only to the `?limit=` auto-rebuild. The panel's manual-rebuild `hasMore` handling stays (harmless, and correct if a future server adds a cursor).
