# Plan — Pipeline Human Step

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Source | `docs/specs/pipeline-human-step.md` (owner task text) + `docs/plans/pipeline-human-step-investigation.md` + `docs/plans/pipeline-human-step-grill.md` + `docs/plans/pipeline-human-step-grill/round-{1,2}/` |
| Flags | none |
| Gates | grilled + approved by owner: all 21 required round-1 questions answered, 4 overrides (`fanout`, `return-mechanics`, `pending-actions`, `bundle-compat`), 3 round-2 consequence answers. One unratified gate remains: the resume spike (`T0`) is a go/no-go — see §8. |
| Status | planned |
| Branch | `feature/agetor-pipeline-human-step` |
| Base SHA | `e4cc58e5` |

> **Commit the inputs first.** `docs/specs/pipeline-human-step.md`, `docs/plans/pipeline-human-step-investigation.md`, `docs/plans/pipeline-human-step-grill.md` and `docs/plans/pipeline-human-step-grill/` are untracked as this plan is written. Commit them unamended as their own docs commit before the first code commit, so every later difference from the contract is visible as a diff.

---

## 1. Objective & success criteria

Add a **Human Step** to pipeline graphs: a pause / review gate that can sit between two agent steps or at the end (never first), that behaves like the board's Review column when reached, and that gives the owner a control panel over the work so far, with two decisions — **Return** to the previous step (comment required) or **Accept** and continue / finish (comment optional).

Each criterion names the production path that produces it and the test that drives that path.

| # | Success criterion | Production path | Proven by |
| --- | --- | --- | --- |
| 1 | A human step can be added between two steps or at the end, never first, and saved; a human step has no agent/subagents and exactly one incoming edge. | `PipelineEditor` → `api.create/updatePipeline` → `validatePipelineGraph` → `pipelines.graph` | `T1` unit (validator), `T8` e2e (editor), `T13` e2e (REST graph) |
| 2 | Starting a pipeline with a later human step runs agent steps normally, then stops at the gate with run status and card column `review` (not `blocked`, not `done`). | `startTask` → `startPipelineRun` → `launchStep` human branch → `persist` (`review` → column `review`) → `pipeline` GlobalEvent | `T4` runner tests R1–R3; `T13` e2e |
| 3 | The board card at a gate stays in Review and offers **Open + Review**, suppresses **Done**, and its context menu suppresses **Mark done**; the run view offers **Stop** and **Restart**, hides Retry/Advance/Done. | `TaskCard` / `task-context-menu` / `Column` / `App` → `GET /tasks` (trimmed `pipelineRun.humanSteps`) | `T10` unit + `T13` e2e |
| 4 | The owner gets a panel showing: pipeline goal, the human step's "What to check", the last handoff into the gate, run history, transcript links for completed agent steps, prior human rounds on this gate, and a worktree diff button. | `PipelineRunView` → `HumanStepPanel` → `api.getPipelineRun` / `api.getTaskDiff` / `onOpenTask` | `T9` implementation + `T13` e2e P1–P5 |
| 5 | **Accept** continues through the gate's outgoing edges (`choose` picks one, `all` launches every outgoing, zero finishes the run); the comment is optional and travels to the next step / join / retry as trusted feedback. | `POST /tasks/:id/pipeline/review` → `reviewHumanStep` → `launchStep` / `resolveNextSteps` / `run.joins` → `composeStepPrompt` `## Human review feedback` | `T4` R4–R7; `T5` endpoint; `T13` e2e |
| 6 | **Return** requires a non-blank comment, re-runs the gate's sole incoming source **fresh by default** or **resumed** by choice, and the returned execution is forced back to the same gate regardless of its `transition` / handoff `next`. | `reviewHumanStep` → `launchStep` (fresh) / `sendInput` (resume) with `returnToStepId` → `settleStepRun` forced-edge override | `T0` spike, `T4` R8–R12, `T13` e2e (fresh) |
| 7 | Stop works with only a gate pending: it confirms, cancels the run, dismisses the gate, keeps history, and moves the card to Ready. Restart clears all human state and starts fresh. | card Stop → `api.cancelPipeline` → `cancelPipelineRun`; run-view Restart → `startPipelineRun({restart:true})` | `T4` R13–R15; `T10`/`T9`; `T13` e2e |
| 8 | Status precedence is `cancelled (stopped) > review (gate pending) > blocked > running > done`; a gate with a live sibling stays Review while the sibling runs, and a blocked sibling is surfaced in the run view, not by an amber card. | `deriveRunStatus` in `src/shared/pipeline.ts`, the single status authority | `T1` unit; `T4` R2/R3; `T7` visual state |
| 9 | Full CLI parity: `agetor pipeline review <ref> --accept\|--return …`; `show` / `status` display human gates and survive a nullable `taskId`. | `src/cli/commands/pipeline.ts` → `AgetorClient.reviewPipeline` → the same route | `T11` CLI tests |
| 10 | Bundle compatibility: human-free bundles export as version 1 byte-identically; a bundle containing a human step exports as version 2; the parser accepts 1 and 2, and an old reader refuses v2 with the existing update message. | `buildBundle` / `parseBundleText` / `planBundleImport` | `T2` bundle tests |
| 11 | Agent-only pipelines do not regress: the existing suites stay green, and an old stored graph / run / bundle with no human fields reads as agent-only. | additive types + sanitizer defaults | `T1`–`T12` existing suites, `T15` |

---

## 2. Context & constraints

### 2.1 Grounded findings (file:line anchors)

The investigation (`docs/plans/pipeline-human-step-investigation.md`) is the full map. The anchors this plan builds on:

- **Graph model.** `PipelineStep` has no type discriminator: `id`, `name`, `instructions`, `agentProfileId`, `position`, `subagents`, `transition`, `join` — `src/shared/types.ts:509-533`. `newStep()` is `src/shared/pipeline.ts:350-362`. `validatePipelineGraph` builds each step explicitly and drops unknown keys — `src/shared/pipeline.ts:378-592`. `resolveStartStep` falls back to the unique root — `src/shared/pipeline.ts:603-611`.
- **Run model.** `PipelineRunStatus` has no `review` — `src/shared/types.ts:622`. `PipelineRunState` — `src/shared/types.ts:808-836`. `PipelineStepRecord.taskId` is required — `src/shared/types.ts:740-795`. `PipelineJoinArrival` is `{fromStepId, seq, handoff}` — `src/shared/types.ts:650-673`.
- **Status authority.** `deriveRunStatus` is blocked-first today — `src/shared/pipeline.ts:1120-1133`. `persist` maps status → column and fires the `pipeline` event — `src/bun/pipeline-runner.ts:269-308` (mapping `:290-295`).
- **Step launch.** `launchStep` does the worktree refresh, step-cap check, profile lookup, hidden task insert, `run.active` + `run.history`, then `startTask` — `src/bun/pipeline-runner.ts:1056-1281` (profile check `:1118-1129`, insert `:1219-1259`, active/history `:1261-1262`). `buildSnapshot` requires every step to have an agent — `:879-908`.
- **Resolve / settle.** `advanceOnHandoff` removes the active entry, records `succeeded`, moves the step task to `done`, then resolves/joins/launches — `src/bun/pipeline-runner.ts:2757-2903`. `settleStepRun` is the single settle body and calls `resolveNextSteps` at `:3140`. `resolveNextSteps` is `src/shared/pipeline.ts:1068-1108`.
- **Manual advance / retry / stop / restart / reconcile.** `advancePipeline` — `src/bun/pipeline-runner.ts:1752-1953`; `performPipelineRetry` / `retryPendingBlocks` — `:1356-1567`; `startPipelineRun` — `:1568-1734`; `cancelPipelineRun` — `:1993-2047`; `reconcilePipelineRuns` — `:3517-3544`. Every mutation is serialized by `runExclusive` — `:147-178`.
- **Persistence.** `PIPELINE_RUN_STATUSES` — `src/bun/db.ts:503`; `STEP_RECORD_OUTCOMES` — `:577`; `sanitizeStepRecord` — `:632-666`; `parsePipelineRunState` — `:761-825`. The graph is JSON in `pipelines.graph` and the run is JSON in `tasks.pipeline_run`; **no SQL migration**.
- **Server.** `trimPipelineRunForList` nulls history/join handoffs — `src/bun/server.ts:1107-1118`, applied at `:5406`. The pipeline column guard (only `done → done`) — `:5574-5581`. The advance route (body validation, `server.timeout(req, 0)`) — `:6007-6058`; retry/restart — `:6061-6120`. `GET /tasks/:id/pipeline` returns the full parent + step rows — `:5984-5999`.
- **Route policy.** Every route needs an entry; pipeline control routes are `app+cli` — `src/bun/route-policy.ts:319-330`, `:372-376`.
- **Card.** `TaskCard` renders Done for any `column === "review"` — `src/mainview/components/kanban/TaskCard.tsx:353-357`; Stop is gated on `pipelineRun.status === "running"` — `:92-97`; the context menu's Mark done — `src/mainview/lib/task-context-menu.ts:121-123`; `Column`'s memo comparator — `src/mainview/components/kanban/Column.tsx:105-121`.
- **Run view.** Status maps / terminal / restartable — `src/mainview/components/pipelines/PipelineRunView.tsx:133-164`; `nodeVisualSignature` — `:532-545`; node click / "hasn't started" — `:694-709`; header buttons — `:860-950`; side panel blocked + `reviewActive` + history — `:1023-1184`; `HistoryRow` — `:1257-1405`.
- **Editor.** `StepNode` visual classes and "No agent" — `src/mainview/components/pipelines/StepNode.tsx:45-140`; `StepPanel` — `StepPanel.tsx:78-286`; `PipelineEditor` blank/add/delete/save — `PipelineEditor.tsx:134-137`, `:290-323`, `:332-340`, `:659-686`.
- **Helpers.** `stepVisualState` / `stepAttention` / `pipelineAttentionStepTask` / `stepTaskFor` / `stepNodeTaskFor` — `src/mainview/lib/pipelines.ts:134-168`, `:262-294`, `:344-390`, `:899-958`. Panel signature — `src/mainview/lib/pipeline-scroll-memory.ts:74-85`.
- **Notifications.** `App.tsx` remembers `prevStatus` and toasts `blocked` / `done` only — `src/mainview/App.tsx:1670-1690`; the headless mirror — `src/bun/headless-notifications.ts:162-171`; OS kinds — `src/shared/os-notification.ts:16-30`; toast slots — `src/mainview/lib/toast-slots.ts:7-11`.
- **CLI.** `pipeline show` — `src/cli/commands/pipeline.ts:375-431`; `pipeline status`, which slices `h.taskId` — `:441-510` (slice at `:494`); `advance` flag parsing — `:95-130`, `:205-236`; `AgetorClient` — `src/cli/api-client.ts:725-775`.
- **Bundle.** `BundleStep` / `BUNDLE_VERSION = 1` — `src/shared/bundle.ts:37`, `:95-105`; export step construction — `:883-914`; import mapping — `:1293-1340`; parser version gate — `:1544-1552`. The planner's `PlannedStep` / "step-without-agent" warning — `src/shared/bundle-import.ts:95-115`, `:540-600`; the import preview's "no Agent" — `src/mainview/components/bundle/ImportBundleDialog.tsx:1292-1310`.
- **Create validation.** `createTask` requires every step to have a resolvable agent — `src/bun/orchestrator.ts:8491-8507`; the cosmetic start profile — `:8535-8537`; `startTaskInner` branches a pipeline parent into `startPipelineRun` — `:2044-2055`.

### 2.2 The contract, in one page

**Graph.** `PipelineStep.type?: "agent" | "human"`; missing = agent. A human step:
- is never the start step (`startStepId` must not name it, and the unique-root fallback cannot produce one: a human step always has exactly one incoming edge, so it is never a root);
- has **exactly one incoming edge** (0 or 2+ is rejected);
- has `agentProfileId: null`, `subagents: { profileIds: [], cap: null }`, and is normalized to `join: "any"` (join is moot with one incoming);
- has no human→human edge;
- keeps `transition: "choose" | "all"` (Accept uses it);
- may be terminal (0 outgoing) or have several outgoing edges;
- saves with no Set-as-start in the editor.

**Run.** Human entries live on `PipelineRunState.humanSteps` (no task row), get a unique `seq` from a run-wide monotonic `seqCounter`, and are recorded in `history` as `PipelineStepRecord` with `taskId: null`. They **do not** increment `stepCount`; the Return re-run of the previous agent step does. A gate entry is not an agent launch — it touches no worktree and spawns nothing — so it is recorded even on an archived parent (`persist` stores the run but skips the column/event while archived); the decision route still refuses an archived parent, so the gate waits for unarchive. This keeps a human gate out of `PipelineBlock.pending` and out of every `{runId}`-returning path. `LaunchResult.runId` becomes optional for the human branch; the two paths that surface a run id (a fresh start, a retry) can never reach it, so their public `{runId: string}` shape is unchanged.

**Status.** A pending gate means `review`, mapped to the Review column, `endedAt: null`. With a gate pending: a stopped run is `cancelled`, otherwise `review` (so review outranks `blocked`). With no gate pending, today's precedence is unchanged: `blocked` > stopped > `running` > `done`. Review survives sibling fan-out and outranks `blocked`.

**Accept.** Reuses `transition`: 0 outgoing finishes; `all` launches every outgoing; `choose` with several requires one picked target; one outgoing is unconditional. The human's reviewed handoff(s) and the comment ride the launch; the comment is rendered as trusted `## Human review feedback`, never inside the untrusted-handoff markers and never folded into a `Handoff`.

**Return.** Target = the gate's sole incoming source (or, for a manual Advance into a gate, the step it was advanced from). Comment required, trimmed, ≤ `PIPELINE_LIMITS.handoffField` (8,000). Mode: `fresh` (default; reuses `launchStep`, new task/session/seq) or `resume` (a `sendInput` turn on the previous step's task, re-armed as a new execution). Either way the new execution records `returnToStepId = gate.stepId`, and `settleStepRun` resolves that edge unconditionally — other outgoing edges are not launched, and a `join:"all"` previous step is launched directly (bypassing the join wait, as manual Advance does).

**Stop / Restart.** Stop works with only a gate pending (and with live siblings): confirm → cancel → dismiss gate → keep history → Ready. Restart clears all human state and starts a fresh run. Plain Run on a `review` run refuses; Retry refuses.

**Panel.** A modal/drawer over the run view, opened from the human node, a run-view Review action, and the card's Review action. It never auto-opens on arrival. It shows all seven content items and exactly two decisions. A half-typed comment survives closing/reopening while the run view stays mounted. Closing keeps the gate.

**Decision route (pinned for T5 / T9 / T11).**

```
POST /tasks/:id/pipeline/review
{ stepId: string, seq: number, decision: "accept" | "return",
  comment?: string, nextStepIds?: string[], mode?: "fresh" | "resume" }
→ 200: the updated pipeline Task (same shape as /pipeline/advance)
→ 400: bad body / blank Return comment / over-cap / bad next target /
       mode on accept / nextStepIds on return
→ 404: unknown task
→ 409: not a pipeline / never run / archived / no pending gate /
       stale seq or already decided / resume unavailable / launches frozen
```

`stepId` + `seq` identify the gate (idempotency); `nextStepIds` is Accept-only and must name outgoing targets; `mode` is Return-only and defaults to `fresh`.

**Notifications.** One "Pipeline needs your review" toast/OS notification per `(run.startedAt, gate.seq)`; clicking opens the run view with the gate focused. "Pipeline finished" only on the transition to `done`.

**Bundle.** Conditional v2: human-free → version 1, no `type` key, byte-identical; any human step → version 2 with `type: "human"` on that step only. The parser accepts 1 and 2, rejects `type:"human"` in a v1 file, and rejects version 3+ with the existing "update agetor" copy.

### 2.3 Repo standards that apply

| Rule | Path | Consequence here |
| --- | --- | --- |
| Update the subsystem doc in the same change | `CLAUDE.md:5` | `docs/architecture/pipelines.md` + `bundle.md` + `notifications.md` + `task-context-menu.md` land in `T14`. |
| Every route needs a `ROUTE_POLICY` entry; pipeline control is `app+cli` | `CLAUDE.md:86`, `src/bun/route-policy.ts:372-376` | `POST /tasks/:id/pipeline/review` gets `{ POST: CLI }` (the `app+cli` constant). No path params. |
| Nothing injected into a prompt may name the product | `CLAUDE.md:92` | The feedback section says "A human reviewed…", never "Agetor". |
| Server-managed columns are written only by their own UPDATE | `CLAUDE.md:97` | The gate writes no column; `persist` keeps using `pipelineUpdateColumn`. No new column, no migration. |
| No second event stream | `CLAUDE.md:105` | Review rides the existing `pipeline` GlobalEvent; the panel reads the existing `GET /tasks/:id/pipeline`. |
| `RunPanel` is one long-lived instance | `CLAUDE.md:112` | The human panel lives in the run view, not `RunPanel`, so no reset line is needed there. |
| Tests that import `db.ts` set `AGETOR_DATA_DIR` at module top level | `CLAUDE.md:140` | `T4`/`T5`/`T6` follow `orchestrator.test.ts`'s `await import` pattern and `rmTestDataDir`. |
| Semantic status tokens only | `CLAUDE.md:170-171` | Human/info styling uses `border-info`, `bg-info/10`, `text-info`; no literal palette classes. |
| Additive bundle fields, old exports byte-identical | `docs/architecture/bundle.md:9` | `type` is written only for human steps; version 1 stays identical. |
| Review/Done semantics | `docs/plans/pipeline-mark-done.md:21-43` | A gate is non-terminal Review; Done parks only a `done` run. |
| The pipeline doc is the code-accurate contract | `docs/architecture/pipelines.md` | It is the reference implementation agents read before T4/T5/T9. |

### 2.4 Live facts checked

| Fact | Evidence |
| --- | --- |
| Baseline is green at the base SHA | `bun --version` → 1.3.10 (investigation); re-run today: `bun test src/shared/pipeline.test.ts` → **239 pass / 0 fail**; `bun test src/shared/bundle.test.ts` → **98 pass / 0 fail**; `bun test src/bun/pipelines.test.ts` → **36 pass / 0 fail**. `git rev-parse HEAD` → `e4cc58e52f1520362022067708fead8a310bfe3a`; `git branch --show-current` → `feature/agetor-pipeline-human-step`. |
| The validator strips `type` and accepts an agent-less start today | Investigation's executed probe (`docs/plans/pipeline-human-step-investigation.md` §2). |
| A Review-column pipeline parent's Done 409s | `TaskCard.tsx:353-357` vs `server.ts:5574-5581` (investigation §2). |
| A plain Run on a `review` run would silently restart today | `pipeline-runner.ts:1600-1626` (investigation §2). |
| `agetor pipeline status` crashes on `taskId: null` | `src/cli/commands/pipeline.ts:494` (investigation §2). |
| No existing human-step code | `grep -rn "humanStep\|type:\"human\"" src` → none (investigation §2). |
| No SQL migration needed | `pipelines.graph` and `tasks.pipeline_run` are JSON columns (investigation §1.2/§1.3). |

### 2.5 Runtime and trust shape

- Local, single-user desktop app; one Bun main process owns SQLite and the loopback HTTP API; the webview authenticates with the per-launch master token; the CLI uses the CLI token. No multi-tenant auth or remote instances (`CLAUDE.md:21-27`).
- The pipeline runner serializes every mutation of one parent's run state through `runExclusive` (`pipeline-runner.ts:147-178`); the only concurrency inside a run is sibling step tasks and their settles, which queue on that lock.
- Agent handoffs are **untrusted** (fenced with nonce markers); human comments are **owner-authored and trusted**, and must be rendered outside those markers (`src/shared/pipeline.ts:88-112`). The threat model here is prompt-injection via agent output, not a hostile human.
- A crash between a human decision and the launch can leave the decision unpersisted (the gate survives) or the launch unpersisted (the step may double-start on a retry). This is the same window `advancePipeline` has today; §7 records it.

---

## 3. Approach & key decisions

### 3.1 The shape

```
PipelineStep.type: "agent" | "human"          (missing = agent)
PipelineRunStatus += "review"                  (non-terminal, maps to Review column)
PipelineRunState.humanSteps?: PipelineHumanStep[]   (pending gates, no task rows)
PipelineRunState.seqCounter?: number           (unique history seq; stepCount stays agent-only)
PipelineStepRecord.taskId: string | null       (human records have no task)
PipelineStepRecord.returnToStepId?: string|null (forced-return control fact)
PipelineStepRecord.human?: { decision, comment, mode?, returnToStepId? }
PipelineJoinArrival.comment?: string|null      (trusted human feedback rides the arrival)
GlobalEvent "pipeline" += humanStepSeqs?, runStartedAt?
```

A gate is entered by the existing `launchStep` (a branch before the worktree/cap/profile checks), decided by a new locked `reviewHumanStep`, and left through the existing resolve/join/fan-out machinery. No new state machine, no second queue, no hidden task row.

### 3.2 Alternatives considered

| Decision | Chosen | Alternatives rejected | Why |
| --- | --- | --- | --- |
| Gate run state | New `review` status + `run.humanSteps` | `blocked` + a new block kind; a hidden task row | `blocked` makes the card amber and says "Blocked", contradicting "same as Review". A task row drags the whole task/column/notification machinery into a state with no agent. |
| Human comment transport | `PipelineJoinArrival.comment` + a trusted prompt section | A `Handoff`-shaped value; a separate `humanFeedback` field on every block | Folding it into a `Handoff` would render it inside the untrusted markers (decision 18). The arrival is the one structure that already survives joins, pending launches and retries. |
| History identity | A run-wide `seqCounter`, `stepCount` stays agent-only | Reuse `stepCount` as the seq | Human and agent entries would collide (e.g. `H` and the next `A` both seq 2); history keys, `historyExpansionKey` and `taskId+seq` lookups would break. |
| Accept target | Reuse `transition` + `nextStepIds` from the panel | A new `next` mode | The graph already defines fan-out/choose; a human is just another resolver. |
| Return | Both fresh and resume | Fresh only; resume only | Owner chose both in v1 (`round-1#return-mechanics`, `round-2#q1`). Resume is gated by the spike; fresh is the default. |
| Forced return | `historyEntry.returnToStepId` overrides the resolver | Inspect `handoff.next` / re-enter the gate by name | A stale or adversarial handoff must not route the loop elsewhere; one override is auditable. |
| Bundle | Conditional v2 | Always v2; v1 + additive `type` | Owner chose conditional v2 (`round-1#bundle-compat`). Old readers must refuse a human step rather than run it agent-less. |
| Panel placement | New `HumanStepPanel` mounted by the run view | Inline in the side panel; a separate page; inside `RunPanel` | Matches decision 11 and keeps the 1,394-line run view from absorbing the whole form. |
| Stop with a gate | Clear gates + blocks, force `cancelled` | Keep blocks so a blocked sibling still wins | Decision 6 requires the card to move to Ready; a retained block would make it Blocked. Recorded as an inference in §8. |

### 3.3 Evidence vs reasoning

- **Evidence:** every file:line anchor above; the investigation's executed validator probe; today's green baseline; the grill's owner answers.
- **Reasoning (flagged in §8):** `seqCounter`; the Stop-drops-blocks rule; `returned` not counting as "completed" in progress; the exact panel layout and copy; rejecting `type:"human"` in a v1 bundle; multiple-gate selection (`oldest` for the card, `--step` for the CLI).

---

## 4. Work breakdown — implementation tasks

Every task owns the files it creates or edits, including its module's tests. No two tasks in one wave share a file. "Wired by" names the production entry point that reaches the code.

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **T0** | **Resume spike — go/no-go.** Prove a settled step execution can be re-armed and resumed via `sendInput`, settles into a new history record, and can be made to resolve to a named next step deterministically; prove it for `claude-code` (persistent session) and at least one one-shot harness (codex fake). | `docs/plans/pipeline-human-step-resume-spike.md` (new), `src/bun/pipeline-human-step-resume-spike.test.ts` (new) | — | Given a completed single-step execution, when a test re-arms `run.active` + a new history record and calls `sendInput` with a handoff-bearing message, then a new run row is created on the **same** task, the new record settles, `stepCount` grew once, and no second task row exists. The test must also prove a stable forced-resolution recipe (the mechanism `T4` will encode as `returnToStepId`); a handoff `next` alone is not sufficient if a stale/missing `next` can divert it. If any of this cannot be made deterministic, the spike doc records the failing command and the plan stops (§8). | `state`, `tests` | Test-only; the production seam is landed by `T4`/`T6` |
| **T1** | Model, validator, status, progress and prompt. | `src/shared/types.ts`, `src/shared/pipeline.ts`, `src/shared/pipeline.test.ts` | — | See §4.1 T1. | `state`, `trust` | `validatePipelineGraph` (save/create), `deriveRunStatus` (`persist`), `composeStepPrompt` (`launchStep`), `pipelineStepProgress` (badge/CLI) |
| **T2** | Conditional bundle v2 + import planning/preview. | `src/shared/bundle.ts`, `src/shared/bundle-import.ts`, `src/shared/bundle.test.ts`, `src/shared/bundle-import.test.ts`, `src/mainview/components/bundle/ImportBundleDialog.tsx` | T1 | Human-free export is version 1 and byte-identical (no `type` key); a human pipeline exports version 2 with `type:"human"` only on the human step; v2 imports; a v1 file containing a human step is rejected with "bundle version 2"; v3 is refused with the update copy; the import preview says "Human" and raises no "step has no Agent" warning. | `data`, `external` | `buildBundle` (export routes/CLI), `parseBundleText`/`planBundleImport` (import routes) |
| **T3** | Persistence sanitizers for the new run state. | `src/bun/db.ts`, `src/bun/pipelines.test.ts` | T1 | `parsePipelineRunState` round-trips `status:"review"`, `humanSteps`, `seqCounter`, `taskId:null`, `outcome:"returned"`, `human` decision, `returnToStepId`, and an arrival `comment`; old rows read `humanSteps: []` and a derived `seqCounter`; junk entries are dropped; `PIPELINE_RUN_STATUSES` accepts `review`. | `data`, `migration` | `parsePipelineRunState` (every `tasks.get/list`) |
| **T4** | Runner: gate entry, review decision, accept, return (fresh + resume), forced return, status, stop, restart, reconcile. | `src/bun/pipeline-runner.ts`, `src/bun/pipeline-runner.test.ts` | T1, T3, T6 | See §4.1 T4 R1–R20. | `state`, `concurrency`, `trust`, `external` | `launchStep` (every settle/advance), `reviewHumanStep` (new route), `cancelPipelineRun`, `startPipelineRun`, `reconcilePipelineRuns` |
| **T5** | HTTP surface: the review route, route policy, list trimming. | `src/bun/server.ts`, `src/bun/route-policy.ts`, `src/bun/pipelines-endpoint.test.ts`, `src/bun/route-policy.test.ts` | T4 | `POST /tasks/:id/pipeline/review` → 200 task; 400 invalid body/decision/comment/next/mode/seq; 404 unknown parent; 409 non-pipeline, never run, archived, no gate, stale seq, double submit, resume unavailable; `server.timeout(req, 0)`; `ROUTE_POLICY` has `app+cli`; `GET /tasks` trims `humanSteps[].arrivals[].handoff` but keeps stepId/seq; `GET /tasks/:id/pipeline` is untrimmed. | `trust`, `data` | `server.ts` route table + `applyRoutePolicy` at boot |
| **T6** | Create/start acceptance + the resume seam (if T0 requires one). | `src/bun/orchestrator.ts`, `src/bun/orchestrator.test.ts` | T0, T1 | `createTask` accepts a human step without an agent, rejects a human step carrying an agent, and rejects a human start step; the cosmetic start profile is unchanged for agent starts. If T0 found `sendInput` needs a forced-fresh/idle option, it lands here with a test. | `state`, `external` | `createTask` (POST /tasks), `sendInput` (resume path) |
| **T7** | Run-view helpers: visual state, attention, progress, null taskIds. | `src/mainview/lib/pipelines.ts`, `src/mainview/lib/pipelines.test.ts` | T1 | A pending human step reads `active` (info), an accepted/returned one `done`, an untouched one `idle`; `stepAttention` returns `null` for a human step (no amber); `stepTaskFor`/`stepNodeTaskFor`/`pipelineAttentionStepTask` skip `taskId:null` and never crash; the badge label uses the gate when no agent is active. | `tests` | `PipelineRunView` / `TaskCard` / `PipelineBadge` |
| **T8** | Editor: human node visuals, type switch, Add human step, start guard. | `src/mainview/components/pipelines/StepNode.tsx`, `StepPanel.tsx`, `PipelineEditor.tsx`, `e2e/pipelines-editor.spec.ts` | T1 | A human node shows an info border + "Human" chip + user-check icon and no "No agent"; the step panel offers Agent/Human; switching clears agent/subagents; the human panel hides Agent/New agent/Subagents/Join, labels instructions "What to check", and disables Set as start; Add human step creates a non-start human node; deleting the start never promotes a human; save surfaces the validator errors for a human start / two incoming / human→human. | `tests` | `PipelineEditor` save → `POST/PATCH /pipelines` |
| **T9** | Run view + the human panel modal + the webview review client. | `src/mainview/components/pipelines/PipelineRunView.tsx`, `src/mainview/components/pipelines/HumanStepPanel.tsx` (new), `src/mainview/lib/pipeline-scroll-memory.ts`, `src/mainview/lib/pipeline-scroll-memory.test.ts`, `src/mainview/lib/api.ts` | T1, T4, T5, T7 | See §4.1 T9 P1–P12. `api.reviewPipeline` posts the documented body with `retry:false`. | `state`, `tests` | `App` view `{kind:"pipeline-run"}` → `PipelineRunView` → `api.reviewPipeline` → the route |
| **T10** | Board card, context menu, App wiring, badge, review toast/alert dedupe. | `src/mainview/App.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/Column.tsx`, `src/mainview/lib/task-context-menu.ts`, `src/mainview/lib/task-context-menu.test.ts`, `src/mainview/components/pipelines/PipelineBadge.tsx`, `src/mainview/lib/toasts.ts` | T1, T7 | See §4.1 T10 C1–C8. | `state`, `tests` | Board render + the `pipeline` GlobalEvent handler |
| **T11** | CLI client + full CLI/TUI parity. | `src/cli/api-client.ts`, `src/cli/commands/pipeline.ts`, `src/cli/commands/pipeline.test.ts`, `src/cli/commands/show.ts`, `src/cli/commands/show.test.ts`, `src/cli/commands/ls.ts`, `src/cli/ls.test.ts`, `src/cli/tui/Dashboard.tsx` | T5 | `AgetorClient.reviewPipeline` posts the documented body with `START_TIMEOUT_MS`; `agetor pipeline review <ref> --accept\|--return` works; `--return` without a comment is a usage error before the network; `--next` resolves a step; `--step` selects among several pending gates; `--mode resume`; `--json`; `status` prints pending gates and `(human)` for a null taskId; `show` prints `human`; `show`/`ls`/TUI color `review`. | `tests` | CLI binary → `AgetorClient` → the route |
| **T12** | Headless review notifications. | `src/bun/headless-notifications.ts`, `src/bun/headless-notifications.test.ts` | T1, T4 | One "Pipeline needs your review" notification per `(runStartedAt, gate.seq)`, including two gates on one run; a repeat persist sends nothing; `done` still sends "Pipeline finished" once; a stopped run sends nothing. | `state` | `persist` → GlobalEvent → the headless handler |
| **T13** | End-to-end human-step flow. | `e2e/pipelines-human-step.spec.ts` (new) | T1–T12 | See §5.3. | `tests` | Playwright against the real backend |
| **T14** | Docs. | `docs/architecture/pipelines.md`, `docs/plans/pipelines.md`, `README.md`, `docs/architecture/bundle.md`, `docs/architecture/notifications.md`, `docs/architecture/task-context-menu.md` | T1–T13 | The subsystem docs describe the shipped behavior: `review` status, gate state, accept/return both modes, forced return, stop/restart, route, CLI, bundle v2, panel, notifications; `README` has the `pipeline review` row; `docs/plans/pipelines.md` gains D15. | `tests` | Docs only |
| **T15** | Final verification + plan/PR refresh. | `docs/plans/pipeline-human-step.md` | T13, T14 | `bun run typecheck` clean; the targeted suites in §5.4 green; the e2e specs green; the PR body's claims match the code; this plan's `Status` updated; no TODO/placeholder left in owned files. | `tests` | Verification only — drives the production entry points end to end (board → run view → route → runner → settle), then refreshes the plan/PR. |

### 4.1 Detailed acceptance

#### T1 — model / validator / status / prompt

1. `newStep()` defaults to `type:"agent"`; `newStep({type:"human"})` yields a human step with `agentProfileId:null`, empty subagents, `join:"any"`.
2. `validatePipelineGraph` with a step missing `type` normalizes it to `"agent"` (old graphs load unchanged).
3. `type:"human"` with `agentProfileId`, any subagent, or `join:"all"` is normalized/rejected per §2.2 (agent/subagents rejected; join normalized to `any`).
4. `type:"human"` as `startStepId` → error; a human step with 0 incoming or 2 incoming → error; a human→human edge → error.
5. A human step at the end (0 outgoing) is valid; a human step with `transition:"all"` and 2 outgoing is valid.
6. `type:"robot"` → error; `type:"agent"` → valid.
7. `deriveRunStatus`: gate + blocked → `review`; gate + `stopRequestedAt` → `cancelled`; gate + live siblings → `review`; gate + no active → `review`; no gate + blocked → `blocked`; no gate + stopped → `cancelled`; no gate + active → `running`; nothing → `done`.
8. `pipelineStepProgress`: a pending gate appears in the label as the active step; `completed` counts an accepted human record, not a returned one; `total` includes the human step.
9. `composeStepPrompt` with `humanFeedback` renders a `## Human review feedback` section containing the comment **outside** the untrusted markers, with no product name; with no feedback and `returned:false` the output is byte-identical to today for an agent step; `returned:true` replaces the "first step" copy. The new inputs (`humanFeedback?`, `returned?`) are optional, so every existing call site compiles unchanged; the new `GlobalEvent` pipeline fields (`humanStepSeqs?`, `runStartedAt?`) are optional too.
10. `composeReviewReturnMessage` contains the comment and the handoff contract, and names no product.
11. `newHumanGateSeqs` returns only unseen seqs for the same `(runStartedAt)`, all seqs for a new run, and `[]` for a repeated event.
12. `pendingHumanSteps(run)` returns `[]` for old runs.

#### T4 — runner scenarios

1. **R1 Gate entry.** Pipeline `A → H` (H terminal). Start; A succeeds. Parent column/status `review`; `run.humanSteps` has H with `seq`, `startedAt`, one arrival; `run.history` has a human record with `taskId:null`, `outcome:null`; `run.stepCount` is unchanged (1); no task row exists for H; `endedAt:null`; `buildSnapshot` accepted the graph without an agent for H; the `pipeline` event carries `humanStepSeqs:[H.seq]` and `runStartedAt`.
2. **R2 Immediate review.** Fan-out `A → (B, C)`, `B → H`, C delayed. B settles; H pending while C is still active → status/column `review` (not running); C settles → still `review`. `run.active` still lists C throughout.
3. **R3 Review beats blocked.** Same fan-out, C blocks while H is pending → status `review`; `run.blocked` still lists C; the run view shows it.
4. **R4 Accept continues.** Accept with "please tighten X" → H cleared, human record `endedAt` set, `succeeded` + `human{decision:"accept",comment}` + `nextStepIds` = the launched target(s); the next step launches; its prompt contains "## Human review feedback" and "please tighten X"; its `previous` context contains the reviewed handoff; its header's step ordinal uses the agent-only `stepCount` (a human gate never skips a number).
5. **R5 Accept terminal.** H has no outgoing; accept with no comment → run `done`, card Review, human record `succeeded` with `nextStepIds:[]`, no next step.
6. **R6 Accept into a join.** H → D (`join:"all"`) with another arrival already in `run.joins`; accepting completes the join; D's prompt contains the comment; a retry after a step-cap or launch-failure hold carries the same comment (via `pending.arrivals[].comment`).
7. **R7 Accept target rules.** `choose` + 2 outgoing without `nextStepIds` → 400/409; with a target not on an outgoing edge → 400/409; `all` launches every outgoing; 1 outgoing is unconditional.
8. **R8 Return fresh.** Return with "redo the header" → new agent task + new seq; a new hidden task row; `stepCount` +1; its prompt has the comment and the returned copy; when it settles, H is pending again with the new handoff; the human record is `returned` with the comment and `nextStepIds:[]` (a return has no graph edge to animate); the prior record is untouched.
9. **R9 Forced return.** The returned step emits `handoff.next:"B"` (or `transition:"all"` with B and C outgoing); only H is launched — B/C are not; `history.nextStepIds` is `[H]`.
10. **R10 Return target + manual advance.** H's sole incoming source is the target. A manual `advancePipeline` into H (handoff `null`) enters the gate; the panel sees `handoff:null`; Return targets the step advanced from.
11. **R11 Return resume.** The spike-proven path: no new task row; 409 if the previous execution is still live; create the new seq/active/history record (with `returnToStepId`) **under the lock before** `sendInput`, so the settle cannot miss it; `sendInput` addresses the previous step task's current run (`tasks.get(taskId).runId`, falling back to the newest run row; if neither exists → 409 and the gate stays pending); the turn's message contains the comment; a refused send removes the record and rolls back `stepCount`; a `pending` send leaves the turn running and the settle re-enters H. If T0 failed, this scenario is **not implemented** and the plan stops.
12. **R12 Return beats a stale next.** A returned execution whose handoff `next` names an unknown step still settles into H (the forced edge is taken; no `handoff-invalid` block).
13. **R13 Stop with gate only.** `cancelPipelineRun` from `review` with no live executions succeeds (no 409); gates cleared; human records `endedAt`/`cancelled`; `stopRequestedAt` set; status/column `cancelled`/`ready`; history preserved.
14. **R14 Stop with gate + live sibling + blocked sibling.** Both are cancelled/dropped; status `cancelled`; column `ready`; no gate and no block survives; a later settle is idempotent.
15. **R15 Restart.** `startPipelineRun({restart:true})` on `review` archives the old steps, creates a fresh run with `humanSteps:[]`, `stepCount:0`, `seqCounter:0`, and launches the start step; a plain Run refuses with a clear error.
16. **R16 Retry on review** → 409 (nothing blocked/cancelled to retry).
17. **R17 Step cap.** `A ↔ H` loop with `maxSteps:2`: two A runs are allowed; the third A launch blocks `step-cap`; H entries never increment `stepCount` and never block on the cap.
18. **R18 Idempotency.** Two `reviewHumanStep` calls with the same `seq`: first succeeds; second 409 "this review was already decided" (or "no pending review"); a new gate after a Return has a new seq and the old seq is refused.
19. **R19 Comment validation.** Blank Return → 400; 8,001 chars → 400; blank Accept → 200; trimmed stored; C0 controls (other than `\n`/`\t`) → 400.
20. **R20 Reconcile + status persistence.** `reconcilePipelineRuns` sweeps a `review` run with a live active sibling whose settle was missed; a `review` run with no active entries is not swept and never becomes `done`; the persisted JSON round-trips `review` after a reload.
21. **R21 Archived parent.** A gate reached while the parent is archived is recorded on the run (no pending block, no column write, no event); the review route refuses the archived parent with 409; after unarchive the gate is reviewable; no `{runId}`-returning path ever sees a human launch.

#### T9 — run view + panel

1. **P1** A pending gate renders a "Human review" side-panel section with the gate's step name, arrival source and an **Open review** button, plus the human node with `data-human="true"` and `data-gate-pending="true"`.
2. **P2** Clicking the human node, the section button, or receiving `focusGateStepId` opens `HumanStepPanel`; the panel has `data-testid="pipeline-human-panel"`.
3. **P3** The panel shows the goal, "What to check" (the step's instructions), the last handoff via `HandoffCard` (or "No handoff — entered manually"), the history, transcript links, prior human rounds, and View changes → `DiffDialog`.
4. **P4** Closing the panel keeps the gate pending; reopening keeps the half-typed comment/mode/target while the run view stays mounted; the draft resets when the gate seq changes.
5. **P5** Return is disabled on a blank/whitespace comment; Accept is enabled; submitting posts `api.reviewPipeline(taskId, {stepId, seq, decision, comment, nextStepIds?, mode?})`; both show the API error inline on 409 and refetch on success.
6. **P6** Accept shows the outgoing target picker only for `choose` + 2+; shows the full target list for `all`; shows "Accept & finish" for 0.
7. **P7** Return shows the fresh/resume mode control; resume is disabled when the source step task is missing or has no resumable run.
8. **P8** The header reads **Review** (info), Done is hidden, Stop is shown when a gate or a live sibling exists, Retry is hidden, Restart is shown.
9. **P9** Stop confirms ("Live steps will be cancelled and the pending review dismissed. History is kept.") and reloads to Ready.
10. **P10** The blocked banner still renders while a gate is pending (review wins visually, but the block is visible).
11. **P11** `nodeVisualSignature` includes each gate's `stepId:seq` and each human history decision, so a new gate/decision repaints without a full graph rebuild.
12. **P12** An archived parent renders the panel read-only (decision buttons disabled) with a clear note.

#### T10 — card / App

1. **C1** A pipeline parent in Review with a pending gate shows **Open** + a neutral **Review** button (`task-card-pipeline-review`), no **Done**; a new `onReviewPipeline` callback is threaded through `Column` (and its memo comparator) and `TaskCard`.
2. **C2** Review opens the run view with `gateStepId` set and the panel open; Open opens the run view with no gate focus.
3. **C3** The context menu shows **Review pipeline** and no **Mark done** while a gate is pending; no **Mark done** for any non-`done` pipeline parent.
4. **C4** The card Stop is visible when `status === "running"` **or** a gate is pending; it confirms first (`confirm` from `@/components/ui/confirm`).
5. **C5** Drag-to-Done still refuses a non-`done` pipeline with the existing toast.
6. **C6** A `pipeline` event with `status:"review"` and a new gate seq fires exactly one "Pipeline needs your review" toast; a repeat persist fires none; a second gate seq fires one more; the toast's click opens the run view with the gate focused.
7. **C7** The review transition does not clear a sibling's pending-question toast or owed alert (review still "needs you"); a `running`/`done`/`cancelled` transition still clears them as today.
8. **C8** `PipelineBadge` renders `review` as `bg-info/10 text-info` and its label shows the gate name.

---

## 5. Work breakdown — test tasks

Each implementation task owns its module's tests (same owner, no cross-task file sharing); `T13` is the only separate test task. Tests must be **shown red** against the pre-change behavior: the human branch removed, the status case removed, the sanitizer field omitted, or the old validator — a green run before the change proves nothing.

| ID | Layer | Covers | Owned test files | Acceptance |
| --- | --- | --- | --- | --- |
| T0 | Spike / integration | Resume feasibility | `src/bun/pipeline-human-step-resume-spike.test.ts` | The re-arm + `sendInput` + forced-edge test passes for claude and one one-shot harness, or the spike doc records the failing command. |
| T1 | Unit | Model, validator, status, progress, prompt, alert helper | `src/shared/pipeline.test.ts` | §4.1 T1 scenarios 1–12; the existing 239 tests still pass. |
| T2 | Unit | Bundle v1/v2 export + parse + plan | `src/shared/bundle.test.ts`, `src/shared/bundle-import.test.ts` | Version selection, byte-identity, `type` placement, v1-human rejection, v3 rejection, preview "Human" / no warning. |
| T3 | Unit | Sanitizer round-trip + defaults | `src/bun/pipelines.test.ts` | §4 T3; an old row reads `humanSteps:[]` and a derived `seqCounter`. |
| T4 | Integration | Runner gate/accept/return/stop/restart/reconcile | `src/bun/pipeline-runner.test.ts` | §4.1 T4 R1–R20. Uses `AGETOR_DATA_DIR` at module top level and `rmTestDataDir`. |
| T5 | Integration / endpoint | Route validation, policy, trimming | `src/bun/pipelines-endpoint.test.ts`, `src/bun/route-policy.test.ts` | Every 400/404/409; the trimmed list; the untrimmed single fetch. |
| T6 | Integration | `createTask` acceptance + the `sendInput` seam | `src/bun/orchestrator.test.ts` | Human step accepted without an agent; human with an agent rejected; human start rejected; the seam (if any) tested with a fake driver. |
| T7 | Unit | Run-view helpers | `src/mainview/lib/pipelines.test.ts` | §4 T7. |
| T8 | E2e | Editor: add/switch/validate/save | `e2e/pipelines-editor.spec.ts` | A human step is added, switched, saved; a human start / two incoming / human→human produces the validator banner; the node reads Human. |
| T9 | Unit (scroll signature, API body) + e2e via T13 | Panel + run view | `src/mainview/lib/pipeline-scroll-memory.test.ts` | The panel signature changes on a new gate seq; `api.reviewPipeline` sends the documented body; §4.1 T9 P1–P12 driven by T13. |
| T10 | Unit | Context menu + alert dedupe + toast copy | `src/mainview/lib/task-context-menu.test.ts` | §4.1 T10 C3/C6/C8 pure parts; the review toast is a blocking `waiting` kind with the "Pipeline needs your review" heading. |
| T11 | Unit | CLI rendering + flag parsing | `src/cli/commands/pipeline.test.ts`, `src/cli/commands/show.test.ts`, `src/cli/ls.test.ts` | Accept/return flags, `--next`, `--step`, `--mode`, `--json`, null-taskId history, review color/hint. |
| T12 | Unit | Notification policy | `src/bun/headless-notifications.test.ts` | Review once per run+seq, repeat silent, two gates, done once, stopped silent. |
| T13 | E2e | Full A→H→B pause/return/accept + card + stop | `e2e/pipelines-human-step.spec.ts` (new) | §5.3 scenarios. |
| T14 | — | Docs | none | The docs match the code. |
| T15 | — | Verification | none | §5.4 commands green. |

### 5.1 Every variant through its handler

- Human step variants: terminal Accept, Accept to one target, Accept to `all`, Accept into `join:"all"`, Return fresh, Return resume, Return on a `join:"all"` previous step, manual-Advance entry — all in T4.
- Status variants: review, review+active, review+blocked, review+stopped, no-gate blocked, no-gate stopped, no-gate active, done — T1/T4.
- Bundle variants: v1 human-free, v2 human, v1 human (reject), v2 human-free, v3 (reject) — T2.

### 5.2 Negative paths at each trust boundary

- Comment: blank Return, over-cap, control chars, whitespace-only — T4/T5.
- Decision: missing `decision`, unknown decision, `nextStepIds` on Return, `mode` on Accept, `seq` mismatch, double submit, unknown `stepId`, archived parent, never-run parent — T5.
- Resume: source task missing / archived / no run / harness refuses — T4/T5 (409, gate stays pending).
- Bundle: a v1 human file, an unknown step type, a human step with an agent in the file — T2.
- Prompt: the human comment never inside a nonce marker; no product name — T1.

### 5.3 E2e

Applies: yes — the feature has a user-visible flow crossing UI → API → SQLite → the runner, and the app runs locally with the fake drivers.

`e2e/pipelines-human-step.spec.ts` scenarios:

1. **Pause + accept.** Build `A → H → B` over REST (`makeStep` gains `type`); start; wait for `review`; assert the board card in Review shows Review and no Done; open the card's Review; assert the panel's What to check / last handoff / history; type a comment; Accept; wait for `done`; read B's task row from `GET /tasks/:id/pipeline` and assert its `prompt` contains the comment under `## Human review feedback`.
2. **Return → re-pause → accept.** At the gate, Return (fresh) with a comment; assert a second A execution appears in history; the gate reappears; Accept; finish. Assert the returned A prompt contains the comment.
3. **Stop at a gate.** At the gate, Stop → confirm; assert the card moves to Ready, the gate section is gone, history kept.
4. **Card/context menu.** In Review with a gate: Review present, Done absent, context menu has "Review pipeline" and no "Mark done".
5. **Editor** (in `e2e/pipelines-editor.spec.ts`, T8): add a human step, switch a step to human and back, save; a human start / two incoming shows the validation banner.

**Run recipe.**

```bash
bun install --frozen-lockfile                 # once per worktree
bunx playwright test e2e/pipelines-human-step.spec.ts
bunx playwright test e2e/pipelines-editor.spec.ts
bunx playwright test e2e/pipelines-run.spec.ts   # regression
```

- `playwright.config.ts` starts the Vite server and one headless Bun backend per worker; `freshBackend` gives each test an isolated `AGETOR_DATA_DIR`, port and token.
- The fake Claude driver is wired by `e2e/fixtures.ts` (`AGETOR_CLAUDE_DRIVER=fake`); pipeline scenarios use `AGETOR_FAKE_CLAUDE_HANDOFF_PROMPT_MARKER` and a widened `AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS`.
- Seed data: `createProfileRest` + `createPipelineRest` + `createPipelineTaskRest` (the existing helpers; extend `makeStep` with `type`).
- Credentials: none; the per-worker API token comes from `freshBackend`.
- A missing backend/env must fail the test loudly (`freshBackend` throws), never skip.

**Runtime-shape testing.** Agetor is a single local core (one writer, per-parent lock), so a multi-instance / rolling-deploy test does not apply. The restart path is covered by T4 R20 (`reconcilePipelineRuns` on a review run) plus the existing boot-reconcile suite; the dependency-outage path is T4's resume-refusal 409. No new process harness is planned.

### 5.4 Verification commands (T15)

```bash
bun run typecheck
bun test src/shared/pipeline.test.ts src/shared/bundle.test.ts src/shared/bundle-import.test.ts
bun test src/bun/pipelines.test.ts src/bun/pipeline-runner.test.ts src/bun/pipelines-endpoint.test.ts src/bun/orchestrator.test.ts src/bun/route-policy.test.ts
bun test src/mainview/lib/pipelines.test.ts src/mainview/lib/task-context-menu.test.ts src/mainview/lib/pipeline-scroll-memory.test.ts
bun test src/cli/commands/pipeline.test.ts src/cli/commands/show.test.ts src/cli/ls.test.ts
bun test src/bun/headless-notifications.test.ts
bunx playwright test e2e/pipelines-human-step.spec.ts e2e/pipelines-editor.spec.ts e2e/pipelines-run.spec.ts
```

---

## 6. Execution waves

Each wave ends in a checkpoint commit; the tree must build and the suites must pass at every barrier. T4 is the critical path; everything else can proceed around it.

| Wave | Tasks (parallel) | Barrier green when |
| --- | --- | --- |
| 0 | **T0** (spike; go/no-go) | The spike test passes or the spike doc records the failure. **If it fails, stop and return to the owner — do not start wave 1.** |
| 1 | **T1** | `bun run typecheck` + `src/shared/pipeline.test.ts`. |
| 2 | **T2**, **T3**, **T6**, **T7**, **T8** | Typecheck + the touched suites (bundle, pipelines persistence, orchestrator, mainview helpers) + the editor e2e. |
| 3 | **T4** | Typecheck + `src/bun/pipeline-runner.test.ts` (R1–R20). |
| 4 | **T5**, **T9**, **T10**, **T12** | Typecheck + endpoint/notification suites + the run view compiles. |
| 5 | **T11**, **T13** | The CLI suite + the new and regression e2e specs. |
| 6 | **T14** | Docs reviewed against the shipped behavior. |
| 7 | **T15** | §5.4 all green; plan `Status` refreshed. |

Wave 4 pairs **T5** (the route) with **T9** (the panel and its client). They share the pinned route contract in §2.2 — the body shape, the returned task, and the 400/404/409 meanings are fixed before either starts — so they land together at the barrier rather than in consecutive waves. Every other task's dependencies land in an earlier wave.

**Delivery slices (stacked PRs).** The change is too large for one review; land it as four slices, each wired, green and reviewable on its own. Delete anything a slice does not wire.

1. **PR 1 — Model, bundle, persistence** (`T1`, `T2`, `T3`). Human steps validate, export/import as v2 and round-trip in SQLite; running one still fails safely at the old agent check until PR 2. No UI yet, so the feature is unreachable from the board.
2. **PR 2 — Runner, route, CLI, notifications** (`T4`, `T5`, `T6`, `T11`, `T12`). The feature is runnable and scriptable end to end; the board still renders the run view generically.
3. **PR 3 — UI** (`T7`, `T8`, `T9`, `T10`, `T13`). Editor, human node, panel, card, notifications toast, e2e.
4. **PR 4 — Docs** (`T14`). The subsystem docs, README and design record.

**Docs commit first.** `docs/specs/pipeline-human-step.md` + the investigation/grill records land as a separate docs commit before PR 1.

---

## 7. Invariants, runtime shape & risks

### 7.1 Invariants (one enforcement point each)

| Invariant | Enforced at |
| --- | --- |
| A human step is never the start step | `validatePipelineGraph` (`startStepId` + exactly-one-incoming), `createTask`'s start check, and a defensive `startPipelineRun` guard. |
| A human step has exactly one incoming edge and no agent/subagents | `validatePipelineGraph` is the only acceptance point; `buildSnapshot`/`createTask` skip human steps. |
| One writer per run state | `runExclusive(parentId)` — every launch, settle, decision, retry, stop and restart. |
| A gate decision is idempotent per `(run.startedAt, gate.seq)` | `reviewHumanStep` under the lock: find the gate by `stepId` + `seq`, remove it and record the decision in the same critical section; a second call finds no gate → 409. |
| A returned execution always goes back to its gate | `PipelineStepRecord.returnToStepId` set by `launchStep`/the resume path; `settleStepRun` overrides `resolveNextSteps` in one place; `handoffSettlesStep` honors it so no reminder/block pre-empts it. |
| Human comments are trusted and never inside untrusted markers | `composeStepPrompt`'s `humanFeedback` is the only renderer; `Handoff` never carries the comment; `PipelineJoinArrival.comment` is separate. |
| Human entries never consume the step cap | `launchStep`'s human branch runs before the cap check and never increments `stepCount`; the cap compares `run.stepCount` only. |
| Status precedence has one authority | `deriveRunStatus`; every surface reads it (or the persisted `run.status`). |
| Every review route is policy-gated | `ROUTE_POLICY["/tasks/:id/pipeline/review"] = { POST: CLI }` (`app+cli`). |

### 7.2 Runtime shape

- **Instances:** one local desktop core; no rolling deploy, no second writer. The per-parent lock is the concurrency boundary.
- **Crash between steps:** a pending gate is persisted JSON; an app restart leaves it pending and the card in Review (a pipeline Restart is different — it clears it). `reconcilePipelineRuns` sweeps a review run only when it still has `active` entries (live siblings); a gate-only run is skipped and never marked done. `reconcilePipelineRuns` must not flip a review run to done.
- **Crash mid-decision:** the gate is removed and the decision recorded in memory, then the launch runs, then `persist`. A crash before `persist` leaves the old gate in the DB (the decision can be retried; a launch that started may double-start — the same window `advancePipeline` has today). A crash after `persist` leaves a retryable `pending` block if the launch failed (`launchTarget`).
- **Dependency outage:** `sendInput` for resume may fail (session gone, harness refuses) → 409, gate stays pending; the user can retry or choose fresh.
- **Kill switch:** `launchesFrozen()` refuses `reviewHumanStep` with 409 like every other launch route.
- **Kill switch wins:** nothing else — a pending gate is data, not a launch.

### 7.3 Blast radius

- **Every `PipelineRunStatus` exhaustive map** (`pipeline-runner.ts:290`, `PipelineRunView.tsx:137/145`, `PipelineBadge.tsx:7`, `colorRunStatus` in the CLI) + `isTerminalRunStatus`, `hasLiveExecution`, `RESTARTABLE_STATUSES`, `cancelPipelineRun`, `reconcilePipelineRuns`, `reviewActive`, `pipelineStepProgress`, notifications.
- **Every `PipelineStepRecord.taskId` reader** (`stepTaskFor`/`stepNodeTaskFor`, `stepAttention`, `pipelineAttentionStepTask`, `HistoryRow`, CLI `status`).
- **The board poll** (`trimPipelineRunForList`) — human arrival handoffs must be nulled like history/joins or every 2s poll ships them.
- **`startPipelineRun`** — a plain Run on `review` must refuse, Restart must clear the gate.
- **Create validation** — `createTask` and `buildSnapshot` must stop requiring an agent for human steps.
- **Bundle** — v2 is a one-way compatibility door for old readers; v1 stays byte-identical.
- **No SQL migration** — the graph and run are JSON; old rows default to no human state.
- **Rollback:** there is no DB downgrade. An older binary reading a `review` run would sanitize the status to `idle` and drop a null-`taskId` history record. This is a one-way DB state change (like migration 072), recorded in §8. Restoring an old app version after a human step has run requires restoring the DB from backup.
- **Feature flag:** none. The editor is the only way to create a human step in the UI; the API/CLI can create one after PR 2.

### 7.4 Cross-repo dependencies

None. All work is in this repo; the fake drivers are local test seams.

---

## 8. Open questions / assumptions

**Unratified one-way decision first.**

1. **Resume is a go/no-go (unratified until T0).** The owner chose both Return modes in v1, and the grill says planning must stop and return to the owner if resume cannot be made deterministic — not silently drop it. `T0` is the gate. If T0 fails: stop before wave 1, record the failing evidence in `docs/plans/pipeline-human-step-resume-spike.md`, and ask the owner to choose fresh-only v1 or a larger resume design. **Do not ship the resume mode at all if the spike fails.** (A per-run unresumable session is different: the route may 409 and leave the gate pending, which the panel surfaces.)
2. **Default Return mode is `fresh`.** The owner chose both modes but not the default (grill assumption 4). Proceeding with fresh as the default, resume opt-in per gate. If the owner wants resume default, flip the panel/CLI default and the tests.
3. **Stop with a gate drops `run.blocked` entries to force `cancelled`.** Decision 6 requires the card to move to Ready; the existing `finalizeCancelled` deliberately keeps a blocked reason visible. This plan resolves the conflict in favor of the owner's Stop decision while a gate is pending. It is an inference, not an explicit answer — flag it in the PR body for review.
4. **`type` handling.** Missing `type` = `"agent"`; `"agent"`/`"human"` accepted; any other value rejected. A v1 bundle containing `type:"human"` is rejected with "bundle version 2". Both are inferences from the conditional-v2 decision.
5. **Human `join` is normalized to `"any"`.** Exactly one incoming makes join moot; normalizing avoids a second validation error for hand-edited graphs.
6. **`seqCounter` and progress.** Human entries get a unique seq but do not consume `stepCount`; `pipelineStepProgress.completed` counts an accepted human record but not a returned one. `returned` is a loop decision, not work completed. The label can exceed `total` on cycles, as it already can today.
7. **Multiple pending gates.** The card Review opens the oldest (`seq` ascending); the CLI requires `--step` when more than one is pending; the notification dedupe is per gate seq. The exact "oldest first" choice is a presentation detail.
8. **The panel mock was not supplied.** The layout follows the record's seven items and the existing run-view visual language (info-tinted, not amber); a later mock can refine it.
9. **No human-step task row or transcript.** The human history record *is* the decision transcript; transcript links cover prior agent steps only.
10. **Terminal Accept with a comment.** The comment is stored on the history record and shown in prior rounds; it is not sent anywhere because there is no next step.
11. **Comment cap** is `PIPELINE_LIMITS.handoffField` (8,000). Control chars other than `\n`/`\t` are rejected; `\r\n` is normalized to `\n`.

---

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| `PipelineStep` type discriminator | In this run | T1 |
| Validator: never start, one incoming, no agent/subagents, no human→human, terminal allowed | In this run | T1 |
| Editor: Add human step, type switch, Set-as-start guard, delete-start guard | In this run | T8 |
| New `review` run status + every exhaustive consumer | In this run | T1 (status), T3 (persist), T4 (runner), T7/T9/T10/T11/T12 (surfaces) |
| `PipelineRunState.humanSteps` + `seqCounter` + sanitizer | In this run | T1, T3, T4 |
| Nullable `PipelineStepRecord.taskId` + every caller | In this run | T1, T3, T7, T9, T11 |
| `PipelineJoinArrival.comment` / pending-launch comment carry | In this run | T1, T3, T4 |
| Human history record: decision, comment, return target, `returned` outcome | In this run | T1, T3, T4 |
| Card Review action, Done suppression, context menu, drag guard | In this run | T10 |
| Panel modal + all seven content items + diff wiring | In this run | T9 |
| Human decision route, API client, CLI, route policy | In this run | T5, T9, T11 |
| Idempotent decision route (run + gate seq) | In this run | T4, T5, T9, T11 |
| Fresh Return path | In this run | T4 |
| Resume Return path + spike | In this run, gated by T0 | T0, T4, T6 |
| Forced-return guarantee on both paths | In this run | T4 |
| Single-incoming validation + editor | In this run | T1, T8 |
| Immediate-review + Review-wins-over-blocked + stop-wins | In this run | T1, T4 |
| Card secondary Stop with confirmation | In this run | T10, T9 |
| Stop/cancel with no live work + history preserved | In this run | T4 |
| Step-cap exemption for human entries | In this run | T1, T4 |
| Conditional bundle v2 + parser 1/2 + import mapping/preview | In this run | T2 |
| Manual Advance into a gate | In this run | T4 |
| Trusted human-feedback prompt section + join/retry durability | In this run | T1, T4 |
| Board poll trims human arrival handoffs | In this run | T5 |
| `startPipelineRun` review guard; Restart clears human state | In this run | T4 |
| Boot reconcile for a review run | In this run | T4 |
| Docs (`docs/architecture/pipelines.md`, `docs/plans/pipelines.md`, `README.md`, `docs/architecture/bundle.md`, `docs/architecture/notifications.md`, `docs/architecture/task-context-menu.md`) | In this run | T14 |
| Unit + endpoint + e2e tests | In this run | T1–T13 |
| Multi-incoming fan-in gates | Out of scope | Owner chose single-incoming (grill decision 9); a separate ticket. |
| Auto-open the panel on arrival | Out of scope | Owner chose no auto-open (decision 11). |
| Comment draft across app reload | Out of scope | The draft lives only while the run view is open (decision 11). |
| Third Reject/Stop panel action | Out of scope | Owner confirmed exactly two decisions; Stop is run-level (decision 22). |
| CLI `--to` for a multi-incoming return target | Out of scope | Single-incoming removes the need (decision 9). |
| Human gate as a join collector | Out of scope | Same as multi-incoming. |
| Bundle v1 downgrade for human steps | Out of scope | Conditional-v2 means old readers refuse; no downgrade (decision 14). |
| Separate human-step task row or transcript | Out of scope | The design has no task row; history is the transcript. |
| PRD or design mock | Not provided | The spec is the task text; the optional mock was blank (grill assumption 12). A later mock refines the panel. |
| Multi-tenant/auth | Not applicable | Local single-user desktop app with loopback tokens. |
| DB migration/backfill | Not applicable | JSON columns; old rows default (investigation §5.6). |
