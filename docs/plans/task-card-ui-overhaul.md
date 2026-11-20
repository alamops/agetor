# Plan — Task card UI overhaul (layout C1)

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Owner goal: "Improve the Card UI following the best UI/UX practices. Currently it's broken like in the attached screenshot." The screenshot is transcribed in [`task-card-ui-overhaul-investigation.md`](task-card-ui-overhaul-investigation.md) §0. Decisions: [`task-card-ui-overhaul-grill.md`](task-card-ui-overhaul-grill.md), 23 decisions in 2 rounds. Design gate (this step): the measured mockup in [`task-card-ui-overhaul-mockup/`](task-card-ui-overhaul-mockup/README.md); the owner picked **C1**. |
| Flags | none |
| Gates | grilled + design sign-off by owner (C over A/B, then C1 over C2, Stop on `--danger`) + plan approved as written by owner, including the four planning calls in §8 (2026-11-18) |
| Status | implemented (T1–T12, branch commits `wave 1`–`wave 3`); T13 owner eyeball check + PR pending |
| Branch | `fix/agetor-card-ui-improvement` (agetor worktree) |
| Base SHA | `4d7f8bfb93320076aa86292d614d84d4b883ba7d` (the planning docs are commit `54a486ec`) |

## 1. Objective & success criteria

Rebuild the kanban `TaskCard` as layout **C1**, which passed every geometry, overlap, squeeze, target-size and contrast check at 262 px in all 12 worst-case states, light and dark, in Chromium and WebKit. Fix the progress over-count at its single source. Add keyboard access and a regression guard so the card can't silently break again.

| # | Criterion | Production path that produces it | Proven by |
| --- | --- | --- | --- |
| SC1 | No child of a board card leaves the card box, spills out of its row, overlaps a flex sibling or is squeezed below 24 px. This holds in every state (pipeline hat + long names + every badge, gate pending, `Answer (12)`, review, done, archived, multi-repo, long repo + `not on PR head`), in light and dark, in Chromium and WebKit. | `App.tsx` board → `Column` → `TaskCard` (C1 markup) | `e2e/task-card-bounds.spec.ts` (T9), which drives the real board |
| SC2 | A pipeline card has a status-tinted **hat**. It shows the full pipeline name (wraps, never cut), progress on the right (`n/total` over distinct steps, `✓ Done` for a done run, never cut), and a step line (active step, `+N` for a fan-out, the pending gate, or `Blocked: <step>`). Its tooltip carries the run counts. | `TaskCard` → `PipelineHat` → `pipelineStepProgress` | `PipelineHat.test.tsx` (T6), `pipeline.test.ts` (T1), bounds spec hat states (T9) |
| SC3 | Progress no longer over-counts anywhere: board hat, run-view header, `agetor show`, `agetor pipeline status`, `agetor ls`, TUI. `show`, `pipeline status` and the run-view header also print `N step runs · M re-runs`. | `src/shared/pipeline.ts` `pipelineStepProgress` → each consumer | `pipeline.test.ts`, `src/cli/show.test.ts`, `src/cli/commands/pipeline.test.ts`, `src/cli/ls.test.ts` (T1) |
| SC4 | The action row is the primary action(s) plus `⋯`, per the state table in §2.3. `⋯` opens the existing task menu at the button, and the menu offers every action the card used to show (Diff, Archive, Unarchive, the extra Stop, Delete…). Stopping a pipeline parent asks for confirmation from both the card and the menu. | `TaskCardActions` → `cardActions()`; `⋯` → `onContextMenu` → `App` `openTaskMenu` → `buildTaskContextMenu`; Stop → `App` `stopFromBoard` | `task-card-actions.test.ts` (T3), `task-context-menu.test.ts` (T3), `pipelines-human-step.spec.ts` + retargeted specs (T10), bounds spec (T9) |
| SC5 | The preview line shows the prompt's first prose paragraph as plain text, or no line at all. | `TaskCard` → `promptPreview(task.prompt)` | `prompt-preview.test.ts` (T2), `TaskCard.test.tsx` (T7), bounds spec "screenshot" state (T9) |
| SC6 | Accessibility: the card is a labelled `group` (no buttons nested in a `button`) with a visible focus outline. Enter opens it. Space picks up and drops, ← → move between columns, Esc cancels, and screen readers hear task titles and column names. Every icon-only button has an `aria-label`, `⋯` is a menu button with `aria-expanded`, and all card text is ≥ 4.5:1. | `TaskCard` root attributes + `onKeyDown`; `App` `sensors` (`KeyboardSensor` + `boardKeyboardCoordinates`) and `DndContext accessibility` | `board-keyboard.test.ts` (T4), `e2e/board-keyboard.spec.ts` (T11), bounds-spec checker (T9) |
| SC7 | Look: one chip system (h-5, 10 px, fully rounded) used only where colour means something. Activity counts are plain icon + number, all card buttons are h-7, padding is p-3, identity is one text line, and the meta line reads `repo · branch`. Answer uses `--warning-solid` + new `--warning-solid-foreground`, card Stop uses `--danger`, and Done is transparent. | `CardChip`/`CardStat` (T5) inside `TaskCard*` (T7) | `StackBadge.test.tsx` (T5), `TaskCard.test.tsx` (T7), bounds spec + screenshots (T9) |
| SC8 | Guardrail: a CLAUDE.md Webview rule, a new `docs/architecture/task-card.md`, and a Topic map row that points at the bounds spec. | docs | review (T12) |
| SC9 | The owner checks the card by eye in `bun run dev:hmr` before merge. The PR carries light/dark screenshots of every state. | — | T13 gate |

## 2. Context & constraints

### 2.1 What is broken today, and why (investigation §1–§2, re-proved by the mockup control)

- **Header overflow.** `TaskCard.tsx:306-330` puts `PipelineBadge`/profile badge/`StackBadge` with caller `shrink-0` in a `justify-between` row. Free space goes negative: the left cluster collapses to 0 px, the icon slides under the pill, and the stack chip lands **26–27 px outside the card**. Measured in Chromium and WebKit.
- **`13/10`.** `pipelineStepProgress` (`src/shared/pipeline.ts:1678-1700`) counts *executions*. In the prod DB, 107 of 120 done runs (89%) over-count.
- **Gate-pending actions** (`TaskCard.tsx:394-422`): Open, Review, Stop and the icon buttons need ~273 px against 225 px of content. Delete ends up 35 px outside.
- **Dark Done hole.** The outline variant paints `bg-background` (`button.tsx:21`).
- **Raw markdown preview** (`TaskCard.tsx:340`).
- **Amber literal** (`TaskCard.tsx:426`).
- **No focus style; `role="button"` card with nested buttons; icon buttons without `aria-label`; no keyboard open or drag** (`App.tsx:397`: `PointerSensor` only).
- **Contrast** (new, measured): the workdir line `text-muted-foreground/70` is 2.74:1 (light); the gate Stop's `text-destructive` is 1.99:1 (dark); white on `bg-destructive` is 3.60:1 (light); the shared ContextMenu's danger entries (`context-menu.tsx:283-284`, `text-destructive`) are 3.76:1 light / 1.77:1 dark.

### 2.2 The C1 layout contract (owner-picked; reference markup `renderC1` in `task-card-ui-overhaul-mockup/render.mjs`)

Card = 262 px (`Column.tsx:70`: `w-72 p-3` + 1 px border). Content = 233 px (`border-l-4`, 1 px right border, `p-3`). Columns stay `w-72`. No `overflow-hidden` on the card.

```
Card root   relative cursor-grab select-none rounded-lg border border-border/60 border-l-4 {type.borderClass}
            bg-card text-card-foreground shadow-sm transition-colors hover:border-border
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring
            + AWAITING_RING_CLASS when awaiting, + "cursor-default opacity-60" when archived
            role="group" aria-roledescription="draggable task" aria-label={task.title} tabIndex=0 data-task-id
 ├ unread dot  absolute -right-1.5 -top-1.5 z-10 size-2.5 rounded-full bg-info ring-2 ring-background
 │             (data-card-overlay, title/aria-label "New messages", role="img"; on the corner, over the hat too)
 ├ PipelineHat (pipeline parent only)   flex flex-col gap-1 border-b px-3 py-2 rounded-tl-[4px_7px] rounded-tr-[7px] + tone
 │   ├ row   Workflow size-3.5 · name (min-w-0 flex-1 text-xs font-semibold leading-[18px] [overflow-wrap:anywhere])
 │   │       · countLabel (shrink-0 text-xs font-semibold tabular-nums)          ← never truncated
 │   └ line  (optional) icon size-3 · text-[11px] font-medium leading-4 [overflow-wrap:anywhere]
 ├ body  flex flex-col gap-2 p-3
 │   ├ title  h3 text-sm font-semibold leading-snug [overflow-wrap:anywhere], type icon inline first
 │   │        (mr-1.5 inline-block size-3.5 align-[-2px], role="img" aria-label={type.label}); full wrap, no clamp
 │   ├ (gap-1 group)
 │   │   ├ identity line  flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground
 │   │   │                 AgentIcon size-3 · ONE truncating span: name (font-medium text-foreground) · model · mode
 │   │   │                 (font-mono text-[10px]); pipeline parent: model · mode only, no agent
 │   │   └ status row      flex flex-wrap items-center gap-x-2.5 gap-y-1
 │   │                      CardStat ×(subagents, terminals, todo, sent files) then CardChip ×(stack, fx paused)
 │   ├ preview  p line-clamp-2 text-xs leading-normal text-muted-foreground (omitted when promptPreview is "")
 │   ├ meta     flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[10px] text-muted-foreground
 │   │           inner: flex min-w-[10rem] flex-1 basis-0 items-center gap-1:
 │   │                  GitBranch size-3 · repo (max-w-[45%] shrink-0 truncate) · "·" · branch (min-w-0 flex-1 truncate)
 │   │           then the drift CardChip (shrink-0 font-sans), which wraps to its own line when the row is full
 │   │           multi-repo: GitFork size-3 · "N repositories" (shrink-0 font-medium) · names (min-w-0 truncate)
 │   └ actions  flex items-center gap-1.5: primary button(s) h-7 px-2.5 text-xs gap-1.5 (icon size-3.5) · ⋯ ml-auto h-7 w-7
 └ AwaitingGlow (last child, when awaiting)
```

- **Chip system** (`CardChip`): `inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full border px-2 text-[10px] font-medium leading-none whitespace-nowrap`. Variable text sits in an inner `truncate` span. Tones: neutral `border-border text-muted-foreground`, info `border-info/40 text-info`, warning `border-warning/40 text-warning`, success `border-success/40 text-success`. Chips are used only where colour carries a meaning: stack, fx pause, drift.
- **Stat** (`CardStat`): `inline-flex shrink-0 items-center gap-1 text-[11px] leading-4 tabular-nums text-muted-foreground`, plus icon `size-3`. Todo complete → `text-success`.
- **Hat tones:** running/review `bg-info/10 text-info border-info/25`; blocked `bg-warning/10 text-warning border-warning/30`; done `bg-success/10 text-success border-success/25`; cancelled/idle `bg-muted text-muted-foreground border-border`.
- **Buttons** (shared `Button`, card-local classes; `cn` is `twMerge`, so overrides win): Run `default`; Stop `default` + `bg-danger text-danger-foreground hover:bg-danger/90` (4.50:1 light, 6.59:1 dark; owner decision); Answer `default` + `bg-warning-solid text-warning-solid-foreground hover:bg-warning-solid/90` (6.98:1); Open `secondary`; Done `outline` + `bg-transparent`; gate Review `default`; `⋯` `outline` `size="icon"` + `h-7 w-7 bg-transparent`, `aria-label="More actions"`, `aria-haspopup="menu"`, `aria-expanded`, `title="More actions"`, `data-testid="task-card-more"`.
- **Hooks e2e already relies on, which must survive:** root `cursor-grab` class + `data-task-id` (23 specs locate cards this way); test ids `task-card-pipeline` (on the hat, with `data-status`), `task-card-agent-profile` (the profile name span, `title={task.agent}`), `task-card-stack-badge`, `task-card-repositories`, `task-card-branch-drift`, `task-card-pipeline-review` (gate Review button), `sent-files-badge`, `fx-paused-badge`; stat `title`s `"N of M tasks done"` (text exactly `N/M`), `"N background task(s) running"`, `"N open terminal(s)"`; button names `Run`, `Stop`, `Open`, `Done`, `Answer`/`Answer (N)`, `Review`; StackBadge text such as `⏳ 2/2`.

### 2.3 Per-state buttons (grill #8, #9; precedence `Answer > Stop > Open > Run` unchanged)

| State (first match wins) | Visible | In `⋯` (existing menu) |
| --- | --- | --- |
| archived | `Open` | Unarchive, Diff, Delete… |
| pipeline gate pending | `Review` · `Open` | **Stop** (with confirm), Diff, Delete… |
| awaiting (pending interactions or `blocked`) | `Answer (N) →` / `Answer →` / `Review →` | Stop (when stoppable), Stop & archive…, Diff, Delete… |
| stoppable (running; pipeline `running`) | `Stop` | Stop & archive…, Diff, Delete… |
| openable or imported | `Open` | Run (never: hidden by the menu's own gate), Diff, Delete… |
| otherwise | `Run` | Diff, Delete… |
| + review column, no pending gate, not an unfinished pipeline | adds `Done` | Mark done |
| + done column | — | Archive |

### 2.4 Repo rules that bear on this change

- Semantic tokens only, and a new token lands in `index.css` (both themes) **and** `tailwind.config.js` in the same change (CLAUDE.md "UI conventions", the undefined-token trap).
- Persisted data stays raw; transforms are client-side rendering (CLAUDE.md "Data"). That is why `promptPreview` is a pure mainview helper returning plain text.
- `src/shared/` stays free of runtime imports; `pipelineStepProgress` is the single implementation for UI, CLI and TUI (CLAUDE.md "Data").
- CLI/TUI print stored text through `terminal-text.ts`; the existing call sites already do (`ls.ts:221`, `Dashboard.tsx:779`, `show.ts:165`, `pipeline.ts:577`).
- A fixed overlay portals to `document.body`; the ContextMenu already does (`context-menu.tsx`).
- The precedence mirror: `buildTaskContextMenu` (`src/mainview/lib/task-context-menu.ts:76-218`) and `docs/architecture/task-context-menu.md`.
- The awaiting look is shared with the pipeline `StepNode` (`src/mainview/lib/awaiting.ts`, `components/ui/awaiting-glow.tsx`, `docs/architecture/pipelines.md:163`). Don't change it.
- `Column` is memoised with a custom comparator listing every prop (`Column.tsx:124-144`); a new prop goes into that comparator, and App passes it from stable state.
- Shared `ui/badge`, `ui/button` and `ui/card` variants are not changed (grill #20).
- Tests: `bun test` runs every file in one process; a component test renders with `react-dom/server` `renderToStaticMarkup`, as `StackBadge.test.tsx` does. e2e uses `bun node_modules/@playwright/test/cli.js` (never `bunx`), one run at a time.
- Repo memory rules: never put real ticket IDs or company names in code or fixtures (all fixture strings below are synthetic); dogfood only against `~/.agetor-dev` (`bun run dev:hmr` sets it).

### 2.5 Runtime and trust shape

Single-user desktop WKWebView; the board polls `/tasks` every 2 s; `reconcileById` preserves task identity, so a memoised card re-renders only when its task changes. No server, DB, route or migration change. Untrusted text on the card (titles, prompts, pipeline/profile/step names) stays React-escaped plain text; the preview never becomes HTML. Rollback is a revert.

### 2.6 Live facts checked at planning

- dnd-kit `@dnd-kit/core` 6.3.1 (`node_modules/@dnd-kit/core/dist/core.esm.js`). `KeyboardSensor`'s activator skips the start key only when `event.target !== active.activatorNode.current` (line ~1360), and `activatorNode` is set **only** by `setActivatorNodeRef`. Without it, Space on a nested button would start a drag. Default codes are start `[Space, Enter]`, cancel `[Escape]`, end `[Space, Enter, Tab]` (~1098). The default announcements print the raw draggable id, which is a task UUID (~43-55). `useDraggable` accepts `attributes: { role, roleDescription, tabIndex }` (~3392-3439).
- `App.tsx:2447-2470` `runTaskMenuAction` maps `stop` → `cancel(t)` **with no confirmation**, while the card's pipeline Stop confirms (`TaskCard.tsx:92-105`). Moving gate Stop into `⋯` would silently drop that confirmation unless App owns it (T8).
- `ContextMenu` focuses its first item on open and restores focus to the element that had it (`context-menu.tsx:79-124`), so `⋯` gets focus back on close.
- `stackBadgeStateFor` returns `task.harnessState` when no stack matches (`stack-badge.ts:31-60`), so an e2e fixture can drive the stack chip without creating stacks.
- `page.route` interception of the core API is an existing e2e pattern (`harness-stack-switch.spec.ts:187`, `terminal-drift.spec.ts:185`); the board reads `GET /tasks` (`api.ts:1756`).
- Mockup verdicts (tailwindcss 3.4.19, Playwright 1.62.1 Chromium + WebKit, light + dark, 12 states): today 0/24; A, B, C, C1, C2 24/24 each; average card height C1 249 px vs today 287 px. Recipe and numbers: [`task-card-ui-overhaul-mockup/README.md`](task-card-ui-overhaul-mockup/README.md).

## 3. Approach & key decisions

1. **C1 layout** (owner, design gate). The title leads, with the type icon inline. Below it come one identity text line and one status line. Activity counts are plain stats, and chips are reserved for meaning (stack, fx pause, drift). Nothing sits in a fixed slot, so no long value can push a sibling out. *Evidence: 24/24 in both engines.* Rejected: A, meta footer (tallest; identity lowest); B, identity header (truncates both profile and model at worst case); C as first drawn (the owner found the chip row "polluted"); C2 (status at the bottom).
2. **One source for card actions and menu flags.** Today `TaskCard` and `buildTaskContextMenu` compute `archived/active/awaiting/openable/gatePending/stoppable` twice, "mirrored by comment". New `src/mainview/lib/task-card-actions.ts` exports `taskActionFlags(task)` and `cardActions(task)`, and the menu builder imports the flags. A superset test proves the menu carries every action the card used to show. *Reasoning: the mirror is the investigation's top blast-radius risk.*
3. **`PipelineHat` replaces `PipelineBadge`.** `PipelineBadge.tsx` has a single caller (`TaskCard.tsx:307`) plus a barrel re-export (`components/pipelines/index.ts:11`), so it is deleted, not kept beside the hat.
4. **Progress shape.** `pipelineStepProgress` keeps `completed/active/total/label` (so `ls.ts` and the TUI need no code change) and adds `done`, `executions`, `reruns`, `current`, `countLabel` and `runsLabel` (§4 T1). `completed` counts **distinct** steps that are present in the snapshot graph and have a `succeeded`/`advanced-manually` record. *Evidence: prod DB, 89% over-count; 15 done runs short of total when counted distinct, hence `✓ Done`.* **Wording:** the grill's example said "13 step runs · 2 loops". "Loop" has no exact count when a run has two different cycles, so the plan uses **re-runs** = executions − distinct executed steps (`13 step runs · 3 re-runs` for the screenshot task). Flagged in §8.
5. **Pipeline Stop confirmation moves to App** (`stopFromBoard`). Both the card's Stop and the menu's Stop route through it; `TaskCard` drops `useConfirm`. *Evidence: §2.6.*
6. **Keyboard drag** uses `KeyboardSensor` with codes `start [Space] / end [Space] / cancel [Escape]`, a custom `coordinateGetter` that jumps to the next or previous column's centre (←/→ only, since columns have no ordering), and `setActivatorNodeRef` on the card root so keys on nested buttons never start a drag. Enter on the card itself opens it. Announcements use task titles and column labels. *Evidence: §2.6.* Rejected: a separate drag handle (the owner kept whole-surface pointer drag, grill #11).
7. **Contrast fixes beyond the grill**, from the mockup's checker: card Stop on `--danger` (owner decision, design gate). The shared ContextMenu's danger entries switch `text-destructive` → `text-danger` (one class pair in `context-menu.tsx`), because Delete now lives only in that menu and reads at 1.77:1 in dark mode. This touches a shared primitive outside grill #20's list (badge/button/card). Flagged in §8.
8. **`aria-expanded` on `⋯`.** App passes `menuTaskId` (the open menu's task id) through `Column` (one new prop, in the comparator), and the card sets `aria-expanded={menuOpen}`. This follows the ARIA menu-button pattern. Cost: every column re-renders on menu open or close, and only the affected card re-renders its DOM.
9. **The bounds e2e drives the real board with fixture state.** It creates real tasks over the API, then `page.route`s `GET /tasks` to merge server-managed fixture fields (pipeline run, counts, stack state, pending interactions, unread, archived). Every state renders deterministically in seconds, with no fake-driver runs. The producers of those fields already have their own specs (todo-progress, sent-files, fx-recovery, pipelines-run, harness-stack-swap, unread-indicator). Rejected: a component-harness page (it would ship a test page in the bundle); real fake-driver runs for 12 states (slow, and they can't produce "every badge at once").
10. **The bounds spec also runs in WebKit** (one `test.describe` with `test.use({ browserName: "webkit" })`). WKWebView is the real target, and the mockup showed Playwright WebKit agrees with Chromium here. If the harness can't drive WebKit, T9 reports it; it never skips silently.
11. **Preview rules** (`promptPreview`). Split on blank lines. Drop front matter (leading `---…---`), headings, tables (`|`-led lines or `|---|`), horizontal rules, code fences (``` and ~~~, through the closing fence) and HTML comments. The first remaining block is the paragraph; list items count as prose with their markers stripped. Inline syntax is stripped: emphasis, inline code, links → text, images → alt, `>` quote markers. Whitespace collapses, and the result caps at 280 chars. If no prose block exists, fall back to the whole prompt with the same syntax stripped; if that is empty, return `""` and the card omits the line.

## 4. Work breakdown — implementation tasks

Unit tests are owned by the task that owns the module under test. Pinned interfaces, coded against within a wave:

```ts
// T1 — src/shared/pipeline.ts
export interface PipelineProgressCurrent { kind: "step" | "gate"; stepId: string; name: string; more: number }
export interface PipelineStepProgress {
  completed: number;        // distinct snapshot steps with a succeeded / advanced-manually record
  active: number;           // run.active.length
  total: number;            // snapshot step count (0 before the first Run)
  done: boolean;            // run.status === "done"
  executions: number;       // history records with taskId !== null, plus run.active.length
  reruns: number;           // executions − distinct stepIds among those executions (≥ 0)
  current: PipelineProgressCurrent | null; // active[0] (more = active.length − 1), else humanSteps[0] (more = humanSteps.length − 1)
  countLabel: string;       // done ? "✓ Done" : `${completed}/${total}`
  label: string;            // countLabel + (done || !current ? "" : ` · ${current.name}`)
  runsLabel: string;        // "" when executions === 0; "1 step run"; "13 step runs · 3 re-runs" (re-run singular at 1)
}
export function pipelineStepProgress(run: PipelineRunState): PipelineStepProgress;

// T2 — src/mainview/lib/prompt-preview.ts
export function promptPreview(prompt: string, maxChars?: number /* 280 */): string;

// T3 — src/mainview/lib/task-card-actions.ts
export interface TaskActionFlags {
  archived: boolean; active: boolean; awaiting: boolean; pendingCount: number; openable: boolean;
  gatePending: boolean; stoppable: boolean; isPipelineParent: boolean; isStepTask: boolean;
  imported: boolean; canMarkDone: boolean;
}
export function taskActionFlags(task: Task): TaskActionFlags;
export type CardAction = "review-gate" | "open" | "answer" | "stop" | "run" | "mark-done";
export function cardActions(task: Task): CardAction[]; // §2.3, in display order; `⋯` is not listed (always present)

// T4 — src/mainview/lib/board-keyboard.ts
export const BOARD_KEYBOARD_CODES: { start: string[]; cancel: string[]; end: string[] };
export function nextColumnX(code: string, columns: { id: string; left: number; width: number }[],
  currentColumnId: string | null, activeWidth: number): number | null;
export const boardKeyboardCoordinates: KeyboardCoordinateGetter; // from @dnd-kit/core
export const BOARD_SCREEN_READER_INSTRUCTIONS: string;
export function makeBoardAnnouncements(titleOf: (id: string) => string, columnLabelOf: (id: string) => string): Announcements;

// T5 — src/mainview/components/kanban/CardChip.tsx
export type CardChipTone = "neutral" | "info" | "warning" | "success";
export function CardChip(p: { tone: CardChipTone } & React.HTMLAttributes<HTMLSpanElement>): JSX.Element;
export function CardStat(p: { icon: LucideIcon } & React.HTMLAttributes<HTMLSpanElement>): JSX.Element;

// T6 — src/mainview/components/pipelines/PipelineHat.tsx
export function PipelineHat(p: { run: PipelineRunState }): JSX.Element;

// T7/T8 contract — TaskCard props: unchanged except `menuOpen?: boolean`; `onCancel` no longer confirms.
// Column props: + `menuTaskId?: string | null` (compared in the memo comparator).
// App: `stopFromBoard(t)` confirms for a pipeline parent ("Stop this pipeline?" copy from TaskCard.tsx:97-101), then `cancel(t)`.
```

| ID | Goal | Owned files | Depends on | Acceptance (scenarios → proof) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Fix progress at its source, and print run counts in the run view, `show` and `pipeline status` | `src/shared/pipeline.ts`, `src/shared/pipeline.test.ts`, `src/cli/commands/show.ts`, `src/cli/commands/pipeline.ts`, `src/cli/show.test.ts`, `src/cli/commands/show.test.ts`, `src/cli/commands/pipeline.test.ts`, `src/cli/ls.test.ts`, `src/mainview/components/pipelines/PipelineRunView.tsx`, `src/mainview/lib/pipelines.test.ts` | — | (a) Given 10 steps and history Code Review ×3, Bug Fix ×2, every other step ×1, all `succeeded`, status `done`: `completed=10`, `countLabel="✓ Done"`, `label="✓ Done"`, `executions=13`, `reruns=3`, `runsLabel="13 step runs · 3 re-runs"`. (b) A done run whose Bug Fix never ran: `completed=9`, `total=10`, `label="✓ Done"`. (c) The same history but status `cancelled`, then `blocked`: `label` starts `9/10` (blocked adds ` · <active step>`). (d) Repeated `stepId` while running with `active=[Implement]`: `label="k/10 · Implement"`, no double count. (e) Fan-out with 3 active: `current.more=2`. (f) Gate pending, no active: `current.kind="gate"`, label names the gate. (g) A history `stepId` missing from the snapshot graph is not counted in `completed`. (h) A `returned` gate record and a `failed` record never count as completed; gate records (`taskId: null`) never count as executions. (i) No snapshot: `0/0`, `runsLabel=""`. (j) `agetor show` and `agetor pipeline status` print `steps: ✓ Done (13 step runs · 3 re-runs)` for (a) and keep `steps: 1/2 · Fix` for the existing fixture. (k) `agetor ls` blocked cell is unchanged for the existing fixture. (l) The run-view header shows `label · runsLabel`, or only `runsLabel` when done. Proof: `bun test src/shared/pipeline.test.ts src/cli src/mainview/lib/pipelines.test.ts`, `bun run typecheck`. | data | `pipelineStepProgress` is already called by `PipelineBadge` (→ `PipelineHat`, T6/T7), `PipelineRunView.tsx:525`, `show.ts:165`, `pipeline.ts:577`, `ls.ts:221`, `Dashboard.tsx:779,911` |
| T2 | Plain-text prompt preview | `src/mainview/lib/prompt-preview.ts`, `src/mainview/lib/prompt-preview.test.ts` | — | `"# Spec — X\n\| Field \| Value \|\n\| --- \| --- \|\n\nKeep the **inbox** watched. See [docs](https://x)."` → `"Keep the inbox watched. See docs."`. Front matter, fences (``` and ~~~, unclosed fence = rest dropped), rules, HTML comments, image → alt, inline code → text, `- item` → `item`, `> quote` → `quote`. A prompt of only a heading and a table falls back to stripped text. Empty or whitespace input → `""`. 10 000 chars → ≤ 280 chars, ending `…`. Output never contains `<`-tags it didn't receive (no HTML generation). Each case has a unit test; one test is shown red against a copy that returns the raw prompt. | none | T7 (`TaskCard` preview line) |
| T3 | One flags source for card buttons and menu | `src/mainview/lib/task-card-actions.ts`, `src/mainview/lib/task-card-actions.test.ts`, `src/mainview/lib/task-context-menu.ts`, `src/mainview/lib/task-context-menu.test.ts` | — | (a) `cardActions` returns exactly the §2.3 row for: backlog, ready-with-openable-run, running, blocked, awaiting (`pendingCount` 1 and 12), awaiting + running, review, review pipeline not done (no `mark-done`), review pipeline done, gate pending, done, archived, imported session, pipeline running, pipeline blocked. (b) **Superset invariant**: for the same fixture matrix, every action the pre-change card showed as an extra button maps to a menu entry from `buildTaskContextMenu`: diff → `diff`, delete → `delete` (non-step), archive → `archive`, unarchive → `unarchive`, the extra Stop (awaiting + stoppable, and gate pending) → `stop`. (c) All existing `task-context-menu.test.ts` cases pass unchanged, so the menu's behaviour does not change. Proof: `bun test src/mainview/lib/task-card-actions.test.ts src/mainview/lib/task-context-menu.test.ts`. | state | `buildTaskContextMenu` (App's `taskMenuItems`); `cardActions` → T7 `TaskCardActions` |
| T4 | Keyboard drag helpers and screen-reader wording | `src/mainview/lib/board-keyboard.ts`, `src/mainview/lib/board-keyboard.test.ts` | — | (a) `nextColumnX("ArrowRight", cols, "backlog", 240)` → centre x of `ready`; ArrowLeft from `backlog` → `null`; ArrowRight from the last column → `null`; ArrowUp/ArrowDown → `null`; unsorted input still resolves by `left`. (b) `currentColumnId` null → the column whose span contains the active rect's centre. (c) `boardKeyboardCoordinates` with a stub context returns `{ x: nextColumnX(...), y: currentCoordinates.y }` or `undefined`. (d) Announcements name the title and column ("Picked up <title>.", "<title> is over Ready.", "<title> was dropped in Review.", "Moving <title> was cancelled."), never a UUID; an unknown id falls back to "task". (e) `BOARD_KEYBOARD_CODES.start` and `.end` are `["Space"]` and `.cancel` is `["Escape"]`. Proof: `bun test src/mainview/lib/board-keyboard.test.ts`. | none | T8 (`App` sensors + `DndContext accessibility`) |
| T5 | Tokens, chip primitives, StackBadge restyle, menu danger contrast | `src/mainview/index.css`, `tailwind.config.js`, `src/mainview/components/kanban/CardChip.tsx`, `src/mainview/components/kanban/CardChip.test.tsx`, `src/mainview/components/kanban/StackBadge.tsx`, `src/mainview/components/kanban/StackBadge.test.tsx`, `src/mainview/components/ui/context-menu.tsx` | — | (a) `--warning-solid-foreground: 20.9 91.7% 14.1%` (amber-950) is in both `:root` and `.dark`, and `"warning-solid-foreground"` is in `tailwind.config.js`. A Tailwind build emits `.text-warning-solid-foreground` (grep the built CSS once in the task). (b) `CardChip` markup carries the §2.2 chip classes and its tone classes; `CardStat` renders icon + text with no border. (c) `StackBadge` uses `CardChip` (`rounded-full`, `h-5`), and its existing tests pass, including `border-info/40`/`border-warning/40`, text and titles; `StackPositionChip` is unchanged. (d) ContextMenu danger entries use `text-danger` in rest/hover/focus/active states, and the menu's existing unit and e2e expectations still hold. Proof: `bun test src/mainview/components/kanban`, `bun run typecheck`. | none | T7 imports `CardChip`/`CardStat`; StackBadge already rendered by `TaskCard`; ContextMenu by `App` |
| T6 | `PipelineHat` component | `src/mainview/components/pipelines/PipelineHat.tsx`, `src/mainview/components/pipelines/PipelineHat.test.tsx` | T1 interface (same wave) | Static markup tests: (a) the full name is rendered with no `truncate` class and with `[overflow-wrap:anywhere]`; (b) running → `bg-info/10`, `3/10`, step line `Implementing`; fan-out → `Implementing +2`; (c) gate → `Waiting for your review: <gate name>`; (d) blocked → warning tone and `Blocked: <step>` (`Blocked` when the block has no step); (e) done → `✓ Done`, success tone, no step line; (f) cancelled → muted tone, no line; (g) `data-testid="task-card-pipeline"`, `data-status={run.status}`, `title` = `"<name> — <countLabel> · <runsLabel>"` (no trailing separator when `runsLabel` is empty). Doc comment states the label rule (replaces `PipelineBadge.tsx:20-26`). Proof: `bun test src/mainview/components/pipelines/PipelineHat.test.tsx`. | none | T7 (`TaskCard` renders it above the body) |
| T7 | `TaskCard` as C1 | `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/TaskCardStatus.tsx` (new: identity line + status row), `src/mainview/components/kanban/TaskCardMeta.tsx` (new), `src/mainview/components/kanban/TaskCardActions.tsx` (new), `src/mainview/components/kanban/TaskCard.test.tsx` (new), `src/mainview/components/kanban/Column.tsx`, `src/mainview/components/pipelines/index.ts`, delete `src/mainview/components/pipelines/PipelineBadge.tsx` | T1–T6 | Markup matches §2.2 and §2.3; every hook in §2.2's "must survive" list is present. `TaskCard.test.tsx` (static markup inside a `DndContext`): (a) root has `role="group"`, `aria-label={title}`, `tabindex="0"`, the focus-outline classes, `cursor-grab`, `data-task-id`, and no `role="button"`; (b) the pipeline card renders `PipelineHat` and no profile/harness name; (c) the preview is `promptPreview(prompt)`, and no `<p>` renders for an empty preview; (d) no `shrink-0` on the agent/profile name, model, pipeline name, repo-branch span or any variable-text chip; (e) `⋯` has `aria-label`, `aria-haspopup="menu"`, `aria-expanded` from `menuOpen`, `data-testid="task-card-more"`; (f) no `amber-`, `bg-destructive` or `text-destructive` class anywhere in the card markup; (g) gate-pending markup has no Stop button; (h) archived markup has exactly one button besides `⋯`. Behaviour: Enter on the focused card root calls `onOpen` once; Enter on a nested button does not reach `onOpen`; Space on a nested button activates that button (activator ref = card root, keydown composes dnd-kit's `onKeyDown` with the card's own). `⋯` click calls `onContextMenu(task, { x: rect.left, y: rect.bottom + 4 })` and stops propagation. No `useConfirm` in `TaskCard`. Preview is memoised on `task.prompt`. `Column` passes `menuOpen={t.id === menuTaskId}` and compares `menuTaskId`. Each file < 250 lines. Proof: `bun test src/mainview/components`, `bun run typecheck`; geometry by T9. | state | `Column.tsx:85-103` renders `TaskCard`; `App.tsx:2861-2888` renders `Column` |
| T8 | App wiring: keyboard sensor, announcements, Stop confirmation, menu state for `aria-expanded` | `src/mainview/App.tsx` | T4 (wave 1); same-wave contract with T7 | (a) `sensors` = `PointerSensor` (`distance: 6`, unchanged) + `KeyboardSensor` with `keyboardCodes: BOARD_KEYBOARD_CODES` and `coordinateGetter: boardKeyboardCoordinates`. (b) `DndContext accessibility={{ announcements: makeBoardAnnouncements(titleOf, columnLabelOf), screenReaderInstructions: { draggable: BOARD_SCREEN_READER_INSTRUCTIONS } }}`, with lookups read from `tasksRef` and `COLUMNS`, memoised so `DndContext` props are stable. (c) `stopFromBoard` = confirm ("Stop this pipeline?" / "Live steps will be cancelled and the pending review dismissed. History is kept." / Stop / destructive) when `t.pipelineId`, then `cancel(t)`; a declined confirm calls nothing. (d) Column `onCancel={stopFromBoard}`, and `runTaskMenuAction`'s `stop` case calls `stopFromBoard`. `cancel` itself and every other caller of it are unchanged. (e) Columns receive `menuTaskId={taskMenu?.task.id ?? null}`. (f) A keyboard drop goes through the existing `onDragEnd` (pipeline refusal toast, optimistic move, 409 re-sync), with no second drop path. Proof: `bun run typecheck`; behaviour by T10/T11 e2e. | state, trust | Root component (`main.tsx` → `App`) |

Validation: within wave 1, T1–T6 own disjoint files (T6 only reads T1's pinned type). Within wave 2, T7 and T8 own disjoint files (`Column.tsx` belongs to T7; `App.tsx` to T8). Every task has a *wired by*. Every §1 criterion has a producing task (SC1/SC7 T5+T7, SC2 T1+T6+T7, SC3 T1, SC4 T3+T7+T8, SC5 T2+T7, SC6 T4+T7+T8, SC8 T12, SC9 T13).

## 5. Work breakdown — test tasks

Unit tests ship inside T1–T7 (table above). The e2e tasks run in wave 3.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| T9 | e2e | SC1, SC2, SC5, SC6 (contrast, labels), SC7, SC9 screenshots | `e2e/task-card-bounds.spec.ts` (new), `e2e/card-checks.ts` (new: the in-page checker ported from `docs/plans/task-card-ui-overhaul-mockup/checker.js`) | Seeds one real task per state via `POST /tasks` (isolation `none`, `workdir: tmpdir()`, synthetic strings from `task-card-ui-overhaul-mockup/states.mjs`). `page.route` on `GET /tasks` merges fixture fields by id: `pipelineId`/`pipelineRun` (10-step snapshot, loop history), `runningSubagents`, `openTerminalCount`, `todoProgress`, `sentFiles`, `fxRecovery` (paused + `autoResume`), `harnessState` (positions and `scheduledSwitch`), `pendingInteractionCount: 12`, `column`, `unread`, `archivedAt`, `agentProfile` (25-char name), `model`/`mode` (38-char), `branch`/`checkoutBranch`/`branchSource`, `repositories`. Sets the archived filter to "all". For theme light and dark (`PUT /preferences/theme` + reload): every seeded card passes `checkCards()`, which checks inside card (clip-aware), inside row, no sibling overlap, no text squeezed below 24 px, `[data-must-not-truncate]` (hat name, progress, title) uncut, buttons ≥ 24×24 with names, no `role=button` card, and contrast ≥ 4.5:1 except the archived card. The unread dot (`[data-card-overlay]`) and `AwaitingGlow` (`.animate-awaiting-pulse`) are exempt. A WebKit `describe` repeats the run. Each state is screenshotted to `test-results/task-card-bounds/<engine>-<theme>-<state>.png` and attached. **Must be able to fail:** one run against a deliberately broken copy (re-add `shrink-0` to the profile name, or pin the hat name with `truncate`) is observed red, then reverted; the task report quotes the failure. |
| T10 | e2e | SC4 retargets, the header spec | `e2e/binary-diff.spec.ts`, `e2e/at-file-autocomplete.spec.ts`, `e2e/pipelines-human-step.spec.ts`, `e2e/task-card-header.spec.ts` | `binary-diff:229-235` and `at-file-autocomplete:718` open diff via `card.getByTestId("task-card-more")` → `getByTestId("task-context-menu").getByRole("menuitem", { name: "View changes" })`. `pipelines-human-step:60-66` asserts gate-pending shows `Review` + `Open`, **no** visible Stop (`task-card-pipeline-stop` count 0, `button[title="Stop"]` count 0), no `Done`; and `⋯` → menu lists `Stop`. `:129` stops via `⋯` → menuitem `Stop` → confirm dialog `Stop`, with the same post-conditions (run `cancelled`, card in Ready, gates cleared). `task-card-header.spec.ts` is rewritten for C1: the title block is above the identity line, which is above the status row, which is above the preview; the profile name is `task-card-agent-profile` with `title=task.agent`; the header comment describes C1 and links `docs/architecture/task-card.md`. Each changed assertion is shown red against `main`'s card (or a reverted hunk), then green. |
| T11 | e2e | SC6 keyboard, SC4 menu by keyboard | `e2e/board-keyboard.spec.ts` (new) | (a) Tab to a backlog card; Enter opens its run panel. (b) Space → ArrowRight → Space moves it to Ready (`GET /tasks/:id` column `ready`). (c) Space → ArrowRight → Escape leaves it in Backlog. (d) A review card moved ArrowRight into Done, which may be scrolled off-screen at 1280 px: the column becomes `done` and the board scrolls to it. (e) Focus the card's `⋯` button and press Space: the task menu opens, no drag starts (no dnd-kit live-region "Picked up" text), and the card stays in its column. This proves the activator rule without spawning an agent. (f) A pipeline parent picked up and moved shows the "column is managed by its run" toast and keeps its column. (g) Tab to `⋯`; Enter opens `task-context-menu` with the first item focused and `aria-expanded="true"`; Escape closes it and focus returns to `⋯` (`aria-expanded="false"`). (h) The dnd-kit live region text contains the task title, not its UUID. |
| — | unit | per module | in T1–T7 | Listed in each task's acceptance. Every new test file is shown failing against a broken copy of its module at least once. |

**E2E applies**: the change is a user-visible flow in the webview, and the app runs locally under the repo's Playwright harness.

**Run recipe** (from the worktree root):

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                                     # the worktree has no node_modules yet
bun node_modules/@playwright/test/cli.js install chromium webkit # WebKit is new for this spec
bun run typecheck && bun test
bun node_modules/@playwright/test/cli.js test e2e/task-card-bounds.spec.ts e2e/board-keyboard.spec.ts \
  e2e/task-card-header.spec.ts e2e/pipelines-human-step.spec.ts e2e/binary-diff.spec.ts e2e/at-file-autocomplete.spec.ts
# then every spec that locates cards (unchanged hooks, but they render the new card):
bun node_modules/@playwright/test/cli.js test e2e/pipelines-run.spec.ts e2e/todo-progress.spec.ts e2e/sent-files.spec.ts \
  e2e/fx-recovery.spec.ts e2e/unread-indicator.spec.ts e2e/task-context-menu.spec.ts e2e/agent-profiles.spec.ts \
  e2e/agent-profiles-launch.spec.ts e2e/harness-stack-swap.spec.ts e2e/monitor-hold.spec.ts e2e/terminal-drift.spec.ts \
  e2e/multi-repo-task.spec.ts e2e/import-claude-sessions.spec.ts e2e/opencode-import.spec.ts e2e/board-scroll-position.spec.ts \
  e2e/fx-interactions.spec.ts e2e/opencode-harness.spec.ts e2e/cursor-ask.spec.ts
```

The `webServer` in `playwright.config.ts` starts Vite (`bun run hmr`). Backends come from the `e2e/fixtures.ts` `backend`/`freshBackend` fixtures (isolated data dir, `AGETOR_API_TOKEN`), so no seed data or credentials are needed. Run one Playwright invocation at a time (port collisions, HMR). Check `uptime` before long suites (repo memory: suites hang at load 30+).

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier: green before moving on |
| --- | --- | --- |
| 1 | T1, T2, T3, T4, T5, T6 | `bun run typecheck`, `bun test`. The old card still renders (it now reads the fixed progress label). |
| 2 | T7, T8 | `bun run typecheck`, `bun test`. Then a dev-build look (`bun run dev:hmr`, `~/.agetor-dev`) to confirm the card renders. Known red until wave 3: `pipelines-human-step.spec.ts` (Stop moved), `binary-diff.spec.ts`/`at-file-autocomplete.spec.ts` (Diff moved), `task-card-header.spec.ts` (old geometry). T10 turns them green. These are the only expected e2e failures at this barrier. |
| 3 | T9, T10, T11, T12 | The full run recipe in §5 is green: unit, the new and retargeted e2e, and the card-locating specs. |
| 4 | T13 | Owner check by eye, then PR. |

**T12 (docs, wave 3)** — owned files: `CLAUDE.md`, `docs/architecture/task-card.md` (new), `docs/architecture/task-context-menu.md`, `docs/architecture/pipelines.md`, `docs/architecture/unread-indicator.md`, `docs/architecture/agent-profiles.md`, `docs/architecture/harness-claude-code.md`, `docs/plans/task-card-header-rows.md`. Acceptance:
- `CLAUDE.md` *Webview* rules gain this bullet: "**A `TaskCard` change keeps every child inside the card in every state.** Run `e2e/task-card-bounds.spec.ts` (worst-case names, every badge, every action state, light and dark, Chromium and WebKit) before merging; it fails on any overflow. Layout contract: [task-card.md](docs/architecture/task-card.md)." The Topic map gains a `task-card.md` row: covers the 262/233 px budget, the C1 order, the chip-versus-stat rule, the hat, per-state actions + `⋯`, keyboard, and the bounds spec; read before touching `TaskCard*.tsx`, `PipelineHat.tsx`, `CardChip.tsx`, `StackBadge.tsx`, `task-card-actions.ts`, `prompt-preview.ts`, `board-keyboard.ts`.
- `task-card.md` holds §2.2, §2.3, the "no `shrink-0` on a variable-length element" rule, the "hooks e2e relies on" list, the keyboard map, the progress rule, and how to run the bounds spec and the mockup.
- `task-context-menu.md`: the card shows only primary actions, and `⋯` opens this menu at the button. Both sides read `taskActionFlags`. The menu's Stop confirms for a pipeline parent through `stopFromBoard`. Danger entries use `text-danger`.
- `pipelines.md:156`: the hat replaces the badge; distinct-step progress and `✓ Done`; run counts in the tooltip, the run-view header, `show` and `pipeline status`.
- `unread-indicator.md`: the dot stays on the card corner, over the hat on a pipeline card.
- `agent-profiles.md:47`: the identity line shows the profile name.
- `harness-claude-code.md:73`: paperclip count in the status row.
- `task-card-header-rows.md` starts with "Superseded by [task-card-ui-overhaul.md](task-card-ui-overhaul.md) (2026-11-18)".

**T13 (verify & deliver, wave 4)** — owned: this plan's `Status` field. Steps: run the full §5 recipe; collect `test-results/task-card-bounds/*.png` (light/dark × every state, Chromium and WebKit); the owner opens `bun run dev:hmr` and approves by eye (grill #14e). Then the PR: the body restates SC1–SC9 and carries the screenshots, with a note on the two flagged decisions in §8. Commit the planning docs (`docs/plans/task-card-ui-overhaul*.md`, `-grill/`, `-mockup/` sources only) as their own docs commit before the code.

**Delivery:** one PR on `fix/agetor-card-ui-improvement`, about 2,500 changed lines, mostly tests and the `TaskCard` split, reviewed commit by commit (one checkpoint commit per wave). T1 is its own commit at the head of wave 1, so the progress fix can be split into a separate PR if a reviewer asks. No cross-repo dependencies.

## 7. Invariants, runtime shape & risks

**Invariants**

- Every child of a card stays inside the card in every state — enforced at `e2e/task-card-bounds.spec.ts` (T9), kept by the CLAUDE.md rule (T12).
- The card's buttons and the task menu derive from one set of flags — enforced at `taskActionFlags` (`task-card-actions.ts`); `TaskCardActions` and `buildTaskContextMenu` both route through it.
- No action disappears from the board — enforced by the superset test in `task-card-actions.test.ts` (T3).
- Stopping a pipeline parent always asks first — enforced at App's `stopFromBoard`; the card's Stop and the menu's Stop both route through it; `TaskCard` has no stop logic of its own.
- Pipeline progress has one implementation — `pipelineStepProgress` (`src/shared/pipeline.ts`); every surface reads it.
- Prompts stay raw in storage; the preview is plain text produced only by `promptPreview`.
- A board move, by pointer or keyboard, goes through the single `onDragEnd` (pipeline refusal, optimistic move, 409 re-sync).
- New colour tokens exist in both themes and in `tailwind.config.js` — T5 acceptance (a).

**Runtime shape.** Single-user desktop process; no server, DB or migration change, so there is nothing to roll out, back-fill or kill-switch; rollback is a revert. The 2 s poll plus memo means the card re-renders only on a task change; the new `menuTaskId` prop re-renders columns only on menu open and close. No timers or subscriptions are added to the card.

**Blast radius.**
- `pipelineStepProgress`'s label changes in the board, run view, `agetor show/pipeline status/ls` and the TUI at once (intended; covered by T1 tests).
- ContextMenu danger colour changes for every menu (App task menu, `HandoffFileChip`, `HandoffArtifactChips`, `SentFilesCard`). It is a colour-only improvement.
- `PipelineBadge` is removed (one caller).
- Shared `AwaitingGlow`/`AWAITING_RING_CLASS`/`awaitingLabel` are untouched, so `StepNode` is unaffected.
- `StackPositionChip` is untouched.
- 23 e2e specs locate cards by `.cursor-grab`/`data-task-id`; both are kept.

**Risks.**
- WKWebView layout vs Chromium. Mitigated by the WebKit run in T9 and the owner's dev-build check.
- `KeyboardSensor` plus horizontal board scroll. T11 (d) covers an off-screen target column.
- `twMerge` and custom colour names. Today's `bg-amber-500` override already relies on this; T7 (f) checks the markup.

## 8. Open questions / assumptions

**Unratified one-way decisions:** none. Everything is rendering-only plus one pure shared function.

**Decisions made in planning, approved by the owner with the plan on 2026-11-18** (each is two-way and evidence-based; calls 1–4 were named in the approval question):
1. **Shared ContextMenu danger text → `text-danger`** (T5). It is 3.76:1 (light) and 1.77:1 (dark) today; `--danger` gives 4.70:1 and 6.59:1. Delete… lives only in this menu after the redesign. This touches a shared primitive that grill #20 did not list.
2. **"re-runs" instead of "loops"** in the run counts (T1). "Loops" has no exact definition when a run has two different cycles; re-runs = executions − distinct executed steps.
3. **`aria-expanded` on `⋯`** via a `menuTaskId` prop through `Column` (T7, T8): the ARIA menu-button pattern, at the cost of one more column prop.
4. **The bounds spec also runs in WebKit** (T9). It needs `playwright install webkit` once.
5. **The unread dot stays on the card corner**, over the hat on pipeline cards. The owner saw it in the mockup's pipeline states before picking C1.
6. **The button precedence is unchanged.** For example, a ready task with an earlier successful run shows `Open`, not `Run`, as today. The grill's state table is the common case of that precedence.

**Assumptions:**
- Playwright WebKit lays the card out like WKWebView. The owner's dev-build check is the backstop.
- The fixture-driven bounds spec (decision 9) represents real states, because the fields it sets are the same server-managed fields the existing specs prove the core produces.
- Measured contrast uses the app's tokens composited over the card; a future token change re-runs through T9's contrast check.

## 9. Completeness ledger

| Item | Disposition | Task / reason / who |
| --- | --- | --- |
| Header overflow (`shrink-0` on badge/profile/stack) | In this run | T7 (C1 has no fixed slots), proven by T9 |
| `13/10` and every consumer (board, run view, `show`, `pipeline status`, `ls`, TUI) | In this run | T1 |
| Execution count in tooltip, run-view header, `show`/`pipeline` | In this run | T1 (labels), T6 (tooltip) |
| Gate-pending and awaiting action overflow | In this run | T3 + T7 |
| Dark Done hole; amber literal | In this run | T7 (`bg-transparent`), T5 + T7 (`--warning-solid-foreground`) |
| Raw-markdown preview | In this run | T2 + T7 |
| Chip system, h-7 buttons, p-3, meta line, "polluted" chip row | In this run | T5 + T7 (C1: stats vs chips) |
| Focus ring, group role, aria-labels, keyboard open | In this run | T7 |
| Keyboard drag (Space/←/→/Esc) and announcements without UUIDs | In this run | T4 + T8, proven by T11 |
| Space on a nested button must not start a drag (dnd-kit activator) | In this run | T7 (`setActivatorNodeRef`), T11 (e) |
| Menu Stop skipped the pipeline confirmation | In this run | T8 `stopFromBoard`, T10 |
| Card Stop contrast (destructive 3.60:1 light) | In this run (owner decision) | T7 `--danger` |
| ContextMenu danger contrast (3.76 / 1.77) | In this run (flagged, §8.1) | T5 |
| Workdir line contrast (`/70`, 2.74:1) | In this run | T7 meta line uses full `muted-foreground` |
| Precedence mirror between card and menu | In this run | T3 (`taskActionFlags`, superset test) |
| `aria-expanded` on `⋯` / Column comparator | In this run (flagged, §8.3) | T7 + T8 |
| `PipelineBadge` removal + barrel re-export | In this run | T7 |
| e2e selectors that move (Diff ×2, gate Stop, header geometry) | In this run | T10 |
| `.cursor-grab` / `data-task-id` / badge titles and test ids kept | In this run | T7 acceptance, re-run in the §5 recipe |
| `StackBadge.test.tsx`, `pipeline.test.ts`, `pipelines.test.ts:1695`, CLI `show`/`ls`/`pipeline` tests, `task-context-menu.test.ts` | In this run | T5, T1, T3 |
| Bounds e2e for every state, light/dark, Chromium + WebKit, with screenshots | In this run | T9 |
| Keyboard e2e | In this run | T11 |
| Docs: CLAUDE.md rule + Topic map, `task-card.md`, `task-context-menu.md`, `pipelines.md`, `unread-indicator.md`, `agent-profiles.md`, `harness-claude-code.md`, superseded note on `task-card-header-rows.md` | In this run | T12 |
| `PipelineBadge` doc comment | In this run | Replaced by `PipelineHat`'s doc comment (T6) |
| Owner check by eye + PR screenshots | In this run | T13 gate |
| Planning docs (plan, grill, investigation, mockup sources) committed before code | In this run | T13 |
| Mobile companion card | Out of scope | Separate codebase and layout (owner, grill #23) |
| Wider or resizable columns | Out of scope | A different ticket in Column/App layout (owner, grill #19) |
| Agent-written prompt summary | Out of scope | A server feature; the preview stays a client transform (grill brief §3) |
| Shared `Button` `destructive` variant contrast app-wide | Out of scope | App-wide colour change outside the card; grill #20 keeps shared button variants untouched. The card works around it locally (T7) |
| Data backfill | None needed | Rendering only; progress recomputes from existing `history` |

## 10. Deviations during implementation

Small, two-way, recorded here so review sees them (owner has not separately ratified these):

1. **`executions` counts history records, not history plus `run.active.length`.** A live execution is already in `history` with `outcome: null` (`pipeline-runner.ts` pushes both), so the plan's formula double-counted it. `pipelineStepProgress` counts `taskId !== null` history records and adds only an active entry missing from history.
2. **The WebKit run is a Playwright project, not a `test.describe` with `test.use({ browserName })`.** Playwright refuses `browserName` inside a describe group. `playwright.config.ts` gains a `webkit` project with `testMatch: task-card-bounds.spec.ts`; every other spec stays Chromium-only.
3. **`onDelete`, `onDiff`, `onArchive` and `onUnarchive` are removed from `TaskCard`, `Column` and the `<Column>` call in `App.tsx`.** The card no longer has those buttons, so the props would be dead; the menu keeps using the same handlers through `runTaskMenuAction`.
4. **Identity line.** The identity text is `name · model · mode` in one truncating span, as §2.2 says; the plan's mockup variant omitted the mode.
5. **Blocked hat line** names the step the block is on (`run.blocked[].stepId`), falling back to the live step, then to the bare word `Blocked`.
6. **Bounds spec.** The worst-case pipeline state uses a 68-character pipeline name: with the plan's 26-character name a deliberately broken hat (`truncate`) still passed, so the check could not fail. With the longer name it fails as required.
