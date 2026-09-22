# Plan — Pipelines

| Field | Value |
| --- | --- |
| Date | 2026-09-22 |
| Source | Task prompt ("Let's implement Pipelines") + two grill passes with the owner |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-running haiku, planning self) |
| Flags | none |
| Gates | grilled (8 questions, all answered by the owner) + approved by the owner ("approve, but sweep in parallel fan-out/join steps too") |
| Branch | feature/agetor-pipelines |
| Base SHA | 6bbe2f8f5257c7e57570c619aabd074afe9fa36c |

## 1. Objective & success criteria

A **pipeline** is a named graph of **steps**, each bound to an agent profile (Settings → Agents), connected by edges. Running a pipeline creates one **pipeline task** on the board; agetor runs the steps one at a time as hidden **step tasks** that share the pipeline task's worktree, and each step ends its turn with a JSON **handoff** (`<handoff>…</handoff>`) that tells agetor which step comes next and carries the context forward.

Done means:

1. A full-page, n8n-style canvas editor (React Flow) creates/edits pipelines: draggable step nodes, drag-to-connect edges, a per-step side panel (name, instructions, agent profile with inline "New agent…", allowed subagent profiles + cap), Auto-arrange, Fit view, keyboard delete, smooth board↔page transitions.
2. New Task offers a **Pipeline** picker (mutually exclusive with the Agent picker). The created board card shows a Pipeline badge with step progress; clicking it opens the full-page **run view** instead of the run panel.
3. The run view animates the run: the active step pulses, traversed edges animate, a token travels the edge on each handoff; clicking a step node opens that step task's normal details (RunPanel) on top; "Back to board" returns.
4. Server-side runner: step 1 starts on Run; on a step's successful settle the handoff is parsed; the next step's task is created + started with the handoff (and the original goal) in its prompt; the last step moves the pipeline task to Review; a failing/dying/asking step moves it to Blocked with the reason; Retry, Stop, and manual advance (pick the next step) are available; branching (agent picks `next`) and cycles (25-step cap, per pipeline) work.
5. Per-step subagent guidance is injected into the step prompt (allowed profiles' settings + cap) — prose only, agetor does not enforce it.
6. Settings → Pipelines section lists pipelines and links into the editor. CLI parity: `agetor pipeline ls|show|rm|export|import`, `agetor add --pipeline <id|name>`, `agetor ls --steps`.
7. Profiles are frozen into the pipeline task at run start; deleting a profile or pipeline never breaks a running pipeline; the editor flags a step whose profile is gone and the runner refuses to start such a pipeline.
8. Deleting/archiving a pipeline task cascades to its step tasks; step tasks cannot be deleted/archived individually.
9. Unit + endpoint + runner + CLI tests, two Playwright specs (editor, run), CLAUDE.md item 19, README section.

## 2. Context & constraints (Phase 1 findings)

- **No router.** Every "page" today is a boolean-gated overlay (`WorktreesDialog`, `SettingsDialog`, `GitHubDialog` in `src/mainview/App.tsx:1750-1773`). Nothing swaps the board out. Pipelines introduce a `view` union in App (D5).
- **Single `RunPanel` instance** (`App.tsx:1712`, `task={selected}`), a non-portaled `fixed` `<aside>` at z-40 that already renders over whatever is behind it — reusable unchanged over the run view (D7).
- **Board `onOpen`** is `setSelected` threaded through `Column` (memo comparator `Column.tsx:105-121`) → `TaskCard.onClick` (`TaskCard.tsx:101`). Badges live in `TaskCard.tsx:150-241` (`task-card-agent-profile` badge is the template).
- **dnd-kit** `DndContext` wraps only the board columns (`App.tsx:1661-1684`); React Flow uses d3-zoom/d3-drag internally — no conflict when the board is unmounted (research brief §1).
- **Settle hook**: `subscribeGlobal` (`orchestrator.ts:369`) — `run-status` (terminal only, `orchestrator.ts:2262`) and `column` events (`updateColumn`, `:405`, reason enum `api-error|approval|session-died|unknown-command`). `attachDoneHandler` (`:2142`) picks `review|ready|blocked` (`:2247`).
- **Assistant text**: `run_events.stream === "assistant"` rows are plain text, one per content block; `runs.events(runId)` returns them in id order (db brief §2). Main stream = `subagent_id IS NULL`.
- **Interactions**: `countPendingForTask`/`listPendingForTask` (`interactions.ts:610-632`), `Task.pendingInteractionCount`; an ask card flips the task to `blocked` with `reason: "approval"`.
- **Worktree reuse**: `prepareWorkdir` (`worktree.ts:797-814`) reuses `task.worktreePath` in place when it exists and is on `task.branch` — a step task inserted with the parent's `branch`/`worktreePath`/`baseRef` reuses the parent's worktree with no git call. `createTask`'s `existingBranch` collision guard (`orchestrator.ts:5325-5330`) is bypassed by inserting step rows directly (D2).
- **No parent/child task concept** exists; `tasks.delete` is a plain `DELETE` (`db.ts:608`); `runs`/`run_events` cascade via FK (`001_init.sql`). `deleteTask` (`orchestrator.ts:5849`) tears down worktree/session; `archiveTask` (`:5718`) requires `column === "done"` unless `force`.
- **Agent profiles**: `composeLaunchPrompt` (`src/shared/agent-profile.ts:74`), `effectiveAgentProfile` (`orchestrator.ts:1096`, live-until-first-run), `agentProfiles` db module (`db.ts:1443`), `tasks.setAgentProfile` (`db.ts:748`), server-managed skip-list pattern (`db.ts:562-580`), `053_task_agent_profile.sql`.
- **Migrations**: latest is `055`; array in `src/bun/migrations/index.ts:130-139`; text imports.
- **Routes template**: `/agent-profiles*` at `server.ts:3446-3618`; `POST /tasks` at `:3884-3963` (tri-state `agentProfileId` check at `:3917-3923`); `ALLOWED_PATCH_FIELDS` `:405`; `GET /events` SSE `:5776`.
- **Fake driver seam**: `makeFakeAgent` (`agents.ts:1143`) branches on prompt-substring markers (`FAKE_CLAUDE_*_PROMPT_MARKER`, `:851-1125`), `after(ms, fn)` timers.
- **CLI**: `src/cli/index.ts` switch (`profile` case `:187-189`), `api-client.ts:307-336` wrapper section, `commands/agent-profile.ts` shape, `output.ts` `c`/`table`, `ls.ts:134-146` `needsCell`, `tui/Dashboard.tsx:465-499`.
- **Tests**: endpoint tests set `AGETOR_DATA_DIR` + `AGETOR_API_PORT` at module scope before dynamic imports; `rmTestDataDir`; e2e `e2e/fixtures.ts` per-worker headless backend with `AGETOR_CLAUDE_DRIVER=fake`; `taskCard(page, title)` helper; API-created tasks with `isolation: "none"` for setup.
- **Deps** (verified 2026-09-22): `@xyflow/react` 12.11.6 (MIT, peer react >=17), `@dagrejs/dagre` 3.1.1 (MIT), `motion` 13.4.1 (MIT, react 18|19). Repo: React 19.2.6, Vite 8, Tailwind v3 (no `tailwindcss-animate`). React Flow CSS must be imported after `@tailwind base`.
- Typecheck is green on the base; `node_modules` installed in this worktree (`bun install`).
- Git history: the Agents feature (#229) is the delivery template; CLAUDE.md numbered items end at 18 → Pipelines is **item 19**; README has `## Highlights` + `## Concepts` sections to extend.

## 3. Approach & key decisions

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D1 | **Parent pipeline task + hidden step tasks.** The board card is a normal `tasks` row with `pipeline_id` + `pipeline_run` (JSON state). Each executed step is its own `tasks` row with `pipeline_parent_id` + `pipeline_step_id`, hidden from the board/`agetor ls`/TUI. | Owner pick. Every per-task surface (RunPanel, ask cards, diff, backlog, CLI `show`) works per step unchanged. Rejected: one task/multi-run (fights freeze-at-first-run, needs prompt/agent overrides in `startTask`). |
| D2 | **Step tasks share the parent's worktree.** The runner materializes the parent's worktree once (`prepareWorkdir(parent)`), then inserts step rows via `tasks.insert` with the parent's `workdir/isolation/branch/branchSource/worktreePath/baseRef` copied in, so `prepareWorkdir(step)` hits the reuse branch. Step rows never go through `createTask`'s `existingBranch` collision guard. `deleteTask`/`archiveTask` skip worktree + session-agnostic teardown for step rows (the parent owns the worktree). | Steps must build on each other's files. Rejected: per-step worktrees (loses continuity, N× disk). |
| D3 | **Handoff contract**: the step prompt asks the agent to end with `<handoff>` + JSON + `</handoff>`. Parser (`src/shared/pipeline.ts`): last `<handoff>` block wins, optional ```json fences stripped, brace-balanced fallback, tolerant of trailing prose; schema `{schemaVersion:1, purpose, summary, reason, next, artifacts[], openQuestions[], status?}`. Missing/invalid → parent Blocked (`handoff-missing`/`handoff-invalid`), re-parsed on every later successful settle of that step task (the user can reply "please emit the handoff"), plus **manual advance** (pick next step or finish). | Owner pick (tag renamed from `agetor_handoff` to `handoff`). |
| D4 | **Graph rules**: multiple outgoing edges allowed; a step's `transition` is `choose` (the agent's `next` — step name, case-insensitive, or edge label — picks ONE; with a single edge `next` is ignored) or `all` (**fan-out**: every outgoing step starts in parallel with the same handoff); 0 edges = terminal for that path; a step's `join` is `any` (default: every arrival starts a new execution — how cycles work) or `all` (**join**: starts once every distinct incoming source has arrived in this generation, receiving all their handoffs); cycles allowed; `maxSteps` per pipeline (default 25, 1..200) caps executions per run → Blocked `step-cap`. Names unique per pipeline (case-insensitive) since `next` is by name. Start step = `startStepId` (editor marks it; defaults to the first step with no incoming edge). **Parallel steps share the parent's single worktree** (tmux sessions are per task id, so nothing collides at the process level, but concurrent agents can edit the same files) — the editor shows a warning on fan-out steps and the step prompt names its parallel siblings. The run finishes when no execution is active and no join is partially filled; a partially filled join whose remaining sources can no longer arrive (all paths ended) → Blocked `join-incomplete`, resolvable by manual advance (start the join step with what arrived). | Owner pick ("sweep in parallel fan-out/join steps too"). Rejected: per-branch worktrees + merge at join (a merge/conflict feature of its own). |
| D5 | **Full-page views via a `view` union in App**: `{kind:"board"} \| {kind:"pipelines", pipelineId: string \| null} \| {kind:"pipeline-run", taskId}`. The `<main>` content swaps under `<AnimatePresence mode="wait">` (motion); header/NewTaskForm/dialogs/RunPanel stay mounted. Entry: header "Pipelines" button (next to Worktrees), New Task's "Manage pipelines…", Settings → Pipelines, card click on a pipeline task. Escape in a page view = back to board when no dialog/popover/RunPanel is open. | First true page-swap in the app; owner asked for "take the whole page". Overlay dialogs would keep the board mounted and cannot host a full canvas comfortably. |
| D6 | **React Flow 12 + dagre + motion.** Custom `StepNode` (input handle left, output handle right with a "+" to append a step), custom `StepEdge` (BaseEdge + EdgeLabelRenderer delete button; `animated` when running; SVG `animateMotion` token on handoff). `colorMode` follows `useTheme().resolved`. Auto-arrange = dagre LR. | Owner pick. |
| D7 | **Reuse the single RunPanel** for step details: the run view calls `setSelected(stepTask)`; RunPanel renders at z-40 over the view (z-index of page views stays < 30). RunPanel gets a small "Part of pipeline · step N/M" strip with an "Open pipeline" button for step tasks. | Avoids duplicating 7.7k lines. |
| D8 | **Freeze at run start**: on the first Run the runner snapshots the pipeline graph + every referenced profile (`AgentProfileSnapshot`) into `tasks.pipeline_run.snapshot`; later edits/deletes of the pipeline or profiles never affect a started run. Step tasks are inserted with `agentProfileId` + the frozen snapshot; `effectiveAgentProfile` returns `"snapshot"` for step tasks (one added guard) so the live-until-first-run refresh can't re-read an edited profile mid-pipeline. The editor shows a "profile deleted" warning; the runner refuses to start with `profile-missing`. | Owner pick; mirrors the agent-profile decision. `agentProfiles.delete`/`pipelines.delete` stay never-blocked; both carry `taskCount`. |
| D9 | **Lifecycle** (owner-confirmed a–f): Run on the parent starts step 1 (or retries the current step when Blocked/cancelled); each step is one agent turn (follow-ups in the step's panel extend it; handoff re-parsed on each settle); all paths finished → parent `review` (each step task → `done` when its handoff is consumed); any execution `failed`/`blocked` → parent `blocked` (reason kinds `step-failed`, `step-blocked`, `handoff-missing`, `handoff-invalid`, `step-cap`, `profile-missing`, `join-incomplete`) while sibling executions keep running; Stop on the parent cancels every active execution and returns the parent to `ready` (state `cancelled`, active set kept so Run retries them); delete/archive cascade; step tasks can't be deleted/archived individually (409). A step task the user manually re-runs from its own panel is a retry (parent mirrors the child's column events). | Consistent with today's semantics. |
| D10 | **Prompt composition** (`composeStepPrompt`, pure): pipeline header (name, step k of the run, cap), the original goal (the task prompt), the previous handoff inlined (capped at 16 KB, the rest in a file), the step's own instructions, delegation guidance (allowed profiles' name/harness/model/instructions/skills + cap or "no limit"), the list of possible next steps, and the handoff contract. Then the normal `composeLaunchPrompt(profileSnapshot, …)` wraps it. Every handoff is also written to `dataDir/pipeline-runs/<parentId>/handoff-<seq>.json` and attached as a `TaskReference` on the next step (issue-threads pattern); for gemini steps the inline copy is dropped when the composed prompt would exceed the 4 KB argv cap. | Keeps the "main purpose + reason" context flowing; the file makes it durable and bounded. |
| D11 | **Board/CLI hiding**: `GET /tasks` returns step rows too (so `selected` sync + the run view work from one list); the board filters `pipelineParentId == null`; the parent's `pendingInteractionCount` aggregates its steps' counts (so the card's "waiting on you" glow is honest); CLI `ls`/TUI hide steps unless `--steps`. | One list keeps `reconcileById` identity semantics; filtering is a one-liner per consumer. |
| D12 | **Live updates**: new `GlobalEvent` kind `"pipeline"` (`{taskId, status, currentStepId, stepCount, ts}`) emitted on every state change; the run view subscribes via `api.subscribeGlobalEvents` and refetches the parent + steps on it; the 2 s `/tasks` poll is the fallback. `column` reason enum gains `"pipeline"`. | Animation needs sub-poll latency. |
| D13 | **Editor connect fallback**: besides drag-to-connect, the step panel has a "Connect to…" select (adds an edge). | Keyboard/a11y and a deterministic e2e path (Playwright handle-drags are flaky). |
| D14 | **Pipeline authoring in CLI = JSON files** (`export`/`import`, `add` from a file); `agetor add --pipeline` creates the parent task. | Canvas is the authoring surface; the CLI moves pipelines around. |

### Contracts

`src/shared/types.ts` (additive):

```ts
export interface PipelineStep {
  id: string;                 // uuid, stable across edits
  name: string;               // unique per pipeline, case-insensitive; `next` targets it
  instructions: string;       // step-specific prompt text
  agentProfileId: string | null;
  position: { x: number; y: number };
  subagents: { profileIds: string[]; cap: number | null };  // cap null = no limit
  transition: "choose" | "all";   // after this step: the agent's `next` picks ONE outgoing edge, or ALL outgoing steps start in parallel (fan-out)
  join: "any" | "all";            // start when ANY incoming step finishes (default; each arrival = a new execution), or only once ALL incoming steps have finished this generation (join)
}
export interface PipelineEdge { id: string; from: string; to: string; label: string }
export interface PipelineGraph { steps: PipelineStep[]; edges: PipelineEdge[]; startStepId: string | null }
export interface Pipeline {
  id: string; name: string; description: string; graph: PipelineGraph; maxSteps: number;
  createdAt: number; updatedAt: number; taskCount?: number;   // taskCount server-derived (parents bound by pipeline_id)
}
export interface PipelineInput { name: string; description?: string; graph: PipelineGraph; maxSteps?: number }
export interface Handoff {
  schemaVersion: 1; purpose: string; summary: string; reason: string;
  next: string | null; artifacts: string[]; openQuestions: string[]; status?: "done" | "blocked";
}
export type PipelineRunStatus = "idle" | "running" | "blocked" | "done" | "cancelled";
export type PipelineBlockKind = "step-failed" | "step-blocked" | "handoff-missing" | "handoff-invalid" | "step-cap" | "profile-missing" | "join-incomplete";
export interface PipelineStepRecord {
  seq: number; stepId: string; taskId: string; startedAt: number; endedAt: number | null;
  outcome: "succeeded" | "failed" | "cancelled" | "advanced-manually" | null;
  handoff: Handoff | null; nextStepId: string | null;
}
export interface PipelineRunState {
  pipelineId: string; pipelineName: string;
  snapshot: { graph: PipelineGraph; maxSteps: number; profiles: Record<string, AgentProfileSnapshot>; capturedAt: number } | null; // null until first Run
  status: PipelineRunStatus;
  active: { stepId: string; taskId: string; seq: number }[];                 // every step execution currently running/blocked (parallel fan-out ⇒ several)
  joins: Record<string, { arrivals: { fromStepId: string; seq: number; handoff: Handoff | null }[] }>; // partial fan-in state per join="all" step
  blocked: { taskId: string | null; stepId: string | null; kind: PipelineBlockKind; message: string }[]; // one entry per blocked execution (or a run-level entry with null ids)
  history: PipelineStepRecord[]; stepCount: number; startedAt: number | null; endedAt: number | null;
}
// Task (additive): pipelineId?: string | null; pipelineRun?: PipelineRunState | null; pipelineParentId?: string | null; pipelineStepId?: string | null;
// GlobalEvent (additive): { kind: "pipeline"; taskId: string; status: PipelineRunStatus; activeStepIds: string[]; stepCount: number; ts: number }
// column-event reason gains "pipeline".
export const PIPELINE_LIMITS = { name: 80, description: 2000, steps: 50, edges: 200, stepName: 60, instructions: 20_000, maxStepsDefault: 25, maxStepsMax: 200, handoffInlineMaxBytes: 16_384 } as const;
```

`src/shared/pipeline.ts` (pure, no runtime imports from either process):

```ts
export const HANDOFF_TAG = "handoff";
export function validatePipelineGraph(g: unknown): { ok: true; graph: PipelineGraph } | { ok: false; error: string };
export function resolveStartStep(g: PipelineGraph): PipelineStep | null;        // startStepId, else unique no-incoming step
export function outgoingSteps(g: PipelineGraph, stepId: string): { step: PipelineStep; edge: PipelineEdge }[];
export function parseHandoff(text: string): { ok: true; handoff: Handoff } | { ok: false; error: string; raw: string | null };
export function resolveNextSteps(g: PipelineGraph, fromStepId: string, handoff: Handoff | null): { kind: "terminal" } | { kind: "steps"; stepIds: string[] } | { kind: "ambiguous"; candidates: string[] } | { kind: "unknown"; next: string; candidates: string[] };  // transition "all" ⇒ every outgoing target; "choose" ⇒ one by name/label
export function incomingSteps(g: PipelineGraph, stepId: string): PipelineStep[];
export function deriveRunStatus(run: PipelineRunState): PipelineRunStatus;   // blocked if any blocked entry, running if any active, done when nothing active and no partial join, else idle/cancelled as stored
export function composeStepPrompt(input: { pipelineName: string; step: PipelineStep; stepIndex: number; stepCap: number; goal: string; previous: { stepName: string; handoff: Handoff | null; filePath: string | null }[]; outgoing: { name: string; label: string }[]; transition: "choose" | "all"; subagentProfiles: AgentProfileSnapshot[]; subagentCap: number | null; inlineHandoff: boolean; parallelSiblings: string[] }): string;  // `previous` has several entries after a join; `parallelSiblings` names steps running concurrently in the same worktree
export function matchPipelineRef(list: Pipeline[], ref: string): { ok: true; pipeline: Pipeline } | { ok: false; error: string };
export function pipelineStepProgress(run: PipelineRunState): { current: number; total: number; label: string } | null;  // for badges
export function newStep(partial?: Partial<PipelineStep>): PipelineStep;
```

DB (`src/bun/db.ts`): `pipelines = { list(), get(id), findByName(name), insert(input), update(id, patch), delete(id), taskCounts(), taskCount(id) }` throwing `PipelineNameError` on a name clash; `tasks.setPipelineRun(taskId, run: PipelineRunState | null): Task | null` (targeted UPDATE, no `updated_at` bump); `tasks.stepsForParent(parentId): Task[]`; `tasks.insert` writes the four new columns; generic `tasks.update` skips them; `parsePipelineRunState` defensive parser.

Routes (`src/bun/server.ts`, all `authed`):

| Route | Body → Result |
| --- | --- |
| `GET /pipelines` | `Pipeline[]` (name ASC, with `taskCount`) |
| `POST /pipelines` | `PipelineInput` → 201 `Pipeline`; 400 invalid graph/limits; 409 name clash |
| `GET /pipelines/:id` | `Pipeline` / 404 |
| `PATCH /pipelines/:id` | partial `PipelineInput` → `Pipeline`; same validation |
| `DELETE /pipelines/:id` | `{ok:true}` / 404 — never blocked |
| `POST /tasks` | additive `pipelineId?: string \| null` (400 unknown; 400 when combined with `agentProfileId`) |
| `GET /tasks/:id/pipeline` | `{ task: Task; steps: Task[] }` (404; 400 not a pipeline task) |
| `POST /tasks/:id/pipeline/advance` | `{ nextStepId: string \| null; handoff?: Partial<Handoff> }` → `Task`; 409 unless blocked on a handoff or the current step is in review |
| `POST /tasks/:id/pipeline/retry` | → `Task`; 409 unless blocked/cancelled |
| `POST /tasks/:id/pipeline/cancel` | → `Task`; stops the active step |
| `DELETE /tasks/:id` / `POST /tasks/:id/archive` | 409 `"step task belongs to a pipeline — act on the pipeline task"` for step rows |

Runner (`src/bun/pipeline-runner.ts`): `initPipelineRunner()` (subscribes to `subscribeGlobal`; called from `index.ts` and `headless.ts` **before** `reconcileOrphans()` so boot-time `orphaned` events for step tasks flip their parents to `ready`/cancelled), `startPipelineRun(parent)`, `advancePipeline(parentId, opts)`, `retryPipelineStep(parentId)`, `cancelPipelineRun(parentId)`, `deletePipelineChildren(parentId)`/`archivePipelineChildren(parentId)` (used by the orchestrator's cascade), `readStepHandoff(runId)` (concatenates main-stream assistant rows of that run, parses). `startTaskInner` branches to `startPipelineRun` when `task.pipelineId` is set (before harness pre-flight — the parent never spawns an agent). Fake driver: `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER = "__agetor_fake_claude_handoff__"` with suffix `:<next-name>` / `:done` / `:missing` / `:invalid`; the **last** occurrence in the prompt wins (goal text carries a default, a step's instructions can override).

## 4. Work breakdown — implementation tasks

### Wave 1 (foundation; 2 tasks, disjoint)

**T0 — Dependencies + CSS.** Owns `package.json`, `bun.lock`, `src/mainview/index.css`, `tailwind.config.js`.
- `bun add @xyflow/react@^12.11 @dagrejs/dagre@^3.1 motion@^13.4`. Import `@xyflow/react/dist/style.css` in `index.css` after `@tailwind base` and add scoped overrides so `.react-flow__*` isn't broken by the base reset; add keyframes `pipeline-pulse` and `pipeline-dash` (+ Tailwind `animation` entries).
- Acceptance: `bun run typecheck` green; `bun run hmr` boots.

**T1 — Shared types + pure pipeline module.** Owns `src/shared/types.ts`, `src/shared/pipeline.ts`, `src/shared/pipeline.test.ts`.
- Add every type/const in §3 Contracts (Task/GlobalEvent additive fields, reason enum); implement `src/shared/pipeline.ts` exactly per the contract, with unit tests (parser: tag anywhere, fenced, trailing prose, draft block earlier, invalid JSON, missing tag; resolveNextStep: terminal/single/multi by name/label/unknown; validate: dup names, dangling edges, limits, start resolution incl. cycles; composeStepPrompt snapshot-style assertions; matchPipelineRef; pipelineStepProgress).
- Acceptance: `bun test src/shared/pipeline.test.ts` green; typecheck green.

Barrier: typecheck.

### Wave 2 (server + webview foundations + CLI; 6 tasks, disjoint)

**T2 — Migrations + db module.** Owns `src/bun/migrations/056_pipelines.sql`, `057_task_pipeline.sql`, `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/migrate.test.ts` (extend the column list), `src/bun/pipelines.test.ts` (new).
- `056`: `pipelines(id, name, name_key UNIQUE, description, graph TEXT, max_steps INTEGER, created_at, updated_at)`. `057`: `tasks.pipeline_id`, `pipeline_run`, `pipeline_parent_id`, `pipeline_step_id` + index on `pipeline_parent_id`; doc comments in the 053 style.
- db: `pipelines` module (validates via `validatePipelineGraph`, name-key clash → `PipelineNameError`), `tasks.setPipelineRun`, `tasks.stepsForParent`, `toTask` mapping (`pipelineId`, `pipelineRun`, `pipelineParentId`, `pipelineStepId`), skip-list + insert columns, parent `pendingInteractionCount` aggregation in `tasks.list()` (D11), `parsePipelineRunState`.
- Acceptance: db tests (CRUD, clash, taskCounts, setPipelineRun no `updated_at` bump, generic update skips columns, stepsForParent, aggregation).

**T3 — Runner + orchestrator hooks + fake driver.** Owns `src/bun/pipeline-runner.ts` (new), `src/bun/orchestrator.ts`, `src/bun/agents.ts`, `src/bun/index.ts`, `src/bun/headless.ts`, `src/bun/pipeline-runner.test.ts` (new).
- Runner per §3 Contracts + D2/D3/D4/D8/D9/D10/D12 — multiple concurrent executions (`active[]`), fan-out (`transition: "all"` launches every target), fan-in (`joins` arrivals keyed by distinct `fromStepId`; launch when complete; `join-incomplete` when nothing else is active), status via `deriveRunStatus`; snapshot on first Run (profiles resolved via `agentProfiles.get` + `snapshotFromProfile`; missing → `profile-missing`), `prepareWorkdir(parent)` once, step insert (title `"<pipeline> · <step>"`, `taskType` from parent, references = handoff file ref), `startTask(child)`, settle handling (only for `currentTaskId`), handoff file writes under `dataDir/pipeline-runs/<parentId>/`, cap, manual advance, retry, cancel, boot orphan handling, `emitGlobal({kind:"pipeline"…})` via `publishGlobalEvent`.
- Orchestrator: `startTaskInner` → `startPipelineRun` branch; `effectiveAgentProfile` returns `"snapshot"` for step tasks; `updateColumn` reason `"pipeline"`; `deleteTask`/`archiveTask` cascade to steps and skip worktree teardown for step rows (session drop still happens per step; the parent's teardown removes the worktree); `createTask` accepts `pipelineId` (validates, seeds `pipelineRun` idle state, sets parent `agent` to the start step's profile harness, rejects `agentProfileId` + `pipelineId` together); `cancelRun`-equivalent for parents lives in the runner; `reconcileOrphans` unchanged (runner subscribes first). `agents.ts`: the handoff marker branch in `makeFakeAgent` (emits one assistant chunk with `<handoff>` JSON whose `next` is the suffix; `:missing` emits prose only; `:invalid` emits a broken block; `:done` emits `next: null`).
- Acceptance: runner tests with the fake claude driver + `isolation: "none"` temp workdirs: 3-step linear run reaches `review` with history + handoff files; branch by name; fan-out A→(B‖C)→D with `join: "all"` (D starts only after both, with two handoffs in its prompt); `join: "any"` starts twice; join-incomplete when one branch ends early → manual advance launches D; missing handoff → blocked → manual advance; invalid → blocked; retry after failure; cancel; cap; delete cascade (steps gone, dir gone); archive cascade; step delete 409 at the orchestrator level (function returns error).

**T4 — Routes + task-route guards.** Owns `src/bun/server.ts`, `src/bun/pipelines-endpoint.test.ts` (new).
- Routes per the table, mirroring `/agent-profiles*` validation; `withTaskCount(s)` analog; `POST /tasks` `pipelineId` tri-state; step-row 409s on delete/archive; `GET /tasks/:id/pipeline`.
- Acceptance: endpoint tests (CRUD + 400/404/409 matrix, create parent from pipeline, step guard 409s, advance/retry/cancel status codes).

**T5 — Webview lib + api + canvas components.** Owns `src/mainview/lib/api.ts`, `src/mainview/lib/pipelines.ts` (new), `src/mainview/lib/pipelines.test.ts` (new), `src/mainview/components/pipelines/*` (new: `PipelinesPage.tsx`, `PipelineEditor.tsx`, `StepNode.tsx`, `StepEdge.tsx`, `StepPanel.tsx`, `PipelineRunView.tsx`, `PipelinePicker.tsx`, `PipelineBadge.tsx`, `layout.ts` (dagre)).
- `api.ts`: `listPipelines/getPipeline/createPipeline/updatePipeline/deletePipeline/getPipelineRun/advancePipeline/retryPipeline/cancelPipeline` (`retry:false` on mutations) + `subscribeGlobalEvents` if absent. `lib/pipelines.ts`: `usePipelines()` module cache (mirror `useAgentProfiles`), `toFlowNodes/toFlowEdges` + inverse, `stepVisualState(run, stepId)` → `idle|active|done|blocked|failed`, `edgeVisualState`, pure + tested.
- Editor: React Flow canvas (`colorMode` from `useTheme`), StepNode (handles, name, profile chip via `AgentProfileCard variant="chip"`/deleted warning, start badge), StepEdge (delete via EdgeLabelRenderer, label), "+" on output handle appends a connected step, StepPanel (name, instructions textarea, `AgentProfilePicker` + "New agent…" → `AgentProfileFormDialog` from T6, subagent `MultiSearchSelect` + cap input with "No limit" switch, "After this step" radio (Choose one / Run all in parallel — with the shared-worktree warning), "Start when" radio (Any incoming finishes / All incoming finished), "Connect to…" select, "Set as start", Delete step; StepNode shows fan-out/join glyphs), toolbar (name/description/maxSteps, Auto-arrange, Fit, Save, Back, unsaved guard via `useConfirm`), test ids `pipeline-editor`, `pipeline-canvas`, `pipeline-step-node`, `pipeline-step-panel`, `pipeline-add-step`, `pipeline-save`, `pipeline-back`, `pipeline-connect-select`. Props: `{ pipelineId: string | null; onBack(); onSaved(p) }`.
- PipelinesPage: list (name, steps count, used by N tasks, edit/duplicate/delete with confirm) + New. Props `{ onOpenEditor(id|null); onBack() }`.
- PipelineRunView: read-only canvas from `run.snapshot.graph`, node states, active pulse, traversed edges `animated`, token `animateMotion` on the most recent transition (keyed by `history.length`), side panel (status, step list with outcomes, handoff JSON per record, Blocked banner with Retry / Advance (next-step select + optional purpose) / Open step), header (pipeline name, Back to board, Stop). Props `{ task: Task; steps: Task[]; onOpenTask(t); onBack(); onRefresh() }`. Test ids `pipeline-run-view`, `pipeline-run-node`, `pipeline-run-blocked`, `pipeline-run-advance`, `pipeline-run-retry`, `pipeline-run-back`.
- PipelinePicker (`value`, `onChange`, `pipelines`, `onManage`) + PipelineBadge (`run`) for the card.
- Acceptance: typecheck; lib tests; components render in isolation (no App wiring yet).

**T6 — Agent profile form extraction.** Owns `src/mainview/components/settings/AgentProfilesSection.tsx`, `src/mainview/components/kanban/AgentProfileFormDialog.tsx` (new).
- Extract the create/edit form (name, instructions, SkillsPicker, `<TaskLaunchPickers hideProfilePicker>`) into `AgentProfileFormDialog({ open, profileId: string | null, onClose, onSaved(profile) })`; `AgentProfilesSection` keeps its inline layout by rendering the same inner `AgentProfileForm` component (exported) — behavior byte-identical (same test ids `agent-profile-form`, `agent-profile-save`, …).
- Acceptance: typecheck; `e2e/agent-profiles-settings.spec.ts` still passes (run it).

**T7 — CLI parity.** Owns `src/cli/api-client.ts`, `src/cli/commands/pipeline.ts` (new), `src/cli/commands/pipeline.test.ts` (new), `src/cli/index.ts`, `src/cli/usage.ts`, `src/cli/commands/add.ts`, `src/cli/commands/ls.ts`, `src/cli/commands/show.ts`, `src/cli/tui/Dashboard.tsx`, existing CLI tests they touch (`add.test.ts`, `ls.test.ts`, `show.test.ts`, `usage.test.ts`).
- `agetor pipeline ls|show <ref>|rm <ref>|export <ref> [--out f]|import <file> [--name n]` (`--json`), `agetor add --pipeline <id|name>` (usage error with `--profile`/manual harness flags), `agetor ls --steps`, `show` prints `pipeline:` / `step of:` lines + run status, TUI hides step rows and shows `⛓ pipeline` in the agent column for parents.
- Acceptance: CLI unit tests with a mocked client; existing CLI tests green (`bun test src/cli` — serialize, see memory on load).

Barrier: typecheck + `bun test src/shared src/bun/pipelines.test.ts src/bun/pipelines-endpoint.test.ts src/bun/pipeline-runner.test.ts src/mainview src/cli/commands/pipeline.test.ts`.

### Wave 3 (wiring; 2 tasks, disjoint)

**T8 — App wiring, board, New Task, Settings.** Owns `src/mainview/App.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/lib/settings-dialog-view.ts`, `src/mainview/components/settings/PipelinesSection.tsx` (new), `src/mainview/lib/task-context-menu.ts` (+ its test), `src/mainview/components/kanban/KanbanFilters.tsx` (only if needed).
- `view` state + AnimatePresence swap of `<main>` content; header "Pipelines" button (`Workflow` lucide icon, `data-testid="pipelines-button"`); `onOpen` routes pipeline parents to the run view (stable `useCallback`); board filter hides step rows; `cancel`/`start` on parents call the pipeline routes; context menu gains "Open pipeline" for parents and hides delete/archive for steps; New Task: `PipelinePicker` (one selection with the Agent picker; hides harness block; payload `pipelineId`, never beside `agentProfileId`; "Manage pipelines…" opens the page); TaskCard badge (`PipelineBadge`, `data-testid="task-card-pipeline"`); Settings → Pipelines section (list + "Open editor" which closes Settings and switches view; `SETTINGS_SECTIONS` entry `pipelines`); run view subscribes to `pipeline` global events and refetches; Escape handling per D5.
- Acceptance: typecheck; manual smoke in `bun run dev:hmr`.

**T9 — RunPanel strip.** Owns `src/mainview/components/kanban/RunPanel.tsx`.
- For step tasks: a header strip "Part of pipeline <name> · step <name> (k/N)" with "Open pipeline" (`onOpenPipeline(parentId)` prop, threaded by T8 in the same wave? — no: T9 adds the prop with a default no-op; T8 passes it; both compile independently), hide Delete/Archive affordances for step rows, disable the Agent-row Detach for step rows (frozen).
- Acceptance: typecheck.

Barrier: typecheck + full unit suite.

### Wave 4 (docs; 1 task)

**T10 — Docs.** Owns `CLAUDE.md`, `README.md`.
- CLAUDE.md item 19 (dense paragraph in the house style: model, routes, runner, handoff contract, freeze, cascade, hiding, test seams); README `## Highlights` bullet + `### Pipelines` under Concepts + CLI section lines.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| U1 | unit (shared) | parser/resolver/compose/validate | `src/shared/pipeline.test.ts` (T1 writes; Phase 6 extends edge cases) |
| U2 | db | pipelines module, task columns, aggregation | `src/bun/pipelines.test.ts` (T2) |
| U3 | endpoint | routes matrix | `src/bun/pipelines-endpoint.test.ts` (T4) |
| U4 | orchestrator | runner lifecycle with fake driver | `src/bun/pipeline-runner.test.ts` (T3) |
| U5 | webview lib | flow mapping, visual states | `src/mainview/lib/pipelines.test.ts` (T5), `task-context-menu.test.ts` (T8) |
| U6 | CLI | pipeline command, add --pipeline, ls --steps | `src/cli/commands/pipeline.test.ts`, existing CLI tests (T7) |
| E1 | e2e | editor: open page, add 3 steps, connect (select fallback + one handle drag), assign profile, inline new agent, save, reload persists, delete | `e2e/pipelines-editor.spec.ts` |
| E2 | e2e | run: New Task with Pipeline picker → card badge → click opens run view → fake driver advances 3 steps (nodes/edges states) → blocked on missing handoff → manual advance → review; click node opens RunPanel; Back to board; Settings section link; a fan-out/join pipeline shows two nodes active at once then the join | `e2e/pipelines-run.spec.ts` |

E2e applies (user-visible flows crossing UI→API→runner). Run recipe: `bun node_modules/@playwright/test/cli.js test e2e/pipelines-editor.spec.ts e2e/pipelines-run.spec.ts --reporter=list` (fixtures boot per-worker headless backends with the fake claude driver; one Playwright run at a time on this machine; check `uptime` before blaming load). Phase 6 adds E1/E2 and extends U1/U4; Phase 7 runs `bun run typecheck && bun test` then the two e2e specs plus `e2e/agent-profiles-settings.spec.ts` (T6 regression).

## 6. Execution waves

1. Wave 1: T0 ‖ T1 → typecheck.
2. Wave 2: T2 ‖ T3 ‖ T4 ‖ T5 ‖ T6 ‖ T7 → typecheck + targeted tests. (T3/T4/T5/T7 code against the db/route contracts in §3; the barrier typecheck reconciles.)
3. Wave 3: T8 ‖ T9 → typecheck + full unit suite; commit.
4. Wave 4: T10; commit.
5. Phase 5 review → Phase 6 tests (E1 ‖ E2 ‖ unit extensions) → Phase 7 run → Phase 8 fixes.

File-ownership check: no file appears in two tasks of the same wave (T2 `db.ts` vs T3 `orchestrator.ts`/`pipeline-runner.ts` vs T4 `server.ts` vs T5 `lib/api.ts`+`components/pipelines/*` vs T6 `AgentProfilesSection.tsx`+`AgentProfileFormDialog.tsx` vs T7 `src/cli/*`; T8 vs T9 differ by `RunPanel.tsx`).

## 7. Blast radius & risks

- `orchestrator.ts` and `server.ts` are touched by every feature; `feature/agetor-pipelines` is currently identical to `main` — re-check `git fetch && git log origin/main..` before Phase 4.
- `tasks.list()` now returns step rows: every consumer must filter (board, CLI `ls`, TUI, WorktreesDialog list, `KanbanFilters` counts). Inventory in §9.
- Worktree teardown: a step row must never `git worktree remove` the parent's path — guarded in `deleteTask`/`archiveTask` + `sweepArchivedTeardowns`/`reapIdleSessions` (T3 audits these for `worktreePath` reads on step rows).
- React Flow CSS vs Tailwind base reset (edges hidden) — T0 verifies visually in `dev:hmr`.
- WKWebView + React Flow untested here; e2e runs in chromium. Phase 7 includes a manual smoke in the packaged dev app (`bun run dev`, `~/.agetor-dev`).
- Gemini 4 KB argv cap: handoff inline dropped for gemini steps (D10); `promptByteOverage` still guards.
- Migrations 056/057: if another branch claims those numbers first, renumber with aliases per `migrations/index.ts` comments.
- Rollback: additive columns/table; disabling the feature = hiding the UI; no destructive migration.

## 8. Open questions / assumptions

- A1: The parent task's `agent`/`model` fields are cosmetic (set to the start step's harness) — the parent never spawns.
- A2: Step tasks inherit the parent's `taskType`; the parent's branch naming uses the normal `agetor/<id>-<slug>` scheme (worktree row in New Task stays available for pipeline tasks).
- A3: Follow-up chat to a *finished* pipeline's last step is allowed (normal task); it does not re-open the pipeline.
- A4: `agetor ls` default hides steps; `agetor show <step>` works by id.
- A5: Handoff `next` matching is by step name or edge label, case-insensitive, trimmed; when only one outgoing edge exists `next` is ignored.
- A6: Cycles: the same step may run many times; each execution is a new step task (history keeps them all); cap default 25.

## 9. Completeness ledger

| Remainder | Disposition |
| --- | --- |
| Step rows leaking into board/CLI/TUI/Worktrees list | in this run — T7/T8 (filter `pipelineParentId`) |
| Parent card "waiting on you" glow while a step asks | in this run — T2 aggregation (D11) |
| Context-menu entries for parents/steps | in this run — T8 |
| RunPanel affordances on step rows (delete/archive/detach) | in this run — T9 |
| Deleted profile / deleted pipeline after a run started | in this run — D8 snapshots + editor warning (T5) |
| Boot with a step mid-run (orphan/reattach) | in this run — T3 |
| Gemini prompt cap with a large handoff | in this run — D10 |
| Handoff missing/invalid/unknown next | in this run — D3 + manual advance (T3/T5) |
| Cycle runaway | in this run — cap (D4) |
| Settings → Pipelines section | in this run — T8 (owner asked) |
| CLI parity | in this run — T7 (owner asked) |
| Docs (CLAUDE.md item 19, README) | in this run — T10 |
| Parallel step execution (fan-out/join) | in this run — owner swept it in at the approval gate (D4, T1/T3/T5/E2) |
| Per-branch worktrees + merge at join | out of scope — a merge/conflict feature of its own; parallel steps share one worktree with a warning |
| Per-step model/harness override without a profile | out of scope — steps bind profiles by design ("create through the same agents page") |
| Enforcing the subagent cap server-side | out of scope — owner confirmed prose-only guidance |
| In-app lightbox/diff of handoff artifacts | out of scope — artifacts are listed as paths; existing diff dialog covers file changes |

## 10. Landed notes

Filled in after delivery.
