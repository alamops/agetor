# Investigation — Task card UI overhaul

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Change | Fix the broken kanban `TaskCard` (the screenshot) and improve the card against current UI/UX practice. This brief decides the scope, the header and action-row layout, and how pipeline progress should read before a plan is written. |
| Agents | none: research done inline (the pipeline step forbids sub-agents); 1 inline spike (headless Chromium geometry) |
| Flags | none |
| Branch | `fix/agetor-card-ui-improvement` (agetor worktree, base `4d7f8bfb`) |

## 0. The screenshot, described in text

The owner's screenshot is outside the repo (a Desktop file attached to the pipeline task), so here is what it shows. The card is a pipeline parent in **Review** with a `task` type (blue left border):

- **Row 1:** the blue `Inbox` type icon is partly covered by the green pipeline pill `⧉ Zebra Pipeline (No Audio) 13/10`. The blue `1/2` stack chip sits **outside the card's right border**.
- **Row 2:** a right-aligned `opus-5.5 · auto`, alone on its line.
- **Title:** `Acme Sync - Keep the inbox watched for the whole session` (2 lines).
- **Prompt preview:** raw markdown, `# Spec — Keep the inbox watched for the whole session | Field | Value | | --- |…`.
- `~/Projects/acme/acme-sync`, then `⑂ feature/acme-sync-inbox-sess…` with a `drifted` chip.
- **Actions:** `Open` (secondary), `Done` (outline, rendered **near-black** in dark mode), and diff and delete icon buttons. The icon buttons are taller than the text buttons.

## 1. What we know

### Root causes of the visible breakage

1. **The header row overflows the card on both sides.** Row 1 (`TaskCard.tsx:221`) is `flex items-center justify-between gap-2`:
   - The left cluster (`:222`) is `flex min-w-0 flex-wrap`, so it may shrink to **0 px**.
   - The right side is `PipelineBadge className="shrink-0"` (`:307`) followed by `StackBadge className="shrink-0"` (`:324-330`).

   `PipelineBadge` is built to truncate: its root is `min-w-0 max-w-full` and the name is `min-w-0 truncate` (`PipelineBadge.tsx:35-38`). The caller's `shrink-0` cancels that, so the pill keeps its full width. When the pill and the chip are wider than the ~225 px content box, free space goes negative and `justify-between` falls back to `flex-start`:
   - the left cluster collapses to 0 width;
   - the icon (`shrink-0`, overflow visible) is painted **under** the pill, 6 px overlap;
   - the stack chip lands **27 px past the card's right edge**. The `Card` has no `overflow-hidden`.

   The same happens with an agent-profile badge (`:309-317`, `shrink-0`) for any long profile name. Proved in §2.
2. **"13/10" is a counting bug, not a display bug.** `pipelineStepProgress` (`src/shared/pipeline.ts:1678-1700`) counts **executions** (`history.filter(outcome ∈ {succeeded, advanced-manually}).length`) and divides by the number of steps in the graph. A Code Review ⇄ Bug Fix loop re-runs steps.

   Prod DB, read-only (`sqlite3 -readonly ~/.agetor/agetor.sqlite`): task `0a1b2c3d…` (the screenshot task) has 10 steps and 13 succeeded executions. Code Review ran 3 times and Bug Fix twice; every other step ran once. Its `status` is `done`.

   Across all 120 `done` pipeline runs in prod, **107 (89%) show an inflated count**, up to 79 executions on a 9-step graph. Counting **distinct** succeeded steps would instead leave **15 done runs short of the total** (e.g. `9/10`), because a branch was never taken (review passed the first time, so Bug Fix never ran).

   A peer knowledge entry from 2026-09-29 (`3c8c2f41…`, "badge progress can read 6/4 with loops") predicted this from reading the code alone; this brief now confirms it at runtime.
3. **The gate-pending action row overflows the card.** When a human gate is pending, the row shows `Open`, `Review`, `Stop`, diff and delete. That needs about 273 px against 225 px of content, so the row overflows 48 px and Delete hangs 31 px outside the card (§2). The row is `flex gap-1` with no wrap and no overflow handling (`TaskCard.tsx:389`).

   The awaiting + running row (`Answer (N) →`, Stop, Archive, diff and delete icons) fits with **0 px** to spare. Any wider label (`Answer (12)`) overflows.
4. **Many count badges stack into a tall column.** When several count badges show (subagents, terminals, todo, sent files, fx-paused) next to a `shrink-0` agent badge and a stack chip, the `flex-wrap` left cluster is squeezed to about 67 px. The badges then wrap **one per line**, 5 rows tall (§2).
5. **The `Done` button looks like a hole in dark mode.** `variant="outline"` paints `bg-background` (`button.tsx:21`). In dark mode `--background` (240 10% 3.9%) is darker than `--card` (240 6% 10%) (`index.css:102-104`). Light mode is unaffected (both are white).
6. **The prompt preview shows raw markdown.** `TaskCard.tsx:340` renders `task.prompt` in a 2-line clamp. No markdown-to-plain-text helper exists in the repo (searched `strip-markdown|markdownToText|toPlainText|…`: no hits). `react-markdown@^10` and `remark-gfm@^4` are dependencies.

   In prod, 355 of 399 non-archived tasks have markdown-looking prompts (`#`, `|---`, fences, `**`). Pipeline and `/implement` prompts start with `# Spec…`, so most cards are affected.

### Other UI/UX findings (not "broken", but against good practice or repo rules)

- **Inconsistent button sizes.** `size="sm"` is `h-8` and `size="icon"` is `h-9 w-9` (`button.tsx:29-31`), so text and icon buttons in the same row differ by 4 px. The four icon buttons take 36 px each (≈160 px of the 225 px row).
- **Five chip styles on one card:**
  - pipeline pill: `text-xs`, `rounded-full`, filled, `font-normal`
  - agent badge: `text-xs`, `font-semibold`, `rounded-full`, `bg-secondary`
  - count badges: `text-[10px]`, outline, `rounded-full`
  - stack chip: `text-[10px]`, `rounded` (4 px), outline in info colour (`StackBadge.tsx:117-121`)
  - drifted chip: `rounded`, filled in info or warning colour (`TaskCard.tsx:377-380`)

  There is no single chip size or radius.
- **A repo-rule violation.** The amber Answer button uses literal palette classes, `bg-amber-500 text-amber-950 … focus-visible:ring-amber-500` (`TaskCard.tsx:426`). CLAUDE.md "UI conventions" says new UI must use semantic tokens. `--warning-solid` (amber-500) exists in both themes (`index.css:98,141`) and is mapped in `tailwind.config.js:70`. This is the only `bg-amber-500` left in `src/mainview` (it dates from `f5bf13c4`).
- **Information hierarchy:**
  - `model · mode` gets a line of its own, right-aligned (`:332-336`).
  - Workdir (`:358-363`) and branch (`:364-386`) are two separate 10 px mono lines.
  - The title has no clamp. Titles reach 128 chars in prod (average 33); at `text-sm` in 225 px that is about 5 lines.
- **Accessibility:**
  - The `Card` root receives dnd-kit's `attributes`: `role="button"`, `tabIndex=0`, `aria-roledescription="draggable"` and `aria-describedby` (dnd-kit `useDraggable` docs). It also contains real `<button>`s, which axe reports as `nested-interactive`.
  - The card has **no `focus-visible` style**, and `index.css` has no global focus ring.
  - **Enter/Space on a focused card does nothing.** Only `onClick` is wired, and the board registers only `PointerSensor` with `distance: 6` (`App.tsx:397`), with no `KeyboardSensor`.
  - Icon-only buttons have `title`, which is the accessible-name fallback, but no `aria-label`.
- **Prior owner decision to respect or reopen.** `docs/plans/task-card-header-rows.md` (2026-09-01, grilled and approved, PR #206) fixed the 3-row header:
  - row 1: type icon and count badges … harness badge
  - row 2: right-aligned `model · mode`
  - row 3: full-width title, deliberately **no title clamp**

  The overflow regression arrived later: `PipelineBadge` in row 1 with `shrink-0` came in #244 (2026-09-29), and `StackBadge` in row 1 in #295 (2026-11-09). That plan already listed "long harness alias in row 1, same `shrink-0` behaviour" as an accepted risk.

### Contract, standards, runtime

- **Contract:** the owner's one-line goal plus the screenshot. Both are outside the repo (Desktop file and pipeline prompt); §0 transcribes the screenshot. There is no spec or PRD. The plan should restate the acceptance bar in the repo.
- **Standards that apply:**
  - Semantic tokens only, never literal palette classes; a new token must land in both `index.css` and `tailwind.config.js` (CLAUDE.md "UI conventions").
  - Light and dark must both work (CLAUDE.md "Theme").
  - An overlay positioned `fixed` portals to `document.body` (CLAUDE.md "Webview").
  - Persisted data stays raw, and transformations are rendering-only and client-side (CLAUDE.md "Data"). A markdown-to-plain-text preview must therefore be a pure client-side helper.
  - `src/shared/` stays free of runtime imports. `pipelineStepProgress` lives there and is the single implementation for UI, CLI and TUI, so extend it rather than fork it.
  - CLI/TUI output of stored text goes through `terminal-text.ts`; the existing call sites already do (`ls.ts:221`, `Dashboard.tsx:779`).
  - The card's button precedence is mirrored in `buildTaskContextMenu` (`src/mainview/lib/task-context-menu.ts:76-140`; `docs/architecture/task-context-menu.md:7`). Keep them in sync.
  - The awaiting ring, glow and wording are shared with the pipeline `StepNode` "by construction" (`src/mainview/lib/awaiting.ts`, `components/ui/awaiting-glow.tsx`, `docs/architecture/pipelines.md:163`). Changing them changes the run-view canvas too.
  - Layout chrome state lives in `localStorage`, read synchronously (CLAUDE.md "UI conventions"). This matters only if the card gains a per-user density or expand toggle.
- **Runtime and trust shape:**
  - Single-user desktop webview (WKWebView); the board polls `/tasks` every 2 s.
  - `TaskCard` is `memo`'d: `App.tsx`'s `reconcileById` preserves `task` object identity, and `Column` has a custom comparator listing every callback prop (`Column.tsx:123-140`). A new callback prop must be `useCallback`-stable in `App.tsx` and added to that comparator.
  - No server, DB or route change is needed for any option in this brief. `pipelineStepProgress` is a pure shared function.
  - Untrusted text on the card: task titles, prompts and pipeline/profile names are user- or agent-written. React escapes them. A markdown-to-text preview must stay plain text, not HTML.
- **Fixed geometry.** A column is `w-72` (288 px) with `p-3` and a 1 px border (`Column.tsx:70`), so a card is **262 px**. After `border-l-4`, the right border and `p-4`, content is **225 px**. That is constant across window sizes.
- **Real string lengths in prod:**
  - pipeline names up to 26 chars (`My Implementation Pipeline`)
  - profile names up to 25 (`Exemplars Helper (Cursor)`)
  - harness ids up to 13 (`claude-backup`)
  - `model · mode` up to 35 (`opencode-go/deepseek-v4.1-flash · auto`)

## 2. What we proved

| Question | Verdict | Evidence (command → output / measurement) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does the current header markup overflow the card the way the screenshot shows? | **Yes** | Scratch HTML with the exact `TaskCard` classes in a `w-72 p-3` column, Tailwind compiled with the repo's own config, measured with Playwright Chromium. Screenshot case: row-1 `scrollWidth−clientWidth = 44`, stack chip **27 px past the card's right edge**, type icon covered by **6 px**, left cluster width **0**. | tailwindcss 3.4.19, Chromium (Playwright 1.62 cache), dark theme | `<scratchpad>/spikes/card-overflow/{card.html,measure.mjs,board.png}` |
| Does removing `shrink-0` from the `PipelineBadge` call site alone fix it? | **Partly** | Overflow 0 and the chip ends inside the card (−17 px = at the content edge). But the left cluster is still squeezed to 10 px, narrower than the 14 px icon. The cluster (or the icon) also needs `shrink-0`. | same | same |
| Long agent-profile name + stack chip | **Overflows** | `Senior Reviewer (Opus long)` + `2/3`: overflow 27 px, chip 10 px past the edge, icon covered by 6 px. | same | same |
| Gate-pending actions (Open, Review, Stop, 2 icons) | **Overflows** | Actions `scrollWidth−clientWidth = 48`; Delete's right edge **31 px past the card**. | same | same |
| Awaiting + running actions (`Answer (2) →` + 4 icons) | **Fits, with 0 px to spare** | Last button's right edge exactly at the content edge. | same | same |
| Every count badge plus agent badge plus stack chip | **Wraps badly** | Left cluster squeezed to 67 px; count badges wrap one per line, 5 rows tall. | same | same |
| Is "13/10" execution counting, and how common is it? | **Yes; 89% of done runs** | `sqlite3 -readonly` over `tasks.pipeline_run`: per-step counts for `0a1b2c3d…`; aggregate `done: 120 runs, 107 over-count, 15 short if distinct, max 79 executions`. | prod DB, read-only | queries in this brief |
| Would the existing tests notice a regression or a naive fix? | **No** (by reading) | `e2e/task-card-header.spec.ts` seeds only a plain `claude-code` badge (no pipeline, profile or stack chip, no "inside the card" bounds check). The `pipelineStepProgress` tests (`pipeline.test.ts:2208-2248`, `:3223-3236`) never repeat a `stepId`. The CLI tests (`show.test.ts:288`, `ls.test.ts:514,538`) use loop-free histories. | n/a | n/a |

The spike recipe can be re-run, and is reusable for geometry checks during implementation:
1. Copy `src/mainview/index.css` without its `@xyflow` import.
2. Compile it with `node <repo>/node_modules/tailwindcss/lib/cli.js -c <cfg extending tailwind.config.js, content=card.html>`.
3. Load `card.html` in Playwright Chromium and compare bounding boxes with the card rect.

The scratchpad is not durable, so treat the recipe as the artifact.

## 3. What we're assuming

- **The column stays `w-72`.** A wider column would hide the overflow without fixing it. If the owner wants wider or resizable columns, that is a different change (`Column.tsx` and App layout).
- **WKWebView lays these flex rules out like Chromium.** The e2e harness runs Chromium (`playwright.config.ts:94`). The geometry is plain flexbox with no WebKit-specific features. If WKWebView differs, the owner's dev-run check (`bun run dev:hmr`) is the backstop.
- **A pure client-side markdown-to-text preview is acceptable**: no server-side summary field, no change to the stored prompt. If the owner wants an agent-written summary instead, that is a server feature and out of this scope.
- **No DB, route or migration change.** True for every option here. Fixing the progress counter changes the CLI and TUI `steps:` label too, through the shared helper. That is intended, since they are wrong in the same way today.

## 4. What we must ask the owner

1. **Scope:** fix the breakage only, or do a full card redesign?
   - **Fix only:** header overflow, `13/10`, gate-pending overflow, dark-mode `Done` hole, the amber literal.
   - **Full redesign:** consistent chip system, button sizing, action overflow menu, plain-text prompt preview, title clamp, focus ring and keyboard open.

   The goal says "improve following best practices", and the owner usually picks the complete path; recommend the full redesign, but confirm.
2. **The 3-row header from 2026-09-01:** keep it or rework it? It is owner-approved and pinned by `e2e/task-card-header.spec.ts`, which asserts row 2 is right-aligned under the harness badge. Options:
   - keep the 3 rows and only fix overflow and truncation;
   - fold `model · mode` into a bottom meta line with workdir and branch, freeing a row;
   - a 2-row header: identity and status chips, then the title.
3. **Pipeline progress semantics** (affects board, run view, CLI and TUI):
   - **(a)** distinct completed steps / total: `10/10` for the screenshot, but 15 done runs would read `9/10`;
   - **(b)** (a), plus a done run reads `✓ Done` (or `10/10`) whatever was skipped;
   - **(c)** the current step's position along the path taken.

   Should the execution count (e.g. "13 step runs, 2 loops") appear in the tooltip or run view? Recommend (b) with the execution count in the tooltip.
4. **Pipeline pill content in 225 px:** when it doesn't fit, which gives way first, the pipeline name or the active step name (`3/10 · Implementing`)? Should the step name move to its own line (e.g. "▶ Implementing" under the title)?
5. **Action row:**
   - **(a)** one state-dependent primary button, plus an overflow `⋯` button that opens the existing right-click menu (`buildTaskContextMenu`), with Diff, Archive and Delete inside;
   - **(b)** keep every icon visible but compact (`h-7`) and allow wrapping;
   - **(c)** reveal secondary icons on hover or focus.

   Option (a) makes Delete two clicks and moves Diff behind a menu. e2e clicks `getByTitle("View changes (git diff)")` on the card in 2 specs.
6. **Prompt preview:**
   - strip markdown to plain text (drop heading markers, table pipes and rules, code fences, emphasis, link syntax);
   - show the first meaningful paragraph only;
   - or hide the preview for pipeline parents, whose prompts are long specs.
7. **Title:** keep full wrap (the 2026-09-01 decision) or clamp to 2–3 lines with the full title in a tooltip? Titles reach 128 chars, about 5 lines.
8. **Accessibility scope:** add a visible `focus-visible` ring and Enter/Space to open on the card? Also resolve the `role="button"` card that contains buttons, either by moving dnd-kit's attributes to a drag handle with `setActivatorNodeRef`, or by giving the card a non-button role? Keyboard dragging (`KeyboardSensor`) is a separate, bigger item: in or out?
9. **Density and look:**
   - tighten padding (`p-4` → `p-3`) and merge workdir and branch into one meta line (e.g. repo name + branch, full path in a tooltip);
   - one chip size and radius for every badge;
   - should the owner see an HTML mockup of 2–3 options before the plan is locked?

## 5. Completeness inventory

- **Callers and users of what changes:**
  - `src/mainview/components/kanban/TaskCard.tsx` (whole file). Rendered only by `Column.tsx:85-103`, which is rendered by `App.tsx`.
  - `PipelineBadge.tsx`: only used by `TaskCard.tsx:307` (`components/pipelines/index.ts:11` re-exports it).
  - `StackBadge.tsx`: used by `TaskCard.tsx:324`; `StackPositionChip` is used by the New Task and launch pickers. A shape change to `StackBadge` alone does not affect them.
  - `pipelineStepProgress` (`src/shared/pipeline.ts:1678`) is used by:
    - `PipelineBadge.tsx:28`
    - `PipelineRunView.tsx:525,967` (run-view header label)
    - `src/cli/commands/pipeline.ts:577`, `show.ts:165`, `ls.ts:221`
    - `src/cli/tui/Dashboard.tsx:779,911`
  - Badge, Button and Card primitives (`components/ui/{badge,button,card}.tsx`) are used app-wide. **Do not** change their variants globally to fix the card; use card-local classes or a new variant.
- **Entry points new code must be wired into:**
  - A new `TaskCard` callback prop (e.g. `onMoreActions` for a `⋯` menu) goes through `Column` props, `Column`'s memo comparator (`Column.tsx:123-140`) and a `useCallback` in `App.tsx`. The existing `onContextMenu(task, pos)` already opens the menu at a point (`App.tsx` task context menu), so a `⋯` button can call it with the button's rect, with no new prop.
  - A new pure helper (markdown to plain text) goes in `src/mainview/lib/<name>.ts` with a sibling `.test.ts`. If the CLI or TUI should share it, put it in `src/shared/`.
- **Propagation surface:**
  - e2e selectors that must survive or be retargeted together:
    - the `.cursor-grab` root locator, used by about 20 specs (`todo-progress`, `binary-diff`, `core-busy-banner`, `sent-files`, `monitor-hold`, `issue-task`, `opencode-import`, `task-switch-during-restore`, `unread-indicator`, `task-context-menu`, `fx-recovery`, `archived-history-retention`, `opencode-harness`, `load-earlier-anchor`, `backlog-collapse`, `agent-profiles`, `terminal-drift`, `pipelines-run`, `task-card-header`)
    - `data-task-id`
    - test ids: `task-card-pipeline`, `task-card-agent-profile`, `task-card-stack-badge`, `task-card-repositories`, `task-card-branch-drift`, `task-card-pipeline-review`, `task-card-pipeline-stop`, `sent-files-badge`, `fx-paused-badge`
    - button names: `Open`, `Run`, `Done`, `Answer`, `Review`, `Stop` (`pipelines-run`, `pipelines-human-step`, `import-claude-sessions`, `opencode-import`, `opencode-harness`, `board-scroll-position`)
    - `button[title="Stop"]` count 1 (`pipelines-human-step.spec.ts`)
    - `getByTitle("View changes (git diff)")` (`binary-diff`, `at-file-autocomplete`)
    - badge `title`s (`"N of M tasks done"`, `"N background task(s) running"`)
    - the `aria-label="Bug"` type icon and the `.rounded-full.bg-secondary` harness badge plus the 3-row geometry (`task-card-header.spec.ts`)
  - Unit tests:
    - `StackBadge.test.tsx`, which asserts class strings such as `border-info/40` and `border-warning/40`
    - `pipeline.test.ts:2208-2248, 3223-3236`
    - `mainview/lib/pipelines.test.ts:1695`
    - `cli/show.test.ts:288`, `cli/ls.test.ts:514,538`
    - `lib/task-context-menu.test.ts` (precedence mirror)
    - `lib/awaiting.test.ts`
- **Existing data to backfill:** none. Every change is rendering-only; the progress fix recomputes from the existing `history`.
- **Docs and config describing current behaviour:**
  - `docs/plans/task-card-header-rows.md` (historical; the new plan should say if it supersedes it)
  - `docs/architecture/task-context-menu.md:5-7` (card and menu precedence)
  - `docs/architecture/unread-indicator.md:9` (corner dot)
  - `docs/architecture/agent-profiles.md:47` (profile name on the badge)
  - `docs/architecture/harness-claude-code.md:73` (paperclip badge)
  - `docs/architecture/pipelines.md:163,171` (awaiting look shared with `StepNode`; Answer/Review landing)
  - the `PipelineBadge.tsx:20-26` doc comment (label format)
  - the `e2e/task-card-header.spec.ts` header comment
- **What the change would orphan:** if `model · mode` leaves row 2, the right-aligned row-2 span and its e2e geometry block go. A `⋯` menu would make the always-visible Archive, Unarchive and Delete icon buttons redundant on the card.

## 6. Runnability

- **Start locally:**
  1. `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`
  2. `bun install` (this worktree has **no `node_modules`** yet)
  3. `bun run dev:hmr` (Vite on 5173 + Electrobun, `AGETOR_DATA_DIR=$HOME/.agetor-dev`, API port 4318). Never point a branch build at prod `~/.agetor`.
  4. Seed pipeline, profile and stack cards in the dev DB to eyeball the overflow cases.
- **Tests:**
  - `bun run typecheck`
  - `bun test` (unit; component markup via `react-dom/server` `renderToStaticMarkup`, as `StackBadge.test.tsx` does, so a component-level unit test is possible without a DOM)
  - single file: `bun test src/shared/pipeline.test.ts`
- **E2E harness:** Playwright, `bun node_modules/@playwright/test/cli.js test e2e/<spec>.spec.ts` (never `bunx`); Chromium Desktop Chrome project (`playwright.config.ts:94`); one Playwright run at a time. Backend seeding via `POST /tasks` with `isolation: "none"`, as `e2e/task-card-header.spec.ts` does. Pipeline-run cards need the fake-driver pipeline fixtures used by `e2e/pipelines-run.spec.ts`.

## 7. Risks and blast radius

- **The precedence mirror.** Any change to which buttons show in which state must match `buildTaskContextMenu`, and its unit test pins the menu side.
- **Shared awaiting look.** Changing `AWAITING_RING_CLASS`, `AwaitingGlow` or `awaitingLabel` changes the pipeline run-view `StepNode`. Swapping the Answer button's amber literal for `bg-warning-solid` is card-local and safe.
- **Progress label change goes everywhere.** The board, run view, `agetor ls`, `show`, `pipeline` and the TUI all switch at once. That is desired, but it needs a loop-history unit test, which does not exist today.
- **Memo and perf.** The card re-renders only when `task` identity changes. Inline closures are fine because the props are already stable. Don't add per-card subscriptions or timers; `useCountdown` already ticks only while fx is paused.
- **dnd-kit.** Root listeners use `PointerSensor` with `distance: 6`, so button clicks never start drags. A new `⋯` popover must portal to `document.body` and stop propagation like the action row does (`:389`). Moving `attributes` and `listeners` to a handle changes what is draggable: the whole card today.
- **Theme.** Verify every new class in both light and dark (`Done` is a dark-only defect today).
- **Rollback.** Pure frontend plus one shared pure function; a single revert.
