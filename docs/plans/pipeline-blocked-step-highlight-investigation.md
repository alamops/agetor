# Investigation — pipeline blocked-step highlight + card action opens the step

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Change | (1) In the pipeline run view, a step node that needs the user (asking a question, waiting on an answer, or stopped on an error) gets the same attention highlight the board's task card has. (2) Clicking a pipeline card's action button (e.g. **Answer**) opens the run view **and** that step's details panel in one click. This brief informs what "needs the user" means per state, which step gets opened, and which entry points are in scope. |
| Agents | none (pipeline step forbids subagents) — inline reading, 1 spike with 3 scenarios, 2 web lookups |
| Flags | none |
| Branch | `fix/blocked-step-highlighted-color` (clean, at `c08e5c7`) |

## 1. What we know

### 1.1 The board card's highlight (the reference to match)

- A card is "awaiting" when `pendingInteractionCount > 0 || column === "blocked"` — `src/mainview/components/kanban/TaskCard.tsx:90-92`.
- Awaiting styling is three pieces:
  - a static ring: `ring-2 ring-warning/60 ring-offset-2 ring-offset-background` — `TaskCard.tsx:110`;
  - a pulsing glow: a separate `pointer-events-none absolute inset-0 rounded-[inherit]` overlay with a static `boxShadow: 0 0 14px hsl(var(--warning) / 0.85)` whose **opacity** animates (`animate-awaiting-pulse motion-reduce:animate-none`) — `TaskCard.tsx:361-367`, keyframes at `tailwind.config.js:87-90,112`. The overlay exists on purpose: an opacity animation is compositor-only, and it does not clobber Tailwind's `ring-*` (which is a box-shadow);
  - an amber call-to-action button, label `Answer` / `Answer (N)` / `Review` — `TaskCard.tsx:93-96,296-306`. It uses literal `bg-amber-500 text-amber-950` (pre-existing exception to the "semantic tokens only" UI rule).
- There is no red/danger variant on the card: an error that lands the task in `blocked` (API error, session died, unknown command) is amber + "Review".

### 1.2 The step node today

- Node classes come from one `VISUAL_CLASSES` map keyed by `StepVisualState` — `src/mainview/components/pipelines/StepNode.tsx:35-46`:
  - `active` → `border-info outline outline-2 outline-info animate-pipeline-pulse` (blue pulse);
  - `blocked` → **`border-warning` only** (a 1px amber border, no ring, no glow, no label);
  - `failed` → `border-danger`; `done` → `border-success`; `cancelled`/`idle` → neutral.
- The state is derived by the pure `stepVisualState(run, stepId, steps)` — `src/mainview/lib/pipelines.ts:133-167`. For a step in `run.active` it returns `blocked` only if a `run.blocked` entry names it or the step task's own `column === "blocked"`; otherwise `active`. **It never reads `pendingInteractionCount`.**
- The node already has a precedent for a small state glyph: the "reminder sent" icon — `StepNode.tsx:93-101`.
- The run view is a read-only canvas (`elementsSelectable={false}` — `PipelineRunView.tsx:865`), so the `ring-primary` selection ring (`StepNode.tsx:63`) never shows there; an amber ring would not collide with it. The same `StepNode` is used by the editor, where `visual` is undefined (→ `idle`).
- Per-poll node updates are gated by `nodeVisualSignature` (`PipelineRunView.tsx:492-499`), which hashes active/blocked/history/**column** — not pending-interaction counts. The merge effect (`:519-534`) only replaces a node's `data` when `visual`/`reminded` changed. Any new per-node flag has to be added to both, or it will never repaint.
- The run view refetches on `pipeline` / `column` / `run-status` global events (`PipelineRunView.tsx:389-403`) plus a 2 s poll. `interaction` events are **not** forwarded into that store (`App.tsx:1097-1099`), so a new question shows on the canvas up to 2 s late, while the board card updates instantly (optimistic bump, `App.tsx:1184-1193`). The store itself is kind-agnostic (`src/mainview/lib/pipeline-events.ts`), so forwarding one more kind is a one-line change.

### 1.3 What "blocked" actually is, per state (server side)

- A pending question/permission card does **not** move a task to the `blocked` column. Only three orchestrator paths do: `api-error`, `session-died`, `unknown-command` — `src/bun/orchestrator.ts:2223,2237,2270`.
- The parent card's `pendingInteractionCount` is the sum of its steps' counts — `src/bun/db.ts:826-837` (list) and `:857-862` (single get). Step rows carry their own count in both `GET /tasks` and `GET /tasks/:id/pipeline` (`src/bun/server.ts:4696-4711`).
- The parent's column mirrors run status (`blocked` → `blocked`) — `src/bun/pipeline-runner.ts:264-273`; run status is `blocked` whenever `run.blocked` is non-empty — `src/shared/pipeline.ts:911-916`.
- Block kinds (`src/shared/types.ts:541-548`): `step-failed`, `step-blocked`, `handoff-missing`, `handoff-invalid` carry a `taskId` (a specific execution); `step-cap`, `profile-missing`, `join-incomplete` (and the archived-parent hold) are **run-level**: `taskId: null`, `stepId` set, the step is usually *not* in `run.active`.
- Resulting matrix (rows 1, 3, 4 confirmed by the spike in §2):

| # | Situation | Step task | Run | Node today | Parent card today |
| --- | --- | --- | --- | --- | --- |
| 1 | Question/permission pending **mid-turn** | `running`, pending ≥ 1 | `running`, no block | **`active` — blue pulse** | amber ring + glow, **Answer** |
| 2 | Turn ended with a card still pending (`user-ask`, `pipeline-runner.ts:1909-1929`) | pending ≥ 1 | `blocked` / `step-blocked` "is waiting for you" | `blocked` — thin amber border | amber, **Answer** |
| 3 | API error / session died / unknown command | `blocked` | `blocked` / `step-failed` | `blocked` — thin amber border (never red: it stays in `run.active`) | amber, **Review** |
| 4 | No/invalid handoff after the one reminder; step reported `status: "blocked"` | `review` | `blocked` / `handoff-*` or `step-blocked` | `blocked` — thin amber border | amber, **Review** |
| 5 | Run-level block (step cap, missing profile, incomplete join, archived hold) | none for the pending launch | `blocked`, `taskId: null` | **no highlight at all** (`idle`/`done` from history) | amber, **Review** |

### 1.4 How a pipeline card opens today

- The card body click **and** every open-style button (Answer/Review/Open) call the same `onOpen(task)` — `TaskCard.tsx:115,293,300,312`.
- `onOpen` is App's `openTask`: a pipeline parent goes to `openPipelineRun(t.id)` → `navigate({ kind: "pipeline-run", taskId })` and returns; `selected` (the run panel's task) is **not touched** — `src/mainview/App.tsx:390-392,405-414`. So today the click lands on the canvas with no panel (or with a stale panel still showing a different task).
- The run view opens a step's panel via `onOpenTask(stepTask)` → `setSelected(t)` — `App.tsx:2278-2286`; used by node click (`PipelineRunView.tsx:636-652`) and the blocked banner's "Open step" (`:958`). The single `RunPanel` is a right-anchored `fixed` slide-over, default 720 px, `z-40`, above the page views — `RunPanel.tsx:521-527`, `src/mainview/lib/panel-width.ts`.
- There is an existing one-shot "land on X after open" pattern to copy: `focusSubagent: { taskId, id, nonce, consumed }` owned by App — `App.tsx:233-246,2281`.
- App already has everything needed to resolve the step **without a fetch**: `tasks` state includes the hidden step rows (they're filtered out only for rendering, `App.tsx:1346,1361`), and the list route's trimmed `pipelineRun` keeps `active` and `blocked` intact (only handoff bodies and snapshot profiles are stripped — `server.ts:677-688`).
- `stepTaskFor(steps, run, stepId)` (`lib/pipelines.ts:726-741`) resolves a step's current task; nothing yet resolves "the step that needs attention".

### 1.5 Other places that open a pipeline parent (same routing, same gap)

| Entry point | Code | Knows the exact step? |
| --- | --- | --- |
| Card body click | `TaskCard.tsx:115` → `openTask` | no (parent only) |
| Card Answer / Review / Open button | `TaskCard.tsx:293-314` → `openTask` | no |
| Context menu "Open pipeline" | `task-context-menu.ts:98-99`, `App.tsx:1813-1815` | no |
| "Waiting on you" toast for a step (retargeted at the parent) | `App.tsx:1146-1162` → `openPipelineRun(stepParentId)` | **yes** — `ev.taskId` is the step task |
| "Pipeline needs you" toast (parent `blocked`) | `App.tsx:1309-1317` → `openTask` | no |
| OS notification deep link `open_task` | `App.tsx:982-1013` → `openTask` (carries the parent id, `toasts.ts:47`) | no |
| Worktrees dialog row | `App.tsx:2356-2361` → `openTask` | no |
| RunPanel strip "Open pipeline" (already on a step) | `RunPanel.tsx:3698-3704` — closes the panel first, on purpose | n/a |

### 1.6 Library / platform facts

- `@xyflow/react` is pinned `^12.11`, installed 12.11.6. Its `.react-flow__node` wrapper sets no `overflow` and no box-shadow for custom node types (`node_modules/@xyflow/react/dist/style.css:215-224,454-468`), so a glow painted outside the node box is not clipped by the node; only the canvas root clips, at the viewport edge.
- Tokens: `--warning` exists in both themes (`src/mainview/index.css:68` light = amber-800; dark differs), and React Flow's background maps to `--background` (`index.css:238-249`), so `ring-offset-background` matches the canvas.
- Accessibility: status must not be conveyed by color alone (WCAG 1.4.1), and an infinite pulse should respect reduced motion — the card already does via `motion-reduce:animate-none`. The node's existing blue pulse does not.

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| While a step is asking the user mid-turn, does the canvas node show it? | **No** — the parent card would show "Answer + amber ring/glow", the node reads `active` (blue "working" pulse). | `SCENARIO=ask bun spike.ts` → `parent.column: "running"`, `pendingInteractionCount_list: 1`, `stepA.column: "running"`, `stepA.pendingInteractionCount: 1`, `blocked: []`, `nodeVisual_A: "active"`, `cardWouldShow: "Answer + amber ring/glow"` | bun 1.3.10, branch at `c08e5c7`, fake claude driver | `<scratchpad>/spikes/step-attention-state/spike.ts` |
| Can existing fake-driver seams put a pipeline step into "asking the user" for an e2e test, with no new test hook? | **Yes** — `__agetor_fake_fx_permission__` in a step's instructions (claude fake profile, default mode) registers a real pending card on the step, aggregated to the parent; answering it resumes the turn. | same run → `interaction kind: fx_permission`; after `answerFxPermission(allow-once)` the turn ends, gets one reminder, then `blocked: [{ kind: "handoff-missing", hasTaskId: true }]`, `nodeVisual_A: "blocked"`, card "Review" | same | same |
| What does an errored step look like? | Run `blocked` with a task-level `step-failed` block; step column `blocked`; node `blocked` (thin amber border), **never** `failed`/red; card "Review + amber". | `SCENARIO=api-error` and `SCENARIO=session-died` → `blocked: [{ kind: "step-failed", message: "step \"A\" failed — api error: HTTP 529 …" }]`, `stepA.column: "blocked"`, `historyOutcomes: ["failed/error"]`, `nodeVisual_A: "blocked"` | same; env seams `AGETOR_FAKE_CLAUDE_API_ERROR=1` / `AGETOR_FAKE_CLAUDE_SESSION_DIED=1` | same |
| Baseline of the unit suites this change will extend | Green | `bun test src/mainview/lib/pipelines.test.ts src/mainview/lib/task-context-menu.test.ts` → `110 pass, 0 fail` | bun 1.3.10 | — |

Not spiked (and why): "would the existing tests notice a naive change?" — settled by reading instead: no unit or e2e test asserts the node's classes, the `blocked` node visual, or what a pipeline card's Answer button opens (`e2e/pipelines-run.spec.ts` only asserts `data-visual` `active`/`done`/`idle`/`working`; `grep` for `Answer`/`ring-warning` in `e2e/` finds nothing). So a green run today proves nothing about either behavior — the plan must add coverage.

## 3. What we're assuming

- **"Highlight similar to the card" = the card's amber ring + pulsing glow**, for all three named cases (asking, waiting, error), since the card itself is amber for errors too. If the owner wants errors red on the canvas, the node needs a second tone and the `blocked` visual has to split by block kind.
- **The step to open is the one that needs attention**: first active execution with a pending interaction; else the first `run.blocked` entry that has a `taskId`; else none (open the run view only). If the owner wants a different rule for fan-out with several waiting steps, the resolver changes, not the plumbing.
- **Resolving the step from App's already-polled `tasks` list is enough**, with "open the run view only" as the fallback when the step row has not been polled in yet (≤ 2 s after it was created). If that gap matters, the alternative is a one-shot focus request the run view honours after its own fetch (the `focusSubagent` pattern).
- **Webview-only change.** No server, DB, CLI or TUI change is required: every field needed is already on the wire. (The TUI already answers a parent's step cards via `g`.)
- **The editor canvas is unaffected** — it never passes `visual`, so new attention styling keyed on run state cannot appear there.

## 4. What we must ask the owner

1. **Which states get the card-style highlight?** Rows 1–4 of the matrix clearly match the request. Row 5 (run-level blocks: step cap, missing profile, incomplete join) currently shows **no** highlighted node even though the card glows. Include it (highlight the step the run is stuck at) or leave it to the side-panel banner?
2. **One amber look for everything, or errors in red?** The card uses amber for both "answer me" and "something failed". Matching the card means amber for errors too; a red variant would be new visual language the card doesn't have.
3. **Should the node say what it needs, not just glow?** e.g. a small `Answer (N)` / `Needs review` chip or icon on the node. Recommended for accessibility (color is otherwise the only cue), and it mirrors the card's button label — but it changes node height/layout slightly.
4. **Does the card body click also open the step, or only the action button?** Today both do the same thing. The request names the button. Splitting them needs a new callback threaded through `Column` (its hand-written memo comparator must be updated too).
5. **Which button states open a step?** `Answer` and `Review` have an obvious target. `Open` (pipeline done/cancelled/idle) does not — keep it opening the run view only?
6. **Fan-out: several steps waiting at once** (`Answer (2)`). Open the first waiting step (recommended; the others stay highlighted on the canvas behind the panel), or something else?
7. **Other entry points** (table in §1.5): should the "Waiting on you" toast, the "Pipeline needs you" toast, the OS-notification click, and the context menu's "Open pipeline" also land on the step panel? The toast already knows the exact step. Recommended: yes for the toasts and the notification (same intent as the Answer button); context menu keeps "Open pipeline" as is, optionally gaining an "Answer" entry.
8. **Instant canvas update on a new question?** Forwarding `interaction` events to the run view makes the highlight appear immediately instead of on the next 2 s poll. Cheap; in or out?

## 5. Completeness inventory

- **Callers of what changes**
  - `stepVisualState` — `PipelineRunView.tsx:525` (only production caller); tests `src/mainview/lib/pipelines.test.ts:117-190`.
  - `StepNode` `data.visual` / `VISUAL_CLASSES` — `StepNode.tsx:35-46,62`; set in `PipelineRunView.tsx:519-534`; the editor (`PipelineEditor.tsx`) renders the same component without `visual`.
  - `nodeVisualSignature` — `PipelineRunView.tsx:492-499`; also a dependency of the satellites memo (`:599`).
  - `openTask` — `App.tsx:405-414`; callers `App.tsx:997,1006,1130,2180,2360`.
  - `openPipelineRun` — `App.tsx:390-392`; callers `:407,1157,1814,2320`.
  - `TaskCard.onOpen` — `TaskCard.tsx:115,293,300,312`; threaded by `Column.tsx:49,77`, compared in `Column.tsx:112`.
  - `PipelineRunView.onOpenTask` — `App.tsx:2280-2283`; internal callers `PipelineRunView.tsx:646,887,895,958,1014`.
  - `publishPipelineGlobalEvent` gate — `App.tsx:1097-1099`; subscribers `PipelineRunView.tsx:390-401`, `RunPanel.tsx:~2752`.
- **Propagation surface**
  - Types: `StepVisualState` (`lib/pipelines.ts:117`), `StepNodeData` (`StepNode.tsx:18-31`), `AppView` (`App.tsx:194-197`) if the focus intent rides on the view, `TaskMenuAction` (`task-context-menu.ts:10-28`) + `App.tsx`'s exhaustive `runTaskMenuAction` switch and icon map (`:165`, `:1806-1887`) if a menu entry is added.
  - Styling: `tailwind.config.js` keyframes (reuse `awaiting-pulse`; no new token needed). Any new token must land in both `index.css` and `tailwind.config.js`.
  - Test ids / attributes specs key on: `pipeline-step-node` + `data-visual`, `task-card-pipeline`, `pipeline-run-view`, `pipeline-run-open-step`, `run-panel-pipeline-strip`.
  - Parent-keyed toast cleanup: opening a step panel calls `dismissPending(selected.id)` with the **step** id (`App.tsx:798-801`), but the retargeted toast is keyed on the **parent** id — it would stay up over the panel unless the parent id is dismissed too.
- **Existing data to backfill:** none — no schema, no persisted shape changes.
- **Docs / config that describe current behavior:** `CLAUDE.md` item 19 (run view node visuals, card button precedence, toast retargeting) and item 9 (context menu mirrors the card); `docs/plans/pipelines.md` (D5/D7/D9/D11, line 199 lists the visual states).
- **Would be orphaned:** nothing identified.

## 6. Runnability

- **Setup:** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`; dependencies are now installed in this worktree (`bun install --frozen-lockfile`, lockfile untouched).
- **Start locally:** `bun run dev:hmr` (Vite + Electrobun, data dir `~/.agetor-dev`).
- **Unit:** `bun test src/mainview/lib/pipelines.test.ts src/mainview/lib/task-context-menu.test.ts`; `bun run typecheck`.
- **E2E:** Playwright, `bun node_modules/@playwright/test/cli.js test e2e/pipelines-run.spec.ts` (one Playwright run at a time). Fixtures: `freshBackend` + `test.use({ backendEnv })` (`e2e/fixtures.ts:490-539`); pipeline helpers in `e2e/pipelines-run.spec.ts:64-229`.
- **Seams for the new scenarios (all pre-existing):**
  - asking the user: step instructions containing `__agetor_fake_fx_permission__` (and no handoff marker in the goal) — proven in §2;
  - error: `backendEnv: { AGETOR_FAKE_CLAUDE_API_ERROR: "1" }` or `AGETOR_FAKE_CLAUDE_SESSION_DIED: "1"` (process-wide — every step errors);
  - blocked on handoff: `__agetor_fake_claude_handoff__:missing` (already used at `e2e/pipelines-run.spec.ts:531`).
- No jsdom in the repo: component behavior is covered by pure-function unit tests plus Playwright.

## 7. Risks & blast radius

- **React Flow re-measure / update-depth loop.** The run view has a documented history of a "Maximum update depth exceeded" crash from identity churn (`PipelineRunView.tsx:228-251`). Any new per-node value must go through the content signature and the identity-stable merge, never a fresh object per render.
- **Animation choice.** Animating `box-shadow`/`filter` on the node would clobber `ring-*` and cost CPU every frame (the reason the card uses an opacity overlay and the node's blue pulse uses `outline`). Reuse the overlay technique.
- **Memoized board.** `Column` uses a hand-written comparator listing every prop (`Column.tsx:105-121`); a new callback prop that isn't added there silently goes stale. New App callbacks must be `useCallback`-stable or every card re-renders on each poll.
- **Navigation guard.** Every view change must go through `navigate` (unsaved-pipeline-editor confirm, `App.tsx:366-382`). If the user cancels that confirm, the step panel must not open on top of the editor.
- **Panel over the run view.** The panel covers the run view's right-hand blocked banner and part of the canvas (default 720 px); Escape closes the panel first, then returns to the board (`App.tsx:940-956`). Same as a node click today, but now it happens on arrival.
- **Stale target.** The step may settle between render and click (question answered elsewhere, run advanced). The resolver must read live state at click time and degrade to "run view only".
- **Step task deleted/restarted.** A Restart replaces every step row; the vanish-sync effect (`App.tsx:765-783`) closes a panel whose task disappears — unchanged, but the new entry path leans on it.
- **Peers:** no other active agent is touching these files (fleet check at session start).
