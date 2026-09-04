# Plan — Fix task-details load lag during another task's warm-up

| Field | Value |
| --- | --- |
| Date | 2026-09-01 |
| Source | /implement — "fix the lag on loading task details when agetor is warming up another task the user just sent a message" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + scope confirmed by owner (4-question pass); plan approved by owner |
| Branch | fix/fix-task-details-load-delay |
| Base SHA | bceeb1880abd8ef946364137e84f763a9ad5415a |

## 1. Objective & success criteria

Opening the task-details panel (RunPanel) must stay responsive while another task is starting/receiving a message. Success:

- No synchronous subprocess spawn or unbounded sync fs work remains on the start-task / send-input warm-up path.
- New responsiveness regression test: with a stub tmux binary that sleeps, a concurrent event-loop operation completes within budget during spawn + paste (proves the loop isn't blocked).
- The SSE replay query for a heavy task (~18.5k events) drops from ~220ms to ~20ms (measured on the production DB, read-only).
- `bun run typecheck` and `bun test` green.

## 2. Context & constraints (grounded findings)

**Root cause (confirmed).** One Bun thread serves `Bun.serve` (`src/bun/server.ts:593`) + the whole orchestrator. The warm-up path runs synchronous subprocess spawns that stall every concurrent HTTP request:

- `tmux()` helper — `src/bun/claude-tmux.ts:1420` — `Bun.spawnSync`, 46 call sites, no timeout. Start = sync `kill-session` + `new-session` back-to-back (`spawnClaudeViaTmux`, `:6502`); every send = 3–4 sync calls (`pastePromptSync`, `:8802`: load-buffer/paste-buffer/delete-buffer + send-keys); claude boot polls fire sync `capture-pane`/`has-session` every ~250–400ms for up to 30s (`BOOT_TIMEOUT_MS`) — a drumbeat of small stalls matching the symptom.
- codex/cursor/gemini one-shot spawns: `spawnSync(tmux, args)` at `codex-tmux.ts:476`, `cursor-tmux.ts:610`, `gemini-tmux.ts:452`, plus shared `killSessionByName` (`claude-tmux.ts:1744`, sync).
- `gitWritableRootsSync` — `worktree.ts:357`, `child_process.spawnSync` with 5s timeout — codex-only, called from `agents.ts:773` (buildCodexCommand) and `orchestrator.ts:2295`.
- `ensureInstalledForCwd`/`applyAgetorSettings` — `hook-installer.ts:277/:145` — sync fs read/merge/atomic-write of `.claude/settings.local.json` before every claude spawn.
- `flushSync` — `claude-tmux.ts:4024` — sync fs read of accumulated JSONL in `sendTurn` (`:7126`).
- SSE replay query — `db.ts:1154` `eventsForTask` with limit: `ORDER BY run_events.id DESC LIMIT 800` sorts ALL of the task's events (with full `data` payloads) in a temp b-tree. **Measured 219.5ms** on prod DB (462k events; worst task 18,535). Sync sqlite ⇒ a 220ms loop stall per SSE (re)connect for heavy tasks.

**Refuted (already async / off-path):** `prepareWorkdir`/`git worktree add` (`worktree.ts:766`, async `Bun.spawn`), `checkAgent`/`checkHarness` probes (async, 2s timeouts), model discovery (not on the path), per-task paste chains do NOT share a global lock (`pasteChains` map, `claude-tmux.ts:2640`). `login-path.ts` spawnSync is boot-only; `git-provider.ts` spawnSync is on the git-host dialog path — both out of scope (see §8).

**Prior art / constraints on record:**
- This exact conversion was deferred to "its own branch" twice: `docs/plans/fix-cannot-reach-api-toasts.md` (decision #5) and `docs/plans/fix-archive-teardown-queue.md`. This branch is that follow-up.
- `docs/plans/tmux-sessions-killed-unexpectedly.md`: every tmux invocation must keep flowing through the single choke point (`resolveTmuxBin()` + `tmuxSocketArgs()` threaded on every call); no parallel spawn logic.
- `docs/plans/fix-archive-teardown-queue.md`: teardown order (kill sessions BEFORE `git worktree remove`) is load-bearing; the global FIFO teardown queue stays.
- `session-liveness.ts` (commit 9b23119) is the working precedent for taking a delicate sync tmux path async without regressing the death watch.
- `queueTmuxOp` (`claude-tmux.ts:8980`) already accepts async op bodies with `stillCurrent()` re-check gates, and `queuePaste` bodies already interleave `Bun.sleep` with tmux calls — the chain layer is async-ready. The "no awaits between tmux calls" comment on `pastePromptSync` protects only its 3-call micro-sequence; atomicity survives conversion because (a) per-task chains serialize all pane mutations, (b) cross-task interleaving targets distinct sessions and per-session buffer names (`agetor-${sessionName}`), (c) mid-sequence session death already surfaces as a non-ok tmux result on the failure path.

**Spike-grade measurements (this session, read-only):**
- `EXPLAIN QUERY PLAN` on `eventsForTask`: `SEARCH runs USING INDEX idx_runs_task` → `SEARCH run_events USING COVERING INDEX idx_run_events_run` → `USE TEMP B-TREE FOR ORDER BY`. Full query on worst task: **219.5ms**.
- Two-step rewrite (ids-only sort over covering index, then fetch `id >= min(ids)` re-filtered by task): **14.8ms + 3.9ms ≈ 19ms**, identical 800-row result, no migration.

## 3. Approach & key decisions

1. **Convert, don't offload.** Make every warm-up-path subprocess spawn async (`Bun.spawn` + `await proc.exited`) instead of moving work to a Worker. Matches the repo's own twice-recorded intent and the `session-liveness.ts` precedent; Workers would fragment deeply stateful drivers. *(reasoning + prior art)*
2. **Owner decisions from the grill:** full sweep (all drivers + sync fs/git bits); **no tmux timeout** (behavior-preserving; timeout stays a follow-up — note an async hang no longer freezes the app, only that op); events query: verified real, fix included; acceptance = responsiveness regression test + suites green.
3. **Atomicity via the existing per-task chain.** All pane-mutating sequences stay inside single chained ops (`queueTmuxOp`/`queuePaste`); the conversion adds awaits *inside* ops, never splits an op. `stillCurrent()` re-checks after each new await where state could have been torn down. *(evidence: chain already async-capable)*
4. **Query rewrite over migration.** `eventsForTask` limit-path becomes the measured two-step (ids-only sort, then row fetch); same signature, same results (incl. `beforeId` paging). No schema change, no backfill. *(spike-measured 11×)*
5. **Contract-first parallelization.** The async signatures (§4 contract) are fixed in this plan so wave-2 consumers can be written against them while wave 1 lands them.

## 4. Work breakdown — implementation tasks

**The signature contract** (wave-2 tasks code against this; wave-1 tasks implement it):

- `claude-tmux.ts`: `tmux()` → `async` (internal). Exports becoming async (return `Promise<…>` of today's type): `sessionExists`, `sessionExistsByName`, `probeSessionActivity`, `sessionLiveness`, `panePidFor`, `killTaskSession`, `killSessionByName`, `dropSession`, `spawnClaudeViaTmux`, `reattachSession`, `sendTurn`, `pasteFollowUp`, `sendSlashCommand`, `healWindowSize`, `interruptTaskSession`. Already-async exports (`dismissTmuxPrompt`, `sendModalKeys`, `driveAskAnswers`, `cycleToMode`, `mirrorModelViaPicker`) keep their signatures. Pure/in-memory exports (`sessionNameFor`, `hasSessionState`, `sessionIdleInfo`, `getSessionLaunchEffort`, `getCurrentPermissionMode` if memory-only, `markTmuxPromptAnswered`, `resolveAskCard`, `jsonlPathFor`, parsers) stay sync. `fileWrittenWithin` stays sync (statSync is a µs syscall, not a fork).
- `codex/cursor/gemini-tmux.ts`: `spawn*ViaTmux`, `drop*Session`, `reattach*Session`, and their turn-send entry points → async where they now await tmux ops.
- `worktree.ts`: `gitWritableRootsSync(cwd)` → `async gitWritableRoots(cwd): Promise<string[]>` using the existing async `git()` helper; sync version removed.
- `hook-installer.ts`: `ensureInstalledForCwd` → async (fs/promises + atomic rename preserved).
- `agents.ts`: `spawnAgent` → `async (args): Promise<SpawnedAgent>`; awaits driver spawns (fake drivers included) and threads `await gitWritableRoots(...)` into the codex branch.
- `db.ts`: `eventsForTask` signature unchanged; limit-path internals rewritten.

**Tasks:**

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Convert `tmux()` + all 46 call sites + contract exports to async in claude driver; `flushSync` → async flush guarded against tailer races (in-flight flag on `SessionState`; if a provably safe async conversion isn't achievable, keep it sync and document why in-code); preserve chain semantics + `stillCurrent()` re-checks; keep choke-point invariant | `src/bun/claude-tmux.ts` | — | File self-consistent; no `Bun.spawnSync` remains; all pane mutations still flow through per-task chains |
| T2 | Same conversion for the three one-shot drivers: async spawn runners, await `killSessionByName`, async drop/reattach per contract | `src/bun/codex-tmux.ts`, `src/bun/cursor-tmux.ts`, `src/bun/gemini-tmux.ts` | contract only | No `spawnSync` imports remain in these files |
| T3 | `gitWritableRoots` async in worktree; async `hook-installer`; `eventsForTask` two-step rewrite (both limit variants, `beforeId` respected in both steps) | `src/bun/worktree.ts`, `src/bun/hook-installer.ts`, `src/bun/db.ts` | — | Query returns byte-identical rows/order vs old impl; no sync spawn in `worktree.ts` warm-up path |
| T4 | `spawnAgent` async + dispatch awaits (all five kinds + fake drivers); thread `gitWritableRoots` | `src/bun/agents.ts` | W1 contract | Compiles against wave-1 signatures |
| T5 | Orchestrator consumption: `spawnAgentOrFail` async (+6 call sites), await kills/drops/reattaches/sendTurn/pasteFollowUp/sessionExists/liveness probes; teardown queue + reconcileOrphans + reaper + cancel paths; re-check the start-task double-entry window the new await points widen (cheap in-flight guard if needed); update now-stale "spawnSync" comments (`orchestrator.ts:188`, `:3883`) | `src/bun/orchestrator.ts` | W1 contract | All orchestrator flows await the contract correctly; teardown ordering preserved |
| T6 | Server + remaining consumers: await `sessionExists` etc. in routes; sweep any other `src/bun` consumer of changed signatures (except files owned by T4/T5 and tests) | `src/bun/server.ts` + misc non-test consumers | W1 contract | No non-test consumer left un-awaited |
| T7 | Compile-green sweep: `bun run typecheck` + `bun test` compile fixes across `src/bun/*.test.ts` and any straggler; no behavior changes beyond adding awaits/async to test plumbing | all `*.test.ts` + stragglers | W1+W2 | typecheck green; suite compiles and runs |

## 5. Work breakdown — test tasks

E2e: **not applicable** — the e2e harness runs `AGETOR_CLAUDE_DRIVER=fake`, which bypasses tmux entirely; no e2e can exercise the real sync path. Recorded decision, not an omission. The regression lives at the integration layer instead:

| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| TT1 | Responsiveness regression test: stub tmux script (sleeps N ms) via `AGETOR_TMUX_BIN`; assert a concurrent `Bun.sleep(10)`-style probe drifts < ~200ms while spawn/kill/paste ops run against a 1000ms-sleeping stub (5× flake margin — see known flake class: never assert tight wall-clock over fake-tmux spawns) | new `src/bun/event-loop-responsiveness.test.ts` | T1, T2 |
| TT2 | `eventsForTask` parity tests: seed multi-run/multi-task events, assert limit/beforeId paging returns identical rows+order to the old query shape (oracle: the unlimited query, sliced) | extend db tests (find existing db test file; else new `src/bun/db-events.test.ts`) | T3 (db) |
| TT3 | worktree + hook-installer async behavior: `gitWritableRoots` parity with old sync results; installer still writes/strips settings atomically | extend `src/bun/worktree.test.ts` + hook-installer tests | T3 |

Run recipe: `bun test` (whole suite), `bun run typecheck`. Dev smoke (optional, owner-side): `bun run dev` against `~/.agetor-dev`.

## 6. Execution waves

- **Wave 1 (parallel):** T1, T2, T3 — file-disjoint. Brief note: typecheck errors in *other* files are expected mid-wave; verify your own files only.
- **Wave 2 (parallel, after W1):** T4, T5, T6 — file-disjoint consumers of the landed contract.
- **Wave 3:** T7 (single agent) — typecheck/test compile sweep.
- Checkpoint commit after each wave. Phase 5 review on `git diff <base>...HEAD`; Phase 6 = TT1–TT3 (TT2/TT3 parallel with TT1; all file-disjoint); Phases 7–8 close the loop.

## 7. Blast radius & risks

- **Paste atomicity / modal guard:** the three-call paste sequence and the guard's double-samples now contain awaits; per-task chains + `stillCurrent()` keep same-task ordering; cross-task interleaving is new but targets distinct sessions/buffers. Reviewer must check every new await inside a chained op re-validates state where it matters.
- **Scraper vs mid-op pane states:** the 1s scraper can now observe a pane between paste steps (previously unobservable). Composer text mid-paste is not a modal, so no card should fire; reviewer to confirm no scraper branch acts on composer-only panes.
- **Double-start window:** `startTask` already has await windows before spawn (pendingTeardown, prepareWorkdir); async spawn widens them slightly. T5 re-checks the guard (`task.runId && active.has(...)`) placement and adds a cheap in-flight set if needed.
- **Teardown ordering:** kills must still complete before `git worktree remove` — awaits must be sequential in the teardown queue, never fire-and-forget.
- **Boot reconciliation:** `reconcileOrphans` gains awaits per run — serialized loop is fine; must not become concurrent (kill-keying safety rules in CLAUDE.md §5).
- **Cancellation latency:** Stop (`interruptTaskSession`) becomes async — response still fast (single tmux send-keys, now non-blocking for everyone else).
- **No rollback hazard:** no schema change, no data migration; revert = git revert.

## 8. Open questions / assumptions

- Owner declined the tmux timeout — a wedged tmux op now hangs only its own chained op (not the app). Logged as a possible future follow-up, not part of this run.
- `login-path.ts` (boot-only) and `git-provider.ts` ssh probe (git-host dialog path) keep their `spawnSync` — off the warm-up path; different ticket if ever.
- `getCurrentPermissionMode` assumed memory-only (stays sync); T1 verifies and may move it into the async set if it actually reads the pane.
- The e2e "Task details editor" convergence flake (`e2e/fx-models.spec.ts`) is a known env-dependent failure on main — not a signal for this branch.
- Phase-8 code review fix: `startTask`, claude's idle-mint paths, and the four one-shot `spawn{Codex,Cursor,Gemini,Fx}TurnNow` functions now share ONE module-level `startingTaskIds` claim (orchestrator.ts) to close the multi-fork double-mint window the async spawn conversion opened between minting a run row and registering it active. Direct consequence of the owner-declined tmux-op timeout noted above: a permanently wedged tmux op (its claim never released) leaves that task un-startable / un-sendable for the remaining lifetime of the process. Accepted, same trade-off as the declined timeout — strictly better than the old app-wide synchronous hang, and scoped to one task rather than the whole app. Revisit together with the tmux op timeout follow-up.

## 9. Completeness ledger

n/a — `--no-follow-ups` not active. Candidate follow-ups recorded: tmux op timeout (owner-declined here); `git-provider.ts`/`login-path.ts` sync spawns (off-path).
