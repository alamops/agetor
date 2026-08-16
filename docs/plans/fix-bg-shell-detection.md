# Plan — Track backgrounded Bash shells (`bg_session`) so tasks hold in `running` and show a live tab

| Field | Value |
| --- | --- |
| Date | 2026-08-16 |
| Source | /implement — "fix the bg agents detection: TUI shows agent+shell running, nothing in task details, task in review instead of running" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Branch | implement/fix-bg-shell-detection |
| Base SHA | be489852d2e2f1ae6f639d575892fe94077d178d (tree clean at branch) |

## 1. Objective & success criteria

A `Bash` tool call with `run_in_background: true` must be tracked like any other background agent:

1. The task **stays in `running`** (held by `subagents.hasRunning`) while the shell runs, and settles to `review` only when it finishes.
2. The shell **appears in the RunPanel subagent tab strip** with its description, and its tab **streams the shell's output live**.
3. A restart mid-shell must not strand the task: the restart-safe notification backstop settles the row.
4. The hold is **bounded**: if the completion notification never arrives, the row settles at `(Bash timeout ?? default) + margin`.

## 2. Context & constraints (verified live, 2026-08-16, prod DB)

Repro task `0ce989fe` ("New Updates Modal"): run succeeded 18:48:52, task flipped to `review` while a backgrounded `xcodebuild` shell ran until 18:50:53. Root cause chain:

- Subagent discovery is **filesystem-based**: `discover()` globs `<sessionId>/subagents/agent-*.jsonl` (`claude-subagents.ts:937-988`). A bg shell writes **no sidecar file**, so no row can ever exist.
- The bg-shell stub `tool_result` (verified shape): `toolUseResult: { stdout:"", stderr:"", interrupted:false, backgroundTaskId:"byqcwo9qq" }`, content text `"Command running in background with ID: <id>. Output is being written to: <path>. You will be notified when it completes."` — no `isAsync`/`agentId`, so the W2 async-stub guard (`:1670-1687`) never sees it either.
- `maybeReleaseHeldTask` (`orchestrator.ts:397-402`) and the end-of-turn hold check (`orchestrator.ts:1370-1394`) gate solely on `subagents.hasRunning` → task released to `review` while the shell lives.
- Completion arrives as a `<task-notification>` whose `<task-id>` **is** the `backgroundTaskId`. Live recovery today: claude-tmux's one-shot `fireBackgroundTaskSettled` → orchestrator `setBackgroundTaskSettledHandler` (`orchestrator.ts:307-309`) → `settleSubagentById(id)` — which **already settles by that exact id** and no-ops when no row matches. The restart-safe scan `scanLineForTaskNotification` (`claude-subagents.ts:1796-1832`) checks `workflows` + `files` maps by the same id.
- `parentKind: "bg_session"` is **already declared** in `Subagent` (`shared/types.ts:2540`) and allowed by the DB layer (`db.ts` subagents module) — reserved, never inserted. `isTabbable` (`subagent-tabs.ts:19-21`) **already treats `bg_session` as tabbable**. `stdout` is an existing `RunEventStream` kind. RunPanel groups tab content purely by `RunEvent.subagentId` (`RunPanel.tsx:1243-1252`).
- Watcher internals to mirror: the `workflows` map pattern (non-FileState rows, `WorkflowState` `claude-subagents.ts:550-565`), `syncSettled` fallthrough (`:2011-2029`), `scanMainSignals` single-cursor scan (`:1869-1892`), `pumpWatcherForHoldCheck` (`:677-688`) which closes the end-of-turn race, `emitLifecycle` + `runs.appendEvent(runId, stream, data, lineUuid, subagentId)` persist/emit idiom (`:1491-1493`).
- Fleet gotcha (knowledge `47725ac4`): anything keyed on `hasRunning` needs a bounded ceiling — a lost notification must not wedge the row `running` forever.

## 3. Approach & key decisions

- **New `bgShells` map inside `attachSubagentWatcher`** (like `workflows`, never `files`): bg shells are raw-text streams, not JSONL transcripts — none of the FileState machinery (uuid dedup, end_turn, mapper) applies. *(decision, rests on code reading)*
- **Detection from the main JSONL** (the only artifact that exists): a two-line correlation inside `scanMainSignals`:
  1. assistant `tool_use` with `name:"Bash"` and `input.run_in_background === true` → remember `{toolUseId → description, command, timeoutMs}` in a small pending map (prefilter: `line.includes("run_in_background")`).
  2. `user` line whose `toolUseResult.backgroundTaskId` is a string → correlate via the content block's `tool_use_id`; create the row (id = `backgroundTaskId`). Tolerate a missing pending entry (still create, null description). Output path parsed best-effort from the stub content text (`/Output is being written to:\s*(\S+\.output)/`) — human text is not a stable contract, so a parse miss degrades to a status-only tab, never a skipped row. *(decision: row creation must not depend on the fragile path parse)*
- **Row**: `parentKind: "bg_session"`, `agentType: "shell"`, `description` = tool_use `input.description` ?? truncated command, `sourcePath` = output path (or `""`), `toolUseId` kept for reference. `insertIfAbsent` + `emitLifecycle("started")` + `fireParkedDiscovery(taskId)` — identical bookkeeping to `discover()`.
- **Hold**: creating the row makes `hasRunning` true; `pumpWatcherForHoldCheck` already runs one cycle before the end-of-turn hold check, so the stub (on disk before end_turn) is discovered in time — same mechanism that fixed the workflow bounce.
- **Live output tab**: each cycle, tail the output file raw (`readAppendedSync`), persist+emit batches as `stream:"stdout"` events tagged `subagentId`, `line_uuid = "bgshell:<id>:<batchStartOffset>"` (idempotent on replay via the `(run_id,line_uuid)` unique index). On rehydration start the offset at the file's current size — persisted `run_events` already cover history.
- **Settle signals** (all idempotent through `settleSubagentById`):
  1. Live notification: orchestrator handler — **zero changes needed**, the row PK is the notification id.
  2. Restart-safe: extend `scanLineForTaskNotification` to check `bgShells` (third lookup after `workflows`/`files`).
  3. Ceiling (user decision): settle `completed` at `startedAt + (timeoutMs ?? AGETOR_BG_SHELL_STALE_MS default 30min) + 2min margin` in a new `checkBgShellCeiling`. Rehydrated rows lose `timeoutMs` (not persisted) → default ceiling from persisted `startedAt`. A ceiling-settled shell **flips back to running** if its output file grows afterwards (byte floor = offset at settle); a notification-settled one never resurrects (receipt semantics).
  4. Generic orphan paths cover the rest (`orphanRunning` is task-scoped, kind-agnostic).
- **Exempt from `checkStale`** by construction (not in `files`) — a quiet shell is normal; the ceiling is its bound.
- **Gating**: `BG_SHELLS_ENABLED = ENABLED && process.env.AGETOR_TRACK_BG_SHELLS !== "0"` (house style — per-feature rollback lever, read once at module load). `scanMainSignals`'s early-return and per-line gates widened so bg-shell scans run when this flag is on (notification scan runs when `WORKFLOWS_ENABLED` **or** bg shells are tracked).
- **Cadence/plumbing**: `anyRunning` (tick), deep-idle disqualification, `syncSettled`, and rehydration (`parentKind === "bg_session"` rows route to `bgShells`, never `files` — today they'd wrongly land in `files` and be JSONL-parsed) all learn about the new map.
- **Alternatives rejected**: settling via a `ps`-based liveness probe (agetor's watcher is deliberately read-only file-tailing, no process introspection); reusing `FileState` (would drag JSONL semantics onto raw text); orchestrator-side detection in `makeChunkHandler` (claude-subagents owns row lifecycle; splitting it would duplicate settle bookkeeping).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | All watcher-side bg-shell tracking in `claude-subagents.ts`: `BgShellState` + `bgShells` map, launch/stub scans, row insert, raw output tailing (persist+emit `stdout`), notification settle widening, ceiling check + flip-back, rehydration routing, `syncSettled`/cadence/gating | `src/bun/claude-subagents.ts` | — | Typecheck green; a stub line creates a row (`hasRunning` true); notification/ceiling settle it; no behavior change with `AGETOR_TRACK_BG_SHELLS=0` |
| T2 | Shell icon: `AgentIcon` renders a terminal glyph for `agentType/kind "shell"` (fallback today is generic) | `src/mainview/components/kanban/AgentIcon.tsx` | — | bg-shell tab shows a distinct icon; existing kinds unchanged |

No changes to `orchestrator.ts`, `db.ts`, `shared/types.ts`, `subagent-tabs.ts`, or `server.ts` — verified all already handle `bg_session` generically. If T1 discovers otherwise it must report the deviation, not silently expand scope.

## 5. Work breakdown — test tasks

| ID | Goal | Owns | Covers | Deps |
| --- | --- | --- | --- | --- |
| TT1 | New unit suite: launch detection off verbatim live-shape fixture lines; row creation + `hasRunning`; output tailing (persist/emit, replay dedup, rehydrate-at-size); notification settle (live-handler and restart-scan paths); ceiling settle + output-growth flip-back; rehydration routes `bg_session` rows to `bgShells`; flag-off no-op — all via the existing `manual` + `pump()` idiom | `src/bun/claude-subagents-bgshell.test.ts` (new) | T1 | wave 2 |
| TT2 | Hold-path integration: extend hold tests so a succeeded run with a live bg-shell row keeps the task `running`, releases to `review` on settle; tab-logic test asserting a `bg_session` row is tabbable/sortable | `src/bun/subagent-hold.test.ts`, `src/mainview/lib/subagent-tabs.test.ts` | T1 | wave 2 |

**e2e: not applicable.** Agetor is an Electrobun desktop app with no e2e harness (no Playwright/WebDriver; the webview is native WKWebView). The closed loop is `bun test` + `bun run typecheck`; final validation is dogfooding via `bun run dev` (dev data dir, per house rule).

## 6. Execution waves

- **Wave 1** (parallel): T1, T2 — disjoint files.
- **Wave 2** (after review): TT1, TT2 — disjoint files.
- Then: full `bun test` + `bun run typecheck` (Phase 7), fixes (Phase 8).

## 7. Blast radius & risks

- `claude-subagents.ts` is shared by every claude task; all new code is behind `BG_SHELLS_ENABLED` and inside `cycle()`'s try/catch — a defect degrades to today's (untracked) behavior.
- The output-path parse reads human-facing stub text (explicitly unstable). Mitigated: row creation never depends on it; a miss costs only the live tab content.
- Ceiling semantics: a shell legitimately outliving `timeout + margin` with a lost notification gets a bounced card (settle → flip-back on next output) — same accepted trade-off as W4, now bounded per-row.
- `run_events` volume: chatty shells append output batches; batching per cycle (600ms fast tier) keeps row counts comparable to codex stdout streaming.
- Rollback lever: `AGETOR_TRACK_BG_SHELLS=0` restores pre-feature behavior exactly.

## 8. Open questions / assumptions

- A1: `backgroundTaskId` appears in `toolUseResult` only for bg-shell stubs (verified in the repro transcript; the substring prefilter plus strict parse keeps a future collision harmless).
- A2: the completion `<task-notification>`'s `<task-id>` equals `backgroundTaskId` (verified live: `byqcwo9qq` in both).
- A3: Bash `input.timeout` is ms and present when the model set one; absent → default ceiling (user-approved).
- User decisions recorded: full tab with live output (not hold-only); ceiling = Bash timeout + margin, env-overridable default.
