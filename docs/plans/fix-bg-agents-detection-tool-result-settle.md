# Plan — Settle synchronous subagents via the parent transcript's tool_result (fix "5 active bg agents, TUI shows 1")

| Field | Value |
| --- | --- |
| Date | 2026-07-15 |
| Source | /implement task: "fix bg agents detection — TUI shows one bg agent but 5 display as active in Task Details" + screenshot-2026-07-15_15-10-48 |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/fix-bg-agents-detection |
| Base SHA | 3f4b057e826383869fff20bf118f7c33b0072d0f (tree clean) |
| Mode | **Autonomous** — the /implement grill and plan-approval gates were self-resolved (agetor-driven run, owner not interactively present). All assumptions are logged in §8. |

## 1. Objective & success criteria

A synchronous (non-background) Task/Agent-tool subagent whose per-agent transcript never receives the terminal `stop_reason:"end_turn"` line must still transition `running → completed` in agetor — promptly while the session is live, and retroactively on the next boot for rows already stuck. Success:

- The four stuck rows on prod task `ec6ea2a6-…` settle on next launch of a build containing this fix, releasing the held card to `review`.
- A live session with the same missing-terminal-line shape settles within one watcher poll of the parent's `tool_result` landing in the main session JSONL.
- The existing `end_turn`+idle path, the task-notification path, resume flip-back, orphan paths, and the hold/release predicate are unchanged.
- `bun run typecheck` clean; `bun test` green.

## 2. Context & constraints (Phase 1 findings, verified on live data)

Root cause — confirmed by on-disk forensics of the exact task in the user's screenshot (prod DB `~/.agetor/agetor.sqlite`, task `ec6ea2a6-e80b-47bb-8d59-a8c20fc04faa`, claude session `8f12154b-…`, claude 2.1.210):

- agetor's only settle signals for a subagent are (a) its own file showing `stop_reason:"end_turn"` then going idle (`claude-subagents.ts:446,471,479` — `sawEndOfTurn` + `DONE_IDLE_MS`) and (b) a `<task-notification>` in the main JSONL (`claude-tmux.ts:528-553` → `fireBackgroundTaskSettled` at `claude-tmux.ts:2346-2350` → `settleSubagentById`).
- 4 of 8 subagents finished (TUI renders `⎿ Done`, full answer + `toolUseResult status:"completed"` present in the main JSONL) but their per-agent files end on an assistant `text` block with `stop_reason: null` — the terminal line was **never written** (flush loss correlates with concurrent subagents). Signal (a) can never fire.
- Synchronous top-level agents get **no task-notification** (that shape is async/background + nested only). Signal (b) never fires either. Rows wedge at `running` forever; `hasRunning()` then holds the card in `running` even though the run `succeeded` (orchestrator hold gate).
- The reliable, unconsumed signal: every finished agent's `toolUseId` (present in its `agent-<id>.meta.json` sidecar, currently **not parsed** by `readMeta`, `claude-subagents.ts:158-170`) has a matching `tool_result` line in the **main** session JSONL. That is claude's own definitive "this Task call returned".
- Prior owner decision (docs/plans/fix-stream-list-stalls-with-bg-agents.md §3.3): **no wall-clock watchdog** — settle signals must be precise. The tool_result correlation honors that.
- Held-task boot path (`orchestrator.ts:577,610`) arms **only** `attachSubagentWatcher` — the main-session tailer is not re-armed for a task whose run already succeeded. So the fix must not depend on claude-tmux's live tailer, or stuck rows would never repair after a restart.

## 3. Approach & key decisions

**Teach the subagent watcher itself to tail the main session JSONL for `tool_result` blocks matching tracked subagents' `toolUseId`s.** When a match is found for a `running` row, settle it through the existing `settleSubagentById` (same bookkeeping as every other external settle: idempotent DB write → lifecycle emit → in-memory sync → `fireSettle` → `maybeReleaseHeldTask`).

Alternatives considered:

- *Hook in claude-tmux's `dispatchLine`* (fire a new injected handler per tool_result, mirroring `fireBackgroundTaskSettled`): rejected — it doesn't cover the held-task boot path (no main tailer armed there), so it would need a second scan mechanism anyway; and it adds cross-module plumbing for a signal only claude-subagents consumes.
- *Relax `checkDone` to settle on prolonged idle*: rejected — contradicts the recorded "no wall-clock watchdog" owner decision; an idle-but-alive agent would be mislabeled.
- Watcher-side scan wins because one mechanism covers all three cases uniformly: live session (poll ticks read appended bytes), live reattach and boot-held repair (fresh watcher starts at offset 0 → full-history scan → retroactively settles stuck rows).

Precision guards: a line merely *containing* the id string (the launching `tool_use` line, a notification's `<tool-use-id>` tag, quoted text) must not settle — candidate lines are cheaply prefiltered with `line.includes(toolUseId)` then strictly verified: `type === "user"`, `message.content[]` has a block with `type === "tool_result"` and `tool_use_id` exactly equal. Cost: the main file is read only when ≥1 running row has a known `toolUseId`; scan offset is per-watcher and only advances when a scan actually runs.

Persistence: `tool_use_id` becomes a nullable column on `subagents` (migration 027) so the correlation survives restarts; rows created before this fix (including the four stuck prod rows) are backfilled at watcher attach from the on-disk `.meta.json`, which persists.

## 4. Work breakdown — implementation tasks

One wave, one task — the change is a single cohesive seam; splitting it across agents would force same-file collisions.

**T1 — tool_result settle path** (owns: `src/bun/migrations/027_subagent_tool_use_id.sql`, `src/bun/migrations/index.ts`, `src/shared/types.ts`, `src/bun/db.ts`, `src/bun/claude-subagents.ts`)

1. Migration `027_subagent_tool_use_id.sql`: `ALTER TABLE subagents ADD COLUMN tool_use_id TEXT;` — append to `migrations/index.ts` (never reorder).
2. `src/shared/types.ts`: add `toolUseId: string | null` to `Subagent` (doc comment: the parent `Agent` tool_use id from the meta sidecar; correlation key for tool_result settle).
3. `src/bun/db.ts`: `SubagentRow.tool_use_id`, map in `toSubagent`, write in `insertIfAbsent`; add `setToolUseId(id, toolUseId)` (backfill, only when currently NULL) and `getRunningByToolUseId(taskId, toolUseId): Subagent | null`.
4. `src/bun/claude-subagents.ts`:
   - `readMeta` parses `toolUseId` (string or null); `SubagentMeta` gains the field.
   - `FileState.toolUseId`; `discover()` stores it (state + DB); `toSubagentShape` includes it.
   - Rehydration loop: when a DB row has `toolUseId === null`, re-read the meta sidecar and backfill via `subagentsDb.setToolUseId` (this is what repairs pre-fix stuck rows).
   - New per-watcher main-JSONL scan: track `mainOffset` (starts 0); in `cycle()`, when any `running` FileState has a non-null `toolUseId`, `readAppendedSync(opts.jsonlPath, mainOffset)`, split lines (partial trailing line re-read next tick, same idiom as `tailFile`), prefilter by `includes(id)`, strict-verify tool_result shape, then `settleSubagentById(id, "completed")`. Never throw out of the scan (cycle's try/catch is the backstop, but keep per-line parse guarded).
   - Resume semantics unchanged: a settled row whose file grows again still flips back to `running` via `tailFile`.

Acceptance for T1: typecheck clean; existing `bun test src/bun/claude-subagents.test.ts subagent-settle.test.ts subagent-hold.test.ts` still green; no UI/server/orchestrator changes needed (status flows through existing DB reads and lifecycle events).

## 5. Work breakdown — test tasks

**T2 — regression tests** (owns: `src/bun/subagent-toolresult-settle.test.ts`, new file; covers T1). Follow module conventions: unique `mkdtemp` `AGETOR_DATA_DIR` set before importing `db.ts`; `attachSubagentWatcher({ manual: true })` + `pump(now)` with injected clock; save/restore of `setSubagentEmitter`/`setSubagentSettleHook`/`setParkedDiscoveryHandler`; created task ids hard-deleted in `afterEach`. Scenarios:

1. Real-world stuck shape: subagent file ends on assistant `stop_reason: null` (no end_turn ever); main JSONL later gains the matching `tool_result` user line → row settles `completed`, `finished` lifecycle emitted once, settle hook fired.
2. Boot repair: DB row pre-seeded `running` with NULL `tool_use_id`, meta sidecar on disk has `toolUseId`, main JSONL already contains the tool_result → fresh watcher attach + first pump settles it (backfill + offset-0 scan).
3. No false settle: main JSONL containing the id only in the assistant `tool_use` launch line and in a `<tool-use-id>` notification tag → row stays `running`.
4. end_turn path regression: clean `stop_reason:"end_turn"` + idle still settles without any tool_result.
5. Missing/absent meta `toolUseId` → degrades gracefully (no crash, no scan match, row still settleable by other paths).
6. Resume flip-back after a tool_result settle: new bytes in the subagent file flip the row back to `running`.
7. Idempotency: pumping again after settle re-emits nothing (no duplicate lifecycle/settle).
8. db helpers: `getRunningByToolUseId` scoping (taskId + running only), `setToolUseId` only fills NULL.

## 6. Execution waves

- Wave 1: T1 (single implementation agent, sonnet).
- Phase 5: code review of the T1 diff (opus).
- Wave 2: T2 (single test agent, sonnet) — after review triage so tests also cover any must-fix adjustments.
- Phase 7: full `bun test` + `bun run typecheck` (haiku).

## 7. Blast radius & risks

- **Hold/release**: `settleSubagentById` already drives `fireSettle → maybeReleaseHeldTask`; no orchestrator change. Board badge (`runningSubagents`) self-corrects from DB.
- **Codex / bg_session rows**: no meta sidecar → `toolUseId` stays NULL → scan never matches → inert.
- **Nested subagents (spawnDepth > 1)**: their tool_use/tool_result live in the *parent agent's* transcript, not the main JSONL, so this scan won't match them — they keep settling via task-notification (proven working on live data) or their own end_turn. No regression, gap unchanged.
- **Replay-after-restart vs a genuinely resumed agent**: a fresh watcher scans from offset 0 and could re-observe an old tool_result for an agent that has since resumed and is live again; `markSettledById` would flip it — but the very next `tailFile` tick sees the still-growing file and flips it back to `running` (existing resume logic). Transient, self-healing, and no worse than the existing notification replay semantics (`claude-tmux.ts:2326-2332` accepts the same trade).
- **Scan cost**: main JSONL read only while ≥1 running subagent with a known id; appended-bytes deltas thereafter; string prefilter before any JSON.parse. First attach on a huge transcript is a one-time sequential read — same order of work claude-tmux's own offset-0 replay already does.
- **Migration**: additive nullable column; older builds reading a newer DB ignore it (SELECT * mapping is by name).

## 8. Open questions / assumptions (autonomous mode — logged, not owner-confirmed)

1. **Assumed** the fix should be signal-precise (tool_result correlation), not an idle timeout — grounded in the recorded owner decision against wall-clock watchdogs.
2. **Assumed** immediate settle on tool_result observation (no extra idle grace): the parent's tool_result is claude's own completion receipt; any trailing subagent-file writes are handled by the existing resume flip-back.
3. **Assumed** nested-subagent coverage is out of scope (their settle path works today via task-notification; extending the scan to parent-agent files would be a separate feature).
4. **Assumed** no UI change is wanted — the green dot is truthful once the DB is; the screenshot's complaint is the stale status, not the rendering.
5. **Assumed** repairing already-stuck prod rows via backfill-on-attach is desired (it is the user's visible symptom).
