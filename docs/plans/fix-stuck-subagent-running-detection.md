# Plan — Fix false "background agent running" detection (stuck subagent rows)

| Field | Value |
| --- | --- |
| Date | 2026-08-03 |
| Source | /implement — "no bg agent/workflow running, but Task Details shows one running" (screenshot of task 24d7cbf2 "Notion Integration") |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/fix-non-running-bg-agent-detection |
| Base SHA | 03b2328 |
| Mode | **Autonomous** — grill & approval gates bypassed (owner unavailable); all assumptions logged in §8 |

## 1. Objective & success criteria

A subagent row must never stay `status='running'` after its agent has actually
finished, and a settled row must never be resurrected by replayed history.
Success: (a) the two live stuck tasks (`24d7cbf2` "Notion Integration": row
`a3a86e7bc6cae5560`; `8e2c5112` "Auto indenting the Code": 5 rows) self-heal at
the first watcher attach after this fix ships — verified by a repro harness
against copies of the real prod data; (b) new unit tests pin every wedge
scenario; (c) full suite + typecheck green.

## 2. Context & constraints (root cause, verified on live prod data)

All evidence gathered read-only from `~/.agetor/agetor.sqlite` and the real
session JSONLs. Confirmed mechanism — three compounding defects in
`src/bun/claude-subagents.ts`:

**D1 — The tool_result scan false-settles ASYNC agents on their launch stub.**
An `Agent(run_in_background: true)` tool_use gets an *immediate* `tool_result`
whose `toolUseResult` is `{ isAsync:true, status:"async_launched", agentId, … }`
(verified in devgantry session `64a7d8b1`, e.g. agent `ac784f36c351a7029`:
launch 02:49:48Z, stub 02:49:50Z). `scanLineForToolResult`
(claude-subagents.ts:1202) has no stub guard — the module header even says
signal (3) is for *synchronous* agents (claude-subagents.ts:29), but async rows
are never excluded from `pending`. The row is settled `completed` while the
agent is still working.

**D2 — The flip-back resurrects settled rows on every reattach and retires
their only remaining settle key.** `tailFile`'s resume-detection
(claude-subagents.ts:1100-1133) flips any non-`running` row back to `running`
when it sees an *unseen* line, and retires `fs.toolUseId` in-memory (line
1128). But every transcript contains lines whose uuids are **never persisted**
to `run_events` (mapper-silent lines — measured 10–17 per transcript, types
`attachment`/`assistant`, in stuck AND completed transcripts alike), so the
offset-0 replay at *every* attach finds "unseen" lines and flips completed rows
back to running. Because `tailFile` runs before `scanMainSignals` in `cycle()`
(claude-subagents.ts:1385-1406), the retirement removes the row from the scan's
`pending` in the same cycle — the row ends the attach `running` and
unsettleable.

**D3 — Once the one-shot real signal is consumed, nothing can ever settle the
row.** The stuck class is precisely "transcript never got its terminal
`end_turn` line" (verified: all 6 stuck transcripts end `stop_reason:null`; a
completed control ends `end_turn`) — the long-known claude flush-loss bug. For
such a row: `checkDone` can never fire; the real receipt (`<task-notification>`
for async — present in the main JSONL for 4 of the 5 devgantry rows, minutes
after launch; a real `tool_result` for sync — present for Notion's T4 since
Jul 10) is only dispatched **live** by claude-tmux (dedup'd via
`seenLineUuids`, never re-dispatched on reattach) or consumed once by the
watcher scan whose cursor only moves forward. The watcher's own notification
backstop (`scanLineForWorkflowNotification`, claude-subagents.ts:1306) settles
*workflow container ids only* — a `<task-id>` naming a regular async subagent
is deliberately skipped (comment at :1289-1291). One devgantry row
(`ace01c07…`, launched 25s before the run's final turn ended) has **no**
notification line at all — the enqueue only lands on a next prompt that never
came — so it has *no* signal on disk, ever.

The card is then held in `column='running'` forever via
`subagentsDb.hasRunning` (orchestrator release predicate + `isReapable`
refusing to reap, orchestrator.ts:2404) even though every run of the task
succeeded — exactly the reported symptom.

Constraints:
- No DB migration needed; all new state is in-memory `FileState`/watcher state.
- `bun test` files that import db.ts must keep the `AGETOR_DATA_DIR` mkdtemp
  pattern.
- Existing tests pin the current flip-back-on-replay behavior
  (claude-workflow-agents.test.ts:462-473 "surprising but verified") — they
  must be updated to the new semantics, not deleted.
- Read-only prod: never write to `~/.agetor` — repro harnesses use temp DBs.

## 3. Approach & key decisions

Restore the invariant *"settled rows stay settled unless genuinely-new bytes
arrive; every running row keeps at least one live settle signal, with a
terminal backstop"* via five fixes in `claude-subagents.ts` (W1–W5) plus two
small workflow-journal hardenings (W6–W7) that close the deferred
`pendingReceipts` gap while we're here:

- **W1 Replay floor.** `FileState.replayFloor` = source file size at
  attach/rehydration (0 for freshly-discovered files). In `tailFile`, a batch
  whose *starting* offset is below the floor never triggers the flip-back
  block (no status flip, no `toolUseId` retirement, no `started` re-emit);
  unseen replayed lines still map/emit chunks and still latch `sawEndOfTurn`.
  Bytes beyond the floor behave exactly as today. Kills D2 for every row kind.
- **W2 Async-stub guard.** In `scanLineForToolResult`, when the matching line's
  `toolUseResult?.status === "async_launched"`, do **not** settle; instead mark
  the row `isAsync = true` and retire its `toolUseId` (no real tool_result will
  ever come; prevents any later stub mis-settle). Kills D1.
- **W3 Generalized notification backstop.** Extend
  `scanLineForWorkflowNotification` → also settle a *regular* tracked row
  (`files` map) whose id matches a `<task-id>` and whose status is `running`.
  Restart-safe settle for async agents, symmetric to the workflow container
  backstop. With W1 in place, replays can no longer resurrect what this
  settles. Heals 4 of the 5 devgantry rows (their notifications are on disk).
- **W4 Staleness backstop.** A `running` file-backed row whose transcript has
  produced no new bytes for `AGETOR_SUBAGENT_STALE_MS` (default 10 min) and has
  no `sawEndOfTurn` pending is settled `completed` by a new check alongside
  `checkDone`. Rehydration sets `lastAppendAt` to attach time (currently 0) so
  the clock starts at attach. If the agent was actually alive and writes again,
  W1's beyond-floor path flips it back to running — a brief card bounce instead
  of a forever-stuck card. Heals `ace01c07…` (no signal on disk) and any future
  signal-less wedge. Kills D3's endgame.
- **W5 Self-heal validation.** Repro harness (scratchpad, not shipped) drives
  `attachSubagentWatcher` against the real prod JSONLs with a temp DB seeded
  from the real stuck rows; must show all 6 rows settle and STAY settled across
  repeated re-attaches.
- **W6 Journal cursor rewind on late agent discovery.** In
  `discoverWorkflowAgents`, when a new `agent-*.jsonl` appears in an
  already-tracked workflow dir, rewind that dir's `wfJournals` cursor to 0
  (receipts are idempotent) — the exact analog of `discover()`'s
  `mainOffset = 0` rewind (claude-subagents.ts:806), closing the deferred
  early-receipt race.
- **W7 Settle-on-discovery under a settled container.** A newly-discovered
  workflow agent whose container row is already settled is inserted `completed`
  directly (the cascade invariant: nothing under a settled container can be
  running).

Alternatives considered: (a) blanket settle of subagent rows at run
resolution — rejected, async agents/workflows legitimately outlive the turn
(the #140 hold feature depends on that); (b) persisting per-row byte offsets
in a migration — rejected, replay floor achieves the same without schema
changes; (c) manual prod-DB repair — rejected, the fix self-heals at next
attach and proves itself on real data.

## 4. Work breakdown — implementation

| ID | Goal | Files owned | Deps |
| --- | --- | --- | --- |
| I1 | W1+W2+W3+W4+W6+W7 in the watcher, plus module-header doc updates | `src/bun/claude-subagents.ts` | — |

Single file ⇒ single implementation agent (no fan-out possible without
collision).

## 5. Work breakdown — tests

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| T1 | New file `src/bun/subagent-stuck-detection.test.ts`: replay-floor no-resurrect; async-stub no-settle + async marking; notification backstop settles regular async row on reattach; staleness settle + genuine-resume flip-back; end-to-end "T4 scenario" (sync, no end_turn, tool_result present, survives repeated re-attaches settled) | `src/bun/subagent-stuck-detection.test.ts` | W1–W4 |
| T2 | Update pinned old-behavior tests to new semantics + journal rewind & settle-on-discovery cases | `src/bun/claude-workflow-agents.test.ts`, `src/bun/subagent-toolresult-settle.test.ts`, `src/bun/subagent-settle.test.ts` (as needed) | W1, W6, W7 |

## 6. Execution waves

1. Wave A: I1 (one agent).
2. Review (opus) on the diff.
3. Wave B: T1 ∥ T2 (disjoint files).
4. Run full suite (haiku background agent) + repro harness W5.
5. Fixes loop as needed (max 3 rounds).

## 7. Blast radius & risks

- `tailFile` flip-back is shared by ALL row kinds — W1 must not break the
  legitimate resumed-background-agent path (covered: beyond-floor bytes keep
  today's behavior; existing resume tests must stay green).
- `scanLineForWorkflowNotification` widening: a `<task-id>` false-positive
  would settle a live agent → guarded by requiring the enclosing
  `<task-notification>` marker (unchanged) + id ∈ tracked running rows.
- W4 threshold: a >10-min silent tool call settles early → self-corrects via
  flip-back on next append; env-tunable.
- UI needs no changes (tabs mirror row status; hold release is the existing
  settle-hook path).

## 8. Open questions / assumptions (autonomous mode log)

- A1: Staleness default 10 min (`AGETOR_SUBAGENT_STALE_MS` override). Not
  user-confirmed.
- A2: Staleness settles as `completed` (not `orphaned`) — in every observed
  case the agent's work had reached the parent; `orphaned` is kept for
  session-death.
- A3: No manual repair of the two stuck prod tasks — they self-heal on next
  attach after the app updates; validated by W5 harness.
- A4: The `<task-notification>` `<status>` value remains ignored for regular
  rows too (any status ⇒ the agent is over), mirroring the container decision.
- A5: Grill/approval gates bypassed — user invoked /implement and is not
  available mid-run.
