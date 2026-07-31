# Plan — Stop "permission-mode: auto" status spam in Task Details

| Field | Value |
| --- | --- |
| Date | 2026-07-31 |
| Source | /implement — "fix the spamming permission auto message in task details messages" + screenshot-2026-07-31_14-49-17-b54ec01a.png |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/permission-auto-spam |
| Base SHA | 5953e19 |
| Mode | **Autonomous** — grill (Phase 2) and plan-approval (Phase 3) gates self-resolved; assumptions logged in §8 |

## 1. Objective & success criteria

The Task Details unified event stream shows long runs of identical
`permission-mode: auto` status chips (screenshot shows 8+ consecutive after a
single "turn complete"). After the fix:

- A `permission-mode: <mode>` chip appears **only when the mode actually
  changes** (or differs from the launch mode) — never repeated back-to-back
  with the same value.
- Already-persisted spam in `run_events` renders collapsed (historical tasks
  look clean without a DB rewrite).
- `bun run typecheck` green, `bun test` green.

## 2. Context & constraints (grounded findings)

- **Emitter**: `src/bun/claude-tmux.ts:999-1012` — `mapParsedEventToChunks`
  `case "system" | "permission-mode"` unconditionally emits
  `onChunk("status", "permission-mode: <mode>", uuid)`. Claude journals a
  mode-bearing JSONL event at **every turn start** (fleet knowledge entry
  776d1222, verified against claude 2.1.170), each with a distinct `uuid`, so
  every one persists to `run_events` (distinct `line_uuid`) and renders.
- **Existing mode tracking**: `SessionState.permissionMode`
  (`claude-tmux.ts:1686`) mirrors the latest mode-bearing event in
  `dispatchLine` at `claude-tmux.ts:2702-2705` — deliberately ABOVE the
  `seenLineUuids` dedup early-return, and pre-seeded from the launch mode in
  `makeSessionState` (`claude-tmux.ts:4165`) and reattach
  (`claude-tmux.ts:1907`). This is the comparison basis for emit-on-change.
- **Callers of the mapper**: `dispatchLine` (main stream, calls
  `mapParsedEventToChunks` directly at `claude-tmux.ts:2800`);
  `mapJsonlEventToChunks` (`claude-tmux.ts:763`) whose only external caller is
  the subagent tailer `src/bun/claude-subagents.ts:633`;
  `rebuildEventsFromJsonl` (`claude-tmux.ts:2846`) drives `dispatchLine`
  against a synthetic state, so it inherits whatever dispatchLine does.
- **UI pipeline**: `RunPanel.tsx` ingests via `createEventDeduper`
  (`lib/event-dedup.ts`) keyed on `ts|runId|stream|data` — same-value chips
  from different lines have different `ts`, so the deduper can't collapse
  them. Rendering is `RunEventList` (`RunPanel.tsx:3151`), which memoizes
  `normalised` from its `events` prop (`RunPanel.tsx:3175`). Both main and
  subagent tabs render through `RunEventList`.
- **Do not break**: orchestrator pattern-matching on `status` sentinels
  (`SESSION_DIED_STATUS_PREFIX`, API-error prefix) — untouched; the
  `(run_id, IFNULL(subagent_id,''), line_uuid)` dedup invariants — we emit
  *fewer* chunks, never re-key existing ones; existing tests
  `claude-tmux.test.ts:649-661` (mapper emits status with no last-mode
  context) and `:763-783` (state overwrite via dispatchLine).

## 3. Approach & key decisions

Two independent layers:

1. **Server-side, emit-on-change** (root fix): thread the previously-known
   mode into the mapper; emit the status chunk only when the event's mode
   differs. Suppressed events still update `SessionState.permissionMode`
   (mirror already runs in `dispatchLine` before the call). Rejected
   alternative: emitting from the `dispatchLine` mirror block — it runs above
   the replay-dedup early-return, so it would need awkward deferred emission;
   the mapper-param approach keeps one emission site.
2. **Client-side collapse** (historical data): a pure helper drops a
   `permission-mode: X` status event when the *previous* permission-mode
   status event in the list carried the same value (non-mode events pass
   through and don't reset the tracker — matches "announce changes only").
   Rejected alternative: DB migration deleting duplicate rows — destructive,
   and the spam keeps arriving from sessions running under the old binary
   anyway.

## 4. Work breakdown — implementation tasks

- **T1 — bun emit-on-change** (owns `src/bun/claude-tmux.ts`,
  `src/bun/claude-subagents.ts`):
  - `mapParsedEventToChunks` + `mapJsonlEventToChunks`: new optional trailing
    param `lastPermissionMode?: string | null` (default `undefined` = always
    emit, preserving all existing callers/tests). In the
    `system`/`permission-mode` case, skip the `onChunk` when
    `evt.permissionMode === lastPermissionMode`.
  - `dispatchLine`: capture `const prevPermissionMode = state.permissionMode`
    **before** the mirror at :2702, pass it to `mapParsedEventToChunks` at
    :2800.
  - Subagent tailer (`claude-subagents.ts:633`): add a
    `lastPermissionMode: string | null` field to the follow-state, pass it to
    `mapJsonlEventToChunks`, update it from the parsed line's
    `permissionMode` after dispatch (tailer already parses each line).
  - Acceptance: two consecutive same-mode lines through `dispatchLine`
    produce exactly one status chunk; a mode *change* still produces one;
    `rebuildEventsFromJsonl` over a spammy JSONL yields one chip per change.
- **T2 — UI collapse** (owns new `src/mainview/lib/status-collapse.ts`,
  `src/mainview/components/kanban/RunPanel.tsx`):
  - `collapseRepeatedModeStatus(events: RunEvent[]): RunEvent[]` pure helper:
    track the data of the last kept `status` event whose data starts with
    `"permission-mode: "`; drop later status events with identical data; any
    permission-mode status with a *different* value is kept and becomes the
    new tracker value. All other events pass through untouched, order
    preserved.
  - Wire into `RunEventList` (`RunPanel.tsx:3175`): apply the helper to
    `events` before `normalizeLegacyEvent` mapping, inside the existing
    `useMemo`.
  - Acceptance: a list with N identical consecutive (or content-interleaved)
    `permission-mode: auto` chips renders one; `auto → plan → auto` renders
    three.

## 5. Work breakdown — test tasks

- **TT1** (owns `src/bun/claude-tmux.test.ts`): mapper suppresses duplicate
  mode vs `lastPermissionMode`, emits on change, default param keeps old
  behavior; `dispatchLine` end-to-end: same-mode repeat → single status
  chunk, changed mode → emitted; rebuild path collapse.
- **TT2** (owns new `src/mainview/lib/status-collapse.test.ts`): helper unit
  tests — consecutive dupes, interleaved-content dupes, mode change kept,
  A→B→A kept, non-mode statuses untouched, empty list.

## 6. Execution waves

- Wave 1 (parallel): T1, T2 — disjoint files.
- Wave 2: code review (opus) of the wave-1 diff.
- Wave 3 (parallel): TT1, TT2 — disjoint files, after impl landed.
- Wave 4: run `bun run typecheck` + `bun test` (haiku, background).
- Wave 5 (conditional): fixes, re-run.

## 7. Blast radius & risks

- Suppressed emission = fewer `run_events` rows; nothing reads
  permission-mode status rows programmatically (grep-verified: only the UI
  renders them). Orchestrator sentinel matching untouched.
- Reattach replay: mirror stays above the dedup return, so
  `state.permissionMode` still rehydrates from replayed lines (comment at
  :2698-2701 preserved).
- First-launch chip disappears when the JSONL mode equals the launch-seeded
  mode — intentional; the task's mode is already visible in the task's
  mode selector UI.
- Client helper runs per render on the memoized event list — O(n), same cost
  class as the existing `normalizeLegacyEvent` map.

## 8. Open questions / assumptions (autonomous mode)

1. **Assumed** desired UX is "announce only changes", including suppressing
   the redundant first chip when it matches the launch mode.
2. **Assumed** historical spam should be cleaned at render time, not via a
   destructive DB migration.
3. **Assumed** subagent (background-agent) tabs get the same suppression.
4. Codex is out of scope — its event mapper never emits permission-mode.
