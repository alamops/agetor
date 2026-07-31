# Plan — Treat Claude Code Workflows (`/workflow`) as running background agents

| Field | Value |
| --- | --- |
| Date | 2026-07-31 |
| Source | `/implement` — "add support to claude code workflows `/workflow` as running BG agents, so the task is kept in the `running` status and column" |
| Config | AGENTS_CONFIG.yml (balanced; `implementation` for T2 overridden to `opus` per `allow_orchestrator_override`) |
| Branch | `fix/claude-code-workflows-as-running-status` (pre-existing feature branch, clean) |
| Base SHA | `988b77f` (== main tip at start) |
| Mode | **Autonomous** — grill + plan-approval gates bypassed; every owner decision below is a logged assumption (§8) |

## 1. Objective & success criteria

When a claude-code task launches a **Workflow** (the `/workflow` multi-agent orchestration tool, run ids `wf_…`), the workflow runs in the background and the main turn ends immediately — today the card jumps to `review` while the workflow is still churning. After this change:

1. Workflow launch (`toolUseResult.taskType === "local_workflow"`, `status === "async_launched"`) → a `subagents` row (`parentKind: "workflow"`) is created `running` → the existing hold gate (`subagents.hasRunning`) keeps the card in `running`.
2. The workflow-completion `<task-notification>` (whose `<task-id>` equals the launch's `taskId`) settles that row via the **unchanged** existing notification path → last running row gone → card flips to `review`.
3. Each workflow agent transcript (`<sessionId>/subagents/workflows/<wf_runId>/agent-<id>.jsonl`) is discovered, tailed, and rendered as a read-only tab exactly like regular subagents (`parentKind: "workflow_agent"`).
4. A workflow launched while the card sits in `review` (follow-up turn) pulls the card back to `running` (existing `pullBackParkedTask`).
5. Session death, `Stop` on a held task, delete/archive, and boot reconciliation all release the hold (existing orphan paths, unchanged).
6. Codex/grok tasks and regular subagent behavior are completely unaffected. Everything is behind `AGETOR_TRACK_WORKFLOWS` (default on) nested under `AGETOR_TRACK_SUBAGENTS`.

## 2. Context & constraints (ground truth, empirically verified 2026-07-31 on claude CLI ≥2.1.220 by running a live probe workflow)

- **Launch:** main JSONL `user` line carries `toolUseResult: { status: "async_launched", taskId: "w2u1mlzr0", taskType: "local_workflow", workflowName, runId: "wf_…", summary, transcriptDir, scriptPath }`. `transcriptDir` = `<sessionDir>/subagents/workflows/<wf_runId>` — **inside** the `subagents/` dir agetor already watches, but in a subdirectory the flat `/^agent-(.+)\.jsonl$/` readdir scan (`claude-subagents.ts:506-549`) never sees. Workflows are always background; the tool_result is immediate.
- **Per-agent files:** `agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` in the wf dir. Meta = `{ agentType: "workflow-subagent", spawnDepth: 1, model }` — **no `toolUseId`, no `description`**. The jsonl is the standard sidechain shape (`isSidechain: true`, parent's `sessionId`, `agentId`, terminal assistant `stop_reason: "end_turn"`) — the existing tailer/mapper consumes it as-is.
- **`journal.jsonl`** in the wf dir: `{"type":"started","key","agentId"}` / `{"type":"result","key","agentId","result"}` per agent — a harness-written completion receipt, immune to the terminal-line flush-loss failure (fleet knowledge: concurrent subagents can lose their terminal `end_turn` line; workflows run up to ~10 concurrent agents, so this matters).
- **Completion:** `<task-notification>` in the main JSONL (`queue-operation` enqueue + synthetic `user` shapes, both already parsed by `claude-tmux.ts:dispatchLine`) with `<task-id>` = the **taskId** (`w2u1mlzr0`), `<tool-use-id>` = the launching Workflow tool_use id, `<status>` ∈ completed/failed/killed/stopped.
- **Existing seams (verified):**
  - `setBackgroundTaskSettledHandler` → orchestrator wires `(_taskId, agentId) => settleSubagentById(agentId, "completed")` (`orchestrator.ts:292-293`) — settles any row by PK, no-ops on unknown ids. **Row PK = workflow taskId ⇒ live completion path needs zero changes.**
  - `scanMainForToolResults` (`claude-subagents.ts:737-774`) — watcher-side main-JSONL scan with its own `mainOffset` cursor; only matches file-backed rows with `toolUseId`, so workflow rows are structurally excluded from the false-settle hazard (their tool_result is the immediate `async_launched` stub).
  - `discover()` fires `fireParkedDiscovery(taskId)` on fresh inserts (`claude-subagents.ts:547`) → pull-back for free.
  - `orphanRunningSubagents(taskId)` flips **all** running rows for a task (kind-agnostic) → death/stop/boot release for free.
  - Boot reconciliation re-arms only `attachSubagentWatcher` (no main tmux tailer) — so workflow launch/completion detection must live in the **watcher's** main-JSONL scan, mirroring why the tool_result scan is watcher-side (fleet knowledge c8edc832).
- **Schema:** `subagents.parent_kind` is TEXT, no CHECK constraint (`022_subagents.sql`), explicitly reserved for new kinds — **no migration needed**. Next free number would be 032 if one becomes necessary; it doesn't.
- **Test hygiene (fleet-verified):** `bun test` = one process, one SQLite DB. Seed run rows terminal (`succeeded` + `endedAt`), track and hard-delete created tasks in `afterEach`, save/restore hook setters (they return the previous value), use `attachSubagentWatcher({ manual: true })` + `pump(now)` — no real timers.

## 3. Approach & key decisions

**One container row per workflow + one row per workflow agent, all in the existing `subagents` table.**

- The **container row** (`parentKind: "workflow"`, `id` = workflow taskId, `sourcePath` = transcriptDir, `agentType: "workflow"`, `description` = workflowName — with `summary` fallback, `toolUseId` = launching tool_use id) is what carries the **hold**: it's `running` from launch to completion-notification, so `hasRunning` stays true across the gaps *between* agent waves and the card never bounces `running → review → running` mid-workflow.
- **Agent rows** (`parentKind: "workflow_agent"`, `id` = agentId, `sourcePath` = the agent jsonl) give the read-only tab streams, reusing `tailFile` + the standard mapper untouched.
- **Container settle:** notification only (live: claude-tmux dispatchLine → existing handler; boot/watcher-only: the watcher's main scan learns to parse the same notification) — plus the generic orphan paths. No idle settle (no file backs it).
- **Agent-row settle:** existing end_turn idle **plus** journal `result` receipts (covers flush-loss) **plus** cascade — when the container settles, any still-running agent rows under its `transcriptDir` settle with it (a finished workflow cannot have live agents).

**Rejected alternatives:**
- *Per-agent rows only, no container* — between waves `hasRunning` drops to 0 → premature release + pull-back churn. The container matches the workflow's true lifetime.
- *Hold on the container only, don't track agents* — cheap, but loses the tab streams users already have for regular bg agents, and the per-agent journal receipts are nearly free.
- *Detect launches in claude-tmux's `dispatchLine`* — dead after a restart (boot path arms only the watcher). Watcher-side main-scan is the established pattern for exactly this reason.
- *New table / migration* — `parent_kind` was designed as this seam; no schema change needed.

## 4. Work breakdown — implementation tasks (one wave, disjoint files)

### T1 — Types + UI (runner: sonnet)
**Owns:** `src/shared/types.ts`, `src/mainview/lib/subagent-tabs.ts`, `src/mainview/components/RunPanel.tsx` (minimal touch)
1. `types.ts`: widen `Subagent.parentKind` to `"subagent" | "bg_session" | "workflow" | "workflow_agent"`; update its doc comment. Touch nothing else in the file.
2. `subagent-tabs.ts`: the **container row must not render as a tab** (it has no event stream — an empty tab is confusing). Add/extend the pure helpers so rows with `parentKind === "workflow"` are excluded from the tab list while `workflow_agent` rows render exactly like `subagent` rows. Keep helpers pure; extend the existing unit test file for `subagent-tabs` accordingly (that test file is yours too).
3. `RunPanel.tsx`: only if the tab derivation doesn't already flow through the helper you changed — keep the diff minimal; do not touch state management, SSE handling, or the composer.

**Acceptance:** typecheck clean; `subagent-tabs` unit tests cover: workflow container excluded, workflow_agent included, mixed list ordering stable.

### T2 — Watcher: workflow discovery, main-scan signals, journal settle, cascade (runner: **opus**)
**Owns:** `src/bun/claude-subagents.ts` (and `src/bun/db.ts` **only if** a helper is genuinely unavoidable — prefer zero db.ts changes; `insertIfAbsent`/`markSettledById`/`listForTask` should suffice)

1. **Kill switch:** `const WORKFLOWS_ENABLED = ENABLED && process.env.AGETOR_TRACK_WORKFLOWS !== "0"`. All new behavior gated on it.
2. **Workflow-dir discovery** (extend `discover()` or a sibling called from the same sites): scan `subagentsDir/workflows/` for `wf_*` dirs (tolerate absence); in each, match `/^agent-(.+)\.jsonl$/` → `insertIfAbsent` a `parentKind: "workflow_agent"` row (`sourcePath` = that file, meta read for `agentType`/`spawnDepth`/`model`; description: fall back to the container row's description or the wf dir name; **meta has no toolUseId — leave it null**) → tail via the existing `tailFile` path so events land `subagentId`-tagged. Fresh inserts must fire `fireParkedDiscovery` and count as discovery activity for the DEEP_IDLE clock, same as regular subagents.
3. **Journal tailing:** per active wf dir, tail `journal.jsonl` (byte-offset cursor like the main scan; re-read partial trailing lines next tick). A `{"type":"result","agentId"}` line → `settleSubagentById(agentId, "completed")` (idempotent, no-op if already settled by end_turn idle).
4. **Main-scan extension** (rename `scanMainForToolResults` → e.g. `scanMainSignals`, same single `mainOffset` cursor; keep the cheap substring prefilters):
   - **Launch:** a `user` line whose `toolUseResult` has `taskType === "local_workflow"` && `status === "async_launched"` → `insertIfAbsent` the **container row**: `id` = `taskId`, `parentKind: "workflow"`, `agentType: "workflow"`, `description` = `workflowName ?? summary`, `sourcePath` = `transcriptDir`, `toolUseId` = the enclosing `tool_result` block's `tool_use_id` (metadata only — the container is not in the `files` map, so the tool_result settle scan can never match it). Fire `fireParkedDiscovery` on fresh insert. **Important:** the current early-return (`pending.length === 0`) must not skip workflow-signal scanning when `WORKFLOWS_ENABLED`.
   - **Completion:** a task-notification payload (both the `queue-operation` enqueue shape and the synthetic `user` shape; match `<task-id>([^<]+)</task-id>`) whose id equals a tracked **running workflow container row** → settle it. Statuses: `completed` → `"completed"`; `failed`/`killed`/`stopped` → also settle (`"completed"` unless a richer mapping is trivial — the hold must release either way). This is the boot-path backstop; live sessions also settle via the untouched claude-tmux handler, and `settleSubagentById` is idempotent so double-fire is safe.
5. **Cascade:** wrap/extend the settle flow so that when a **container** row settles (any path: notification, watcher scan, orphan), every still-`running` `workflow_agent` row whose `sourcePath` starts with the container's `sourcePath` is settled too (`settleSubagentById` each, so lifecycle emits + the hold re-check fire per row). Implement at the claude-subagents level (e.g. inside `settleSubagentById` when the settled row's `parentKind === "workflow"`, or a small wrapper) — **do not** touch orchestrator.ts.
6. **Reattach hygiene:** on watcher (re)attach, rehydrate workflow rows like regular ones (existing DB rehydrate loop); do not resurrect settled rows (mirror the grok lesson: check existing row status before re-emitting "started" lifecycle). Replaying the main JSONL from offset 0 will re-see old launch lines — `insertIfAbsent` makes that a no-op; a launch line for an already-settled container must not flip it back.

**Boundaries:** no changes to `claude-tmux.ts`, `orchestrator.ts`, `server.ts`, migrations, or the UI. The `parentKind` union values come from T1's contract above — compile against `"workflow"` / `"workflow_agent"` literals.

**Acceptance:** typecheck clean; existing `claude-subagents.test.ts`, `subagent-settle.test.ts`, `subagent-toolresult-settle.test.ts` still pass unmodified.

## 5. Work breakdown — test tasks (one wave, after review)

### TT1 — Workflow watcher behavior (`src/bun/claude-workflow-agents.test.ts`, new file) — covers T2
- Launch line in main JSONL → pump → container row `running`, `parentKind: "workflow"`, `hasRunning` true; `fireParkedDiscovery` observed (via saved/restored `setParkedDiscoveryHandler`).
- wf-dir agent file + meta → pump → `workflow_agent` row, events tagged with the agent id; journal `result` line → row settles even **without** a terminal end_turn line in the agent jsonl (the flush-loss case).
- Notification enqueue line (queue-operation shape) → pump → container settles; still-running agent rows cascade-settle; settle hook fired.
- Replay-from-0 idempotency: re-attach the watcher, pump — settled container is not resurrected, no duplicate lifecycle emits.
- `AGETOR_TRACK_WORKFLOWS=0` → none of the above rows are created (save/restore the env var).
- Conventions: module-top `AGETOR_DATA_DIR` mkdtemp, `manual: true` + `pump(now)`, terminal-status seeded runs, `createdTaskIds` + `afterEach` cleanup, hook setters saved/restored.

### TT2 — Hold/release + orphan integration (`src/bun/workflow-hold.test.ts`, new file) — covers success criteria 1/2/4/5
- Succeeded terminal run + running container row → task stays `running` (`isHeldByBackgroundAgents` true); settle container → `review`.
- Task in `review` + fresh container insert firing parked discovery → back to `running`.
- `orphanRunningSubagents(taskId)` flips container + agent rows and releases the hold.
- Same seeding/env idiom as `subagent-hold.test.ts` (fake drivers via env, terminal run rows).

### TT3 — Tabs derivation (extend the existing `subagent-tabs` unit test file — **owned by T1, executed here only if T1 left gaps**; skip if already covered).

## 6. Execution waves

- **Wave 1** — T1 + T2 in parallel (disjoint files). Barrier: `bun run typecheck` + full `bun test` (regression only) → commit `wave 1: …`.
- **Wave 2** — code review (opus, diff `988bf77f..HEAD` — use recorded base `988b77f`) → triage → fix must-haves.
- **Wave 3** — TT1 + TT2 in parallel (two new disjoint test files). Barrier: `bun test`.
- **Wave 4** — fixes to green (max 3 rounds).

## 7. Blast radius & risks

| Risk | Mitigation |
| --- | --- |
| Container row wedges `running` if claude dies before writing the notification | Same failure family as before: session-death watch + `disposeSessionState` + boot reconcile all call `orphanRunningSubagents` (kind-agnostic). A wedged-but-alive session still holds — consistent with the owner's prior "no watchdog" decision. |
| Workflow taskId collides with an agent id as PK | Both are harness-generated short random ids in the same namespace claude itself uses for `<task-id>`; collision would break claude's own notification routing first. Accepted. |
| Badge over-counts by 1 during waves (container + N agents) | Accepted (assumption A2): between waves the container alone keeps the badge truthful ("still working"). |
| Old transcripts replayed at attach create rows for long-dead workflows | Launch line precedes notification line in-file; replay settles them in order. Never-completed + dead session → boot orphan pass. |
| `scanMainForToolResults` early-return starves workflow signals | Called out explicitly in T2.4; TT1 covers launch detection with zero pending toolUseId rows. |
| Grok/codex regression | Neither writes `workflows/` dirs nor `local_workflow` toolUseResults; all new code paths are claude-watcher-internal and env-gated. |
| Stop on a held-by-workflow task | `stopHeldTask` → interrupt session + `orphanRunningSubagents` — kind-agnostic, releases the hold. Claude's own Ctrl+C tears down the workflow harness-side. |

**Rollback:** all changes are additive behind `AGETOR_TRACK_WORKFLOWS`; setting it to `0` restores today's behavior exactly (no rows → no hold → no tabs).

## 8. Open questions / assumptions (autonomous mode — owner to audit)

- **A1 (scope):** hold + per-agent tabs + badge; the container row is hidden from the tab strip. UI beyond `subagent-tabs.ts` exclusion (e.g. a "workflow" group header over its agent tabs) is out of scope.
- **A2 (badge):** `runningCountsByTask` stays generic — the container counts as one background agent. Over-count of 1 during waves accepted for between-wave truthfulness.
- **A3 (gate):** only `succeeded → review` is gated, mirroring the prior owner decision; cancelled/api-error/session-died outcomes win outright.
- **A4 (statuses):** notification `<status>` failed/killed/stopped all settle the container as `completed` (release the hold); we do not surface a distinct failed-workflow state on the card. Revisit if users need it.
- **A5 (kill switch):** `AGETOR_TRACK_WORKFLOWS`, default on, nested under `AGETOR_TRACK_SUBAGENTS` — follows `AGETOR_TRACK_<THING>` convention.
- **A6 (nested workflows):** `workflow()`-in-workflow children share the parent's transcript dir per the harness contract (one level only); the dir scan handles whatever appears, no special casing.
- **A7:** no real-app smoke test in this run (unit/integration suite only), matching the predecessor feature's verification bar.

## 9. What actually shipped — deviations from this plan

1. **db.ts was touched after all** (plan preferred zero changes): the pre-existing `toSubagent` read-coercion (`parent_kind === "bg_session" ? … : "subagent"`) silently collapsed unknown kinds to `"subagent"`, which would have neutered every workflow branch on rows read back from SQLite. Replaced with a `PARENT_KINDS` allow-list.
2. **orchestrator.ts was touched** (plan said no changes needed): review found the hold race — the container row is created by a watcher poll (4–10 s tiers) while `attachDoneHandler` evaluates the hold ~800 ms after end_turn, so the card bounced `running → review → running` on nearly every launch. Fixed by `pumpWatcherForHoldCheck(taskId)` called right before the hold predicate; this also closes the same pre-existing race for async `Agent` subagents launched at the end of a turn.
3. **Attach-time main-JSONL replay is clamped** to `REPLAY_WINDOW_BYTES` (4 MB) when no toolUseId correlation is pending — without it, boot reconciliation sync-read entire multi-MB transcripts per watcher.
4. **`workflow_agent` files are tailed past settle** while their container runs, so a journal-receipt settle can't permanently truncate a tab whose terminal lines flush late.
5. **Notification matching is anchored** on the literal `<task-notification>` substring + `matchAll` (a quoted `<task-id>` in ordinary content must never false-settle a container — that would be unrecoverable).
6. **The cascade fires the settle hook once, at depth 0**, after all agent rows settle, making the "release sees the whole workflow at once" invariant actually true.
7. RunPanel.tsx needed no changes — all tab derivation flows through the pure helpers in `subagent-tabs.ts`.
8. Deferred from review (accepted): a `pendingReceipts` buffer for journal receipts arriving before agent-file discovery (container-settle cascade is the backstop), and deep-idle-tier retention for workflow state (matches existing `files.size` behavior).
