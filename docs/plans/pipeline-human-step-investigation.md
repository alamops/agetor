# Investigation — Pipeline Human Step

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Change | Add a new **Human Step** element to pipeline graphs: a pause/review gate that can sit between two steps or at the end, never first. Reaching it must leave the pipeline card in the board's **Review** state, give the human a control panel showing the work so far and the last handoff, and offer two decisions: **return to the previous step** (comment required) or **accept and continue to the next step** (comment optional, finish when there is no next step). This brief establishes what exists, what must change, and the decisions only the owner can make. |
| Agents | none (the pipeline step forbids subagents) — inline reading, baseline test runs, one read-only validator probe. Web search was unavailable in this environment (the search tool returned "cancelled"), so the repo's own docs and code are the only sources. |
| Flags | none |
| Branch | `feature/agetor-pipeline-human-step` at `e4cc58e5` |

## 1. What we know

### 1.1 The contract

There is **no PRD, ticket or spec in the repo** for this feature. The only contract is the pipeline step's own task text (quoted in the header row). If a ticket/PRD exists outside the repo, it must be linked or copied in before planning; this investigation used only the step text. The existing pipeline design is documented in:

- `docs/plans/pipelines.md` — the original design (D1–D14, especially D1 parent/step task split, D2 shared worktree, D3 handoff contract, D4 graph rules, D8 freeze-at-run-start, D9 lifecycle).
- `docs/architecture/pipelines.md` — the current, code-accurate reference for the runner, routes, state machine, UI and CLI.
- `README.md:178-233` — the user-facing pipeline description.
- `docs/plans/pipeline-mark-done.md:21-43` — what "Review" means for a finished pipeline (run `done` → Review column; Done is a separate park action).

The owner's wording maps onto the app as follows:

| Owner phrase | App concept today |
| --- | --- |
| "pause / review / breaker" | A pipeline run that stops advancing and waits on a human |
| "behavior of the card/pipeline must be the same of the Review status" | Board column `review`, the same column a successful task/pipeline run lands in; no `blocked` amber state |
| "control panel view/modal of the work done so far, including the last handoff" | A new human-review surface over `run.history` + `run.humanSteps[].arrivals[].handoff` |
| "send that as a return to the previous step" | Re-enter the step that handed off to the human step, with the comment as feedback |
| "accept and send to the next step (if exists)" | Continue along the human step's outgoing edge(s), or finish when there are none |

### 1.2 The current graph model

- `PipelineStep` is an **agent-profile-bound** node: `id`, `name`, `instructions`, `agentProfileId: string | null`, `position`, `subagents`, `transition: "choose" | "all"`, `join: "any" | "all"` — `src/shared/types.ts:509-533`. There is **no step type/kind field**.
- `PipelineGraph` is `{steps, edges, startStepId}` — `src/shared/types.ts:548-552`. `startStepId` may be `null`; `resolveStartStep` falls back to the unique step with no incoming edges — `src/shared/pipeline.ts:603-611`.
- `newStep()` creates an agent step with no profile, `transition:"choose"`, `join:"any"` — `src/shared/pipeline.ts:350-362`.
- `validatePipelineGraph` normalizes/validates the graph; it explicitly builds each step object and **drops unknown keys** (it does not spread the raw step) — `src/shared/pipeline.ts:378-592`. A read-only probe (below) proves a `type:"human"` field is currently stripped and an agent-less start step is accepted.
- `PIPELINE_LIMITS` caps names, instructions (20k), steps (50), edges (200), handoff sizes, etc. — `src/shared/types.ts:841-883`.
- The live template is stored as JSON in `pipelines.graph` (migration `057_pipelines.sql`), so **adding a step type needs no SQL migration**. A started run freezes the graph + profiles onto `tasks.pipeline_run.snapshot` (`PipelineRunSnapshot`, `src/shared/types.ts:681-688`; `buildSnapshot`, `src/bun/pipeline-runner.ts:879-908`).

### 1.3 The current run model

- `PipelineRunStatus = "idle" | "running" | "blocked" | "done" | "cancelled"` — `src/shared/types.ts:622`. There is **no `review` status**.
- `PipelineRunState` holds `snapshot`, `status`, `active` (one entry per running/blocked step **task**), `joins`, `blocked`, `history`, `stepCount`, `startedAt`, `endedAt`, `capExtensions`, `stopRequestedAt` — `src/shared/types.ts:808-836`.
- `PipelineStepRecord` requires `taskId: string`, has `outcome: "succeeded" | "failed" | "cancelled" | "advanced-manually" | null`, `handoff`, `nextStepIds`, plus response/reminder/stop fields — `src/shared/types.ts:740-795`.
- `deriveRunStatus` is: blocked wins; stopped (`stopRequestedAt` or every active execution stopped) → cancelled; any active → running; explicit cancelled/idle preserved; else done — `src/shared/pipeline.ts:1120-1133`.
- `persist` maps status → board column: `running → running`, `blocked → blocked`, `done → review`, `cancelled → ready`; it writes `tasks.setPipelineRun` and emits the `pipeline` GlobalEvent — `src/bun/pipeline-runner.ts:269-308` (mapping at `:290-295`).
- `PipelineRunState` is persisted as JSON in `tasks.pipeline_run`; `parsePipelineRunState` sanitizes it defensively (`src/bun/db.ts:761-825`), with the status whitelist at `src/bun/db.ts:503` and history outcomes at `src/bun/db.ts:577`.

### 1.4 How a step actually runs today

- `startTaskInner` branches a pipeline parent straight to `startPipelineRun(task)` before every harness/profile pre-flight — `src/bun/orchestrator.ts:2044-2055`.
- `createTask` validates a pipeline up front and **requires every step to have a resolvable agent** — `src/bun/orchestrator.ts:8491-8507`. It also mirrors the start step's profile onto the parent's cosmetic fields (`:8535-8537`).
- `buildSnapshot` **also requires every step to have an `agentProfileId`** — `src/bun/pipeline-runner.ts:884-889`.
- `launchStep` requires a snapshot, refreshes the shared worktree, checks the step cap, looks up the frozen profile, **inserts a hidden `tasks` row** with the parent's worktree fields, pushes `run.active` + `run.history`, persists, then calls `startTask(childId)` — `src/bun/pipeline-runner.ts:1056-1281` (profile check `:1118-1129`, insert `:1219-1259`, active/history `:1261-1262`).
- `advanceOnHandoff` removes the settled execution from `run.active`, marks history `succeeded`, moves the step task to `done`, then resolves/launches the next steps — `src/bun/pipeline-runner.ts:2757-2903`. It implements `join:"all"` accumulation (`run.joins`) and `transition:"all"` fan-out.
- `resolveNextSteps` is the pure next-step resolver: 0 outgoing = terminal; `transition:"all"` = every outgoing; one outgoing = that step; several = `handoff.next` matched against target name → id → edge label; no/miss = `ambiguous`/`unknown` — `src/shared/pipeline.ts:1068-1108`.
- The runner serializes every mutation of one parent's run state through `runExclusive`/`withPipelineLock` — `src/bun/pipeline-runner.ts:147-178`.
- Boot-time `reconcilePipelineRuns` only sweeps parents whose status is `running`, or `blocked` with active executions — `src/bun/pipeline-runner.ts:3517-3544`. A paused human run with no active executions would be skipped (which is fine if its state is persisted).
- `startPipelineRun` handles `blocked`/`cancelled` as retry-in-place and `done` as "restart explicitly"; **any other status falls through to a fresh run** — `src/bun/pipeline-runner.ts:1600-1626`. A new `review` status must be guarded here or a plain Run would silently discard the human state.
- `cancelPipelineRun` only acts when something is genuinely live or a runner decision is pending — `src/bun/pipeline-runner.ts:1993-2047`. A human step with no task would make `agetor cancel`/Stop 409 ("pipeline is not running").
- Restart (`opts.restart`) re-validates, re-snapshots, resolves the start step, refreshes the worktree, archives every old step row, and replaces `run` — `src/bun/pipeline-runner.ts:1686-1732`. It must also clear any human state.

### 1.5 What "Review status" means today

- A normal task whose run exits 0 moves to column `review` (`src/bun/orchestrator.ts:3419`), gets a success toast on `run-status succeeded` (`src/mainview/App.tsx:1589-1602`), shows **Open + Done** on its card, and has no amber "awaiting" ring.
- A finished pipeline (`run.status === "done"`) maps to column `review` (`src/bun/pipeline-runner.ts:293`), gets a **"Pipeline finished"** toast/notification on the transition into `done` (`src/mainview/App.tsx:1684-1690`, `src/bun/headless-notifications.ts:162-171`), and its card shows Open + Done.
- The **only** manual column write allowed on a pipeline parent is `column:"done"` while `run.status === "done"` — `src/bun/server.ts:5574-5581`. A pipeline parent in Review for any other reason cannot be parked in Done; a direct PATCH 409s with `"pipeline task's column is managed by its run"`.
- `TaskCard` renders its **Done** button for **any** `task.column === "review"` — `src/mainview/components/kanban/TaskCard.tsx:353-357`. The context menu's **Mark done** does the same — `src/mainview/lib/task-context-menu.ts:121-123`. So a human-pending pipeline card placed in Review would show a Done button that 409s unless the card/menu is taught to suppress it.
- `TaskCard`'s `hasOpenablePipelineRun` is `pipelineRun.history.length > 0`; the primary button becomes Open once a pipeline has run — `src/mainview/components/kanban/TaskCard.tsx:84-91`. Stop is gated on `pipelineRun.status === "running"` — `:92-97`.
- The run view's **Done** button is gated on `run.status === "done"` — `src/mainview/components/pipelines/PipelineRunView.tsx:863`; its `reviewActive` section only covers `run.active` executions whose **step task** column is `review` — `:872-878`. A human step represented without a task row (the recommended design, §3 assumption 2) would be invisible there.
- `pipelineStepProgress` counts `run.active` only; a human step with no task would not appear in the badge's "`<completed>/<total> · <active step>`" label — `src/shared/pipeline.ts:1512-1525`.
- `GET /tasks` trims `pipelineRun` per task: it nulls every history/join handoff and empties `snapshot.profiles` — `src/bun/server.ts:1107-1118`, applied at `:5406`. Any new human arrivals with handoffs must be trimmed the same way or the 2s board poll would ship them forever.
- `GET /tasks/:id/pipeline` returns the **full** parent task plus its step task rows — `src/bun/server.ts:5984-5999`; `GET /tasks/:id` also returns the full state. The human panel can rely on the full state.

### 1.6 The current UI surfaces

**Editor** (`src/mainview/components/pipelines/`):

- `StepNode` is shared by editor and run view. It has a `VISUAL_CLASSES` map keyed by lifecycle state (`idle`, `active`, `done`, `blocked`, `failed`, `cancelled`) — `StepNode.tsx:45-56`; it always renders an `AgentProfileCard` chip, or a warning `"No agent"` when `agentProfileId` is null — `StepNode.tsx:130-140`; attention styling/chip at `:115-127`.
- `StepPanel` is the editor's right-hand panel: name, instructions, Agent picker (+ "New agent…"), subagent picker/cap, transition, join, "Connect to…", Set as start, Delete — `StepPanel.tsx:78-286`. Nothing is conditional on step type.
- `PipelineEditor` starts a blank draft with one agent step as start (`blankGraph`, `PipelineEditor.tsx:134-137`); `appendStep`/`addStep` create agent steps (`:290-323`); `addStep` auto-sets the new step as start when none is set (`:321`); `deleteStep` picks another node as start when deleting the start (`:332-340`); save validates synchronously (`:659-663`).

**Run view** (`PipelineRunView.tsx`):

- Status labels/classes are exhaustive `Record<PipelineRunStatus, …>` — `:137-151`; restartable statuses `["done","cancelled","blocked"]` — `:164`; `isTerminalRunStatus` = done/cancelled — `:133-135`.
- Node click resolves `stepNodeTaskFor`; a step with no task shows the `"hasn't started yet"` note — `:694-709`, `:1013-1020`.
- Side panel renders Goal, blocked entries (with Retry/Advance), `reviewActive` (with `AdvanceForm`), and history rows (`HistoryRow`) whose handoffs render as `HandoffCard` — `:1023-1184`, `:1186-1245`, `:1257-1405`.
- `nodeVisualSignature` includes active/blocked/history/columns — `:532-545`; the identity-stable merge only repaints when that signature changes. Any new human state must be added there.
- `reviewActive` and `AdvanceForm` are the existing "manual decision" UI; the human panel can follow their visual language but needs its own form.

**App / board / notifications**:

- `App.tsx`'s `view` union is `{kind:"board"} | {kind:"pipelines",…} | {kind:"pipeline-run", taskId}` — `App.tsx:214`. `openPipelineRun`/`openPipelineAttention`/`openPipelineStep` route pipeline landings through `navigate` — `:495-548`.
- `openPipelineAttention` resolves a **step task** via `pipelineAttentionStepTask`; a human step represented without a task row has none, so the attention path would land on the run view alone — `:520-540`, resolver `src/mainview/lib/pipelines.ts:344-390`.
- `TaskCard`'s amber Answer/Review button is driven by `awaiting = pendingInteractionCount > 0 || column === "blocked"` — `TaskCard.tsx:98-108`; a Review-column human step would not be amber.
- `pipeline` GlobalEvent handling: `prevStatus` is remembered; status `blocked` raises "Pipeline needs you"; status `done` raises "Pipeline finished"; no other status has a toast — `App.tsx:1670-1690`. `headless-notifications.ts:162-171` mirrors this for the headless core.
- `pipelineStatusRef` and `pendingInputRef` are the existing dedupe/clear machinery; a new `review` status must fit its "non-blocked" cleanup path — `App.tsx:1673-1682`.

### 1.7 CLI, TUI and bundle surfaces

- `agetor pipeline show` prints every step's profile (`step.agentProfileId ? … : "none"`) — `src/cli/commands/pipeline.ts:375-431`.
- `agetor pipeline status` prints run status, blocked entries, active executions, and history; the history line **slices `h.taskId`** — `src/cli/commands/pipeline.ts:441-510` (slice at `:494`). A nullable human `taskId` would crash it.
- `agetor pipeline advance|retry|restart` resolve a pipeline **task**; `advance` requires `--next` or `--finish` — `src/cli/commands/pipeline.ts:95-130`, `:205-236`.
- `agetor show` prints a parent's pipeline status + progress — `src/cli/commands/show.ts:75-85`; `ls` adds a blocked hint only — `src/cli/commands/ls.ts:163-171`; the TUI shows `pipelineStepProgress` text — `src/cli/tui/Dashboard.tsx:612-654`.
- Bundle format: `BundleStep` is `{id, name, instructions, agent, position, subagents, transition, join}` — `src/shared/bundle.ts:95-105`; export explicitly builds those fields (`:883-914`); import maps `agent`→`agentProfileId` and spreads `...rest` before validation (`:1293-1340`). A new `type` field is additive and old readers would drop it; `BUNDLE_VERSION` is 1 and readers reject `version > 1` (`:37`, `:1544-1552`).

### 1.8 Standards that apply

- **Every route needs a `ROUTE_POLICY` entry**; pipeline run-control routes are `app+cli` — `src/bun/route-policy.ts:319-330`, `:372-376`. A new human-decision route needs an entry and a `route-policy.test.ts` pass.
- **Server-managed columns** (`pipeline_run` among them) are excluded from the generic `tasks.update` SET clause and `ALLOWED_PATCH_FIELDS`; writes go through targeted UPDATEs that never bump `updated_at` — `CLAUDE.md:97`, `src/bun/db.ts:1188-1195`.
- **Semantic status tokens only** for new UI (`success`/`warning`/`info`/`danger`), never literal palette classes — `CLAUDE.md:170-171`.
- **No second event stream**; use the existing `pipeline` GlobalEvent/store — `CLAUDE.md:105`, `src/mainview/lib/pipeline-events.ts`.
- **`RunPanel` is one long-lived instance**; a new per-task state in it needs a reset line — `CLAUDE.md:112`. The human panel should live in the run view, not RunPanel, unless it is deliberately added there.
- **Update the subsystem doc in the same change** — `CLAUDE.md:5`; the pipeline doc is `docs/architecture/pipelines.md`.
- **Tests**: `bun test`, `bun run typecheck`, Playwright e2e with the fake drivers; no jsdom — `CLAUDE.md:150-163`, `e2e/fixtures.ts`.
- **Bundle additive-field convention**: fields are written only when non-default (e.g. `opencodeServer`), so old exports stay byte-identical — `docs/architecture/bundle.md:9`.
- **Nothing agetor injects into an agent's prompt may name the product** — `CLAUDE.md:92`; the human-feedback section must be product-neutral.

### 1.9 Runtime and trust shape

- Local, single-user desktop app: one Bun main process owns the SQLite store and HTTP API; the React webview talks to it over loopback with per-launch tokens — `CLAUDE.md:21-27`. There is no multi-tenant/auth model; "the human" is the machine's owner.
- One core at a time (port ownership); the pipeline runner serializes per-parent mutations (`runExclusive`), and the board polls every 2s with SSE for sub-poll events — `docs/architecture/pipelines.md:25-33`.
- Trust: **agent handoffs are untrusted** (fenced with nonce markers and a warning), **human comments are owner-authored/trusted**, and a human comment must not be rendered inside the untrusted-handoff span or it would be mislabeled. See `src/shared/pipeline.ts:88-112`, `:1252-1286`.
- No remote access or background multi-instance concurrency is in scope for this feature.

## 2. What we proved

The first row is an executed baseline; the validator row is an executed read-only probe; the remaining rows are code-reading verdicts with exact anchors (not runtime experiments).

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Is the existing pipeline baseline green? | **Yes** | `bun --version` → `1.3.10`; `bun test src/shared/pipeline.test.ts` → `239 pass, 0 fail`; `bun test src/mainview/lib/pipelines.test.ts src/mainview/lib/task-context-menu.test.ts` → `184 pass, 0 fail`; `bun test src/bun/pipeline-runner.test.ts` → `114 pass, 0 fail`; `bun test src/bun/pipelines-endpoint.test.ts` → `73 pass, 0 fail`; `bun test src/shared/bundle.test.ts src/cli/commands/pipeline.test.ts` → `208 pass, 0 fail`; `bun run typecheck` → clean | bun 1.3.10, deps installed with `bun install --frozen-lockfile` | — |
| Does the graph validator already support a step type? | **No.** `validatePipelineGraph` strips an unknown `type` field and accepts an agent-less start step. | `bun -e 'import {validatePipelineGraph,newStep} from "./src/shared/pipeline.ts"; …'` → `{"ok":true,"graph":{"steps":[{"id":"h","name":"Human review","instructions":"","agentProfileId":null,"position":{"x":0,"y":0},"subagents":{"profileIds":[],"cap":null},"transition":"choose","join":"any"}],"edges":[],"startStepId":"h"}}`; `newStep()` output has no `type` | bun 1.3.10 | — |
| Does `createTask` / `buildSnapshot` / `launchStep` already require every step to have an agent? | **Yes** — all three would reject a human step unless changed. | `src/bun/orchestrator.ts:8501-8505` (`step "…" has no agent`), `src/bun/pipeline-runner.ts:884-889`, `:1118-1129`; existing test `src/bun/pipeline-runner.test.ts:689` ("…a pipeline with a step that has no agent") | — | — |
| Would a Review-column pipeline parent's Done button work? | **No** — the card renders Done for any `column === "review"`, but the server only allows `done → Done`. | `src/mainview/components/kanban/TaskCard.tsx:353-357`; `src/bun/server.ts:5574-5581` | — | — |
| Would a human step be visible in the run view today? | **No** — `reviewActive` only inspects `run.active` step tasks; a human step would have no task. | `src/mainview/components/pipelines/PipelineRunView.tsx:872-878` | — | — |
| Would the 2s board poll ship human handoffs? | **Yes, unless trimmed** — `trimPipelineRunForList` only nulls `history` and `joins` handoffs today. | `src/bun/server.ts:1107-1118` | — | — |
| Would a plain Run on a `review` run silently restart it? | **Yes** — `startPipelineRun` only special-cases `blocked`/`cancelled`/`done`; any other status falls into the fresh-run path. | `src/bun/pipeline-runner.ts:1600-1626` | — | — |
| Would `agetor pipeline status` crash on a human history record with `taskId: null`? | **Yes** — it calls `h.taskId.slice(0, 8)`. | `src/cli/commands/pipeline.ts:494` | — | — |
| Is there any existing "human step" code? | **No** | `grep -rn "human" src --include='*.ts' --include='*.tsx'` → only unrelated humanize/human-readable strings; no `humanStep`/`type:"human"` | — | — |

**Not spiked (and why):** the return mechanism's two candidate implementations (a fresh previous-step execution vs. resuming the previous step task's session) are a design decision, not a fact to measure; the fresh-execution path reuses `launchStep` and is the lower-risk one, while the resume path would need a small runner spike before planning it. The human panel's exact contents (diff vs. history only) are also a scope decision, not a technical unknown.

## 3. What we're assuming

1. **A new `PipelineRunStatus` `"review"`** is the right representation, not `blocked` + a new block kind. It maps to the Review column exactly like `done`, but is non-terminal (no `endedAt`, no Done button, no "Pipeline finished" toast). If the owner wants a `blocked` representation, the card would glow amber and say "Blocked", which contradicts "same as Review".
2. **Human steps get a dedicated pending state** on `PipelineRunState` (e.g. `humanSteps: PipelineHumanStep[]` with `stepId`, `seq`, `startedAt`, `arrivals`), plus a `PipelineStepRecord` whose `taskId` is `null` and whose decision/comment is stored as a normalized `Handoff` (comment in `summary`, decision in `reason`/`outcome`; the graph's step type marks it trusted when it reaches a join or a retry), with an optional `human` display field. No hidden task row is created for a human step. If we instead create a task row, the whole task/run/column/notification machinery would treat it as an agent execution and need far more special cases.
3. **`launchStep` branches before the profile lookup**: a human target increments `stepCount`, records the arrival(s), pushes the pending human state + a pending history record, and returns without inserting a task. This reuses the existing cap/archived/stopped/worktree guards.
4. **Accept** resolves the human step's outgoing targets using the existing `transition` rules and the existing join/fan-out machinery (ideally by generalizing `advanceOnHandoff`), and passes the human comment + the reviewed handoff(s) into the next step's prompt as a **trusted** "Human review feedback" section. Because a target may be a `join:"all"` step whose arrival is stored in `run.joins` as only `{fromStepId, seq, handoff}`, the comment must travel in a `Handoff`-shaped value (or `PipelineJoinArrival` must gain a human-feedback field) — otherwise a join launch loses the comment. If this is wrong, the next step loses context or the prompt mislabels the comment as untrusted.
5. **Return** re-enters the previous step with the comment as trusted feedback. The recommended v1 is a **fresh execution** of that step via `launchStep` (new hidden task, new history record, new `seq`), carrying the human comment and the step's prior handoff. The alternative is `sendInput` on the previous step task's existing session (preserves conversation context, but needs a re-armed active execution and a way to guarantee the handoff contract). If the owner wants the same session, the plan changes materially.
6. **Graph constraints**: a human step is never the start step, must have at least one incoming edge, has no agent/subagents, uses `join:"all"` (accumulate all arrivals), and human→human edges are rejected. If any of these is relaxed, validation, join handling and return-target resolution all change.
7. **The control panel is a modal in the run view**, opened from the human node, a run-view Review button, and (optionally) a card Review action. It shows the goal, the last handoff(s), a compact history, step-transcript links, and the comment/decision form. If the owner wants it inline in the side panel or a separate page, the component placement changes but not the data contract.
8. **Human steps count toward `maxSteps`.** They are executions in the run's budget; a return loop is human-gated but still bounded. If they should not count, `effectiveStepCap`/`stepCount` and the progress label change.
9. **Bundle v1 gains an additive `type: "human"` field** (omitted for agent steps to keep old exports byte-identical); old readers drop it and see an agent step with no agent, which fails at run time. If cross-version compatibility matters, the bundle version may need a bump or an explicit warning.
10. **No DB migration or backfill** is needed: the graph is JSON and the run state is JSON. Existing steps without `type` read as agent. If a migration is expected, the plan changes.

## 4. What we must ask the owner

1. **What exactly should the card do at a human step?** The requirement says "same as Review status". Today a Review card shows Open + Done, but Done would 409 for a non-`done` pipeline. Recommended: put the card in Review, keep Open, suppress Done, and add a neutral **Review** action that opens the human panel (no amber ring). Alternative: keep Done and make it mean "accept & finish" (confusing), or use the amber Answer/Review attention treatment (not the same as Review). *Why it matters: `TaskCard.tsx:353-357`, `task-context-menu.ts:121-123`, `server.ts:5574-5581`; the card/menu/guard all change differently per answer.*
2. **What does "return to the previous step" mean mechanically?** (a) Re-run the previous step as a fresh execution with the comment in its prompt (recommended: reuses `launchStep`, guarantees the handoff contract, new `seq`/task), or (b) send the comment as a follow-up turn into the previous step task's existing session (preserves context, needs a re-armed execution and a contract reminder). *Why it matters: (a) is mostly `composeStepPrompt` + `launchStep`; (b) touches `sendInput`, the settle/lookback window, and the "is this execution active?" state machine.*
3. **With multiple outgoing edges, how does accept choose?** Recommended: reuse `transition` — `choose` requires the human to pick one (the panel shows the candidates), `all` launches every outgoing step, zero outgoing finishes the run. If an outgoing target is a `join:"all"` step, the human comment must ride its arrival (a `Handoff`-shaped value, or an extended `PipelineJoinArrival`) or the join launch loses it. *Why it matters: `resolveNextSteps` and `advanceOnHandoff` already implement these rules for agents; the human form must expose the choice, and `run.joins` only stores `{fromStepId, seq, handoff}`.*
4. **With multiple incoming edges, which previous step does Return target?** Recommended: force human steps to `join:"all"` (wait for every incoming source), show every arrival's handoff, and require a `returnToStepId` when there are multiple distinct sources (or default to the latest). *Why it matters: `run.joins`/`PipelineJoinArrival` already model this; the UI and route need a target field.*
5. **Confirm the graph constraints**: never start; at least one incoming edge; no agent/subagents; `join:"all"`; no human→human edges. *Why it matters: validation (`validatePipelineGraph`), editor UI, `resolveStartStep`, `createTask`/`buildSnapshot`, and the runner all depend on these invariants.*
6. **What must the control panel show?** At minimum the goal, the last handoff card(s), and the comment/decision form. Should it also show the full history, buttons to open each completed step's transcript, and a **View changes** diff of the shared worktree? *Why it matters: the run view already has the history and handoff cards; a diff adds `api.getTaskDiff(parentId)`/`DiffDialog` wiring and more UI.*
7. **Modal or inline side panel, and how is it opened?** Recommended: a modal opened from the human node, a run-view Review button, and optionally the card's Review action. Should it auto-open when the run reaches the human step, or wait for the user to click Review? Should a half-typed comment survive closing/reopening the modal (the app has a persisted-draft pattern for the composer, but nothing for this panel yet)? *Why it matters: `App.tsx`'s view union, `openPipelineAttention`, the run view's modal state, and whether a draft needs `localStorage`/server persistence.*
8. **Comment rules**: required for Return, optional for Accept, trimmed, max length (recommend `PIPELINE_LIMITS.handoffField` = 8,000 or a new `humanComment` limit), blank/whitespace rejected, no comment needed for a terminal Accept. *Why it matters: route 400s, UI disabled state, CLI parsing, prompt size.*
9. **What should happen to the other actions while a human step is pending?** Recommended: no Stop (nothing is live), no Retry, no Advance, no Done; allow **Restart** (with the existing "history will be cleared" confirm) as the escape hatch, or leave Restart out and rely on archive/delete. *Why it matters: `RESTARTABLE_STATUSES`, `startPipelineRun`'s review guard, `cancelPipelineRun`, the card's Stop/Done logic.*
10. **Fan-out semantics**: if one branch reaches a human step while other branches are still running, does the whole pipeline pause, or only that branch? Recommended: only that branch; the run stays `running` until every active sibling settles, then becomes `review`; multiple human steps may be pending at once and each is shown. *Why it matters: `deriveRunStatus`, `pipelineStepProgress`, the run view's sections, and whether the human panel can coexist with active work.*
11. **Notifications**: should reaching a human step send a toast/OS notification? Normal Review sends "Task succeeded"; pipeline done sends "Pipeline finished". Recommended: a distinct "Pipeline needs your review" (success/pending tone) on the transition into `review`, and no "Pipeline finished" until a terminal Accept. *Why it matters: `App.tsx`'s `pipeline` handler, `headless-notifications.ts`, `toasts.ts`, and the OS-notification click landing.*
12. **Do human steps count toward `maxSteps`?** Recommended yes. *Why it matters: `stepCount`, `effectiveStepCap`, the `step-cap` block and the progress label.*
13. **CLI parity**: should `agetor pipeline review <ref> --accept|--return --comment …` exist alongside `show`/`status` changes, or is the UI the only required surface? The repo's convention is CLI parity for pipeline actions. *Why it matters: `route-policy.ts` (`app+cli`), `AgetorClient`, `cli/commands/pipeline.ts`, tests.*
14. **Bundle compatibility**: keep bundle version 1 with an additive `type:"human"` (old readers degrade to an agent step with no agent), or bump the version so old readers refuse the file? *Why it matters: `BundleStep`, export/import, `docs/architecture/bundle.md`, and the import preview.*
15. **Human step instructions**: should the `instructions` field be shown to the human as review guidance, or is it unused for human steps? Recommended: show it in the panel as "What to check". *Why it matters: editor StepPanel labels/placeholders and panel copy.*
16. **Is a "reject/stop" third action needed?** The task only names Return and Accept. Recommended: no extra stop; Return loops, Accept continues, and archive/delete/Restart are the escape hatches. *Why it matters: the panel's action set and the run state's terminal paths.*

## 5. Completeness inventory

### 5.1 Types and contracts

- `PipelineStep` — add a step type discriminator (e.g. `type: "agent" | "human"`), with `agentProfileId`/`subagents` constraints for human — `src/shared/types.ts:509-533`.
- `PipelineRunStatus` — add `"review"` — `src/shared/types.ts:622`.
- `PipelineStepRecord` — make `taskId` nullable for human records; add the human decision/comment shape (or store it as a normalized `Handoff`); add `"returned"` to `outcome` if used — `src/shared/types.ts:740-795`.
- `PipelineJoinArrival` / `PipelineBlock.pending` — if the human feedback is not encoded as a `Handoff`, these need a human-feedback field so a join arrival or a retry does not lose the comment — `src/shared/types.ts:650-673`.
- `PipelineRunState` — add the pending human state (e.g. `humanSteps`) — `src/shared/types.ts:808-836`.
- `PIPELINE_LIMITS` — add a human-comment cap if not reusing `handoffField` — `src/shared/types.ts:841-883`.
- `PipelineBlockKind` — no new kind if using `review`; otherwise a `human-step` kind and all its sanitizer/UI/CLI cases — `src/shared/types.ts:627-634`.
- `newStep` / `validatePipelineGraph` / `resolveStartStep` / `deriveRunStatus` / `pipelineStepProgress` / `composeStepPrompt` — `src/shared/pipeline.ts:350-362`, `:378-592`, `:603-611`, `:1120-1133`, `:1512-1525`, `:1220-1336`.
- Bundle `BundleStep` + export/import — `src/shared/bundle.ts:95-105`, `:883-914`, `:1293-1340`; `src/shared/bundle-import.ts` legacy path.

### 5.2 Runner and server callers

- `persist` column mapping / `endedAt` — `src/bun/pipeline-runner.ts:269-308`.
- `buildSnapshot` agent requirement — `:879-908`.
- `launchStep` profile check + task insert — `:1056-1281`; human branch must go before `:1118`/`:1219`.
- `launchTarget` result type / post-insert throw detection — `:1305-1341`; a human launch has no `runId` and no `run.active` entry.
- `advanceOnHandoff` — `:2757-2903`; human accept should reuse its resolve/join/fan-out/hold logic.
- `advancePipeline` manual advance into a human step — `:1752-1953`; the form's candidate list includes human steps.
- `performPipelineRetry` / `retryActiveExecutions` / `retryPendingBlocks` — `:1356-1567`; a pending human launch must be retryable and must carry the human feedback.
- `startPipelineRun` — `:1568-1734`; guard `review`, clear human state on restart.
- `cancelPipelineRun` — `:1993-2047`; 409 with only a human pending (or decide to allow).
- `reconcilePipelineRuns` — `:3517-3544`; skips `review` (fine) but must not mark it done.
- `cascadePipelineDelete` / `cascadePipelineArchive` — `:2060-2108`; no human task, but the run state is removed/archived with the parent.
- `createTask` pipeline validation + cosmetic start profile — `src/bun/orchestrator.ts:8491-8507`, `:8535-8537`.
- `startTaskInner` pipeline branch — `src/bun/orchestrator.ts:2044-2055`.
- `GET /tasks` trim — `src/bun/server.ts:1107-1118`, `:5406`.
- `PATCH /tasks/:id` pipeline column guard — `src/bun/server.ts:5574-5581`.
- `GET /tasks/:id/pipeline` — `src/bun/server.ts:5984-5999`.
- New human-decision route + `server.timeout(req, 0)` — follow `advance` at `:6007-6058`; `route-policy.ts:372-376`.
- `trimPipelineRunForList` must null human arrival handoffs — `src/bun/server.ts:1107-1118`.

### 5.3 DB / persistence

- `PIPELINE_RUN_STATUSES` — add `review` — `src/bun/db.ts:503`.
- `STEP_RECORD_OUTCOMES` — add `returned` if used — `src/bun/db.ts:577`.
- `sanitizeStepRecord` — allow `taskId: null` for human records; sanitize the human decision/comment — `src/bun/db.ts:632-666`.
- `parsePipelineRunState` — sanitize/emit `humanSteps` — `src/bun/db.ts:761-825`.
- `sanitizeRunSnapshot` — no deep graph validation; a human step's `type` passes through (old snapshots default agent) — `src/bun/db.ts:708-747`.
- `parsePipelineGraph` — validation now normalizes `type`; shape-safe fallback still accepts a type-less graph — `src/bun/db.ts:2621-2647`.
- No migration; `pipeline_run` JSON is additive. Existing rows with no `humanSteps` read as `[]`.

### 5.4 Webview surfaces

- `StepNode` — human border/chip/icon; no "No agent" warning; attention interaction — `src/mainview/components/pipelines/StepNode.tsx:45-140`.
- `StepPanel` — type radio; hide Agent/New agent/Subagents/cap for human; force `join:"all"`; disable Set as start; keep transition/connect/delete — `StepPanel.tsx:78-286`.
- `PipelineEditor` — blank/add/append defaults; auto-start guard; save validation — `PipelineEditor.tsx:134-137`, `:290-323`, `:659-686`.
- `PipelineRunView` — status labels/classes; terminal/restartable; node click; human pending section; human modal; `nodeVisualSignature`; history row nullable `taskId`/human decision; `reviewActive` separation — `PipelineRunView.tsx:133-164`, `:532-545`, `:694-709`, `:860-878`, `:1023-1184`, `:1257-1405`.
- `lib/pipelines.ts` — `stepVisualState` (human pending), `stepAttention` (human), `pipelineAttentionStepTask` (human has no task), `stepTaskFor`/`stepNodeTaskFor` (nullable taskId), `pipelineStepProgress` (human), `toFlowNodes`/`graphFromFlow` (type is in `data.step`, no change), `subagentSatellites` (human has none) — `src/mainview/lib/pipelines.ts:134-168`, `:262-294`, `:344-390`, `:899-958`.
- `lib/pipeline-scroll-memory.ts` — panel signature must include human pending state — `:74-85`.
- `TaskCard` — suppress Done for a pipeline parent whose run is not `done`; optional Review action — `TaskCard.tsx:319-357`.
- `Column` — if a new callback prop is added, add it to the hand-written memo comparator — `Column.tsx:49-121`.
- `task-context-menu` — suppress Mark done for a non-`done` pipeline; optional Review entry — `src/mainview/lib/task-context-menu.ts:121-123`.
- `App.tsx` — view union/landings; `openPipelineAttention` human resolution; pipeline event toast/cleanup; card Review action — `App.tsx:214`, `:495-548`, `:1670-1690`.
- `toasts.ts` / `headless-notifications.ts` — review notification copy/kind and OS click landing — `src/bun/headless-notifications.ts:162-171`, `:309+`.
- `PipelineBadge` — `review` status class/label — `src/mainview/components/pipelines/PipelineBadge.tsx:7-13`.
- `src/mainview/lib/api.ts` — a new `reviewPipeline` method calling the new route.

### 5.5 CLI / TUI

- `pipelineShowLines` — print `human` instead of `profile: none`; `pipelineStatusLines` — show pending human step/arrivals and handle nullable `taskId` — `src/cli/commands/pipeline.ts:375-510`.
- New `agetor pipeline review` (or equivalent) + `AgetorClient` method — `src/cli/commands/pipeline.ts`, `src/cli/api-client.ts` (use `START_TIMEOUT_MS`, since the route can launch a step), `src/cli/commands/pipeline.test.ts`.
- `agetor show` / `ls` / TUI progress — `src/cli/commands/show.ts:75-85`, `ls.ts:163-171`, `Dashboard.tsx:612-654`.
- `headless-notifications.ts` status map — `:309+`.

### 5.6 Existing data a migration would have to backfill

- **None.** `pipelines.graph` is JSON; `tasks.pipeline_run` is JSON; old steps have no `type` and must read as agent. Old runs have no `humanSteps` and must read as `[]`. No SQL column, no backfill, no migration.

### 5.7 Docs / config / examples that describe current behavior

- `docs/architecture/pipelines.md` — the primary subsystem doc; needs a Human steps section and updates to routes/runner/UI/CLI.
- `docs/plans/pipelines.md` — add the new decision(s) (e.g. D15) and the human-step contract.
- `README.md:178-233` — user-facing pipeline bullet and run-control table.
- `docs/architecture/bundle.md` — the bundle step schema/version note.
- `docs/architecture/notifications.md` — if a review notification is added.
- `docs/architecture/task-context-menu.md` — if a Review menu entry is added.
- `docs/plans/pipeline-mark-done.md` — Review/Done semantics reference; no change unless Done behavior changes.

### 5.8 What the change would orphan

- Nothing structural. The existing agent-step path stays. `pipelineStepProgress`'s `active` field gains human pending entries; any caller that assumed `active === run.active.length` must be checked (the run view, badge, CLI, TUI).
- If a new `review` status is added, every exhaustive `Record<PipelineRunStatus, …>` must add it (TypeScript will catch), and every `if (status === "done")` must decide whether it means "finished" or "finished or human review" (the compiler will not catch those).

## 6. Runnability

- **Setup:** dependencies were absent in this worktree; `bun install --frozen-lockfile` installed 696 packages and left `bun.lock` untouched. `bun --version` → `1.3.10`.
- **Start locally:** `bun run dev:hmr` (Vite + Electrobun, data dir `~/.agetor-dev`); `bun run dev` for the packaged/views path (requires `bun run build` first).
- **Unit tests:** `bun test <file>`; baseline suites above are green. `bun run typecheck` is green.
- **E2E:** Playwright, one shared Vite server + one headless Bun backend per worker (`playwright.config.ts`, `e2e/fixtures.ts`). Command: `bunx playwright test e2e/pipelines-run.spec.ts` / `e2e/pipelines-editor.spec.ts`. `freshBackend` gives an isolated data dir/port/token; the fake Claude driver is wired by `e2e/fixtures.ts` (`AGETOR_CLAUDE_DRIVER=fake`), and pipeline scenarios use `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER` (`e2e/pipelines-run.spec.ts:64-130`).
- **Test seams for the new scenarios:** existing fake Claude handoff markers (`:done`, `:missing`, `:rich`, etc.) drive the agent steps; the human step itself spawns no agent, so no new fake driver is needed. A pipeline `A → H → B` can be created over REST (the e2e helper already does this) and driven by the fake driver.
- **No jsdom** in the repo; component behavior is covered by pure-function unit tests plus Playwright. `bun test` runs every file in one process, so DB-importing tests must set `AGETOR_DATA_DIR` at module top level (`CLAUDE.md:140`).
- **Local dev caveat:** `bun test src/mainview/lib/pipelines.test.ts` failed before `bun install` with `Cannot find package 'react'`; after install it is green. This is a worktree setup issue, not a code issue.

## 7. Risks & blast radius

- **State-machine complexity is the main risk.** The runner already has a large settle/retry/lookback/held/stop machine. Adding a second kind of execution (no task, no run, no handoff parse) touches `launchStep`, `advanceOnHandoff`, `retryPendingBlocks`, `startPipelineRun`, `cancelPipelineRun`, `reconcilePipelineRuns`, and every `run.active` assumption. The plan should isolate the human branch and reuse the existing resolve/join/fan-out helpers rather than fork them.
- **Pending-block retries and join arrivals can lose the human comment.** `PipelineBlock.pending` only carries `{stepId, arrivals}` (`src/shared/types.ts:659-673`), and `PipelineJoinArrival` only carries `{fromStepId, seq, handoff}` (`src/shared/types.ts:650-654`). If a human accept targets a `join:"all"` step, the comment rides the arrival; if a human accept/return launch is blocked (archived parent, stopped run, step cap, worktree failure), a later Retry must reconstruct the human feedback from the human history record, or the pending block must carry it. Otherwise the next step/join runs without the comment. Encoding the human decision as a `Handoff`-shaped value is the lowest-friction way to survive both paths; a separate `humanFeedback` field requires extending both structures.
- **The card's Done button will 409** unless suppressed for a non-`done` pipeline parent (`TaskCard.tsx:353-357`, `server.ts:5574-5581`). The same applies to the context menu (`task-context-menu.ts:121-123`) and drag-to-Done (`App.tsx` `onDragEnd`).
- **The board poll payload can grow.** Human arrivals hold handoffs; `trimPipelineRunForList` must null them (`server.ts:1107-1118`) or every board/TUI/CLI poll ships them.
- **Nullable `taskId` ripples.** `PipelineStepRecord.taskId` is assumed non-null in the run view history row, `stepTaskFor`/`stepNodeTaskFor`, `stepAttention`, the CLI status line (`h.taskId.slice`), and the handoff context. The plan must either make it nullable and update every caller or keep a sentinel/extra record shape.
- **`startPipelineRun` on `review` must not restart.** The current fall-through would discard the human state and history (`pipeline-runner.ts:1600-1626`). Add a guard and a test.
- **Restart must clear human state.** `startPipelineRun({restart:true})` replaces `run` (`:1697-1710`); if `humanSteps` is not cleared, a stale panel survives the restart.
- **Fan-out / join semantics.** A human step can be reached while sibling branches run; the run status should stay `running` until they settle, then `review`. A human step with `join:"all"` must accumulate arrivals like `run.joins`; a human step with multiple incoming sources needs a return-target choice. If the owner wants a whole-pipeline pause, that is a much larger change (cancelling/pausing live agents is not an existing capability).
- **Step cap.** Counting human steps changes `stepCount`/`effectiveStepCap`; a long review loop will hit `step-cap` and block, which may surprise. Not counting them weakens the run budget but is human-gated.
- **Leftover pending interactions can outlive a human decision.** The runner does not cancel a step task's pending question when it settles; only Restart does. If the previous step had a leftover question, a human Return/Accept could leave the parent's aggregated `pendingInteractionCount > 0`, keeping the card amber and pointing at a stale question. The plan must decide whether a human decision cancels those interactions (like Restart) or leaves them answerable.
- **Attention precedence can conflict.** A previous step can still hold a leftover pending question (the runner never cancels pending cards on settle, and a manual advance can leave one behind) while the human step is pending. The card's amber Answer/Review button, `stepAttention`, and `pipelineAttentionStepTask` must decide whether the human review or the older question wins; the recommended order is human review first (it is the current gate), with the older question still reachable from its node. If the owner wants the question to win, the resolver changes.
- **Notifications.** A `review` status with no toast/notification would leave a headless-core user unaware; adding one touches `App.tsx`, `headless-notifications.ts`, `toasts.ts`, and the OS deep-link landing.
- **React Flow identity churn.** The run view has a documented "Maximum update depth exceeded" history (`PipelineRunView.tsx:228-279`); any new per-node human flag must go through `nodeVisualSignature` and the identity-stable merge, never a fresh object per render.
- **Memoized board.** `Column`'s comparator lists every prop (`Column.tsx:105-121`); a new card callback must be `useCallback`-stable and added there, or cards re-render on every poll.
- **Bundle compatibility.** `BundleStep` export explicitly constructs fields (`bundle.ts:883-914`); a new `type` must be added there and in the import mapping (`:1293-1340`). Old readers drop it and see an agent step with no agent; the import preview should warn or the version should bump.
- **Docs drift.** `docs/architecture/pipelines.md` is the code-accurate contract; every new route/status/UI surface must be added in the same change (`CLAUDE.md:5`).
- **Tests that cannot fail.** The existing suites do not assert human-step behavior; the plan must add unit tests for validation/status/prompt/sanitizer/CLI/bundle and e2e for the pause → return → re-pause → accept → finish flow. A green run before those tests proves nothing.
- **No migration/backfill** keeps rollout simple, but old snapshots and bundles must default missing `type` to agent; any code that reads `step.type` directly must use a helper/default.

## 8. Recommended shape for the next step

1. **Grill the 16 questions in §4**, especially card behavior (Q1), return mechanics (Q2), multiple outgoing/incoming (Q3/Q4), graph constraints (Q5), and fan-out pause semantics (Q10).
2. **Write the plan** around a new `review` run status + `run.humanSteps` + nullable human history record, a `launchStep` human branch, a human-decision route/API/CLI, and a run-view human modal. Keep the return path as a fresh previous-step execution for v1 unless the owner explicitly wants session continuity.
3. **Add tests before implementation**: validation (human start/no incoming/agent/human→human/join), `deriveRunStatus` review, `composeStepPrompt` human feedback, sanitizer round-trip, trim payload, CLI status nullable taskId, bundle export/import, and the e2e `A → H → B` pause/return/accept flow.
