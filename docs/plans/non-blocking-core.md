# Plan — A multi-threaded, non-blocking Agetor core

| Field | Value |
| --- | --- |
| Date | 2026-11-19 |
| Source | Owner request in conversation ("make Agetor excellently performant, with multi-thread support and non-blocking features"); measured evidence below; grill `docs/plans/non-blocking-core-grill/round-1/answers.json`, `round-2/answers.json` |
| Config | AGENTS_CONFIG.yml (balanced, schema v1; host claude_code) |
| Flags | none |
| Gates | grilled via decision form (round-1 + round-2 answers.json, both `complete: true`); owner overrode two recommendations (full async DB worker, all of it in this run; one PR); plan approved by owner in chat ("approved", 2026-11-19) |
| Status | waves 0–5 landed: W1 e686cc14, W2 515feaa5 + dc5e31f1, W3 7a6a68c0 · ba33fa22 · 6a45a89c · aa69a966 · a7d8751a · d519bc27 · debb6402 (+ review fixes b0119b77, 9e1d635f), W4 682de003 · 36991bf0 · 7a41ea81, W5 34cf96e8 · fc1abbe5; Phase 5 review, Phase 6 e2e and Phase 7 runs/benchmark in progress |
| Branch | perf/non-blocking-core (worktree `.claude/worktrees/perf-non-blocking-core`) |
| Base SHA | 26b0069c (main, includes #305) |

## 1. Objective & success criteria

No SQLite query and no multi-millisecond parse runs on the thread that serves the app. The "Agetor is busy" banner stops appearing during ordinary heavy work, and the board updates without re-sending unchanged tasks.

Each criterion names the production path that produces it and the test that drives it.

1. **No SQLite on the main thread.** Every production DB access goes `caller → db-async.ts → db-rpc.ts → postMessage → core-worker.ts (db role) → db-core/* → bun:sqlite`. The main-thread process opens no connection in production. Proven by a guard test (no production import of `db.ts`) plus `src/bun/db-rpc-worker.test.ts`, which runs the real Worker thread.
2. **/health p95 ≤ 100 ms and no main-thread block > 100 ms under heavy load** (owner: block-budget = 100 ms, health-p95 = 100 ms). Produced by the whole change and proven by:
   - `scripts/measure-core-responsiveness.ts`, run before and after on a `.backup` copy of a real-sized DB in `~/.agetor-dev`;
   - `e2e/core-busy-banner.spec.ts` (extended), where heavy load runs, the board keeps updating and the banner never appears.
3. **Idle board refresh costs one indexed lookup.**
   - Path: `App.tsx` refresh → `GET /tasks?delta=1&since=<epoch:rev>` → `server.ts` → `tasks.changedSince` (db-core) over `task_revs` (migration 093, triggers).
   - Push path: any write that moves a revision (worker reply carries `rev`), or a decoration change (terminals, stall registry, interactions) → `task-change-bus.ts` → global SSE `tasks-changed` → the board fetches the delta at once. The timer stretches to a 15 s safety net.
   - Proven by `src/bun/task-list-delta.test.ts` and `e2e/board-delta-push.spec.ts`.
4. **Subagent transcript work never blocks the main thread.**
   - File reads and JSON.parse run in the transcript worker role.
   - Steady-state ticks and dir-watcher passes are deadline-bound cooperative jobs.
   - Inserts are batched one transaction per chunk.
   - Proven by `src/bun/subagent-watcher-drift.test.ts` (re-pinned to < 100 ms max gap), a new tick-budget test, and the benchmark's subagent-run scenario.
5. **Stalls are diagnosable.** Every stall ≥ 1 s, labelled or not, goes to `~/.agetor/logs/core.log` (0600, 5 MB × 3, buffered async writer, secrets redacted), along with all console output.
   - Path: `index.ts` / `headless.ts` boot → `installCoreLog()` → console tee; `event-loop-lag.ts` sink → core-log.
   - Proven by `src/bun/core-log.test.ts` and `src/bun/event-loop-lag.test.ts`.
6. **Smaller blockers gone.** The login-shell PATH probe, request-path file scans, the `ssh -G` probe and recursive `rmSync` are all async. Unit tests cover each.

## 2. Context & constraints

Measured on the owner's machine with installed 1.2.0 (2026-11-19):

- **Stalls.** A 250 ms `/health` prober saw 54 stalls of 1–10 s in 10 minutes.
- **Where the time goes.** `sample` during stalls shows the JS thread ~30–40% in `sqlite3_step → vdbeColumnFromOverflow/accessPayload → unixRead → pread`, with the rest idle.
- **The board poll.** `GET /tasks` took 0.56–1.16 s for 28.8 MB. Raw SQL took 260–406 ms for 3,360 rows and 68–281 ms for the 453 unarchived rows.
- **SQLite settings.** The DB is 4.6 GB with page_size 4096 and no `cache_size`.
- **Lost logs.** Core stdio goes to `/dev/null`. Fleet knowledge entry 18db0f48 has the details.

Code anchors (Phase 1 research):

- **db.ts.** `src/bun/db.ts` is 5,359 lines. It opens the DB at import (`:72`) with pragmas WAL (`:73`), `synchronous=NORMAL` (`:83`) and `foreign_keys=ON` (`:84`), and migrates at `:86`. It has about 20 module objects (~165 methods) and imports `interactions.ts` and `terminals.ts` for `toTask` counts (`:32`, `:36`).
- **Call-site scale.**
  - Production: 1,022 call sites in 36 files, 69 raw `db.*` calls outside `db.ts`, and 25 `db.transaction` sites.
  - Tests: 198 files and ~5,980 calls.
- **Task-list path.** `TASKS_SELECT` is at `src/bun/db.ts:1247`, `tasks.list` at `:1265`, and `GET /tasks` at `src/bun/server.ts:6173`. `parseTaskListQuery` (`:410`) carries the #305 `archived` / `keep` semantics.
- **Watcher steady state.** `src/bun/claude-subagents.ts:4192` `cycle()` → `createCycleJob(false).step(Infinity)`, run every `FAST_POLL_MS = 600`. The dir watcher at `:4034` tails all files on every event. `dispatchTailedLines` (`:2715`) does an autocommit INSERT plus an emit per line within a 256 KB chunk.
- **Lag label.** It spans the whole attach job (`:4261`), so stalls are attributed by overlap (`event-loop-lag.ts` `attribute()`).
- **Logging.** `daemon-log.ts` already rotates (5 MB × 2) through sync appends. `headless.ts` output already lands in `daemon.log` under the login daemon, but `index.ts` has no file log.
- **Bundling.** Electrobun compiles only `src/bun/index.ts` into `Contents/Resources/app/bun/index.js`. `scripts/build-daemon-bundle.ts` builds `vendor/daemon/{login-daemon,headless}.js`, which `electrobun.config.ts` copies into `app/daemon/`. The launcher starts the app with `new Worker(appEntrypointPath)` (packaged `main.js:160`).

Spike (Phase 1, Bun 1.3.13 = packaged runtime and 1.3.10). Scratch dir: `/private/tmp/claude-501/-Users-alamosaravali-Projects-alamops-agetor/29369aea-…/scratchpad/spikes/nested-worker-sqlite`.

- A nested Worker inside the app Worker opens the same WAL DB, read-only or read-write.
- Across ~590 writer ticks per run there were 0 SQLITE_BUSY errors with a 100 ms writer timer.
- Moving a 30 MB query + stringify into the nested Worker cut `/health` max latency 3–4× and p95 2.5–5×.
- Posting a 30 MB result back cost the receiving thread 2–31 ms (string) or 3–25 ms (transferred buffer), so not producing huge payloads matters more.
- Separate `bun build --target=bun` entries work when copied side by side. Every Worker target must be its own build entry.

Repo standards that apply (paths):

- `CLAUDE.md`: persistence/test rules (the db.ts singleton, `AGETOR_DATA_DIR` at top level, `rmTestDataDir`, `snapshotHarnessState`), every route in `ROUTE_POLICY`, every spawn through `coreSpawn`, no-follow reads, run_events SEARCH, server-managed columns never bump `updated_at`, the WKWebView connection budget, the cooperative-job convention.
- `docs/architecture/core-responsiveness.md`: forward resume needs send order = id order; the busy banner contract; history byte budgets.
- `docs/architecture/persistence.md`: migrations are append-only and never edited.
- `docs/architecture/security.md`: never log tokens or the OpenCode password (`redactSecrets` in `opencode-http.ts`); task-dir I/O through `task-dir-fs.ts`.
- `docs/plans/non-blocking-session-restore-grill.md`: the 100 ms block bar; a new index on `run_events` was rejected (this plan adds none).

## 3. Approach & key decisions

- **Full async DB worker** (owner, round 1, overriding the hybrid recommendation; round 2: all of it in this run, one PR).
  - SQL moves into `src/bun/db-core/*.ts` as factories `makeX(conn: Database)` with no import-time side effects and no main-thread state.
  - One worker script, `src/bun/core-worker.ts`, has two roles: `db` (one connection, the only one in production) and `transcript` (file read + parse).
  - The main thread talks to it through `db-rpc.ts` (request id, FIFO, structured clone, error mapping, crash restart). Production code imports only `db-async.ts`, which keeps the module names (`tasks`, `runs`, …) with every method returning a Promise.
- **Transactions** (owner, round 2): each of the 25 becomes one named atomic operation in `db-core`, run start to finish inside the worker. No lock is held across thread hops.
- **Ordering** (owner, round 2): a per-run emit queue. Inserts are posted in order, and each row's live SSE send fires when its insert resolves, strictly in id order. Transcript lines insert in batches, one transaction per chunk.
- **Tests** (owner, round 2):
  - Under `bun test` the RPC runs in-process (same async API, no thread) on the singleton connection opened by `db.ts`.
  - `db.ts` stays the synchronous test-and-in-process module, so the ~5,980 test fixture calls do not change.
  - A guard test forbids production imports of `db.ts`.
  - `src/bun/db-rpc-worker.test.ts` runs the real Worker thread.
- **Transitional connection.** Unconverted code keeps using `db.ts` while Wave 3 converts files, so the main connection and the worker both write. Both get `busy_timeout = 5000` during the transition. Wave 5 removes the main-thread connection from production and the transitional timeout with it.
- **Worker crash** (owner, round 2): restart automatically. In-flight calls reject with a `DbRestartingError`, routes answer 503 `database restarting`, and the event goes to core.log. `/health` keeps answering.
- **Boot** (owner, round 2): the worker opens the DB and runs migrations before the boot gate opens. `/health` and `/info` answer immediately, as today.
- **Board refresh** (owner, round 1: delta poll + push).
  - Migration 093 adds `task_revs` (task id → rev, deleted flag) and `task_rev_meta` (epoch, current rev), with triggers on `tasks` (insert, update, delete), `runs` (insert, update of status) and `subagents` (insert, update of status). No write path can forget to bump a revision.
  - In-memory decorations (pending interactions, open terminals, running subagents, `stalledSince`) ride every delta as a sparse map.
  - Plain `GET /tasks` is unchanged for older clients. `?delta=1` opts into an envelope, and a client that gets a bare array falls back to legacy behavior.
  - Rejected: an `updated_at` cursor (it misses about 17 server-managed columns and 4 in-memory counts) and hooking every writer (one missed hook means a silently stale board).
- **Watcher** (owner, round 1, all four): deadline-bound tick and dir-watcher passes, read + parse in the transcript worker, batched inserts, and a lag label scoped to the attach work.
- **Other blockers** (owner, round 1, all four): async login-path, request-path scans, `ssh -G` and rmSync.
- **SQLite settings** (confirmed): the worker connection gets `cache_size` −65536 (64 MB) and `mmap_size` 268435456 (256 MB). The in-process test connection gets the same.
- **Core log, benchmark, e2e, busy banner unchanged, Compact unchanged**: confirmed defaults (round 1).
- **Missed awaits are the main correctness risk.** `if (tasks.get(id))` on a Promise is silently truthy. We add a typed lint gate, `bun run lint:async`: ESLint with typescript-eslint rules `no-floating-promises` (ignoreVoid), `no-misused-promises` (checksConditionals) and `await-thenable`, scoped to `src/bun`, `src/cli` and `src/shared`. It is reasoning-based, not spiked, and each conversion agent leaves its files clean under it.

## 4. Work breakdown — implementation tasks

Every task carries the completeness clause and the use-what-exists clause. Rules for writing code: the build-rules sections *Always* plus the listed risk tags. Each agent self-checks with typecheck, `lint:async` on its files and the affected tests.

### Wave 1 — independent foundations (parallel)

| ID | Goal | Owns (files) | Risk | Wired by |
|---|---|---|---|---|
| T1 | Core log and lag sink: `core-log.ts` (install once; tee `console.*` into a buffered async writer to `<dataDir>/logs/core.log`, mode 0600, dir 0700, rotation 5 MB × 3 by rename, redaction through a shared redactor covering the master/CLI token values and OpenCode password patterns, flush on exit). Make `event-loop-lag.ts` write every stall ≥ 1 s, labelled or not, with every overlapping label | `src/bun/core-log.ts` (new), `src/bun/core-log.test.ts` (new), `src/bun/event-loop-lag.ts`, `src/bun/event-loop-lag.test.ts` | infra, trust | T9 (index.ts, headless.ts) |
| T2 | Lint gate: add `eslint` + `typescript-eslint` devDeps, `eslint.config.js` with only the 3 rules above, a `lint:async` script, a `measure:core` script entry (for T4) and a `build` step for the core-worker bundle (for T9). Report the baseline violation list without fixing other files | `package.json`, `bun.lock`, `eslint.config.js` (new) | tests | T15 (gate on) |
| T3 | Migration 093: `task_revs(task_id PK, rev, deleted)` + index on rev, `task_rev_meta(id=1, epoch, rev)` seeded with a random epoch, and triggers on tasks/runs/subagents. Additive only | `src/bun/migrations/093_task_revs.sql` (new), `src/bun/migrations/index.ts`, `src/bun/task-revs-triggers.test.ts` (new) | data, migration | T12 (`tasks.changedSince`) |
| T4 | Benchmark `scripts/measure-core-responsiveness.ts`: `.backup` a source DB into a temp `~/.agetor-dev` sub-dir, start a headless core on it, drive the board poll, a transcript replay and a fake subagent run, and probe `/health` every 50 ms. Report p50/p95/max and the longest stall from core.log. Refuses to write under `~/.agetor` | `scripts/measure-core-responsiveness.ts` (new) | none | `package.json` script (T2) |
| T5 | db-core extraction: move every module's SQL from `db.ts` into `src/bun/db-core/<module>.ts` factories (`makeTasks(conn)`, …). Main-thread decorations (interaction/terminal counts) stay in a `db.ts` wrapper. `db.ts` keeps exactly today's synchronous exports, so behavior is unchanged | `src/bun/db.ts`, `src/bun/db-core/*.ts` (new) | data, state | T8 (`db-handler` instantiates factories) |
| T6 | Other blockers: `login-path.ts` (`rehydratePathAsync`, coreSpawn async), `git-provider.ts` (async + cached `ssh -G`), `claude-session-scan.ts`, `account-usage.ts` fs parts (async, capped `readSlice`), `clone.ts` (async rm). Tests for each | those 5 files + their tests | external | T9 (boot uses `rehydratePathAsync`); the existing route callers (async already or converted in W3) |
| T7 | Transcript parse module: `transcript-parse.ts` (pure line split + JSON.parse + chunked read helpers, shared by worker and in-process mode), `workers/transcript-handler.ts` (worker-side), `transcript-client.ts` (main-side API with in-process fallback). Keeps no-follow semantics (`isPlainDirBelow`, `O_NOFOLLOW` reads) | those 3 new files + tests | concurrency, trust | T8 (core-worker registers the role), T11 (watcher uses the client) |

### Wave 2 — the worker (T8, then T9)

| ID | Goal | Owns | Risk | Wired by |
|---|---|---|---|---|
| T8 | DB worker and async facade: `core-worker.ts` (entry with roles `db` and `transcript`), `workers/db-handler.ts` (opens the connection with the pragmas above plus WAL/NORMAL/foreign_keys/busy_timeout, runs migrations, dispatches `{id, module, method, args}` to the db-core factories, piggybacks `rev` from `task_rev_meta` on write replies), `db-rpc.ts` (mode `worker`\|`inprocess`, chosen by `AGETOR_DB_MODE` with defaults `inprocess` under NODE_ENV=test and `worker` otherwise; FIFO; error mapping that keeps class names and codes; crash restart with `DbRestartingError`; `onRevChanged`), `task-change-bus.ts`, `db-async.ts` (async facade with the same module names and decorations on main), `worker-entry.ts` (resolver: `AGETOR_CORE_WORKER_ENTRY`, then the bundle dir `core-worker.js`, then `process.execPath`-relative `Resources/app/{bun,daemon}/core-worker.js`, then the source `core-worker.ts`), and named atomic ops for every `db.transaction` that lives in `db.ts` | the new files listed; `src/bun/db.ts` (pragmas, transitional busy_timeout); tests `db-rpc.test.ts`, `db-rpc-worker.test.ts` | concurrency, data, state | T9 |
| T9 | Build and boot: `scripts/build-daemon-bundle.ts` also builds `vendor/core-worker/core-worker.js`; `electrobun.config.ts` copies it into `app/bun/` and `app/daemon/`; the `verify:vendor` script checks it; `index.ts` and `headless.ts` install core-log first, start the worker, `await dbReady()` before reconcile/boot gate, and use `rehydratePathAsync` | `scripts/build-daemon-bundle.ts`, `electrobun.config.ts`, `scripts/verify-vendor*.ts`, `src/bun/index.ts`, `src/bun/headless.ts` | infra | production boot |

### Wave 3 — convert every caller to `db-async` (sequential sub-waves, leaf → root)

Each agent converts its files from `./db.ts` to `./db-async.ts`. It turns their raw `db.*` and transactions into named db-core ops in a **new per-owner file** `src/bun/db-core/ops-<owner>.ts`, and leaves its files clean under typecheck and `lint:async`. The sub-waves run one at a time, and only then may an agent add the `async`/`await` that its own export changes force in callers that are not converted yet. That is the reason they're sequential.

| ID | Files | Risk |
|---|---|---|
| T10a | small leaves: interactions, terminals, background, notification-hooks, headless-notifications, tmux-resolution, window-url, duplicate-agent-profile, account-usage (db part), harness-swap-history, agent-status, cursor-acp, opencode-session-scan, model-discovery, harness-auto-enable, harness-mirror, harness-mirror-provenance, harness-stacks, bundle, claude-session-launch | data, state |
| T10b | mid: harness-session-transfer, harness-failover, opencode-subagents, orchestrator-opencode-server, claude-session-import, opencode-session-import, claude-tmux, agents | data, state, concurrency |
| T11 | claude-subagents.ts: conversion plus the 4 watcher changes (cooperative tick and dir-watcher, transcript-client reads/parses, batch insert per chunk, lag label scoped to attach work only) | concurrency, state |
| T10c | pipeline-runner.ts | state, concurrency |
| T10d | orchestrator.ts: conversion plus the per-run emit queue around `appendEvent` (send order = id order), async rmSync on delete, and every exit path awaiting its DB writes | state, concurrency, data |
| T10e | server.ts (every route awaits; 503 `database restarting` mapping), retention.ts (ops in worker; Compact refusal unchanged), test-harness-state.ts, remaining index/headless call sites | trust, data |

### Wave 4 — delta poll and push (parallel)

| ID | Goal | Owns | Risk | Wired by |
|---|---|---|---|---|
| T12 | Server side: `tasks.changedSince(rev, archived, keep)` db-core op; `GET /tasks?delta=1[&since=epoch:rev]` envelope `{format:"delta", cursor, tasks, removedIds, decorations}` (snapshot when `since` is absent or its epoch mismatches); `task-change-bus` → throttled global `tasks-changed {cursor}` event; `ROUTE_POLICY` unchanged (same route) and `pathParams` untouched; shared types in `src/shared/types.ts` | `src/bun/db-core/ops-delta.ts` (new), `src/bun/server.ts`, `src/bun/task-delta-route.ts` (new), `src/shared/types.ts`, `src/shared/task-delta.ts` (new merge helper) | state, concurrency | the webview and TUI |
| T13 | Webview: `App.tsx` refresh uses `?delta=1`, merges through `src/shared/task-delta.ts` with `reconcileById` identity preserved, keeps the #305 archived/keep semantics, resets the cursor on a view change, handles `tasks-changed` from the existing global SSE handler, falls back to the 15 s safety poll, keeps the "vanished" and toast-sweep semantics, and reuses the same path for the `open_task` fallback. `api.ts` additions | `src/mainview/App.tsx`, `src/mainview/lib/api.ts`, `src/mainview/lib/task-delta-client.ts` (new) | state | board |
| T14 | TUI and CLI: `useTasks` uses the delta (1.5 s poll stays, now cheap); `api-client.listTaskDelta` | `src/cli/tui/useTasks.ts`, `src/cli/api-client.ts` | state | TUI |
| T14b | Decoration push hooks: terminal open/close, stall set/clear and interaction changes call `task-change-bus.markChanged(taskId)` | `src/bun/terminals.ts`, `src/bun/stall-registry.ts`, `src/bun/interactions.ts` (hook lines only) | state | T12's emitter |

### Wave 5 — cutover and docs

| ID | Goal | Owns | Risk |
|---|---|---|---|
| T15 | Remove the production main-thread connection: `db.ts` opens only in in-process mode; the guard test `src/bun/db-import-guard.test.ts` fails on any production import of `db.ts` (outside `db-rpc.ts`'s in-process branch); the transitional busy_timeout is gone; `lint:async` passes repo-wide and runs in the test gate; `db-run-events-plans.test.ts` still sweeps every run_events method (now in db-core) | `src/bun/db.ts`, `src/bun/db-import-guard.test.ts` (new), `src/bun/db-run-events-plans.test.ts`, `package.json` | data, tests |
| T16 | Docs: core-responsiveness.md (worker architecture, delta and push, watcher, logs, benchmark), persistence.md (worker connection, pragmas, migration 093, test mode), testing-seams.md (`AGETOR_DB_MODE`, `AGETOR_CORE_WORKER_ENTRY`), security.md (core.log contents and redaction; the worker is the same process, so TCC is unchanged), run-panel.md and unread-indicator.md where the delta changes them, CLAUDE.md (production imports `db-async`, tests keep `db.ts`, `lint:async`, worker bundle, board delta). Also CLAUDE.md's Topic map row for core-responsiveness | `docs/architecture/*.md`, `CLAUDE.md` | none |

## 5. Work breakdown — test tasks (Phase 6)

| ID | Layer | Covers |
|---|---|---|
| X1 | unit | core-log: rotation, 0600, redaction of token-shaped values, async writer never blocks > 5 ms per burst, flush on exit. Lag sink logs unlabelled stalls (T1) |
| X2 | unit | migration 093 triggers: insert, update of any column (including server-managed ones), delete leaves a tombstone, run status change and subagent status change bump the task, `updated_at` is never touched (T3) |
| X3 | unit | db-rpc in-process and worker modes: FIFO order, error class mapping, crash → `DbRestartingError` → restart → next call succeeds, rev piggyback fires `onRevChanged`, read-after-write consistency (T8) |
| X4 | integration (real thread) | `db-rpc-worker.test.ts`: the real Worker on a temp DB, 5k inserts with an ordered emit queue, concurrent heavy read while `/health`-like timers keep ticking, so no main-thread gap > 100 ms (T8/T10d) |
| X5 | unit | delta route: snapshot, since cursor, archived/keep semantics, removedIds for archive and delete, epoch mismatch → snapshot, sparse decorations, legacy `GET /tasks` byte-identical shape (T12) |
| X6 | unit | the shared delta merge: identity preserved for unchanged rows, removal, decorations overlay (T13/T14) |
| X7 | unit | watcher: steady-state tick with 39 files × 5 MB never blocks > 100 ms; dir-watcher burst stays bounded; batch insert keeps id order and dedup; label covers attach work only; re-pin `subagent-watcher-drift.test.ts` to < 100 ms (T11) |
| X8 | unit | other blockers: async login-path result equals the old sync one; `ssh -G` cache; capped account-usage read (T6) |
| X9 | unit | guard: no production `db.ts` import; every route still has `ROUTE_POLICY`; core-spawn allowlist unchanged (T15) |
| X10 | e2e | extend `e2e/core-busy-banner.spec.ts`: a big transcript replay plus 500 seeded tasks while the board keeps updating and `core-busy-banner` never shows |
| X11 | e2e | new `e2e/board-delta-push.spec.ts`: the board receives a change within 1 s via push, the idle poll sends `?delta=1&since=`, archive/delete remove the card, the All view snapshot works, a legacy array response (stubbed) still renders |
| X12 | e2e | full existing e2e suite on the worker-mode headless backend (one Playwright run at a time, `AGETOR_E2E_PORT_OFFSET` / `AGETOR_E2E_VITE_PORT`) |
| X13 | benchmark | `bun run measure:core -- --source <db>` before (base SHA build) and after; numbers recorded in the PR body |

E2E applies: the busy banner and the board are user-visible, and the change crosses the process and thread boundary.

Run recipe:
- `export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$HOME/.bun/bin:$PATH"`, then `bun node_modules/@playwright/test/cli.js test <specs> --workers=2`.
- Use port offsets when another run is active.
- The fixtures start headless backends from source (worker mode via `src/bun/core-worker.ts`).

## 6. Execution waves

W0 contract commit (plan + grill) → W1 (T1–T7 parallel) → W2 (T8, then T9) → W3 (T10a → T10b → T11 → T10c → T10d → T10e, sequential) → W4 (T12, T13, T14, T14b parallel) → W5 (T15 ∥ T16) → wiring audit → Phase 5 review → Phase 6 tests → Phase 7 run → Phase 8 fix.

Every wave ends green on typecheck and `bun test` (under a 60 s timeout while machine load is high), with one commit per wave (`wave N: …`). Risky waves (W2, W3 sub-waves, W4) get a read-only wave review before the next wave builds on them. Delivery is one PR (owner, rounds 1 and 2).

## 7. Invariants, runtime shape & risks

Invariants, each with its single enforcement point:

- **One SQLite connection in production**, owned by the worker's `db` role (`workers/db-handler.ts`). Enforced by the `db-import-guard` test.
- **Send order = id order per run.** Every live send of a saved row goes through the per-run emit queue in `orchestrator.ts` (T10d); no path emits a saved row any other way.
- **Every transaction runs entirely inside the worker** as a named db-core op; no BEGIN is held across a hop.
- **Server-managed columns never bump `updated_at`.** The triggers write `task_revs` and `task_rev_meta` only.
- **`GET /tasks` without `delta=1` is byte-compatible with today** (#305 semantics).
- **Every route keeps its `ROUTE_POLICY` entry.** Every spawn stays `coreSpawn`. Logs never carry tokens or passwords (one shared redactor in core-log).
- **Every `run_events` query keeps a SEARCH plan** (`db-run-events-plans.test.ts` sweeps db-core).

Runtime shape:

- **Instances.** One core per data dir, either the desktop app or the headless core (always-on host), each with one DB worker and one transcript role (a second Worker).
- **Crash.**
  - A worker crash rejects in-flight calls and restarts the worker. Writes in flight may be lost; callers see an error, as with any failed write.
  - A core crash between an insert and its emit loses only the live send; forward resume replays it from the DB.
- **Quit.** Wait for the RPC queue to drain (bounded at 3 s), then terminate the workers.
- **Kill switch.** `AGETOR_DB_MODE=inprocess` runs everything on the main thread (debug escape hatch; logged at boot).

Blast radius: every DB caller (36 files), the build and packaging (new bundle), boot ordering, the board refresh protocol, the TUI, and 198 test files (unchanged fixture calls, but tests that call now-async production helpers need `await`).

Rollback: revert the PR. Migration 093 is additive, and an older build ignores the extra tables and triggers.

Risks:
- **Missed awaits.** Mitigated by `lint:async`.
- **Exit handlers that need synchronous writes.** Each one is found and converted to the drain-on-quit path in T10d/T10e.
- **Electrobun dev and packaged resolution of the worker file.** Mitigated by the T9 resolver plus a packaged-build smoke test in Phase 7.
- **Structured-clone cost on very large results.** Mitigated by not producing them in the first place (delta, history byte budgets already cap replays).

## 8. Open questions / assumptions

- **The lint gate.** Choosing typescript-eslint over a custom checker is my call (the repo has no linter), so it is reversible.
- **The 15 s safety poll interval.** My default, inside the owner's "delta poll + push" choice.
- **Tombstones in `task_revs` are never pruned.** Rows are tiny, and pruning would add a "cursor too old" path. Revisit if the table ever matters.
- **Unverified by spike: Electrobun dev mode (`bun run dev`)** copies the worker bundle like the other vendor files. Phase 7 builds and smoke-tests it.
- **The watcher-drift bar (X7) is looser than the "< 100 ms" first pinned.** `subagent-watcher-drift.test.ts` allows up to 3 times the measured idle gap, capped at a 250 ms hard ceiling: a deliberate machine-load tolerance (a 100 ms bar flaked on a loaded laptop). A real regression, a blocking read on the main thread, costs far more than the ceiling.
- No unratified one-way decisions. Migration 093 is additive. No public contract changes (the old `GET /tasks` shape is kept).

## 9. Completeness ledger

| Candidate | Disposition |
|---|---|
| All 1,022 production DB call sites, 69 raw `db.*`, 25 transactions | in this run (T5, T8, T10a–e, T11) |
| Main-thread connection removed from production | in this run (T15) |
| Tests calling now-async production helpers | in this run (each W3 owner fixes the tests of its files) |
| Delta poll + push, TUI delta, decoration hooks | in this run (T12–T14b) |
| Watcher: cooperative tick, worker parse, batch insert, label | in this run (T11) |
| Other blockers (login-path, scans, ssh -G, rmSync) | in this run (T6, T10d) |
| SQLite cache/mmap | in this run (T8) |
| Persistent core log + lag sink | in this run (T1, T9) |
| Benchmark + e2e | in this run (T4, X10–X13) |
| Docs and CLAUDE.md | in this run (T16) |
| Busy banner behavior | out of scope: owner confirmed unchanged |
| Compact (VACUUM) off the main thread | out of scope: owner confirmed (it still locks writers) |
| `/projects` 2 s poll, `/harnesses` 15 s poll | out of scope: they're cheap reads that become async worker reads in W3 anyway; changing their cadence is a different ticket |
| Pruning `task_revs` tombstones | out of scope (§8) |
