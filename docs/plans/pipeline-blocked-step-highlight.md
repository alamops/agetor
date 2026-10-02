# Plan — Pipeline step attention highlight + card action opens the step

| Field | Value |
| --- | --- |
| Date | 2026-10-01 |
| Source | Pipeline goal (step 3 "Planning" of "My Implementation Pipeline") + `docs/plans/pipeline-blocked-step-highlight-investigation.md` + `docs/plans/pipeline-blocked-step-highlight-grill.md` (D1–D21) |
| Flags | none |
| Gates | grilled + approved by owner (grill D1–D21; plan approved at the end of the Planning step, including §8 items 2 and 5) |
| Branch | `fix/blocked-step-highlighted-color` (already cut, at `c08e5c7`) |
| Base SHA | `c08e5c7` |

## 1. Objective & success criteria

**Objective.** In the pipeline run view, a step that needs the user carries the board card's amber attention look and says what it needs. From the board, a pipeline card's amber action button (and the matching toasts / notification click) lands on the run view **and** that step's details panel in one click.

**Done when:**

1. A step node shows the amber ring + pulsing glow + a label chip in all five situations (grill D1): asking mid-turn, a question still pending after the turn, error, missing/invalid/blocked handoff, and a run-level block (highlighted on the node named by `block.stepId`).
2. The chip reads `Answer`, `Answer (N)` or `Review` by the card's own rule, with the block message as its tooltip (D5).
3. A node asking mid-turn is amber, not blue (D4). Both pulses stop under reduced motion (D3, D7).
4. A new question repaints the canvas on the `interaction` event, not on the next 2 s poll (D8).
5. The card's amber button, the "Waiting on you" toast, the "Pipeline needs you" toast and the OS-notification click open the run view plus the step's panel. Card body, context menu "Open pipeline", Worktrees row and the non-attention Open button stay run-view-only (D9, D10, D12).
6. Run-view-only landings close a leftover panel (D14); a step landing dismisses the parent-keyed toast (D15); a cancelled discard-confirm opens nothing (D16).
7. Unit tests, the new Playwright scenarios, `bun run typecheck`, and the existing unit + pipeline e2e suites are green (D20).
8. `CLAUDE.md` item 19 and `docs/plans/pipelines.md` describe the new behavior (D21).

**Not changing** (D19): the editor canvas, TUI/CLI, node click, the run view's "Open step" button, the context menu, the board card's own look, and anything server-side. *Review fix (re-review of `5a5afad`, landed in `d78159d`): node click did change — a glowing node now opens the execution that needs the user (`stepNodeTaskFor`), not just the latest one, because `stepAttention` counts every execution of the step and a cycle could otherwise open a sibling with nothing to answer. This departs from D19 as grilled; flagged to the owner.*

## 2. Context & constraints

Anchors are at `c08e5c7`.

**The card's look (the reference).**
- Awaiting rule and label: `src/mainview/components/kanban/TaskCard.tsx:90-96`.
- Ring: `ring-2 ring-warning/60 ring-offset-2 ring-offset-background` — `TaskCard.tsx:110`.
- Glow: a `pointer-events-none absolute inset-0 rounded-[inherit]` overlay with a static box-shadow whose opacity pulses — `TaskCard.tsx:361-367`; keyframes `tailwind.config.js:87-90,112`.
- Body click and every open-style button call the same `onOpen(task)` — `TaskCard.tsx:115,293,300,312`.

**The node today.**
- `VISUAL_CLASSES` — `src/mainview/components/pipelines/StepNode.tsx:35-46`. `blocked` is a 1px `border-warning`; `active` is the blue outline pulse with no reduced-motion guard.
- The node root is already `relative … rounded-lg` (`StepNode.tsx:61`), so the overlay technique drops in. The title row (`StepNode.tsx:73-102`) already hosts the Start badge and glyphs.
- `stepVisualState` — `src/mainview/lib/pipelines.ts:133-167`. It never reads `pendingInteractionCount`, and returns history-derived state for a step that is not in `run.active`.
- `StepNode` is shared with the editor, which never sets run-derived data (`PipelineEditor.tsx:53`).

**Run view repaint rules.**
- `nodeVisualSignature` — `PipelineRunView.tsx:492-499`; identity-stable merge — `:519-534`. Both must carry any new per-node value or it never repaints. The class doc (`:228-251`) records the "Maximum update depth exceeded" crash that identity churn caused.
- Event subscription handles `pipeline` / `column` / `run-status` only — `PipelineRunView.tsx:389-403`. App's forward gate — `App.tsx:1097-1099`. The store is kind-agnostic (`src/mainview/lib/pipeline-events.ts`); RunPanel's subscriber narrows on `pipeline` (`RunPanel.tsx:2751-2753`), so one more kind is harmless there.

**How things open today.**
- `navigate` — `App.tsx:366-382` (confirm-guarded `setView`). `openPipelineRun` — `:390-392`. `openTask` — `:405-414`; a pipeline parent goes to the run view and `selected` is not touched.
- Run view opens a step panel via `setSelected(t)` — `App.tsx:2280-2283`.
- Retargeted step toast builds `target` with `onOpen → openPipelineRun(stepParentId)` — `App.tsx:1146-1162`. The same `target` also feeds `files-sent` (`:1237`) and `fx-auto-resume` (`:1255-1257`).
- "Pipeline needs you" toast — `App.tsx:1309-1317`.
- `open_task` deep link — `App.tsx:982-1013`. The link is `agetor://task/<id>` and carries only the task id (`src/bun/deep-link.ts`, `toasts.ts:47`), always the parent id for a pipeline.
- Panel-open toast dismissal is keyed on the selected (step) id — `App.tsx:798-801`; retargeted toasts are keyed on the parent.
- `Column` threads `onOpen` and has a hand-written memo comparator — `Column.tsx:49,77,105-121`. `App.tsx:2171-2188` is its only caller; `Column.tsx:70` is `TaskCard`'s only caller.
- RunPanel unmounts once closed (`RunPanel.tsx` returns `null` when no task is mounted), so `run-panel-resize` having count 0 is a reliable "no panel" check in e2e.

**Data already on the wire** (no server change).
- App's `tasks` state holds hidden step rows with their own `pendingInteractionCount`, `pipelineParentId`, `pipelineStepId`; the list route's trimmed `pipelineRun` keeps `active`, `blocked` and `history[].taskId` (`server.ts:677-688`).
- `interaction` events already bump the step row and the parent optimistically (`App.tsx:1184-1193`).
- `run.active` order is launch order (`pipeline-runner.ts:776`, `:2009`).
- The runner does not cancel pending interactions when a step settles (only Restart does, `pipeline-runner.ts:1164`), so a leftover card on a settled step is reachable.

**Spike verdicts** (investigation §2, bun 1.3.10, fake claude driver):
- Mid-turn ask leaves the node `active` while the card shows Answer. Proven.
- `__agetor_fake_fx_permission__` in a step's instructions registers a real pending card on the step, with no new test hook. Proven.
- `AGETOR_FAKE_CLAUDE_API_ERROR=1` gives run `blocked` / `step-failed`, step column `blocked`. Proven.
- Baseline `bun test src/mainview/lib/pipelines.test.ts src/mainview/lib/task-context-menu.test.ts`: 110 pass.

**Constraints.**
- Semantic tokens only for new UI (`warning`); no new token, no `box-shadow`/`filter` keyframes on the node.
- New App callbacks handed to `Column` must be `useCallback`-stable and listed in its comparator.
- Every view change goes through `navigate`.
- One Playwright run at a time; e2e uses `freshBackend` and existing fake-driver seams only.
- A peer agent is implementing agents/pipelines import-export on another branch (`src/shared/bundle*`, `src/bun/server.ts`, `src/cli/commands/pipeline.ts`, `src/mainview/components/bundle`). No file here overlaps its declared paths; `App.tsx` is the likely merge-conflict spot if it wires a dialog there.

## 3. Approach & key decisions

### 3.1 Separate "attention" from the lifecycle visual (reasoning)

`stepVisualState` stays as is. A new pure `stepAttention(run, stepId, steps)` returns what the step needs, or `null`. The node keeps `data-visual` and gains `data-attention`.

Why not a new `StepVisualState` member: a run-level block must highlight a node whose lifecycle state is `idle` or `done`, and the node also needs a label and a tooltip. One enum can't carry that. Keeping `data-visual` untouched also keeps every existing e2e assertion valid.

### 3.2 One source for the card's look and label (reasoning)

The ring classes, the glow overlay and the label rule move into two tiny shared modules that both `TaskCard` and `StepNode` use. "Same as the card" is then enforced by construction. The card renders byte-identical classes; only where they are defined changes.

Rejected: copying the classes into `StepNode`. It works today and drifts the first time either side is touched.

### 3.3 Pinned interfaces (wave-1 contracts that wave 2 codes against)

```ts
// src/mainview/lib/awaiting.ts  (new)
/** Card rule: >1 → `Answer (N)`, 1 → "Answer", else "Review". */
export function awaitingLabel(pendingCount: number): string;
export const AWAITING_RING_CLASS = "ring-2 ring-warning/60 ring-offset-2 ring-offset-background";

// src/mainview/components/ui/awaiting-glow.tsx  (new)
/** The opacity-pulsed glow overlay, exactly TaskCard.tsx:361-367. Parent must be `relative`. */
export function AwaitingGlow(): JSX.Element;

// src/mainview/lib/pipelines.ts  (additions)
export interface StepAttention {
  kind: "answer" | "review";
  label: string;            // awaitingLabel(pending) for "answer", "Review" for "review"
  message: string | null;   // the matching block's message, if any
}
export function stepAttention(
  run: PipelineRunState | null | undefined, stepId: string, steps: Task[],
): StepAttention | null;
export function sameStepAttention(
  a: StepAttention | null | undefined, b: StepAttention | null | undefined,
): boolean;
export function pipelineAttentionStepTask(
  parent: Task, tasks: readonly Task[], preferredStepTaskId?: string | null,
): Task | null;

// StepNodeData (StepNode.tsx) gains:
attention?: StepAttention | null;

// Column / TaskCard props gain (required):
onOpenAttention: (t: Task) => void;
```

### 3.4 `stepAttention` rules

1. No run → `null`.
2. Candidate tasks: every `run.active` entry with this `stepId`, plus the task of every `run.history` record for this step (deduped). *Review fix: originally only the latest history record when nothing was active, which disagreed with resolver tier 4 (now tier 2) in a cycle — the card read Answer and opened a step while no node glowed.*
3. `pending` = sum of `pendingInteractionCount` over the candidate rows found in `steps`.
4. `block` = first `run.blocked` entry where `b.stepId === stepId`, or `b.taskId` is one of the step's active task ids.
5. `columnBlocked` = any active candidate row with `column === "blocked"`.
6. `pending > 0` → `{ kind: "answer", label: awaitingLabel(pending), message: block?.message ?? null }`.
7. Else `block || columnBlocked` → `{ kind: "review", label: "Review", message: block?.message ?? null }`.
8. Else `null`.

This covers grill rows 1–5, gives `null` for the `reviewActive`-without-block case (D18), and reads `Review` for row 2 once the count has dropped (grill assumption).

### 3.5 `pipelineAttentionStepTask` rules (the "which step" resolver)

With `preferredStepTaskId` (the toast names the step, D12): return that row if it is in `tasks`, its `pipelineParentId` is `parent.id`, and it still needs the user (pending > 0, `column === "blocked"`, or a `run.blocked` entry with its `taskId`). Otherwise fall through to the tiers. *Review fix: originally no fallback, so the parent-keyed toast stayed pinned to its first asker after that step was answered while another step's question was open. D13's "no longer needs you → run view only" still holds when no tier matches.*

Without it, over `parent.pipelineRun` (`null` run → `null`):

1. First `run.active` entry, in array order, whose row has `pendingInteractionCount > 0` (D11).
2. Latest `run.history` record (scanning from the end) whose row has `pendingInteractionCount > 0`.
3. First `run.blocked` entry with a non-null `taskId` whose row is in `tasks` (D11).
4. First `run.active` entry whose row has `column === "blocked"`.
5. `null` → run view only (D10 row 5, D13).

Tiers 2 and 4 are planner additions; see §8. *Review fix (third review): the leftover-question tier was originally 4th, after the block tiers. Within one step that has a finished execution still asking plus a blocked re-run, the card's Answer then opened the blocked execution (nothing to answer) while the node opened the asking one. A question now outranks every block, matching `stepNodeTaskFor` and §8 item 2's intent that Answer opens the row that asks.*

### 3.6 Node rendering

- Classes: `attention ? cn("border-warning", AWAITING_RING_CLASS) : VISUAL_CLASSES[visual]`. Attention replaces the blue pulse (D4).
- `data-attention={attention?.kind}`.
- Chip in the title row, after the existing glyphs: `data-testid="pipeline-step-attention"`, `bg-warning/15 text-warning`, same size classes as the Start badge, a `MessageCircleQuestion` icon and `attention.label`. `title` is the block message, else "Waiting for your answer" / "Needs your review". Not interactive.
- `<AwaitingGlow />` as the node's last child while `attention` is set.
- `VISUAL_CLASSES.active` gains `motion-reduce:animate-none` (D7).
- Node height is unchanged, so `LAYOUT_NODE_HEIGHT` stays.

### 3.7 App navigation

- `navigate(next, onNavigated?)`: calls `onNavigated` right after `setView(next)` in both branches. A cancelled confirm calls nothing (D16).
- `openPipelineRun(taskId)`: passes `() => { setFocusSubagent(null); setSelected(null); }`. Every run-view-only landing closes a leftover panel (D14).
- New `openPipelineAttention(parentId, opts?: { stepTaskId?: string; tasks?: readonly Task[] })`. Inside the `onNavigated` callback it reads `opts.tasks ?? tasksRef.current`, resolves the step with §3.5, then `setFocusSubagent(null)`, `setSelected(step)` (`null` closes a leftover panel), and `dismissPending(parentId)` when a step was found (D15).
- New `openAttention(t)`: `t.pipelineId ? openPipelineAttention(t.id) : openTask(t)`. Passed to `Column` as `onOpenAttention`.

Rejected: a deferred "open after the run view loads" request (the `focusSubagent` pattern). D13 settled on resolving from already-polled state with run-view-only as the fallback.

### 3.8 OS-notification click

The deep link carries only the parent id, so the click can't tell which notification was clicked. Every `open_task` for a pipeline parent goes through `openPipelineAttention` with no preferred step. A "finished" notification finds nothing that needs the user and lands on the run view only.

Rejected: adding the kind or step id to the deep link. That changes `notifyOS`, the URL scheme and the main process, and the grill fixed this change as webview-only.

Accepted edge: a "files sent" notification clicked while another step is waiting lands on the waiting step.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Shared awaiting primitives | `src/mainview/lib/awaiting.ts` (new), `src/mainview/components/ui/awaiting-glow.tsx` (new) | — | Exports match §3.3. `AwaitingGlow` renders the exact span from `TaskCard.tsx:361-367` (`aria-hidden`, same classes, same inline `boxShadow`). Typecheck green. |
| T2 | Attention derivation + resolver | `src/mainview/lib/pipelines.ts` | T1 (interface only) | `stepAttention`, `sameStepAttention`, `pipelineAttentionStepTask` exported per §3.3–3.5 with doc comments in the file's style. `stepVisualState` unchanged. Pure, no React. |
| T3 | Node attention look | `src/mainview/components/pipelines/StepNode.tsx` | T1, T2 | Per §3.6. With `attention` unset the node renders exactly as before except the `motion-reduce:animate-none` class on `active`. Editor canvas unaffected. |
| T4 | Run view carries attention and reacts to questions | `src/mainview/components/pipelines/PipelineRunView.tsx`, `src/mainview/lib/pipeline-events.ts` (doc comment only) | T2 | `nodeVisualSignature` adds `kind` + `message` per blocked entry and `pendingInteractionCount` per step row. The merge effect computes `stepAttention`, compares with `sameStepAttention`, writes `data.attention`, and still returns the same array when nothing changed. The subscriber reloads on an `interaction` event whose `taskId` is a known step or whose `pipelineParentId` is this run's task. Comments at `:381-388` and the store's header name the fourth kind. No update-depth error on an edge-bearing pipeline. |
| T5 | Card button gets its own callback; card uses the shared primitives | `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/Column.tsx` | T1 | The amber awaiting button calls `onOpenAttention(task)`; body click, archived Open and plain Open still call `onOpen`. `Column` threads the prop and compares it in the memo comparator. Card uses `awaitingLabel`, `AWAITING_RING_CLASS`, `<AwaitingGlow />` and its rendered classes are unchanged. |
| T6 | App wiring | `src/mainview/App.tsx` | T2, T5 | Per §3.7–3.8: `navigate` callback; `openPipelineRun` closes the panel; `openPipelineAttention`; `openAttention` passed as `onOpenAttention`; `interaction` added to the forward gate at `:1097`; the retargeted `interaction` toast opens `openPipelineAttention(stepParentId, { stepTaskId: ev.taskId })` while `files-sent` / `fx-auto-resume` keep `target.onOpen`; the "Pipeline needs you" toast opens `openPipelineAttention(ev.taskId)`; both `open_task` branches route a pipeline parent through `openPipelineAttention` (the fresh-fetch branch passes `{ tasks: list }`). All new callbacks are `useCallback`-stable and listed in the two effects' dependency arrays. `openPipelineRun`, `openTask`, `navigate` keep stable identities. |
| T7 | Docs | `CLAUDE.md`, `docs/plans/pipelines.md` | T3–T6 | Item 19 gains: node attention look and chip, `data-attention`, the amber-over-blue rule, which paths open the step and which stay run-view-only, the resolver tiers, `interaction` forwarding, the leftover-panel and toast-dismissal rules, the notification-click limitation. `pipelines.md` gets an "as landed" note next to the visual-states line (~199) and the open paths (D5/D7). Item 9 untouched. |

Notes for T6:
- `tasksRef` is declared at `App.tsx:882`, after the early callbacks at `:366-414`. Reading it inside a callback body is fine; don't read it during render above its declaration.
- Keep the generic `onOpen` (`:1125-1137`) as is. It serves ordinary tasks and the "Pipeline finished" toast, which stays run-view-only.
- The existing `dismissPending(selected.id)` effect (`:798-801`) stays as is; the parent-keyed dismissal lives in `openPipelineAttention` only (D15 scopes it to attention paths). *Review fix (`d78159d`): the effect now also dismisses `selected.pipelineParentId`'s toast when the opened step itself has a pending question, so opening an asking step from its node (or a step-named toast) clears the parent-keyed toast that would otherwise sit over the panel answering it.*

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U1 | unit | T1 | `src/mainview/lib/awaiting.test.ts` (new) | `awaitingLabel`: 0 and negative → `Review`, 1 → `Answer`, 2+ → `Answer (N)`. |
| U2 | unit | T2 | `src/mainview/lib/pipelines.test.ts` | `stepAttention`: rows 1–5; mid-turn ask returns `answer` while `stepVisualState` still returns `active`; row 5 on a step not in `run.active`; row 4 `step-blocked`; `reviewActive` without a block → `null`; two pending → `Answer (2)`; block message carried; a block naming another step doesn't leak; leftover pending on a settled step → `answer`; no run → `null`. `sameStepAttention`: null/undefined equal, field differences detected. `pipelineAttentionStepTask`: question beats block; launch order within tier 1; block tier skips a row missing from the list; run-level-only blocks → `null`; column-blocked tier; leftover-pending tier; preferred id hit, miss, and wrong parent; parent without a run → `null`. Existing tests untouched and green. |
| E1 | e2e | T3–T6 | `e2e/pipelines-run.spec.ts` (new `describe` blocks appended) | Scenarios below pass; the existing tests in the file still pass. |

**E2e: applies.** The change is a user-visible flow across webview → API → orchestrator. Scenarios (all `freshBackend`, existing seams, helpers already in the file). Toasts are live-only, so scenarios 1, 4 and 6 must load the board (`gotoApp`) **before** starting the task over REST:

1. **Mid-turn question** (`backendEnv`: resolve delay only). Pipeline A→B; A's instructions contain `__agetor_fake_fx_permission__`; the goal has no handoff marker. Wait for the parent's `pendingInteractionCount` to reach 1. On the board the card shows the amber `Answer` button. Click it: `pipeline-run-view` is visible, the panel's `run-panel-pipeline-strip` names step A, node A has `data-attention="answer"` and a `pipeline-step-attention` chip reading `Answer`, and no "Waiting on you" toast remains.
2. **Card body stays run-view-only.** Same setup. Click the card title: run view visible, `run-panel-resize` count 0, node A still `data-attention="answer"`.
3. **Leftover panel closes.** Same setup, viewport widened (e.g. 2200 px) so the board card isn't under the panel. Open the run view, click node A (panel opens), "Back to board", click the card title: run view visible and `run-panel-resize` count 0.
   - *As executed:* not reachable as written — an open run panel's full-screen backdrop (`Close task panel`, z-30) intercepts "Back to board" and every board click. The scenario instead opens another (plain) task's panel and clicks the "Pipeline finished" toast's Open (a run-view-only landing, and clickable above the backdrop): run view visible, `run-panel-resize` count 0 — the D14 "leftover panel from another task" case.
   - *As executed, all attention clicks:* the landing resolves from App's already-polled list with no fetch (D13), so a click inside the 2 s poll after a step was created lands on the run view only, by design. Scenarios therefore wait for a `GET /tasks` response that carries the step row (`waitForPolledStep`) before clicking. The asking scenarios also set `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS=3000` so the fake question lands after the runner's post-launch `persist` (see the ledger row on the pre-existing toast gap).
4. **Toast opens the named step.** Same setup, staying on the board. Click the "Waiting on you" toast's `Open` action: run view plus step A's panel.
5. **Error** (own `describe`; `backendEnv` must list both `AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS` and `AGETOR_FAKE_CLAUDE_API_ERROR: "1"`, because a nested `test.use` replaces the object). Single-step pipeline. Wait for parent column `blocked`. Card shows `Review`; click it: run view plus step A's panel, node A `data-attention="review"`, chip `Review`.
6. **Missing handoff.** Goal carries `__agetor_fake_claude_handoff__:missing`; wait with `REMINDER_TIMEOUT` for `handoff-missing`. Click the "Pipeline needs you" toast's `Open`: run view plus step A's panel, node A `data-attention="review"`, chip `Review` whose `title` contains the block message.
7. **Run-level block.** A→B with `maxSteps = 1` and a `:done` goal marker (A's single outgoing edge is taken unconditionally; launching B hits `run.stepCount >= cap`, `pipeline-runner.ts:624-633`). Wait for a `step-cap` block. Click the card's `Review`: run view visible, `run-panel-resize` count 0, node B `data-attention="review"`, node A has no `data-attention`.

**Run recipe.**

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun run typecheck
bun test src/mainview/lib/awaiting.test.ts src/mainview/lib/pipelines.test.ts \
  src/mainview/lib/pipeline-events.test.ts src/mainview/lib/task-context-menu.test.ts
bun node_modules/@playwright/test/cli.js test e2e/pipelines-run.spec.ts
bun node_modules/@playwright/test/cli.js test e2e/pipelines-editor.spec.ts e2e/task-context-menu.spec.ts e2e/task-card-header.spec.ts
```

Playwright starts the shared Vite server itself (`bun run hmr`, :5173) and one headless backend per worker with the fake drivers; no seed data or credentials. Run one Playwright invocation at a time and check `uptime` first (the suite stalls at high load). No real task is created in `~/.agetor` or `~/.agetor-dev`.

Not covered by e2e: the OS-notification click (headless has no native bridge). Its wiring is two call sites over the unit-tested resolver; verify by reading and typecheck.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 1 | T1, T2, U1, U2 | typecheck + the four unit files green. Nothing user-visible changes yet. Commit. |
| 2 | T3, T4, T5, T6 | typecheck + unit green; existing `e2e/pipelines-run.spec.ts` green. Commit. |
| 3 | E1, T7 | full recipe in §5 green. Commit. |

File ownership is disjoint inside every wave (checked: no path appears twice in a wave). T5 makes `onOpenAttention` required and T6 supplies it in the same wave, so the wave-2 barrier builds. T3 and T4 meet only through `data.attention`, pinned in §3.3.

This is small enough for one agent to run sequentially in wave order; the partition is there so it can fan out safely if the implementer chooses to.

## 7. Blast radius & risks

- **React Flow update loop.** The run view crashed before on identity churn. T4 must go through the signature and the identity-stable merge; `stepAttention` returns a fresh object each call, so the merge must compare with `sameStepAttention`, never by reference. The existing edge-bearing e2e tests are the regression check.
- **Memoized board.** A missed comparator line in `Column` makes the button silently stale; an unstable `openAttention` re-renders every card on each poll.
- **`openPipelineRun` now closes the panel.** Callers: `openTask` for parents, the context menu, RunPanel's strip (already closes first), the retargeted `files-sent` / `fx-auto-resume` toasts. All are run-view-only landings, so this is the intended D14 behavior, but it is a behavior change for each of them.
- **Resolver freshness.** A step row created under 2 s ago may not be in `tasks`; the landing degrades to run view only (D13). A click during a discard-confirm resolves when the navigation commits, so it uses the freshest list.
- **Notification click ambiguity** (§3.8).
- **Chip width.** The 240 px title row may hold name + Start + two glyphs + chip. The name truncates sooner; the row must not wrap.
- **Glow near satellites.** The 14 px glow can overlap a step's subagent satellite row slightly; it is non-interactive.
- **Merge conflicts.** `App.tsx` and `CLAUDE.md` are hot files; the import-export branch may touch both.
- **Rollback.** Webview-only, no persisted shape, no migration, no flag: revert the commits.

## 8. Open questions / assumptions

Nothing is blocked. These are the points where the plan goes past the letter of the grill. The owner approved the plan with them; items 2 and 5 were asked explicitly and confirmed:

1. **Resolver tier 4** (originally tier 3; active execution whose own column is `blocked`). Covers the moment where the card already reads Review from the optimistic column patch but the parent's refetched `run.blocked` hasn't landed. Without it that click lands on the run view only.
2. **Leftover question on a settled step** (resolver tier 2 — originally tier 4 — and `stepAttention` rule 2) — **owner-confirmed**. The runner doesn't cancel pending cards when a step settles, so the card can read Answer while no active step is asking. The plan highlights that step's node and lets Answer open it, which keeps D1's rule ("whenever the card glows, some node glows") true. A finished node can therefore show amber.
3. **Blocked tier skips unpolled rows.** D11 says "the first `run.blocked` entry with a `taskId`"; the plan takes the first one whose row is present.
4. **D14 also closes a same-pipeline step panel** on a run-view-only landing, not only another task's. This matches what RunPanel's "Open pipeline" strip already does.
5. **Notification click** uses the resolver for every notification on a pipeline parent (§3.8) — **owner-confirmed**.
6. **Shared primitives touch `TaskCard`** beyond the new callback (§3.2). Rendered output is unchanged.
7. **Default chip tooltips** when no block message exists: "Waiting for your answer" / "Needs your review".

Carried from the grill unchanged: `block.stepId` naming a step missing from the snapshot highlights nothing (`pipeline-runner.ts:957`); the banner covers it.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who decided |
| --- | --- | --- |
| Node attention look for rows 1–5 | In this run | T2, T3 |
| Amber replaces blue on a mid-turn ask | In this run | T3 |
| Label chip + tooltip | In this run | T2, T3 |
| Reduced motion on the blue step pulse | In this run | T3 |
| Signature + merge carry attention | In this run | T4 |
| `interaction` events reach the run view | In this run | T4 (subscriber), T6 (forward gate) |
| `pipeline-events.ts` header names three kinds | In this run | T4 |
| Card amber button → run view + step | In this run | T5, T6 |
| `Column` prop + comparator | In this run | T5 |
| "Waiting on you" toast → named step | In this run | T6 |
| "Pipeline needs you" toast → step | In this run | T6 |
| OS-notification click → step | In this run | T6 |
| Parent-keyed toast dismissed on step landing | In this run | T6 |
| Leftover panel closed on run-view-only landings | In this run | T6 |
| Cancelled discard-confirm opens nothing | In this run | T6 |
| Leftover pending card on a settled step | In this run | T2 (see §8.2) |
| Card label / ring / glow drift between card and node | In this run | T1, T5 |
| Unit coverage | In this run | U1, U2 |
| Playwright coverage (D20 + toast paths + leftover panel) | In this run | E1 |
| `CLAUDE.md` item 19, `docs/plans/pipelines.md` | In this run | T7 |
| Card body / context menu / Worktrees row landing on the step | Out of scope | Owner decision D9: browse paths stay run-view-only |
| New context-menu entry | Out of scope | Owner decision D9 |
| Red tone for errors | Out of scope | Owner decision D2 |
| Auto-pan around the panel | Out of scope | Owner decision D17 |
| TUI / CLI equivalents | Out of scope | Owner decision D19: no canvas there |
| Card's literal `bg-amber-500` button | Out of scope | Pre-existing exception on a surface this change doesn't restyle; different ticket |
| Reduced motion for satellite pulse and edge animations | Out of scope | D7 names the step node's pulse only; a canvas-wide reduced-motion pass is a different ticket |
| Step id / kind in the notification deep link | Out of scope | Needs `notifyOS`, URL scheme and main-process changes; the grill fixed this change as webview-only |
| Runner cancelling pending cards when a step settles | Out of scope | Server behavior change; the UI side is handled in T2 |
| Server / DB / schema | Out of scope | Every needed field is already on the wire |
| A step that asks the instant it spawns loses its "Waiting on you" toast | Out of scope (found while executing; pre-existing) | The runner `persist`s again right after `launchStep`'s `startTask` returns (`startPipelineRun`, and the settle path), and App's `pipeline`-event handler dismisses the parent's pending toast + tracker entry on any non-`blocked` status. A question registered during the spawn therefore loses its toast (the card and node still glow). Fixing it means changing either the runner's persist ordering (server) or the toast lifecycle rule for every pipeline event — neither is part of this webview-only change; reported in the handoff. |

## Review fixes (code review of `c08e5c7..dfa130e`)

- **Step-named toasts.** The retargeted `files-sent` / `fx-auto-resume` toasts no longer call `openPipelineRun`, which closed the step panel the user was reading. They go through `openPipelineStep(parentId, stepTaskId)`: run view plus the named step's panel, unconditionally, without re-resolving and without dismissing the parent's "Waiting on you" toast.
- **`landOnPipeline`.** Shared by `openPipelineAttention` and `openPipelineStep`. With no step to open, it closes another task's leftover panel but keeps a step panel of the same pipeline (and its subagent-focus request) open. So an OS-notification click about the pipeline being read (a proactive send notifies the OS even when focused) no longer closes the step. `openPipelineRun` keeps closing every panel, because RunPanel's "Open pipeline" strip button lands there and must reveal the run view.
- **Resolver preferred id** and **`stepAttention` candidates**: see §3.4/§3.5 notes above.
- **D16 e2e.** A dirty-editor scenario: "Waiting on you" toast Open → cancel the discard confirm → editor still shown, no run view, no run panel.

