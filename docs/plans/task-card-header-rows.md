# Plan — TaskCard header: 3-row layout

| Field | Value |
| --- | --- |
| Date | 2026-09-01 |
| Source | /implement request + screenshot (Desktop/Screenshot 2026-09-01 at 12.40.12 PM.png) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | fix/fix-task-card-header-ui (pre-existing agetor worktree branch) |
| Base SHA | e2d95dfa9f07d39bc8e6d5781b17788711ffdd8c |

## 1. Objective & success criteria

Restructure the kanban board task card's header (`CardHeader` in
`src/mainview/components/kanban/TaskCard.tsx`) from today's 2-column layout
(icon+title left, badge stack right) into 3 rows:

- **Row 1**: `[type_icon] [agents_badge] [shell_badge] [todo_badge]` … space-between … `[harness_badge]`
- **Row 2**: right-aligned `[model · mode]` (row collapses entirely when both absent)
- **Row 3**: `[task_title]` (full card width)

Everything outside `CardHeader` (unread dot, prompt preview, workdir, branch row,
action buttons) stays untouched. Success = new layout renders per spec, no badge
or tooltip lost, all existing e2e selectors still pass, typecheck green.

## 2. Context & constraints (Phase 1 findings)

- Current header JSX: `TaskCard.tsx:135-191`. Left cluster (`TypeIcon` + `CardTitle`)
  at :137-143; right `flex-col items-end` stack at :144-189 holding, in order:
  harness badge (:145-148), `model · mode` span (:149-153), terminal badge
  (:154-163), subagents badge (:164-173), todo badge (:174-188).
- The squeezed title in the screenshot is caused by the right badge stack taking
  horizontal space from the title (`flex-1` vs `shrink-0` column).
- `type_icon` = `taskTypeIcon(type.icon)` (`src/mainview/lib/task-type-icon.ts`),
  semantic color via `type.iconClass` (`text-info`/`text-danger`/`text-spike`).
  Its `mt-0.5` exists only to align with the title's first line — drop it when
  the icon moves into a badge row (`items-center` handles alignment).
- `agents_badge` = `Bot` + `runningSubagents` count, shown when > 0,
  `title="N background task(s) running"` — **e2e-load-bearing**
  (`e2e/monitor-hold.spec.ts:207,256`).
- `shell_badge` = `Terminal` + `task.openTerminalCount`, shown when > 0,
  `title="N open terminal(s)"` (only accessible label — preserve).
- `todo_badge` = `ListTodo` + `completed/total`, `text-success` when complete,
  `title="X of Y tasks done"` — **e2e-load-bearing** (`e2e/todo-progress.spec.ts:141`,
  `e2e/fx-interactions.spec.ts:196`).
- `harness_badge` = `Badge variant="secondary"` + `AgentIcon kind={task.agent}` +
  raw `task.agent` string (harness aliases fall back to claude-code glyph by design).
- `model`/`mode` = `[task.model, task.mode].filter(Boolean).join(" · ")`,
  `text-[10px] font-mono text-muted-foreground`, rendered only when at least one set.
- Title = `CardTitle` `text-sm break-words`, no clamp — keep behavior (full wrap);
  it now gets the full card width, which is the fix for the screenshot's
  one-word-per-line wrapping.
- Unread dot (`:120-134`) is a sibling of `CardHeader`, absolutely positioned on the
  card corner — untouched; visual overlap check with the row-1 harness badge is part
  of acceptance (dot sits half outside the card edge; header padding should clear it).
- Memoization: pure JSX/class reshuffle of already-read `task.*` fields — no prop or
  callback changes, so `memo(TaskCardImpl)` and `Column`'s comparator are unaffected.
- Conventions: semantic tokens only (no literal palette classes); badge idiom is
  `variant="outline"`, `text-[10px]`, icon `size-3`, count, `title` tooltip.
- No `data-testid` in TaskCard; e2e keys off `.cursor-grab`, exact title text, and
  `title` attributes — all layout-independent. DOM order of title vs. prompt
  paragraph doesn't matter to specs as long as both render inside the card.
- Unit tests in this repo are pure-function tests (`src/mainview/lib/*.test.ts`) —
  there is no React component-rendering harness, and this change introduces none.
- E2E harness: Playwright under `e2e/` — run with
  `bun node_modules/@playwright/test/cli.js test <spec>` (never `bunx`), one
  Playwright run at a time, no concurrent dev/HMR session.

## 3. Approach & key decisions

- Pure JSX restructure inside `CardHeader` (lines 135-191). No state, props, data,
  or server changes. No new components.
- Row 1: `flex items-center justify-between gap-2`; left cluster
  `flex min-w-0 items-center gap-1.5` holding type icon + the three conditional
  count badges (order: agents, shell, todo — owner-confirmed todo placement);
  harness badge `shrink-0` on the right.
  - Badge order changes from today's DOM order (shell before agents) to the spec's
    (agents before shell) — deliberate, per the requested layout.
- Row 2: rendered only when `task.model || task.mode`; `flex justify-end` wrapper
  around the existing span (unchanged classes/format).
- Row 3: `CardTitle` keeps `text-sm break-words`, drops `min-w-0 flex-1`
  (no longer in a flex row).
- Vertical rhythm: rely on `CardHeader`'s base column layout; implementer checks
  `src/mainview/components/ui/card.tsx` base classes and, if needed, tightens
  spacing (e.g. `space-y-1` / `gap-1`) to match today's compact density.
  **Decision rests on reading, not spike** — trivial CSS, verified by e2e + eyes.
- All `title` tooltip strings, icons, conditional rendering guards, and semantic
  color classes are moved verbatim, not rewritten.

## 4. Work breakdown — implementation tasks

- **T1** — Restructure `CardHeader` into the 3-row layout.
  - Owns: `src/mainview/components/kanban/TaskCard.tsx` (only file).
  - Scope: lines 135-191 only; everything else in the file untouched.
  - Acceptance: layout per §1; all five header elements + todo badge present with
    verbatim `title` attributes and guards; semantic tokens only; typecheck green.

## 5. Work breakdown — test tasks

- **TT1** — New Playwright spec `e2e/task-card-header.spec.ts`.
  - Owns: `e2e/task-card-header.spec.ts` (new file only).
  - Seeds a task (via the existing e2e fixtures/backend, `isolation: none`) with a
    `bug` type, `model`, and `mode`; asserts on the board card (`.cursor-grab`):
    1. type icon (`aria-label`) and harness badge render, and their bounding boxes
       overlap vertically (same row), icon left of badge;
    2. `model · mode` text renders below row 1 (its `y` > row-1 elements' `y`);
    3. title renders below the model·mode row and starts at the card's left content
       edge (x ≈ type icon's x), i.e. full-width row 3;
    4. badge tooltips that are seedable without live runs are asserted by `title`
       attribute presence where applicable.
  - Robustness: y-ordering + presence assertions only (no pixel-tolerance
    geometry), per the repo's e2e flake caveats. Runtime-dependent badges
    (subagents/terminals/todo) stay covered by the existing
    `monitor-hold`/`todo-progress` specs — not duplicated here.
- **E2E applicability**: applies (user-visible UI in the webview; harness exists).
  Unit layer: not applicable — no component-render harness exists and the change
  has no extractable pure logic; existing `lib` unit tests are unaffected but run
  anyway as regression.

## 6. Execution waves

- **Wave 1**: T1 (single agent, `implementation` runner: claude/sonnet).
- Phase 5: code review (claude/opus) of `git diff <base>...HEAD`.
- **Wave 2**: TT1 (single agent, `tests_creation` runner: claude/sonnet) —
  file-disjoint from T1, runs after review so the spec targets the final DOM.
- Phase 7 (`tests_running` runner: claude/haiku): `bun run typecheck`, `bun test`,
  then targeted Playwright: `task-card-header.spec.ts`, `todo-progress.spec.ts`,
  `monitor-hold.spec.ts`, `unread-indicator.spec.ts` (the specs that touch card
  header selectors). Full e2e suite is skipped deliberately: serial-only Playwright
  + known load-flakes make the targeted set the higher-signal regression net for a
  header-scoped change.

## 7. Blast radius & risks

- Single component; no callers/contract changes. Board-only surface (RunPanel
  header is a different component, untouched).
- e2e selector risk: none identified (selectors are layout-independent), but the
  three selector-bearing specs run in Phase 7 to prove it.
- Visual risks: unread-dot/harness-badge corner proximity; long harness alias in
  row 1 (same `shrink-0` behavior as today — parity, not regression). Checked
  visually via the new spec's screenshots on failure + owner's dev run.
- Rollback: single-file revert.

## 8. Open questions / assumptions

- Todo badge placement — **resolved by owner**: row 1 left cluster, after shell badge.
- Assumption (low risk): keep title full-wrap (`break-words`, no clamp) — now that
  it owns a full row, the screenshot's pathological wrapping disappears; clamping
  is a separate design decision nobody asked for.
- Assumption (low risk): row 2 collapses when model & mode are both null
  (mirrors today's conditional span).
