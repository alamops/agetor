# Plan — Hold a claude-code task in `running` while Claude Code Monitors are alive

| Field | Value |
| --- | --- |
| Date | 2026-08-24 |
| Source | /implement — "fix the running status for the tasks that aren't considering the monitors or the agents (status bar: `2 monitors still running · 4 agents`) as part of the running status" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema) |
| Flags | none |
| Gates | self-resolved: the owner's question tool returned no answer in an unattended session, so the Phase 2 grill was run autonomously (§8) and the plan self-approved; decisions Q2/Q4 are the ones to check first |
| Branch | fix/claude-code-monitors-and-agents (pre-existing task branch, not main) |
| Base SHA | ef320a6 (tree clean) |

## 1. Objective & success criteria

A Claude Code **Monitor** (the `Monitor` tool — what `/loop` and "watch this log" workflows use) must count as background work for the task that launched it:

1. The board card **stays in `running`** from the monitor's launch until it ends, across every auto-continued turn its events trigger. Today it oscillates `running ↔ review` once per event (42 continuation runs on the repro task).
2. The card **settles to `review`** when the last monitor ends (timeout, stop) and no other background work is live.
3. The hold is **bounded**: a lost terminal receipt (restart, harness quirk) cannot wedge the card — a per-row ceiling settles it, and a later event flips it back.
4. A restart mid-monitor **rehydrates** the hold (row → watcher) and the restart-safe JSONL scan settles it if the terminal event already landed.
5. The monitor is **visible**: a tab in the task details that streams each event, the board badge counts it, and a small "holding" line explains why the card is still `running` after the turn ended.
6. Rollback lever: `AGETOR_TRACK_MONITORS=0` restores today's behavior exactly (no rows → no hold → no tab).

**Out of scope (decided, §8 Q1):** the status bar's "N agents" — verified to count *other local Claude sessions* (native background-agent-session feature), not this task's work; in-session Task-tool subagents are already tracked.

## 2. Context & constraints (verified live 2026-08-24)

Repro: prod task `39d4d3b6`, session JSONL under the per-account harness dir (`~/.agetor/harnesses/<name>/projects/<encoded-cwd>/<sessionId>.jsonl`, CC 2.1.241). Monitor lifecycle in the main JSONL (there is **no** sidecar file and **no** heartbeat line while alive):

- **Launch, half 1** — assistant `tool_use` `name:"Monitor"`, `input:{command, description, timeout_ms, persistent}` (line 514/888). `persistent:true` ⇒ no timeout, ends only via TaskStop.
- **Launch, half 2** — immediate `user` `tool_result` whose text is `Monitor started (task <id>, timeout <ms>ms). You will be notified on each event…` and whose `toolUseResult` is `{taskId:"bc8fskjvq", timeoutMs:3600000, persistent:false}` (line 515/889). The key is **`taskId`** — bg shells use `backgroundTaskId`.
- **Event** — `queue-operation`/`enqueue` line followed by a `user` line with `origin.kind:"task-notification"`, content `<task-notification><task-id>ID</task-id><summary>Monitor event: "<description>"</summary><event>…</event></task-notification>`. **No `<status>` tag.** Claude auto-continues on each → agetor adopts a continuation run per event (`maybeAdoptContinuation`, `claude-tmux.ts:3102`).
- **Terminal (timeout)** — same envelope with `<event>[Monitor timed out — re-arm if needed.]</event>` (line 934). TaskStop shape only inferred from the CLI binary (generic "was stopped" / `<status>stopped</status>` template) — never observed live.

Why the card flips today:
- Row creation is kind-specific: `discover()` globs `subagents/agent-*.jsonl`; `scanLineForBgShellLaunch/Stub` key on `run_in_background`/`backgroundTaskId` (`claude-subagents.ts:2284-2463`). A monitor matches neither → no `subagents` row.
- The hold predicate is kind-agnostic and DB-derived: `holdForSubagents = succeeded && !cancelled && !apiError && !sessionDied && !unknownCommand && subagents.hasRunning(taskId)` (`orchestrator.ts:1395-1401`), release via `maybeReleaseHeldTask` (`:397-403`), pull-back via `pullBackParkedTask` (`:420-430`). **No orchestrator change is needed for the hold itself.**
- Both settle-by-id paths treat *any* `<task-notification>` naming an id as that id's completion receipt: live `setBackgroundTaskSettledHandler((_t, id) => settleSubagentById(id, "completed", "receipt"))` (`orchestrator.ts:307-309`, fed by `fireBackgroundTaskSettled` at `claude-tmux.ts:3127`), and the restart-safe `scanLineForTaskNotification` (`claude-subagents.ts:2208-2270`, lookups `workflows → files → bgShells`). A naive `monitor` row would therefore be settled by its **first event**. Both paths need a monitor-aware terminal rule.
- `parent_kind` is open TEXT (`022_subagents.sql`); only the read-side allow-list `PARENT_KINDS` (`db.ts:1321`) and the TS union (`shared/types.ts:2573`) enumerate kinds. `isTabbable` (`subagent-tabs.ts:16-20`) already tabs every kind except `workflow`; RunPanel renders any `stdout` event tagged with a `subagentId` into that row's tab (`RunPanel.tsx:3950`).
- Plumbing points every new map must mirror (bg-shell precedent, `claude-subagents.ts`): map decl `:960`, rehydration routing `:1031-1051`, tail loop `:1597`, ceiling `:1966-2003`, notification scan `:2246-2270`, stub replay guard `:2422`, `scanMainSignals` gates `:2507-2537`, `anyRunning` tick `:2623`, deep-idle disqualification `:2627`, `syncSettled` `:2692`. `pumpWatcherForHoldCheck` (`:896-907`) runs one cycle before the end-of-turn hold check, so a stub on disk before `end_turn` is discovered in time.
- Fleet rules honored: hold is DB-derived; only `succeeded → review` is gated; continuations stay new run rows; `disposeSessionState`'s reattach call site must not orphan; anything keyed on `hasRunning` needs a bounded, activity-anchored ceiling (the bg-shell R1 finding: an immutable anchor oscillates); replay floor / async-stub guard patterns.
- Pane scrape: `claude-tmux.ts:3983-3984` lists "busy pane" regexes (`Waiting for \d+ background agent`, `\d+\s+shells?\s+still\s+running`) — no `monitors?` variant exists.
- Fake claude driver (`agents.ts:660-800`) emits chunks only, writes no JSONL, attaches no watcher; scenarios select by env var or a **prompt marker** (`FAKE_CLAUDE_TODOS_PROMPT_MARKER`) because the e2e backend is worker-shared. E2E harness: Playwright, `e2e/fixtures.ts` (`test` with worker `backend`), `e2e/helpers.ts` (`gotoApp`), run with `bun node_modules/@playwright/test/cli.js test <spec> --reporter=list`.

## 3. Approach & key decisions

- **New `monitor` subagent kind, tracked in `claude-subagents.ts` by a `monitors` map** (never `files`): two-line launch correlation over the main JSONL, exactly the bg-shell shape — `scanLineForMonitorLaunch` (prefilter `"name":"Monitor"`, remembers `{toolUseId → description, timeoutMs, persistent}` in a capped pending map) + `scanLineForMonitorStub` (prefilter `Monitor started`/`"taskId"`, parses `toolUseResult.taskId`, correlates via the block's `tool_use_id`, inserts the row; tolerant of a missing pending entry). Row: `parentKind:"monitor"`, `agentType:"monitor"`, `description` = `input.description` ?? truncated command, `sourcePath:""`, `toolUseId`, `startedAt` = line timestamp. *(decision, rests on verified shapes)*
- **Monitor-aware receipt rule, one implementation, both paths.** A notification naming a monitor id is **terminal** iff its `<status>` is in `TERMINAL_NOTIFICATION_STATUSES` **or** its `<event>` text matches `MONITOR_TERMINAL_EVENT_RE = /^\s*\[Monitor (?:timed out|stopped|exited|ended|killed|finished)\b/i` (only "timed out" is verified; the others are defensive). Non-terminal ⇒ **activity**: bump `lastActivityAt`, persist+emit the event text as a `stdout` event on the monitor's tab, flip a ceiling-settled row back to `running`. Terminal ⇒ `settleSubagentById(id, "completed", "receipt")`. Implemented once as `applyMonitorNotification(id, body)` inside the watcher and reached by (a) the restart-safe scan (`monitors` lookup added after `bgShells`) and (b) a new module export `handleBackgroundTaskNotification(taskId, id, body)` that the orchestrator's live handler calls instead of `settleSubagentById` directly: it routes to the task's attached watcher if one exists, else falls back to the DB row's `parentKind` (`subagents.get(id)`) so a monitor id still isn't falsely settled when no watcher is attached; non-monitor ids keep today's `settleSubagentById(..., "receipt")` behavior. `fireBackgroundTaskSettled` gains the notification body as a third argument. *(decision: claude-subagents owns row lifecycle and shape knowledge; claude-tmux only forwards the payload)*
- **Event persistence**: `runs.appendEvent(runId, "stdout", "<ts> <event text>\n", "monitor:<id>:<fnv1a(body)>", id)` + emit — idempotent across the duplicate enqueue/user lines and reattach replay (content-hash uuid, same trick as claude-tmux's synthetic uuid for `uuid:null` lines). Terminal events are persisted too (the tab shows why it ended).
- **Ceiling (`checkMonitorCeiling`)**: timed (`persistent:false`, `timeoutMs` known) ⇒ settle when `now > startedAt + timeoutMs + MONITOR_TIMEOUT_MARGIN_MS (2 min)` — Claude itself kills the monitor at that deadline. Persistent or rehydrated (timeoutMs not persisted) ⇒ settle when `now - lastActivityAt > MONITOR_DEFAULT_STALE_MS` (`AGETOR_MONITOR_STALE_MS`, default 60 min). A ceiling-settled row **flips back** on a later non-terminal event (`ceilingSettled` latch, no receipt); a receipt-settled row never resurrects. *(decision §8 Q3)*
- **Rehydration**: `parentKind === "monitor"` rows route to `monitors` with `lastActivityAt = attachedAt`, `timeoutMs = null`, `persistent = null`; they never land in `files`.
- **Gating**: `MONITORS_ENABLED = ENABLED && process.env.AGETOR_TRACK_MONITORS !== "0"`, nested like `BG_SHELLS_ENABLED`; `scanMainSignals` early-return and the notification-scan gate widened accordingly.
- **UI**: monitor tab label "monitor" with a distinct lucide icon (`Radar`/`Activity`) in `SubagentTab`; board badge title becomes "N background task(s) running" (covers monitors/shells/agents); a `HoldingIndicator` line in the main stream when `column === "running"`, no run is `running`, no interaction is up, and `anySubagentRunning(subagentList)` — "Holding in running — 1 monitor · 1 shell still active", semantic tokens only. *(decision §8 Q2/Q4)*
- **Pane regex sweep**: add `\d+\s+monitors?\s+still\s+running` (and the `·`-separated status-bar item variant if the shells one has it) next to the shells regexes so a "monitors still running" pane reads as busy exactly like shells.
- **Fake-driver scenario for e2e**: `FAKE_CLAUDE_MONITOR_PROMPT_MARKER = "__agetor_fake_claude_monitor__"` (optional `:<settleMs>` suffix, default 4000): turn 1 emits a `Monitor` `tool_use` + `tool_result` chunk pair, inserts a `monitor` row directly via `subagents.insertIfAbsent` (the fake writes no JSONL), resolves the turn, then settles the row after the delay via `settleSubagentById(id, "completed", "receipt")` — driving the real hold/release predicate and the real UI.
- **Rejected**: process introspection (`ps`) for liveness — the watcher is read-only file tailing by design; putting monitor shape knowledge in claude-tmux's `dispatchLine` — splits row lifecycle across two modules; persisting `timeoutMs` in a new column — a migration for a value the default ceiling already bounds; holding on the daemon `jobs/` registry — unverified and not this task's work.

## 4. Work breakdown — implementation tasks

Wave 0 (orchestrator, inline, mechanical): add `"monitor"` to `PARENT_KINDS` (`src/bun/db.ts:1321`) and to `Subagent.parentKind` + its doc comment (`src/shared/types.ts:2558-2573`) so every wave-1 task typechecks against the same union.

| ID | Goal | Owns (exact files) | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | All watcher-side monitor tracking: `MONITORS_ENABLED`, `MonitorState` + `monitors`/`monitorPending` maps, launch+stub scans, `toMonitorShape`, `applyMonitorNotification` (terminal rule, activity, event persist/emit, flip-back), `checkMonitorCeiling`, rehydration routing, `anyRunning`/deep-idle/`syncSettled`/`scanMainSignals` plumbing, exported `handleBackgroundTaskNotification(taskId, id, body)`, module-header doc section "Monitors" | `src/bun/claude-subagents.ts` | wave 0 | Typecheck green; a stub line creates a running `monitor` row; an event line does NOT settle it; a `[Monitor timed out…]` event settles it `completed` (receipt); ceiling settles a quiet row; `AGETOR_TRACK_MONITORS=0` ⇒ no rows |
| T2 | Forward the notification body: `fireBackgroundTaskSettled(taskId, id, body)` + handler type; add the `monitors?` busy-pane regex(es) beside the shells ones | `src/bun/claude-tmux.ts` | wave 0 | Typecheck green (against T3's new handler arity); a pane line `2 monitors still running` matches the busy regex |
| T3 | Live handler → `handleBackgroundTaskNotification(taskId, agentId, body)`; keep the doc comment truthful | `src/bun/orchestrator.ts` | wave 0 | Typecheck green; non-monitor ids behave exactly as before |
| T5 | Monitor tab label/icon in `SubagentTab`; `HoldingIndicator` line (main tab, held state); badge title "background task(s)" (keep any pinned test text) | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/TaskCard.tsx` | wave 0 | Typecheck green; held task shows the line; monitor tab renders `stdout` events |
| T6 | Fake-driver monitor scenario (prompt marker, row insert, delayed receipt settle) | `src/bun/agents.ts` | wave 0 | `bun test` unaffected; a task whose prompt carries the marker holds in `running` after its turn and releases after the delay |

## 5. Work breakdown — test tasks

| ID | Goal | Owns | Covers | Deps |
| --- | --- | --- | --- | --- |
| TT1 | New unit suite (bg-shell suite as template, `manual` + `pump()`): launch+stub off verbatim live-shape lines → row + `hasRunning`; event line ⇒ still running + `stdout` event persisted once despite the enqueue/user duplicate; timeout event ⇒ receipt settle; `<status>stopped</status>` ⇒ settle; timed ceiling; persistent/rehydrated ceiling + flip-back on a later event; rehydration routes to `monitors`; replay guard; flag-off no-op | `src/bun/claude-subagents-monitor.test.ts` (new) | T1 | wave 2 |
| TT2 | Hold-path + tabs: `insertRunningMonitor` helper; succeeded run + live monitor row keeps `running`, releases on settle; cancelled still wins; `monitor` row is tabbable and sorts with the others | `src/bun/subagent-hold.test.ts`, `src/mainview/lib/subagent-tabs.test.ts` | T1 | wave 2 |
| TT3 | Live path + scrape: `handleBackgroundTaskNotification` with a non-terminal monitor body leaves the DB row running (watcher attached and not attached), terminal body settles; non-monitor id still settles on any body; pane regex matches `N monitors still running` | `src/bun/claude-tmux-monitor.test.ts` (new) | T1–T3 | wave 2 |
| TT4 | **e2e** (applies — user-visible flow across UI→API→DB): create+start a task with the fake-monitor marker; assert the card is in Running with badge `1` after the turn resolves and the "Holding in running" line is visible; assert it lands in Review after the settle delay | `e2e/monitor-hold.spec.ts` (new) | T5, T6 | wave 2 |

Run recipe: unit `bun test` (+ `bun run typecheck`); e2e `bun node_modules/@playwright/test/cli.js test e2e/monitor-hold.spec.ts --reporter=list` (fixture boots a headless backend per worker on 4600+; no external services or credentials; load-related flakes documented — check `uptime` before blaming a change).

## 6. Execution waves

- Wave 0: union edits (inline) → typecheck.
- Wave 1 (parallel, file-disjoint): T1, T2, T3, T5, T6 → typecheck + `bun test` → commit `wave 1`.
- Phase 5 review on `git diff ef320a6...HEAD`.
- Wave 2 (parallel, file-disjoint): TT1, TT2, TT3, TT4 → `bun test` + e2e → commit `wave 2`.
- Phase 8 fixes as needed; loop to green.

## 7. Blast radius & risks

- `claude-subagents.ts` runs for every claude task; all new code sits behind `MONITORS_ENABLED` and inside `cycle()`'s try/catch — a defect degrades to today's behavior. Kill switch `AGETOR_TRACK_MONITORS=0`.
- Changing the live handler's contract touches every kind's receipt path; non-monitor ids must keep the exact `settleSubagentById(id, "completed", "receipt")` semantics (TT3 pins it).
- Terminal detection for a TaskStop'd monitor is inferred; if the real shape carries neither a terminal `<status>` nor a `[Monitor …]` event, the ceiling (timeout + 2 min, or 60 min idle) bounds the hold — a bounded wedge, never a permanent one.
- Each monitor event still adopts a continuation run row (existing design, unchanged) — run-list growth is the same as today; only the column stops oscillating.
- `run_events` growth: one `stdout` row per event, deduped by content hash.
- Rehydrated rows lose `timeoutMs` → default ceiling; same accepted trade-off as bg shells.

## 8. Open questions / assumptions — self-answered grill (unattended run)

| # | Question | Answer | Source | Confidence / blast radius |
| --- | --- | --- | --- | --- |
| Q1 | Should "N agents" from the status bar be part of the hold? | **No — monitors only.** "N agents" = other local Claude sessions (native background-agent-session feature); in-session subagents are already tracked. | Evidence: CLI binary noun table (`"1 local agent"`), specimen with zero `Agent` tool uses + 5 live `sessions/*.json` records. | High. If wrong, a separate feature (daemon `jobs/` registry) is needed — nothing here blocks it. |
| Q2 | Tab per monitor, or hold + badge only? | **Full tab** streaming events (bg-shell parity). | Owner's recorded preference for the complete path; bg-shell precedent chose a full tab. | Medium — check first. Reversible: dropping the tab = not persisting `stdout` events. |
| Q3 | Ceiling for persistent / rehydrated monitors? | **60 min since last event**, `AGETOR_MONITOR_STALE_MS`, activity-anchored, flip-back on a later event; timed monitors `timeout + 2 min`. | Fleet rule (`hasRunning` needs a floor) + bg-shell design; env-overridable. | High. Alternative (6 h / none) is one constant. |
| Q4 | Add a visible hold indicator in the panel? | **Yes**, a one-line "Holding in running — …" under the stream while held. | Owner's completeness preference; closes the "why is it still running?" gap reviewers flagged for all hold kinds. | Medium — check first. Reversible: delete one component. |
| A1 | `toolUseResult.taskId` appears only on Monitor stubs among tool results we scan. | Assumed; the prefilter also requires the `Monitor started` text / a pending `Monitor` tool_use id. | Specimen (2 stubs) | Medium; a collision creates a harmless row bounded by the ceiling. |
| A2 | Ordinary monitor events never carry a terminal `<status>`. | Verified on 90+ events. | Specimen | High. |
| A3 | Monitors launched from a fresh session before agetor attaches are caught by the main-scan lookback window; older ones by rehydration from the DB. | Same as bg shells. | Code | High. |

One-way doors: none (additive rows, no migration, kill switch, no contract change outside this process).

## 9. Completeness ledger

Not requested (`--no-follow-ups` off). Swept in anyway because they are remainders of this change, not adjacent features: the busy-pane regex for monitors; the badge title wording; the hold line. Left out deliberately: daemon-jobs "agents" hold (different feature, unverified).

## 10. What actually shipped — deviations from §3

- **Gates:** the owner's question tool returned no answer in an unattended session, so the grill was run autonomously (§8) and the plan self-approved. Decisions to check first: Q2 (monitor tab) and Q4 (hold line).
- **Review round** (opus, `code-review` skill, 9 findings, all applied):
  1. Timed ceiling now requires the deadline **and** ≥ `MONITOR_TIMEOUT_MARGIN_MS` of silence, and a flip-back nulls `timeoutMs`/`persistent` so the row drops to the activity-anchored rule — an immutable deadline alone re-settled a flipped-back row on the next tick (the bg-shell R1 class of bug).
  2. `MONITOR_TERMINAL_EVENT_RE` is anchored on both ends (`/^\[Monitor (…)\b[^\]]*\]$/i` on the trimmed `<event>`), since a false terminal latches `receiptSettled` and is unrecoverable.
  3. Flip-back survives restarts and the watcher-less path: terminal events persist under `monitor:<id>:terminal:<hash>`; rehydration derives `receiptSettled` from `runs.seenLineUuidsForSubagent`; `applyMonitorNotificationForRow` flips a ceiling-settled DB row back only on a genuinely **new** event (never a replayed line).
  4. The restart-safe scan dispatches monitors before its unknown-`<status>` guard.
  5. Event dedup key is `monitor:<id>:<hash>:<floor(lineTs/10s)>`; the live path now forwards the line's timestamp (`ParsedJsonlEvent.timestamp` → `fireBackgroundTaskSettled(taskId, id, body, lineTimestampMs)` → orchestrator → `handleBackgroundTaskNotification`).
  6. Fake monitor row id is keyed on the run (`fake-monitor-<runId>`), not the task.
  7. The `N monitors still running` pane arm is anchored to the spinner chrome; the pre-existing shells arm was left as-is (separate change).
  8. `hasAnyMonitor()` short-circuits the DB probe for tasks with no monitors.
  9. `isTabbable` / `Subagent.parentKind` doc comments.
- **Found while pinning #5:** the scan hashes the block as it sits in the *raw* JSON line (escape sequences intact) while the live path gets the *parsed* payload — same event, two keys, and literal `\n` in scan-persisted text. `decodeJsonStringFragment` at the scan's monitor dispatch restores parity; the test drives both paths on one line.
- **Tests:** 28 (watcher unit) + 10 (live path + pane regex) + 10 (hold/tabs) + 2 e2e specs. Full `bun test` 3102 pass / 0 fail; e2e green on four invocations. `terminals.test.ts` flaked under a 35–57 load average (its two fixed 2 s polls raced a `zsh -l` sourcing the developer's profile) — hardened in this branch: the file pins `SHELL=/bin/sh` for its spawns (restored after), waits on a 20 s deadline instead of `40 × 50 ms`, and sets explicit test timeouts; passes 3/3 at load 55 in <1 s.
- **Deliberately not done:** any hold keyed on the status bar's "N agents" (other local sessions); anchoring the shells pane arm.
- **Second review round** (`/code-review` on the branch, 7 low findings, all applied): `decodeJsonStringFragment` moved so `extractLineTimestampMs` keeps its docblock; three comments no longer claim the live path lacks a line timestamp (and the `extractLineTimestampMs` ordering rationale is corrected); the watcher-less flip-back is gated on `status === "completed"` (an `orphaned` row stays closed, matching rehydration); the terminal-receipt probe is a targeted `runs.hasLineUuidPrefixForSubagent` query instead of materialising every uuid; persisted event text and the emitted `ts` use the line's own timestamp; `persistMonitorEvent` guards `runs.appendEvent` so one bad line can't drop the rest of a scan batch; two tests added (escaped `<event>` text through the scan path + line-time stamp; orphaned-row watcher-less path).
