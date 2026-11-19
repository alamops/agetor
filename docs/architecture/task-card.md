# Task card (board)

> The kanban `TaskCard`, layout **C1**. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map). Origin: `docs/plans/task-card-ui-overhaul.md` (decisions, measured mockup, rejected layouts A, B, C and C2).

The card was broken because the header put a pipeline pill, a profile badge and a stack chip with caller-supplied `shrink-0` in a `justify-between` row: free space went negative, the left cluster collapsed to 0 px and the stack chip landed outside the card. C1 has no fixed-width slot beside variable text, so no long name can push a sibling out.

## Width budget

`Column` is `w-72 p-3` (262 px of card, including a 1 px border). The card has a 4 px left border, a 1 px right border and `p-3`, which leaves **233 px of content**. Columns stay `w-72`. The card has no `overflow-hidden` (the awaiting glow and unread dot paint outside it on purpose), so clipping can never hide a bug.

## Layout (top to bottom)

```
PipelineHat   (pipeline parent only)  status-tinted band, full-bleed
title         type icon inline first, then the title; wraps, never clamped
identity      agent · model · mode, ONE truncating text line
status        quiet stats (icon + number), then chips (stack, fx pause)
preview       first prose paragraph of the prompt, 2 lines, or no line
repo · branch truncating; drift chip wraps to its own line
actions       primary button(s) + ⋯
```

- **Root** is `role="group"` with `aria-roledescription="draggable task"`, `aria-label={title}` and `tabIndex=0`. It is not a button, because it holds buttons. It keeps the `cursor-grab` class and `data-task-id`, which 23 e2e specs locate cards by (an archived card swaps `cursor-grab` for `cursor-default opacity-60`). An archived card can't be dragged: it is named `<title> (archived)`, carries no drag description or role description, and is never `aria-disabled` (dnd-kit stamps it from `disabled`, and on a group it would mark the card's Open and `⋯` buttons disabled too). The focus outline is `focus-visible:[outline-style:solid] outline-2 outline-ring`: `cn`'s tailwind-merge 3 follows Tailwind v4 and drops v3's `outline` beside `outline-2`, which leaves the browser's own ring.
- **Unread dot** (`data-card-overlay`) sits on the corner, over the hat on a pipeline card. **`AwaitingGlow`** is the last child. The awaiting ring and glow are the shared ones from `lib/awaiting.ts` and `components/ui/awaiting-glow.tsx`; the pipeline `StepNode` uses them too, so don't change them for the card.
- **Identity.** A pipeline parent shows model · mode only (the profile is per step). A profile shows its name (`task-card-agent-profile`, the harness id as tooltip). The identity text is one `truncate` span.
- **Chip versus stat.** `CardChip` (`h-5`, 10 px, fully rounded, bordered) is used only where colour carries meaning: the account stack (`StackBadge`), an fx pause and the branch-drift marker. Activity counts (background tasks, terminals, todo progress, sent files) are `CardStat`: icon + number, no border. Variable text inside a chip sits in an inner `truncate` span.
- **The rule that keeps the card whole:** never put `shrink-0` on a variable-length element (a name, a model, a branch). Fixed-size things only: icons, a count, the separator dot, buttons, the drift chip. The repo name is bounded by `max-w-[45%]`.
- **Preview.** `promptPreview(prompt)` (`lib/prompt-preview.ts`) is rendering-only: it drops front matter, headings, tables, fences, rules and HTML comments, takes the first prose paragraph, strips inline markdown and caps at 280 characters. Inline stripping runs on a bounded prefix (the emphasis pattern is quadratic), and the cut is moved to the close of any link, image or code span it fell inside when that close is within 8 KB, so a presigned URL never previews as raw `[text](https://…`. A span that closes farther away is left cut: it is not worth a quadratic scan. A prompt with no prose falls back to its stripped text, and an empty result omits the line. Stored prompts stay raw.
- **Tokens.** Colour comes from semantic tokens only. Answer is `bg-warning-solid text-warning-solid-foreground`; Stop is `bg-danger text-danger-foreground` (the shared `destructive` variant is 3.60:1 with white text in light mode); Done is `bg-transparent` (the outline variant paints `bg-background`, a hole in dark mode). A new token goes in `index.css` (both themes) and `tailwind.config.js` together.

## Pipeline hat

`PipelineHat` shows the full pipeline name (wraps), progress on the right and a step line. Progress is `pipelineStepProgress` ([pipelines.md](pipelines.md)): `n/total` over distinct steps, or `✓ Done`. Tooltip: `<name> — <progress> · <N step runs · M re-runs>`; a run with no snapshot yet (idle, before its first Run) leaves the count out of the band and the tooltip, and the run view header hides it too, so there is no `0/0` and the tooltip is `<name>` plus any run counts. Tones: running and review `info`, blocked `warning`, done `success`, cancelled and idle muted.

## Actions

`cardActions(task)` (`lib/task-card-actions.ts`) lists the visible buttons, first match wins:

| State | Visible | In `⋯` |
|---|---|---|
| archived | Open | Unarchive, Diff, Delete… |
| pipeline gate pending | Review · Open | Stop (confirms), Diff, Delete… |
| awaiting (pending interactions or `blocked`) | `Answer (N)` / `Answer` / `Review` (Answer drops its trailing arrow when `Done` shares the row, an awaiting task in Review: the row is 8 px too wide in WebKit with it) | Stop when stoppable, Stop & archive…, Diff, Delete… |
| stoppable | Stop | Stop & archive…, Diff, Delete… |
| openable or imported | Open | Diff, Delete… |
| otherwise | Run | Diff, Delete… |
| + review column, no gate, not an unfinished pipeline | adds Done | Mark done |

`⋯` opens the task context menu at the button ([task-context-menu.md](task-context-menu.md)). Every button is `h-7`. `taskActionFlags` is the one source for both the card and the menu, and `task-card-actions.test.ts` proves the menu offers everything the card used to show. Stopping a pipeline parent confirms in App's `stopFromBoard`, which the card's Stop and the menu's Stop both call. `e2e/task-card-stop.spec.ts` proves both paths confirm, that declining stops nothing, that a plain task stops in one click with no dialog, that pressing Stop or `⋯` never also opens the card (the action row stops its clicks; a pipeline card's open target is its run view, so that is what the spec checks), and that a second click on `⋯` closes its menu instead of reopening it. `TaskCard.test.tsx` pins the Answer arrow rule in both directions.

## Keyboard

| Key | Does |
|---|---|
| Tab | reaches a card (visible focus outline) |
| Enter on the card | opens it (on a nested button, activates that button) |
| Space | picks the card up |
| ← / → | moves it to the previous / next column (the board scrolls to it) |
| Space | drops it, through the same `onDragEnd` as a pointer drop |
| Escape or Tab | puts it back (Tab keeps focus on the card; a second Tab moves on) |
| a click elsewhere, or focus leaving the card | puts it back |
| Enter while held | ignored: the task does not open out from under the drag |

dnd-kit's keyboard sensor listens on the **document**, so a drag that outlived the card's focus would keep taking Space and the arrows typed anywhere else (the run panel's composer). That is why Tab cancels. dnd-kit itself cancels only on its cancel codes, a window resize and a hidden tab, so while a card is held `TaskCard` listens (capture phase) for a `pointerdown` anywhere (the held card and its buttons included, or a card that stayed held while its Run button acted would keep taking keys) or a `focusout` that lands outside the card and calls `cancelBoardDrag`, which dispatches a keydown with a private code, `BOARD_CANCEL_CODE`, listed in `BOARD_KEYBOARD_CODES.cancel`. It is not a synthetic Escape: the run panel's own document Escape handler would act on that too. Those listeners leave with the card, so a held card that unmounts calls `cancelBoardDragIfGone` (a microtask later): when no element carries its `data-task-id` any more (deleted or archived elsewhere) the drag is cancelled, and a card that only changed columns keeps it. For the same reason App sets `data-board-drag` on `<body>` from `onDragStart` until `onDragEnd`/`onDragCancel`, and the run panel's Escape handlers (the panel close and the message-search close) skip while it is set (`BOARD_DRAG_SELECTOR`), so the Escape that puts a card back does not also close the open panel or its search bar. dnd-kit's `RestoreFocus` re-focuses the card a frame after a keyboard drag ends with focus elsewhere, which would undo a focus-leave cancel (Cmd/Ctrl+F to the board search), so App passes `accessibility.restoreFocus`: `false` from `onDragCancel` (the same batched update that ends the drag) and `true` again from `onDragStart`. A drop into another column remounts the card and still gets the restore. `lib/board-keyboard.ts` holds the key codes, the coordinate getter and the announcements; App wires them (`KeyboardSensor`, `DndContext accessibility`). The card root is the sensor's **activator node** (`setActivatorNodeRef`): dnd-kit starts a keyboard drag only when the key event's target is that node, so Space on a nested button (like `⋯`) activates the button instead. Announcements name the task and the column, never the task id.

## Hooks e2e relies on

Keep these: root `cursor-grab` and `data-task-id`; test ids `task-card-pipeline` (on the hat, with `data-status`), `task-card-agent-profile`, `task-card-stack-badge`, `task-card-repositories`, `task-card-branch-drift`, `task-card-pipeline-review`, `task-card-more`, `sent-files-badge`, `fx-paused-badge`; the stat titles `"N of M tasks done"` (text `N/M`), `"N background task(s) running"`, `"N open terminal(s)"`; the button names `Run`, `Stop`, `Open`, `Done`, `Answer`/`Answer (N)`, `Review`; `data-part` markers (`title`, `identity`, `status`, `preview`, `meta`, `actions`).

## Guardrail

`e2e/task-card-bounds.spec.ts` drives the real board through every state (backlog, worst-case names with every badge, running, awaiting with `Answer (12)` in Running and in Review (next to `Done`), review, done, archived, multi-repository, raw-markdown prompt, and the pipeline states running, gate, done and blocked), in light and dark, in the `chromium` and `webkit` Playwright projects. `e2e/card-checks.ts` fails the run when a child leaves the card, spills out of its row, overlaps a sibling, is squeezed below 24 px, when the hat name, progress or title is cut, when a target is under 24×24 or an icon button has no `aria-label`, when a button nests in a `role="button"`, or when text contrast drops below 4.5:1. Each state is screenshotted to `test-results/task-card-bounds/`.

```bash
bun node_modules/@playwright/test/cli.js install chromium webkit   # once
bun node_modules/@playwright/test/cli.js test e2e/task-card-bounds.spec.ts
```

The design-gate mockup (renderers for A, B, C, C1 and C2 plus the original checker) is in `docs/plans/task-card-ui-overhaul-mockup/`; `README.md` there says how to rebuild it.
