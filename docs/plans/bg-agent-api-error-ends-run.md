# Plan — Background-agent API errors end the run

| Field | Value |
| --- | --- |
| Date | 2026-07-30 |
| Source | /implement task: "we must consider the following error and similars as ending of the agent running" + screenshot of a subagent tab showing `API Error: 529 Overloaded` / "API ERROR: HTTP 529 — TURN ABORTED; BLOCKED FOR MANUAL RETRY" with the heartbeat stuck on "Agent is working…" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/fix-bg-agent-api-error-catch |
| Base SHA | 25fb711b5bd8eb892acc034fccf5031a0cba168e (tree clean) |
| Mode | **Autonomous** — the two human gates (grill, plan approval) were bypassed; all decisions logged in §8. |

## 1. Objective & success criteria

When a claude-code **background agent / subagent** stream emits an API-error line
(`isApiErrorMessage: true` in its `agent-<id>.jsonl` — 529 Overloaded, 400, any status),
the run must end instead of hanging forever:

- The subagent's own row settles immediately (`failed`) — the subagent tab's
  "Agent is working…" heartbeat stops.
- If the parent task's main turn is **in flight**, the run settles exactly like a
  main-stream API error: task column → `blocked` (reason `api-error`), run status →
  `failed`, tmux session left alive for manual retry/follow-up.
- If the main run already **succeeded** and the task is only held open by background
  agents, the errored agent stops holding it — the task releases to `review` once no
  running subagents remain (existing `maybeReleaseHeldTask` machinery).
- No re-fire on boot reattach (JSONL replayed from offset 0 must not re-block a task).

## 2. Context & constraints (Phase-1 findings)

- Subagent transcripts are separate files tailed by `src/bun/claude-subagents.ts`
  (`tailFile`, ~:505-553); chunks are written straight to DB+SSE, **bypassing the
  orchestrator's `makeChunkHandler`** — so `handle.apiError` is never set and nothing
  settles the main turn. That is the bug's mechanism.
- The shared mapper already emits the sentinel for subagent streams too:
  `claude-tmux.ts:887-893` emits `status` = `CLAUDE_API_ERROR_STATUS_PREFIX` +
  `"HTTP <n> — turn aborted; blocked for manual retry"` and returns `endOfTurn: true`.
- The main-stream consumer is `orchestrator.ts:900-915` (`makeChunkHandler`): prefix
  match → `handle.apiError = true` + `updateColumn(taskId, runId, "blocked", "api-error")`;
  `attachDoneHandler` (~:966-990) folds `wasApiError` into run `failed`.
- The template for cross-stream settlement is `signalSessionDeath`
  (`claude-tmux.ts:~3604-3660`): two branches — `turnInFlight(state)` → emit sentinel via
  `slot.onChunk` + resolve the slot; else `heldProbeSafe(taskId)` → plain status +
  `orphanRunningSubagents`. Our fix mirrors this shape but **does not tear down** the
  session/tailers (the tmux session is alive; only the turn aborted).
- The `#81` reattach pre-seed guard (`orchestrator.ts:584-590`, `subagent_id IS NULL`)
  stays as-is (§8, A4).
- `SubagentStatus` already includes `"failed"` (`shared/types.ts:1808-1813`).
- The watcher is attached at a single choke point: `attachTailer` →
  `attachSubagentWatcher({ taskId, jsonlPath })` (`claude-tmux.ts:~3850`).
- Reattach replay safety: `tailFile` dedups lines via the `seen` uuid set (seeded from
  `run_events.line_uuid` on rehydrate), so a replayed API-error line is skipped before
  our new detection point — no re-fire by construction.
- Idle reaper can't save us: `reapIdleSessions` skips runs in the `active` map.

## 3. Approach & key decisions

Detect the API error **inside the subagent tailer** (it's the only thing reading that
file), settle the subagent row immediately, and notify claude-tmux via a new optional
callback on `attachSubagentWatcher`. claude-tmux then runs a `signalSessionDeath`-shaped
two-branch settle that reuses the existing sentinel so the orchestrator needs **zero
changes** (the sentinel flows through `slot.onChunk` = `makeChunkHandler`, which already
does blocked/api-error + failed).

Alternative considered — a new orchestrator hook (like `setSubagentSettleHook`) that
directly mutates the handle: rejected; it would duplicate blocked/failed logic the
sentinel path already owns and diverge from the session-died precedent.

## 4. Work breakdown — implementation (Wave 1, one agent — files are interface-coupled)

**T1 — detection + propagation** (owns `src/bun/claude-subagents.ts` and
`src/bun/claude-tmux.ts` only):

a) `claude-subagents.ts`:
   - Add `onApiError?: (info: { subagentId: string; detail: string }) => void` to
     `attachSubagentWatcher` opts.
   - In `tailFile`'s per-line mapping (`mapJsonlEventToChunks` callback), flag when a
     chunk is `stream === "status" && data.startsWith(CLAUDE_API_ERROR_STATUS_PREFIX)`
     (import the constant — it's already exported from claude-tmux; if that import
     would create a cycle, move/re-export the constant via `shared/types.ts`-style or
     import type-free constant — check existing import direction first: claude-subagents
     already imports `mapJsonlEventToChunks` from claude-tmux, so importing the constant
     is fine).
   - After the line is processed (post `seen.add`): settle the row immediately —
     `fs.status = "failed"; fs.endedAt = now; subagentsDb.setStatus(id, "failed", now);
     emitLifecycle(fs, "finished"); fireSettle(taskId);` then invoke
     `opts.onApiError?.({ subagentId, detail })` where `detail` is the sentinel payload
     after the prefix. Mirror `checkDone`'s completed block ordering (DB write before
     `fireSettle`). Do not wait for `DONE_IDLE_MS`.
   - The existing "resumed subagent flips back to running" block (~:529) must keep
     working: a retry that appends new lines flips the `failed` row back to `running`.

b) `claude-tmux.ts`:
   - New `function signalSubagentApiError(state: SessionState, info): void`, next to
     `signalSessionDeath`, mirroring its settle shape but **without** any
     watcher/session teardown and **without** `orphanRunningSubagents`:
     - If `turnInFlight(state)`: clear `state.pendingSlashToken`; emit via
       `slot.onChunk ?? state.lastChunk`:
       `${CLAUDE_API_ERROR_STATUS_PREFIX}background agent aborted: ${detail}`;
       then settle the slot exactly like signalSessionDeath (shift queue, set
       `state.lastChunk`, `resolve(0)`; else fall back to `state.onEndOfTurn`).
       Also `clearContinuationWatchdog(state)` (nothing will end this turn now).
     - Else: no-op (the watcher already settled the row; `fireSettle` handles the held
       release; an idle session needs nothing).
   - Wire it at the attach site: `attachSubagentWatcher({ taskId, jsonlPath,
     onApiError: (info) => signalSubagentApiError(state, info) })`.
   - Doc-comment cross-references on `signalSessionDeath` and the sentinel constant.

Acceptance: typecheck green; behavior per §1; no orchestrator/webview changes.

## 5. Work breakdown — tests (Wave 2, two agents, disjoint new files)

**T2 — `src/bun/claude-subagents-apierror.test.ts`** (new file; owns it alone).
Follow `claude-subagents.test.ts` conventions (temp `AGETOR_DATA_DIR` via mkdtemp before
db import, `attachSubagentWatcher({ manual: true })` + `pump()`, fixture
`agent-<id>.jsonl` written with `writeFileSync`/`appendFileSync`, save/restore
`setSubagentEmitter`/`setSubagentSettleHook`, delete created tasks in afterEach):
1. A subagent jsonl gaining an `isApiErrorMessage: true` line (with `apiErrorStatus:
   529`) → row flips to `failed` immediately on the same pump (no `DONE_IDLE_MS` wait),
   lifecycle `finished` emitted, settle hook fired, `onApiError` called with the
   subagent id and a detail containing `HTTP 529`.
2. Reattach replay: seed `run_events.line_uuid` for the API-error line (or pre-populate
   via a first watcher pass), attach a fresh watcher → `onApiError` NOT called again.
3. A normal end_turn subagent still completes via the idle path (regression guard).

**T3 — `src/bun/claude-tmux-subagent-apierror.test.ts`** (new file; owns it alone).
Exercise `signalSubagentApiError` (export it, or drive via the watcher callback seam)
following `claude-turn-routing.test.ts` fake-session state-building idiom:
1. In-flight turn: chunk recorded with `CLAUDE_API_ERROR_STATUS_PREFIX` and the HTTP
   detail; slot resolved with 0; queue empty afterwards.
2. No turn in flight: no chunk emitted, nothing settled (no-op branch).
3. End-to-end settlement contract: feed the emitted sentinel through
   `orchestrator`'s existing machinery only if cheap via existing fake-driver test
   (`orchestrator-blocked.test.ts` already proves sentinel→blocked; do NOT duplicate).

## 6. Execution waves

- Wave 1: T1 (single agent, sonnet).
- Barrier (typecheck).
- Phase 5 review (opus) on the diff.
- Wave 2: T2 ∥ T3 (two sonnet agents, disjoint files).
- Phase 7: full `bun test` + `bun run typecheck` (haiku).

## 7. Blast radius & risks

- `makeChunkHandler`'s api-error branch now also fires for subagent-originated
  sentinels — intended; text differs ("background agent aborted: …") but prefix match
  is unchanged. Reattach pre-seed picks up the new main-stream row naturally
  (`subagent_id IS NULL` holds — it's emitted via the run's own chunk handler).
- If claude's TUI would have recovered (Task tool returns an error tool_result and the
  main turn continues), we now settle the run `failed`/`blocked` anyway; later JSONL
  lines still append via `lastChunk` routing, and a stray later `end_turn` finds an
  empty queue (no-op). Accepted per the user's explicit directive (§8, A1).
- Held tasks with *other* live background agents keep holding — only the errored row
  settles. Correct per #92 semantics.
- Codex untouched (no subagent tracking).

## 8. Assumptions (autonomous mode — audit these)

- **A1**: "consider … as ending of the agent running" = settle the run immediately and
  terminally on any subagent API error while a turn is in flight (blocked/api-error,
  run failed) — no grace period waiting for the TUI to self-recover. Screenshot shows
  non-recovery; interactive claude waits for manual retry.
- **A2**: "and similars" = any `isApiErrorMessage: true` line (all HTTP statuses), the
  same criterion the main stream already uses. No allowlist of status codes.
- **A3**: Held-after-success case releases to `review` (not `blocked`) — main work
  already succeeded; mirrors the session-died held branch.
- **A4**: The `#81` reattach pre-seed guard stays main-stream-only. New-style blocks
  write their own main-stream sentinel row, which the existing query already counts;
  historical transient subagent api-error rows in old DBs must not retro-block runs.
- **A5**: Subagent row settles as `failed` (not `orphaned` — reserved for
  reconciliation/teardown paths).
