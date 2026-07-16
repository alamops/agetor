# Plan — Grok subagent rendering

| Field | Value |
| --- | --- |
| Date | 2026-07-16 |
| Source | /implement — follow-up: render grok's spawned subagents as read-only tabs (A3 from grok-build-oss-alignment) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | agetor/21f644e90eb8-grok-build-code-integration (continuing) |
| Base SHA | ee05b16decb6d186c38a13ae3abd8c90afa151cd |

## 1. Objective & success criteria

When a grok task spawns subagents, agetor renders each as a read-only tab in the run panel — the subagent's own transcript (assistant text, thinking, tool calls) inside — exactly like claude-code's subagent tabs. Done = grok subagent rows created on spawn, child transcript streamed & tagged, settled on finish, tabs appear/sort/read-only-gate identically to claude; kill switch + defensive parsing; typecheck + suite green.

## 2. Context & constraints (source-verified + codebase, with anchors)

**The subagent UI/DB/server surface is already kind-agnostic** — it consumes `Subagent` rows + `subagentId`-tagged `run_events`, never branches on `AgentKind`:
- DB: `subagents` table (migration 022) + `run_events.subagent_id` + `subagents` module in `db.ts:805-904` (`insertIfAbsent`, `setStatus`, `markSettledById`, `orphanRunning`, `taskIdsWithRunning`). `parent_kind` is a free TEXT column; reusing value `"subagent"` needs **no schema/type change** (owner D-parentKind).
- `run_events.appendEvent(runId, stream, data, lineUuid?, subagentId?)` (`db.ts:705`); per-subagent dedup seed `seenLineUuidsForSubagent` (`db.ts:759`).
- Server: `GET /tasks/:id/subagents` (`server.ts:3146`) + unified `/tasks/:id/events` carries subagent-tagged events (no kind gate). No route changes needed.
- Webview: `RunPanel` + `lib/subagent-tabs.ts` (`shouldShowSubagentTabs`/`sortSubagentTabs`/`resolveActiveStream`) operate purely on `Subagent[]` + `subagentId`; `RunEventStream` has `"subagent"` lifecycle stream (live-only) + `SubagentEvent`. **No webview changes needed.** (RunPanel poll-rebuild gotchas already handled; we add no UI.)
- Generic orchestrator sinks: `emit` (SSE fan-out, `orchestrator.ts:198`), hold policy `maybeReleaseHeldTask`/`pullBackParkedTask`/`isHeldByBackgroundAgents` — all keyed by `taskId`, kind-agnostic.

**The one hard kind gate**: `orchestrator.ts:651` — `if (resolveHarness(task.agent)?.kind !== "claude-code") continue;` in `reconcileOrphans`' held-subagent re-arm pass. Grok must be added or its stuck rows never re-arm/orphan on boot.

**Grok's subagent contract** (source `xai-org/grok-build@c68e39f`, still unverified vs a running binary — A-robust):
- Lifecycle events persist to the PARENT session `updates.jsonl` as `{"timestamp","method":"_x.ai/session/update","params":{"sessionId","update":{"sessionUpdate":"subagent_spawned|subagent_finished",…}}}` (`session/acp_session_impl/updates.rs:423,509,641`). `subagent_progress` is **NOT persisted** (live-only) — no live token/turn counters for us; tabs are spawn→finish.
- `subagent_spawned` fields (snake_case): `subagent_id` (stable UUIDv7 correlation key), `child_session_id` (→ the child session dir), `parent_session_id`, `parent_prompt_id?`, `subagent_type` ("general-purpose"|"explore"|"plan"|…), `description`, `model?`, `resumed_from?` (`extensions/notification.rs:560`).
- `subagent_finished` fields: `subagent_id`, `child_session_id`, `status` ("completed"|"failed"|"cancelled"), `error?`, `output?`, `tool_calls`, `turns`, `duration_ms` (`notification.rs:629`). **Clean terminal status — NO tool_use_id/tool_result-scan fallback needed** (grok's key divergence from claude's synchronous-subagent problem).
- The subagent's OWN transcript is a full independent session at `~/.grok/sessions/<encoded-cwd>/<child_session_id>/updates.jsonl` (`session/storage/jsonl/mod.rs:70`), standard ACP `sessionUpdate` entries (`agent_message_chunk`/`agent_thought_chunk`/`tool_call`/`tool_call_update`/`plan`) — same format our parent tailer already maps, EXCEPT for subagents we also render the message/thought chunks (the parent skips those because grok's stdout owns them; the child transcript has no stdout, so text must come from here).
- Subagents spawn by default (`config/mod.rs:449`; `GROK_SUBAGENTS`/`--no-subagents` gate). We render, don't disable.

**Existing grok tailer seams** (`grok-tmux.ts`): `dispatchGrokUpdateLine` (`:470`) currently early-returns on `_x.ai/session/update` (`:474`); `GrokSessionState` holds the updates tailer (`updatesPath`/`updatesOffset`/`updatesWatcher`/`updatesPollTimer`, `:567-572`); `disposeGrokState` (`:587`) tears them down; `encodeGrokCwd` (exported), `scanForGrokUpdatesPath`/`resolveGrokHome` (module-private — need export). `spawnGrokViaTmux`/`reattachGrokSession` build state; the driver already carries `taskId`/`runId`/`cwd`/`env`.

## 3. Approach & key decisions

- **D1 — New `src/bun/grok-subagents.ts`** mirroring `claude-subagents.ts`'s shape but for grok's model (child = independent session dir, not a `subagents/agent-*.jsonl` sidecar). A per-task `GrokSubagentManager`: `onLifecycleLine(update, taskId, runId, cwd, env)` handles spawn/finish; owns a `Map<childSessionId, ChildTailer>`. Reuses `subagents`/`runs` DB modules directly. Injected sinks via setters (decoupled from claude): `setGrokSubagentEmitter`, `setGrokSubagentSettleHook`, `setGrokParkedDiscoveryHandler` — wired by orchestrator to `emit` / `maybeReleaseHeldTask` / `pullBackParkedTask`. Kill switch `AGETOR_GROK_TRACK_SUBAGENTS=0` (mirrors claude's `AGENT_TRACK_SUBAGENTS`).
- **D2 — Row shape**: `insertIfAbsent({ id: subagent_id, taskId, runId, parentKind: "subagent", agentType: subagent_type, description, spawnDepth: 1, sourcePath: <child updates.jsonl path>, status: "running", startedAt })`. `sourcePath` is the resolved child updates.jsonl (best-effort; if unresolvable yet, the child tailer resolves lazily like the main one). On `subagent_finished`: `markSettledById(subagent_id, status)` + emit `SubagentEvent{phase:"finished"}` + fire settle hook. Emit `SubagentEvent{phase:"started"}` on spawn.
- **D3 — Child transcript tailer**: resolve `~/.grok/sessions/<encodeGrokCwd(cwd) | scan>/<child_session_id>/updates.jsonl`; poll+watch from offset 0; map via a shared `mapGrokUpdateEvent(u, { includeText: true })` extracted from `dispatchGrokUpdateLine` — `includeText` adds `agent_message_chunk`→assistant / `agent_thought_chunk`→thinking (keyed `am:<child>:<n>` / `at:<child>:<n>`), tool/plan unchanged. Persist `runs.appendEvent(runId, stream, data, lineUuid, subagentId)` + `emitFn({…, subagentId})`; dedup via `seenLineUuidsForSubagent(subagent_id)` (task-scoped-per-subagent). Terminal: `subagent_finished` settles; also stop the child tailer on settle. (No idle/end_turn heuristic needed — the finish event is authoritative.)
- **D4 — grok-tmux.ts changes**: extract & export `mapGrokUpdateEvent`; export `scanForGrokUpdatesPath`/`resolveGrokHome`; in `dispatchGrokUpdateLine`, when method is `_x.ai/session/update` and the tag is a subagent variant, forward to an **injected hook** `grokSubagentLineHook?(update, ctx)` (setter seam — grok-tmux does NOT import grok-subagents at eval time; the manager registers itself, mirroring claude-tmux↔claude-subagents cyclic import). Instantiate/attach the manager in `spawnGrokViaTmux`/`reattachGrokSession`, dispose (+ orphan running children) in `disposeGrokState`. Pass `taskId/runId/cwd/env/grokHome` through.
- **D5 — orchestrator.ts**: wire the three grok-subagent setters (module-load, next to the claude ones); generalize the `:651` gate to `!== "claude-code" && !== "grok"` and re-arm/orphan grok tasks' subagent rows on boot (the re-arm for grok = ensure the manager reattaches via the normal grok reattach path — grok's reattachGrokSession already re-tails the parent updates.jsonl, so subagent lines re-dispatch and rows rehydrate via `insertIfAbsent`; boot just needs to NOT skip grok and to orphan rows whose session is gone). Grok teardown (`dropGrokSession` sites) already covered by disposeGrokState orphaning.
- **D6 — Defensive (A-robust)**: every field read tolerant (missing `subagent_id`→skip line, missing `child_session_id`→row with placeholder sourcePath + no child tail, unknown status→"failed" conservative like the death-watch default); a malformed subagent line never throws into the parent tailer (try/catch at the hook boundary); kill switch short-circuits the hook.

## 4. Work breakdown — implementation

**Wave 1 (2 agents, file-disjoint):**
- **T1 — `src/bun/grok-tmux.ts` + `src/bun/grok-subagents.ts` (new)** — one agent (the two are cyclically coupled: grok-tmux imports the manager factory, grok-subagents imports grok-tmux's `mapGrokUpdateEvent`/path helpers; splitting would collide). Implements D1–D4 + D6. **Pins these exports for T2**: `setGrokSubagentEmitter(fn)`, `setGrokSubagentSettleHook(fn)`, `setGrokParkedDiscoveryHandler(fn)`, `orphanRunningGrokSubagents(taskId)` (for boot/ teardown parity), all from `grok-subagents.ts`.
- **T2 — `src/bun/orchestrator.ts`** — D5: import & wire the three setters (to `emit`/`maybeReleaseHeldTask`/`pullBackParkedTask`); generalize the `:651` kind gate to include grok and re-arm/orphan grok subagent rows on boot; verify grok teardown paths orphan running children. Codes against T1's pinned export names.

## 5. Work breakdown — tests

- **TT1 — `src/bun/grok-subagents.test.ts` (new)**: `mapGrokUpdateEvent({includeText})` maps message/thought/tool/plan with stable keys; a spawn line creates a row (fields from payload; tolerant to missing optional fields); finish settles with the right status; malformed line (missing subagent_id / bad JSON) is a no-op that doesn't throw; kill switch disables; child transcript path resolution (encode + scan fallback); dedup across re-read. Drive via a temp GROK_HOME session tree + the manager (mirror grok-tmux.test.ts's real-tmux-free unit seams).
- **TT2 — `src/bun/orchestrator-grok.test.ts` (extend)**: a grok run whose fake driver emits a `subagent_spawned` then `subagent_finished` into the parent updates.jsonl produces a `subagents` row that ends non-running (leaves no stuck row → reconcile-safe); the `:651` gate no longer skips grok (a grok task with a running subagent row is re-armed/orphaned, not ignored). Keep shared-DB hygiene.

## 6. Execution waves

W1: T1 ∥ T2 → typecheck barrier + commit → opus review → TT1 ∥ TT2 → full `bun test` → fixes → commit.

## 7. Blast radius & risks

- Un-skipping `_x.ai/session/update` only routes subagent variants; `rewind_marker`/other `_x.ai` tags still ignored (explicit allowlist).
- A second+ set of child tailers per active grok turn — bounded by concurrent subagents, disposed on settle/teardown; kill switch is the escape hatch.
- Schema unverified vs a real binary (A5, session-wide): defensive parsing + kill switch contain it; worst case = no tabs, never a crash.
- `parent_kind="subagent"` shared with claude: harmless (no query filters by it per-kind; webview is kind-blind).
- Boot reconcile change touches a claude-critical path (`:651`) — must keep claude behavior byte-identical (only widen the gate, add a parallel grok arm).

## 8. Open questions / assumptions

- A1 (owner-approved): full transcript tabs; reuse `parentKind:"subagent"`; defensive + `AGETOR_GROK_TRACK_SUBAGENTS=0` kill switch.
- A2: no live progress counters (grok doesn't persist `subagent_progress`) — tabs show running/finished + type/description only.
- A3: no `tool_use_id` correlation (grok's finish event is authoritative) — no tool_result-scan fallback like claude's.
- A4: nested subagents (spawnDepth>1) — grok's `resumed_from` is subagent-to-subagent lineage, not depth; ship spawnDepth=1 for all (webview's `CornerDownRight` nested marker just won't show; acceptable v1).
- A5: contract source-verified only; live-binary smoke still pending session-wide.
