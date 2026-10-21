# Plan — Keep the board's scroll position across pipeline pages

| Field | Value |
| --- | --- |
| Date | 2026-10-20 |
| Source | Pipeline goal ("the board position resets every time we open a pipeline task or pipeline and navigate back"), `docs/plans/board-scroll-position-investigation.md`, `docs/plans/board-scroll-position-grill.md` (D1–D19) |
| Flags | none |
| Gates | grilled + approved by owner (D1–D19); plan approved by owner as written, including the §8 extensions A1–A4 (2026-10-20) |
| Branch | `fix/fix-board-position-scroll-reset` (already checked out at planning time) |
| Base SHA | `b2cacb1` (HEAD at planning time; re-confirm when execution starts) |

## 1. Objective & success criteria

Since Pipelines (#244, `6cd0241`), going to any pipeline page unmounts the board, so `.kanban-scroll` comes back at `0,0`. The Pipelines list and the run view's side panel reset the same way. This change makes all three remember their position for the app session.

Success means every behavior the owner decided works:

1. **Board, both axes (D1, D3, D4, D10).** After any trip to a pipeline page (run view, Pipelines list, editor) and back by any return path (run view Back, Pipelines Back, Escape, the pipeline task vanishing, deleting it from its run view), the board shows the exact `scrollLeft`/`scrollTop` it had when the user left. The browser clamps a value that no longer fits.
2. **Reveal (D5–D9).** Only when the user left from a pipeline-parent card (card body, its Open button, its amber Answer/Review button, or right-click → Open pipeline), and only on the first return to the board: after restoring the offsets, if that card is rendered and **entirely** outside the scroller's visible area, scroll instantly by the minimum distance on both axes to show it. A card that is partly visible doesn't move. A card that is filtered out, archived or deleted means offsets only. A multi-hop trip (card A → toast → run view B → Back) reveals A.
3. **Pipelines list (D11).** One vertical offset for the session, restored once the list has rendered. On a cold cache it waits for the first load.
4. **Run-view side panel (D12–D14).** Per pipeline task id: the exact offset comes back only when the run is unchanged since the user left. Otherwise the panel starts at the top. The Goal toggle and the expanded history rows always come back, keyed by run generation + `seq`, so after a Restart every row starts collapsed.
5. **Session-only (D2).** Nothing goes to `localStorage`. A reload starts everything at the top.
6. **Done bar (D17).** (a) New Chromium e2e for every behavior above. (b) Bun unit tests for the pure helpers. (c) `bun run typecheck` green and the existing related e2e green. (d) One one-off Playwright WebKit run of the new specs, with an uncommitted config. (e) An owner manual smoke in `bun run dev:hmr` (`~/.agetor-dev`) using the checklist in §5.

## 2. Context & constraints

**Root cause and mount timing** (investigation §1, re-read for this plan):

- `src/mainview/App.tsx:203-206` defines `AppView`. `:211-220` `viewMountKey` gives each page its key. `:271` holds `view` state. `<main>` renders one page at a time under `<AnimatePresence mode="wait">` (`:2373-2558`): board `:2374-2477`, Pipelines list `:2479-2502`, editor `:2504-2535`, run view `:2537-2557`. Every page uses `transition={{ duration: 0.18 }}` and `initial={{ opacity: 0, y: 8 }}`. With `mode="wait"`, the entering page mounts only after the leaving page's 0.18 s exit, so a restore has to run **when the scroller mounts**, not in `navigate`.
- The board's only scroller is `<div className="kanban-scroll absolute inset-0 overflow-x-scroll">` (`App.tsx:2425`). It scrolls both axes. Its horizontal scrollbar is a classic 10 px bar (`src/mainview/index.css:148-164`), so the visible area is the element's **client** box. There's no `scroll-behavior: smooth` anywhere, so programmatic writes are instant.
- The board's content is complete on its first commit after a remount, because `tasks` and every filter are `AppInner` state (`:274-279`, `visibleTasks` `:1574-1594`, `visibleColumns` `:1596-1599`).
- `src/mainview/main.tsx:9` wraps the app in `<StrictMode>`. The e2e runs against the Vite dev server (`playwright.config.ts` `webServer: bun run hmr`). On an element's initial mount, React 19 StrictMode calls a ref callback, then its cleanup, then the callback again, and does the same for layout effects. Any mount-time restore must therefore be **idempotent**.

**Navigation callers** (all in `App.tsx`):

- `navigate` `:417-438` → `switchView` `:387-404`. The `onNavigated` callback runs only once the switch commits, and never when a leave guard or discard confirm is cancelled.
- `openPipelineRun(taskId)` `:479-484` is called by `openTask` `:543`, the context-menu `open-pipeline` action `:2070-2072` and RunPanel's strip `:2589`.
- `openPipelineAttention(parentId, opts?)` `:501-513` is called by `openAttention` `:557-563`, the OS-notification `open_task` handler `:1156`/`:1168`, and the "Waiting on you" / "Pipeline needs you" toasts `:1347`/`:1533`.
- `openPipelineStep` `:523-528` is used by the step-named toasts.
- `openTask(t)` `:541-550` is shared by board cards (Column `onOpen` `:2438`), the event toasts' `onOpen` `:1289-1294` (the "Pipeline finished" toast `:1492` uses it), the OS notification `:1157`/`:1169`, and the Worktrees dialog `:2629`. Because non-card callers share `openTask`, the card origin **cannot** be inferred inside it.
- `openAttention` has exactly one caller: Column `onOpenAttention` `:2439`.
- `openTaskMenu` `:2046-2048` is only ever wired to board cards (Column `onContextMenu` `:2446`), so the menu's `open-pipeline` action is always a card origin. `buildTaskContextMenu` offers it for every pipeline parent (`src/mainview/lib/task-context-menu.ts:98-99`).
- Return paths: run-view Back `:2554` (direct `setView`), Pipelines Back `:2492`, Escape `:1096-1112` (not attached on the board or the editor), the pipeline task vanishing `:927-931`, deleting from the run view `:1932-1934`, and the editor's own `onBack`/`onSaved` `:2522-2530` (back to the list).

**Board card:**

- `src/mainview/components/kanban/TaskCard.tsx:114-153` renders the root `<Card>`, which forwards props (`components/ui/card.tsx:4-12`). It has no task-id attribute today, and no `data-task-id` exists anywhere in `src/` or `e2e/`.
- The card body's `onClick` → `onOpen` is at `:127`. The buttons are at `:315-341`: the archived "Open" → `onOpen`, the amber Answer/Review → `onOpenAttention`, and "Open" → `onOpen`.
- Column passes both callbacks through, and its memo comparator compares their identity (`Column.tsx:110-126`), so replacement callbacks must be `useCallback`-stable.

**Pipelines list:**

- `src/mainview/components/pipelines/PipelinesPage.tsx:30` calls `usePipelines()`. The scroller is `:102` (`min-h-0 flex-1 overflow-y-auto p-4`). The "Loading pipelines…" branch is at `:118`.
- `usePipelines` (`src/mainview/lib/pipelines.ts:68-100`) has a module cache that never resets after the first load (`:31-48`). App warms it at boot (`App.tsx:315`), so in practice the cold-cache branch only matters if that boot fetch is still pending or failed.

**Run view** (`src/mainview/components/pipelines/PipelineRunView.tsx`):

- `showGoal` `useState(false)` is at `:275`. Data arrives asynchronously from `api.getPipelineRun` inside `load` (`:316-399`); `setTask` and `setSteps` happen in one batch.
- Until the first result, the view renders "Loading pipeline run…" (`:810-816`), so the side panel element **first mounts on the first data commit**.
- Side panel `:981`, Goal toggle `:983-997`, Blocked section `:999-1060` (`AnimatePresence initial={false}`), "Awaiting review" section `:1063-1101` (derived from step-task columns), History `:1103-1112`, rendered newest-first with `key={record.seq}` (`:1109`).
- `HistoryRow` `:1181-1237` keeps local `open` state (`:1182`).
- Types (`src/shared/types.ts`): `PipelineRunState` `:685-704` (`startedAt: number | null`, `status`, `active`, `blocked`, `history`), `PipelineBlock` `:573-587`, `PipelineActiveStep` `:553-559`, `PipelineStepRecord.seq` `:654-660`, `COLUMNS` `:249-256` (backlog, ready, running, blocked, review, done).

**Spike verdicts** (investigation §2; WebKit 26.5 and Chromium 151 under Playwright 1.62.1):

- Writing `scrollLeft`/`scrollTop` synchronously right after the new element is inserted sticks, including under motion's initial `opacity:0; translateY(8px)`: `[300,650]`, `[333,777]`.
- A remount without a restore comes back at `[0,0]`.
- A hidden scroller reads `[0,0]`, so offsets must be saved on scroll and never read at unmount.

**Test harness:**

- Playwright, Chromium only (`playwright.config.ts`), Desktop Chrome 1280×720. Vite on `:5173` is started by `webServer`, with one headless backend per worker (`e2e/fixtures.ts`). `freshBackend` (`:560`) gives each test its own backend, and `backendEnv` passes env to it.
- `gotoApp` (`e2e/helpers.ts:57`) seeds `onboardingDismissed`.
- Pipelines are seeded over REST with the fake claude driver (`e2e/pipelines-run.spec.ts:70-200`). That file uses `boardCard` `:208`, `gotoAppSubscribed` `:1180` (wait for `/events` before a toast can fire), and the toast pattern `[data-sonner-toaster] [data-sonner-toast]` + "Open" button (`:1406-1412`). Those helpers are module-private.
- No jsdom/testing-library exists, so rendering behavior is tested in Playwright and pure logic with `bun test`.
- WebKit builds `webkit-2336`/`webkit-2359` are installed in `~/Library/Caches/ms-playwright`.

**Environment:**

- The worktree has no `node_modules` yet, so run `bun install` first, with `PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- Three unit tests already fail on `main` (tmux-socket ×2, reconcile-cancel).
- Run only one Playwright invocation at a time.

## 3. Approach & key decisions

**Approach A (D4): save each offset as the user scrolls, and write it back when the scroller mounts again.** The board keeps its fade/slide transition, and `AppView`/`viewMountKey`/`navigate` stay as they are. Each decision below is marked as resting on evidence [E] or on reasoning [R].

- **K1 — Board restore at mount, through a stable callback ref** [E: spike; R: StrictMode].
  - `.kanban-scroll` gets `ref={boardScrollerRef}`, where `boardScrollerRef = useCallback((el) => {…}, [])`. Its identity must be stable: an unstable ref would re-run on every 2 s task poll and yank the board back mid-scroll.
  - On attach, the ref calls `restoreBoardScroll(el)`, which does four things in order. (1) Write the saved offsets. (2) Take (and clear) the departure record. (3) If that card is rendered and entirely out of view, add the minimum delta. (4) **Save the resulting offsets synchronously.**
  - Step 4 is what makes StrictMode's second ref call idempotent. Without it, the second call would write the pre-reveal offsets back, because the async `scroll` event that would have saved the revealed position fires after the commit.
  - Offsets are saved from `onScroll` only, never read at unmount.
- **K2 — The departure origin comes from the card paths, never inferred** [R].
  - `openPipelineRun(taskId, opts?: { fromBoardCard?: boolean })` and `openPipelineAttention(parentId, opts?: { stepTaskId?; tasks?; fromBoardCard? })` call `recordBoardDeparture(id)` inside their `onNavigated` callback, so a cancelled confirm records nothing.
  - Only three call sites pass the flag:
    - a new `openTaskFromBoard` (Column `onOpen`, which covers both the card body and the Open buttons);
    - `openAttention` (its only caller is the card's Answer/Review button);
    - the menu's `open-pipeline` action.
  - Every other caller is untouched, so it carries no flag. A non-card hop while away never touches the record, which is how D8's multi-hop reveal of A works.
- **K3 — Guard a fast return during the exit window** [R].
  - Setup: if `view` flips back to `board` while the leaving board is still mounted (Escape pressed inside the 0.18 s exit), the board element may be kept or re-entered without a remount, so the departure would never be consumed and would fire on some later return.
  - Fix: a `useLayoutEffect` on `view.kind` in `AppInner` calls `discardBoardDeparture()` when `view.kind === "board"` and the tracked scroller element `isConnected`.
  - On a normal return that element is `null` at that commit (the board mounts 0.18 s later), so the guard does nothing. On a normal remount the ref has already consumed the record in the same commit (children's refs attach before the parent's layout effect), so the guard is a no-op there too.
- **K4 — Card lookup** [R]. `TaskCard`'s root gets `data-task-id={task.id}`. `restoreBoardScroll` finds the card with ``el.querySelector(`[data-task-id="${CSS.escape(id)}"]`)``, scoped to the scroller. A card that isn't rendered (filtered out, archived in the active view, deleted, or in a hidden status column) gives offsets only (D9).
- **K5 — Reveal geometry is a pure function** [R]. `revealScrollDelta(view, target)` returns `null` when any part of the target lies inside the view (D6), or when the target is degenerate. Otherwise it returns the per-axis minimum delta (D7); exact rules are in T1. The view is the scroller's client box: `getBoundingClientRect()` + `clientLeft/clientTop` + `clientWidth/clientHeight`, which leaves out the 10 px scrollbar. motion's initial `translateY(8px)` shifts the scroller and the card equally, so the relative geometry holds.
- **K6 — The Pipelines list restores once per mount, after loading** [R]. A `useLayoutEffect` keyed on `loading`, with a once-per-mount flag, writes the saved `scrollTop` the first time `loading` is false: at mount on a warm cache, or on the commit that renders the first load on a cold one.
- **K7 — The side panel decides once, on the first data commit** [R]. The panel element first mounts on the first data commit (`:810-816`).
  - A `useLayoutEffect` keyed on `[taskId, panelSignature]` asks the store once per mount whether to restore. It restores the saved offset when the stored signature equals the current one. Otherwise it starts at the top **and resets the stored offset to 0**, so a later unchanged return doesn't bring back a stale offset.
  - On every later signature change, the effect only records the new signature. The stored signature therefore always means "what the user last saw".
  - The signature extends D13; see §8 A1.
- **K8 — Expansion lives in the store** [R]. `showGoal` and `HistoryRow`'s `open` take their initial state from the store and write to it on every toggle. History rows are keyed `historyExpansionKey(run.startedAt, record.seq)`, which is also their React `key` (A2). That key is what keeps a Restart collapsing every row (D14).
- **K9 — Memory is module-level, session-only and bounded** [R]. Board and list state are module variables, and the side-panel state is a `Map` keyed by pipeline task id with an LRU cap of 200 entries (A3). Nothing is written to `localStorage` (D2).
- **K10 — No contract changes** (D19). There are no API, DB, CLI, TUI or server changes. `AppView`, `viewMountKey`, `navigate` and `switchView` keep their semantics.

**Rejected:**

- **(B) Keep the board mounted** (`<Activity>` or `hidden`). The owner rejected it (D4): it loses the board transition, needs a Cmd+F gate, double-matches e2e locators, and breaks the `viewMountKey` invariant.
- **Restoring inside `navigate`.** The board mounts 0.18 s later.
- **Reading offsets at unmount.** A detached or hidden element reads `0,0`.
- **Inferring the origin inside `openPipelineRun`/`openTask`.** Shared with non-card callers.
- **`element.scrollIntoView({block/inline:"nearest"})`.** Its threshold is "not fully visible", where D6 wants "entirely out of view". It can also scroll ancestors, and it isn't unit-testable.
- **`localStorage`.** D2.

**Pinned interfaces.** Wave-2 test tasks code against these, so implementers must not rename them.

```ts
// src/mainview/lib/board-scroll.ts — no React import
export interface ViewportRect { left: number; top: number; right: number; bottom: number }
export function revealScrollDelta(view: ViewportRect, target: ViewportRect): { dx: number; dy: number } | null;
export function saveBoardScroll(left: number, top: number): void;
export function boardScrollOffsets(): { left: number; top: number };
export function recordBoardDeparture(taskId: string): void;
export function takeBoardDeparture(): string | null;   // returns the record and clears it
export function discardBoardDeparture(): void;
export function restoreBoardScroll(el: HTMLElement): void; // DOM glue (K1/K4/K5), e2e-covered
export function resetBoardScrollMemoryForTest(): void;

// src/mainview/lib/pipeline-scroll-memory.ts — type-only imports from ../../shared/types.ts, no React
export const PIPELINE_RUN_PANEL_MEMORY_MAX = 200;
export function pipelinesListScrollTop(): number;
export function savePipelinesListScrollTop(top: number): void;
export function pipelineRunPanelSignature(run: PipelineRunState, steps: readonly Pick<Task, "id" | "column">[]): string;
export function historyExpansionKey(startedAt: number | null, seq: number): string; // `${startedAt ?? "none"}:${seq}`
export function resolvePipelineRunPanelScroll(taskId: string, signature: string): number | null;
export function notePipelineRunPanelSignature(taskId: string, signature: string): void;
export function savePipelineRunPanelScroll(taskId: string, top: number): void;
export function pipelineRunGoalOpen(taskId: string): boolean;
export function setPipelineRunGoalOpen(taskId: string, open: boolean): void;
export function isHistoryRowExpanded(taskId: string, key: string): boolean;
export function setHistoryRowExpanded(taskId: string, key: string, expanded: boolean): void;
export function resetPipelineScrollMemoryForTest(): void;
```

**Pinned test ids and attributes:**

| Id or attribute | Element |
| --- | --- |
| `data-task-id` | `TaskCard` root |
| `pipelines-list-scroll` | Pipelines list scroller |
| `pipeline-run-side-panel` | Run-view side panel |

Existing ids are reused as they are: `pipelines-button`, `pipelines-back`, `pipelines-row`, `pipelines-edit`, `pipeline-back` (editor), `pipeline-run-view`, `pipeline-run-back`, `pipeline-run-status`, `pipeline-run-goal-toggle`, `pipeline-run-goal`, `pipeline-run-history`, `pipeline-run-history-row`, `pipeline-run-history-handoff`, `run-panel-resize`. The board scroller is still located as `.kanban-scroll`.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| **T1** | Board: save and restore both axes, record the departure from card paths, reveal, fast-return guard, card attribute, CLAUDE.md sentence | `src/mainview/lib/board-scroll.ts` (new), `src/mainview/App.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `CLAUDE.md` | — | See T1 detail. `bun run typecheck` green; existing `pipelines-run`/`pipelines-editor`/`task-context-menu` e2e still green |
| **T2** | Pipeline pages: list offset, side-panel offset with signature gating, Goal and row expansion memory | `src/mainview/lib/pipeline-scroll-memory.ts` (new), `src/mainview/components/pipelines/PipelinesPage.tsx`, `src/mainview/components/pipelines/PipelineRunView.tsx` | — | See T2 detail. Typecheck green; existing `pipelines-run`/`pipelines-editor`/`bundle-export-import` e2e still green |
| **T3** | Shared e2e helpers (REST seeding, scroll read/write, visibility) | `e2e/scroll-memory-helpers.ts` (new; not a spec, so Playwright won't collect it) | — (codes against the pinned ids in §3) | Typecheck green; exports exactly the API in T3 detail |

### T1 detail

**`lib/board-scroll.ts`** holds module state `let offsets = { left: 0, top: 0 }` and `let departure: string | null = null`.

`revealScrollDelta(view, target)`:

- Return `null` if `target` has zero (or negative) width or height.
- Return `null` if the rects overlap with positive area: `target.left < view.right && target.right > view.left && target.top < view.bottom && target.bottom > view.top`. Touching edges count as **out** of view.
- Otherwise, for each axis, compute `axis(vS, vE, tS, tE)`:
  - `0` if `tS >= vS && tE <= vE`.
  - If the target is bigger than the view on that axis (`tE - tS > vE - vS`): `0` if it already overlaps that axis (`tS < vE && tE > vS`), else `tS - vS` (align start).
  - Else `tS - vS` if `tS < vS`.
  - Else `tE - vE`.
- Return `{ dx, dy }`.

`restoreBoardScroll(el)` follows K1's order:

1. Write `scrollLeft`/`scrollTop` from `offsets`.
2. Call `takeBoardDeparture()`.
3. If there is an id, look up the card. If found, build the client-box view rect, compute `revealScrollDelta` against `card.getBoundingClientRect()`, and add `dx`/`dy`.
4. Always finish with `saveBoardScroll(el.scrollLeft, el.scrollTop)`. This also records clamped values (D10).

**`App.tsx`:**

- **Imports.** Add `useLayoutEffect` to the React import, and import the board-scroll API.
- **`openPipelineRun`.** Change it to `(taskId: string, opts?: { fromBoardCard?: boolean })`. In its `onNavigated`, call `if (opts?.fromBoardCard) recordBoardDeparture(taskId);` before the existing `setFocusSubagent(null); setSelected(null);`.
- **`openPipelineAttention`.** Add `fromBoardCard?: boolean` to its `opts`, and call `if (opts?.fromBoardCard) recordBoardDeparture(parentId);` first thing in its `onNavigated`.
- **`openTaskFromBoard` (new).** Next to `openAttention`, add `const openTaskFromBoard = useCallback((t: Task) => { if (t.pipelineId) { openPipelineRun(t.id, { fromBoardCard: true }); return; } openTask(t); }, [openPipelineRun, openTask]);`. Its doc comment should say: board cards only, every other `openTask` caller stays flag-less.
- **`openAttention`.** Pass `{ fromBoardCard: true }` to `openPipelineAttention`, and update the doc to say it is the card's button only.
- **Context menu.** The `runTaskMenuAction` case `"open-pipeline"` becomes `openPipelineRun(t.id, { fromBoardCard: true })`.
- **Column.** `onOpen={openTaskFromBoard}`; `onOpenAttention` is unchanged.
- **`boardScrollerElRef` and `boardScrollerRef` (new).** `const boardScrollerElRef = useRef<HTMLDivElement | null>(null);` and `const boardScrollerRef = useCallback((el: HTMLDivElement | null) => { boardScrollerElRef.current = el; if (el) restoreBoardScroll(el); }, []);`.
- **Fast-return guard (K3).** `useLayoutEffect(() => { if (view.kind === "board" && boardScrollerElRef.current?.isConnected) discardBoardDeparture(); }, [view.kind]);`. Comment the exit-window reason.
- **`.kanban-scroll` div.** Add `ref={boardScrollerRef}` and `onScroll={(e) => saveBoardScroll(e.currentTarget.scrollLeft, e.currentTarget.scrollTop)}`.
- **Leave alone.** Don't touch `openTask`, `openPipelineStep`, `landOnPipeline`, the toast/notification/Worktrees/RunPanel-strip/header/Settings callers, `AppView`, `viewMountKey`, `navigate` or `switchView`.
- **Comments.** Match the file's dense doc-comment style.

**`TaskCard.tsx`:** add `data-task-id={task.id}` on `<Card>`. Nothing else changes, and the memo comparator is untouched.

**`CLAUDE.md`:** insert exactly one sentence in item 19 (D18), right after the existing sentence "`<main>`'s content swaps under `<AnimatePresence mode="wait">` (`motion`) while the header, `NewTaskForm`, dialogs, and the single `RunPanel` instance stay mounted.":

> Because that swap unmounts the page being left, three scrollers remember their position for the app session, in memory only (`docs/plans/board-scroll-position.md`): the board's `.kanban-scroll` on both axes (saved `onScroll` and written back by a stable callback ref when the board remounts, `lib/board-scroll.ts`, which then — only on the first return after leaving from a pipeline-parent card's body, Open or Answer/Review button or its context menu's Open pipeline, flagged `fromBoardCard` on `openPipelineRun`/`openPipelineAttention` — scrolls that card into view by the minimum distance when it is now entirely out of view), the Pipelines list (one offset, restored once the list has loaded), and the run view's side panel (`pipeline-run-side-panel`, per pipeline task: its offset only while `pipelineRunPanelSignature` is unchanged, its Goal toggle and `startedAt:seq`-keyed expanded history rows always, `lib/pipeline-scroll-memory.ts`).

### T2 detail

**`lib/pipeline-scroll-memory.ts`:**

- **Module state.** `let listTop = 0`, plus `const panels = new Map<string, { top: number; signature: string | null; goalOpen: boolean; expanded: Set<string> }>()`.
- **Reads.** `pipelineRunGoalOpen` and `isHistoryRowExpanded` never create an entry; with no entry they return `false`.
- **Writes and the LRU cap.** Every write gets-or-creates the entry and refreshes its recency (`delete` + `set`). After an insert, while `panels.size > PIPELINE_RUN_PANEL_MEMORY_MAX`, delete the first (oldest) key.
- **`pipelineRunPanelSignature(run, steps)`** returns `JSON.stringify([run.startedAt, run.status, run.history.length, run.blocked.map((b) => [b.kind, b.stepId, b.taskId]), run.active.map((a) => [a.stepId, a.taskId, steps.find((s) => s.id === a.taskId)?.column === "review"])])`. This is D13 plus A1's `startedAt` and per-active "awaiting review" flag. Order is preserved, so a different order counts as different.
- **`resolvePipelineRunPanelScroll(taskId, sig)`.** Look up the entry. If it exists and `entry.signature === sig`, the result is `entry.top`. Otherwise the result is `null`; set `entry.top = 0`, creating the entry when needed. Always set `entry.signature = sig`.
- **`notePipelineRunPanelSignature`** sets the signature, creating the entry when needed.
- **`savePipelineRunPanelScroll`** sets `top`.
- **`setHistoryRowExpanded(..., false)`** removes the key from the set.

**`PipelinesPage.tsx`:**

- Add a `listScrollRef` and a `listRestoredRef = useRef(false)`.
- Add `useLayoutEffect(() => { if (listRestoredRef.current || loading) return; listRestoredRef.current = true; const el = listScrollRef.current; if (el) el.scrollTop = pipelinesListScrollTop(); }, [loading]);`.
- On the `:102` div, add `ref={listScrollRef}`, `data-testid="pipelines-list-scroll"` and `onScroll={(e) => savePipelinesListScrollTop(e.currentTarget.scrollTop)}`.
- Nothing else changes, and the bundle drop zone and leave guard stay as they are.

**`PipelineRunView.tsx`:**

- **Goal toggle.** `useState(() => pipelineRunGoalOpen(taskId))`. Its onClick computes `next = !showGoal`, then calls `setShowGoal(next)` and `setPipelineRunGoalOpen(taskId, next)`.
- **Signature and refs.** Compute `const panelSignature = run ? pipelineRunPanelSignature(run, steps) : null;` and add `sidePanelRef` and `panelRestoredRef`. All new hooks are declared **above** the early returns at `:799`/`:810`.
- **Restore effect.** `useLayoutEffect(() => { if (panelSignature == null) return; const el = sidePanelRef.current; if (!el) return; if (!panelRestoredRef.current) { panelRestoredRef.current = true; const top = resolvePipelineRunPanelScroll(taskId, panelSignature); if (top != null) el.scrollTop = top; return; } notePipelineRunPanelSignature(taskId, panelSignature); }, [taskId, panelSignature]);`.
- **Side panel div (`:981`).** Add `ref={sidePanelRef}`, `data-testid="pipeline-run-side-panel"` and `onScroll={(e) => savePipelineRunPanelScroll(taskId, e.currentTarget.scrollTop)}`.
- **History rows.** Compute `expansionKey = historyExpansionKey(run.startedAt, record.seq)` and render `<HistoryRow key={expansionKey} taskId={taskId} expansionKey={expansionKey} record={record} graph={effectiveGraph} />`.
- **`HistoryRow`.** Its `open` is `useState(() => isHistoryRowExpanded(taskId, expansionKey))`. The button computes `next = !open`, then calls `setOpen(next)` and `setHistoryRowExpanded(taskId, expansionKey, next)`.
- **Leave alone.** The canvas, the load and poll logic, and the existing signatures are untouched.

### T3 detail

`e2e/scroll-memory-helpers.ts` imports only from `./fixtures` and `./helpers` and Node built-ins.

**REST seeding** (shape mirrors `pipelines-run.spec.ts:70-200`; that file isn't refactored):

- `FAKE_CLAUDE_HANDOFF_PROMPT_MARKER = "__agetor_fake_claude_handoff__"` and `auth(backend)`.
- `createPlainTasksRest(backend, count, titlePrefix) → TaskRow[]` (`isolation: "none"`, `workdir: tmpdir()`, never started, so they land in backlog).
- `createProfileRest(backend, name) → id`.
- `makeStep({ id, name, agentProfileId, instructions? })`.
- `createPipelineRest(backend, name, steps, edges, maxSteps = 25) → id` (positions spaced the same way).
- `createPipelineTaskRest(backend, title, pipelineId, prompt) → TaskRow`.
- `startTaskRest`, `getTaskRest`, `waitForPipelineRest(backend, id, pred: (t: TaskRow) => boolean, timeoutMs = 30_000)`.
- `retryPipelineRest(backend, id)` (`POST /tasks/:id/pipeline/retry`) and `restartPipelineRest(backend, id)` (`POST /tasks/:id/pipeline/restart`).
- `gotoAppSubscribed(page, backend)`.

**Locators:** `boardScroller(page)` returns `.kanban-scroll`. `boardCardById(page, id)` returns `[data-task-id="<id>"]`.

**Scroll primitives** (all via `locator.evaluate`):

- `readScroll(loc) → { left, top }`.
- `scrollRange(loc) → { maxLeft, maxTop, clientWidth, clientHeight }`.
- `scrollToOffsets(loc, { left?, top? }) → { left, top }`. It writes the values. If either value changed, it awaits that element's next `scroll` event, then two `requestAnimationFrame`s, so the app's `onScroll` has saved them. It returns the actual (clamped) values, and returns immediately when nothing changed.

**Geometry (in page):**

- `cardVisibility(page, taskId)` and `columnVisibility(page, label)` both measure against the board scroller's client box. They return `{ state: "full" | "partial" | "none", target, view }`; the column is found by its `h2` label and its closest `.w-72` column div.
- `contentRect(page, taskId)` gives the card rect in scroll-content coordinates: card rect − client-box origin + scroll offsets.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| **U1** | unit (bun) | T1 pure logic | `src/mainview/lib/board-scroll.test.ts` (new) | Cases below pass, and each fails when its rule is broken (mutate locally to prove it, then revert) |
| **U2** | unit (bun) | T2 pure logic | `src/mainview/lib/pipeline-scroll-memory.test.ts` (new) | Cases below pass, same mutation proof |
| **E1** | e2e (Chromium) | T1 (+T3) | `e2e/board-scroll-position.spec.ts` (new) | Scenarios B1–B6 green twice in a row |
| **E2** | e2e (Chromium) | T2 (+T3) | `e2e/pipeline-scroll-memory.spec.ts` (new) | Scenarios L1, S1, S2 green twice in a row |
| **V1** | verification | everything | none committed; a temporary, untracked `playwright.webkit.local.config.ts` that is deleted before finishing | Recipe below run in full, results reported per layer, owner checklist handed over |

**U1 cases** (`revealScrollDelta`; call `resetBoardScrollMemoryForTest()` in `beforeEach`):

- Fully inside → `null`.
- Partly visible on the x axis, on the y axis, and in a corner → `null` (D6).
- Touching the view's right edge exactly (`target.left === view.right`) → revealed.
- Entirely right → `dx = target.right − view.right`, `dy = 0`. Same for entirely left, above and below.
- Diagonal: both axes non-zero, each at minimum distance.
- Out on x, partly out on y → `dy` brings it fully in.
- Target taller than the view and overlapping on y → `dy = 0`. Target wider than the view and out on x → aligns start.
- Zero-width target → `null`.
- Memory: offsets round-trip. `takeBoardDeparture` returns the id once, then `null`. `discardBoardDeparture` clears it. A second `recordBoardDeparture` overwrites the first.

**U2 cases:**

- **Signature equality.** Equal for structurally equal runs built as separate objects.
- **Signature differences.** Each of these changes it: `startedAt`, `status`, history length, one blocked entry's kind / stepId / taskId, adding a blocked entry, an active entry's stepId / taskId, and an active step task's column turning `review`. A step column change that isn't `review` (`running` → `blocked`), or a step that isn't active, doesn't change it.
- **`historyExpansionKey`.** `(123, 4)` gives `"123:4"`, `(null, 1)` gives `"none:1"`, and a different `startedAt` gives a different key.
- **`resolvePipelineRunPanelScroll`.** The first visit gives `null`. A saved offset with the same signature comes back. A different signature gives `null` **and** resets the stored offset, so the next same-signature resolve gives `0`. `notePipelineRunPanelSignature` makes a later resolve match. Two task ids are independent.
- **Goal and row expansion.** Both default to `false`, persist, and stay per task. `setHistoryRowExpanded(…, false)` removes the key.
- **LRU.** After writing to `MAX + 1` task ids, the oldest is forgotten. A read never creates an entry. Touching an old id with a write keeps it.
- **List offset.** It round-trips.

**E2e applies** to every flow here. The change is user-visible webview behavior that crosses the webview → Bun API → fake-agent process boundary, and the app runs locally.

**E1** (`e2e/board-scroll-position.spec.ts`; each test uses `freshBackend` and the default fast fake driver unless noted):

- **Seeding and geometry.** Each test seeds 12 plain backlog tasks (vertical overflow) plus its pipeline task(s), and asserts `maxLeft > 100 && maxTop > 100` as a precondition. Tests compute geometry in the page, through T3, and assert their preconditions explicitly, never hard-coded pixels.
- **Returns.** "Back" waits for the board's `.kanban-scroll` to be attached, then uses `expect.poll(readScroll)`.

- **B1 — exact offsets, non-card leaves (D3, D10).**
  1. Scroll to about half of each max on both axes.
  2. (a) Header `pipelines-button`, then `pipelines-back`: expect exactly the same offsets.
  3. (b) `pipelines-button`, then `Escape`: same.
  4. (c) `pipelines-button`, then `pipelines-edit` on a row (needs one pipeline seeded), then `pipeline-back`, then `pipelines-back`: same.
- **B2 — a toast leave never reveals (D5).** One single-step pipeline, prompt `Do it. ${MARKER}:done`, task P (backlog).
  1. Load the page with `gotoAppSubscribed`.
  2. Pick offsets: `left` = a small non-zero value at which `columnVisibility("Review")` is `none` (assert it), and `top` = half of max.
  3. Start P over REST and wait for the "Pipeline finished" toast. Assert P's card visibility is `none`.
  4. Click the toast's "Open", then `pipeline-run-back`.
  5. Expect exactly the same offsets, with P still `none`.
- **B3 — card-body leave, the card moved entirely off-screen, it is revealed; the record is consumed (D3, D5–D8).** Same seed as B2, P unstarted.
  1. Scroll so P is `full` and the Review column is `none` (assert both).
  2. Click P's title text, which opens the run view.
  3. Start P over REST and wait for `pipeline-run-status` "Done".
  4. Click `pipeline-run-back`.
  5. Expect P `full`, with minimum distance on each axis: either that axis's offset is unchanged, or P's edge in the direction the board moved is flush with the view's edge (±1 px).
  6. Then scroll so P is `none` again, go `pipelines-button` → `pipelines-back`, and expect exactly those offsets with P still `none`. The record was cleared after the first return.
- **B4 — multi-hop reveals the original card (D8).** Two single-step pipeline tasks, P1 and P2, both unstarted.
  1. Scroll so P1 is `full` and Review is `none`.
  2. Click P1's body.
  3. On P1's run view, start both over REST.
  4. Wait for the "Pipeline finished" toast whose text contains P2's title, and click its "Open". You land on P2's run view, a non-card hop.
  5. Click `pipeline-run-back`. Expect P1 `full`.
- **B5 — a partly visible card that didn't move stays put (D6).** P unstarted.
  1. Scroll so P's card is `partial` on x, by a `left` that cuts the backlog column, and assert it.
  2. Trigger the departure with `boardCardById(P).dispatchEvent("click")`. This avoids Playwright's scroll-into-view and focus-scroll.
  3. Click `pipeline-run-back`. Expect exactly the same offsets, P still `partial`.
- **B6 — the other three card paths record a departure (D5); control path doesn't.**
  - Seed:
    - F, a finished single-step pipeline in Review (shows "Open");
    - F2, another finished one (for the context menu);
    - K, a single-step pipeline with prompt `${MARKER}:missing`, blocked after its reminder (shows amber "Review"; use `waitForPipelineRest` until `status === "blocked"`).
  - For each path:
    1. At 1280×720, scroll so the target card is `full` with its right edge within 24 px of the view's right edge, `top` = 0.
    2. Leave: F's "Open" button; K's "Review" button (this also opens the step's run panel, so close it with `Escape` and wait for `run-panel-resize` count 0); F2 right-click → menu item "Open pipeline".
    3. On the run view, call `page.setViewportSize({ width: 880, height: 720 })`, then click `pipeline-run-back`.
    4. Expect `scrollLeft` changed, the card `full`, and its right edge flush with the view's right edge (±1 px).
    5. Reset the viewport to 1280×720.
  - **Control:** the same setup on F, leaving with `pipelines-button`, narrowing, then `pipelines-back`. Expect exactly the same offsets, F `none`.

**E2** (`e2e/pipeline-scroll-memory.spec.ts`, `freshBackend`):

- **L1 — Pipelines list (D11).**
  1. Seed one profile and 16 single-step pipelines.
  2. `pipelines-button`, then assert `pipelines-list-scroll` has `scrollHeight > clientHeight + 200`, and scroll to about 60% of max (S).
  3. Click `pipelines-edit` on a row that's `full`ly visible in the list viewport, wait for `pipeline-back`, and click it. Expect S.
  4. `pipelines-back`, then `pipelines-button`: expect S.
  5. `Escape`, then `pipelines-button`: expect S.
  6. Scroll to S2 ≠ S, then editor and back again: expect S2.
- **Cycle seed** used by S1 and S2:
  - one profile;
  - pipeline "Cycle" with steps A and B, edges A→B and B→A, `maxSteps: 14`;
  - prompt `Cycle. ${MARKER}:done`.

  With one outgoing edge per step, the edge is taken unconditionally, so the run cycles until `step-cap` and blocks with 14 history rows. `waitForPipelineRest` waits for `status === "blocked" && history.length === 14`.
- **S1 — side panel, unchanged run and per-task separation (D12–D14).** Two tasks, T1 and T2, both started and blocked at the cap.
  1. Open T1 from its card body.
  2. Assert `pipeline-run-side-panel` has `scrollHeight > clientHeight + 150`.
  3. Click `pipeline-run-goal-toggle`, then expand history row `#3` (the row whose text starts with `#3 `). Its `pipeline-run-history-handoff` should be visible.
  4. Scroll the panel to about 60% of max (S).
  5. `pipeline-run-back`, then open T2: expect panel `scrollTop` 0, no `pipeline-run-goal`, and no `pipeline-run-history-handoff`.
  6. Back, then open T1: expect panel `scrollTop` = S, `pipeline-run-goal` visible, and row `#3`'s handoff visible.
  7. Escape to the board, reopen T1: still S.
- **S2 — changed run starts at the top; Restart collapses rows (D12–D14).** One task T, blocked at the cap.
  1. Open T, open Goal, expand `#3`, scroll to S > 0, then Back.
  2. Call `retryPipelineRest` and wait for `blocked` with 28 history rows (the cap is extended once).
  3. Reopen T: wait for 28 `pipeline-run-history-row`, then expect `scrollTop` 0, Goal visible, and `#3` expanded.
  4. Scroll to S2 > 0, then Back.
  5. Call `restartPipelineRest` and wait for `blocked`, 14 rows, and a different `startedAt`.
  6. Reopen T: expect `scrollTop` 0, Goal visible (it's per task), and zero `pipeline-run-history-handoff`.

**Rule for wave 2:** `e2e/scroll-memory-helpers.ts` is frozen. E1 and E2 put any extra helper inside their own spec file.

**Run recipe** (from the worktree root):

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                   # fresh worktree only
bun run typecheck
bun test src/mainview/lib/board-scroll.test.ts src/mainview/lib/pipeline-scroll-memory.test.ts
bun test                                      # full; 3 known pre-existing failures (tmux-socket ×2, reconcile cancel) — report, don't fix
# Playwright starts Vite (:5173, `bun run hmr`) via webServer and one headless backend per worker (fake drivers, temp data dirs).
# No credentials, no ~/.agetor access. One Playwright invocation at a time.
bun node_modules/@playwright/test/cli.js test e2e/board-scroll-position.spec.ts e2e/pipeline-scroll-memory.spec.ts
bun node_modules/@playwright/test/cli.js test e2e/pipelines-run.spec.ts e2e/pipelines-editor.spec.ts e2e/task-context-menu.spec.ts \
  e2e/fx-recovery.spec.ts e2e/bundle-export-import.spec.ts e2e/non-blocking-restore.spec.ts
```

**One-off WebKit run (D17d).** Never commit the config.

1. Create the untracked `playwright.webkit.local.config.ts` at the worktree root:

   ```ts
   import { defineConfig, devices } from "@playwright/test";
   import base from "./playwright.config.ts";
   export default defineConfig({ ...base, projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] });
   ```

2. Run it:

   ```bash
   bun node_modules/@playwright/test/cli.js test --config playwright.webkit.local.config.ts e2e/board-scroll-position.spec.ts e2e/pipeline-scroll-memory.spec.ts
   ```

3. `rm playwright.webkit.local.config.ts`, then check that `git status` doesn't list it.

If the WebKit build is missing, `bun node_modules/@playwright/test/cli.js install webkit` downloads it; ask the owner first, since that's a network fetch. A WebKit-only failure is reported to the owner with the trace, not hidden.

**Owner smoke checklist (D17e)** for V1 to hand over. Run it in `bun run dev:hmr`, against `~/.agetor-dev` only:

1. Have enough tasks for the board to scroll both ways. Scroll right and down, then:
   - open a pipeline card and go Back;
   - open it again and press Escape;
   - use the header Pipelines button and Back.

   Each time, the board is exactly where you left it.
2. Open a pipeline card that is fully visible, then let it finish so it moves to a column off-screen. Back: the board comes back where it was, then moves just enough to show that card. The next round trip leaves the board alone.
3. Leave the board through a toast's Open. Back: no nudge, even if that pipeline's card is off-screen.
4. Pipelines page: scroll, Edit a pipeline, Back. Same place. Back to the board, Pipelines again: same place.
5. A pipeline's run view:
   - expand Goal and a history row, scroll the right panel, then Back and reopen: everything is as you left it;
   - let the run change and reopen: the panel is at the top, and Goal and the row are still expanded;
   - Restart and reopen: rows are collapsed.
6. Reload the window (Cmd+R). Everything starts at the top.

## 6. Execution waves

- **Wave 1 — T1, T2, T3 in parallel.** Their owned files are disjoint (App.tsx/TaskCard.tsx/board-scroll.ts/CLAUDE.md, the two pipeline components and pipeline-scroll-memory.ts, and the e2e helper), and none depends on another: T3 codes against the ids pinned in §3.
  - **Barrier:**
    - `bun run typecheck` green;
    - `bun test` with only the 3 known failures;
    - existing `e2e/pipelines-run.spec.ts`, `e2e/pipelines-editor.spec.ts` and `e2e/task-context-menu.spec.ts` green, which catches regressions from the new callbacks and the `HistoryRow` key change.
  - **Checkpoint commit.** It includes `docs/plans/board-scroll-position{,-investigation,-grill}.md`.
- **Wave 2 — U1, U2, E1, E2 in parallel.** Each owns its own new test file, and the helper file is frozen.
  - **Barrier:** the new unit tests green; E1 and E2 green twice in a row in Chromium; typecheck green.
  - **Checkpoint commit.**
- **Wave 3 — V1.** Run the full recipe in §5: typecheck, full `bun test`, the new and related e2e, and the one-off WebKit run. Report per layer and hand over the owner checklist.
  - A failure goes back to the owning task's files as a fix wave (T1/T2 for product code, E1/E2/U1/U2 for tests), never fixed by loosening a test, and V1 re-runs after it.
  - No commit unless a fix wave produced changes.

Every barrier is expected to be green. No test is known to fail on purpose apart from the 3 failures already on `main`.

## 7. Blast radius & risks

- **Callers changed.**
  - Column `onOpen` (new `openTaskFromBoard`), `openAttention`, and the menu's `open-pipeline` action.
  - `openPipelineRun` and `openPipelineAttention` gain an optional, ignorable `opts` field. Every existing call stays type-compatible, and `onOpenPipeline={(id) => openPipelineRun(id)}` passes no options.
  - No caller passes `openPipelineRun` by reference, where an event object could land in `opts`; checked against every call at `:543`, `:2071`, `:2589`.
- **Sibling paths.** Toasts, OS notifications, Worktrees, the RunPanel strip, `openPipelineStep`, the header, New Task's Manage pipelines and Settings keep their behavior, and they now also benefit from the offset restore.
- **StrictMode double invocation (K1).** Handled by the synchronous save at the end of `restoreBoardScroll`. The side-panel and list effects use per-mount flags, which survive StrictMode's simulated remount.
- **Clamping (D10).** If tasks were deleted or the window resized while away, the offset clamps, and the clamped value is saved. Accepted.
- **Scroll anchoring.** Chromium may adjust the side panel's `scrollTop` when newest-first history rows are inserted while the user is watching. That fires `scroll`, which saves it, so "where you left it" still holds.
- **`HistoryRow` key change** (`seq` → `startedAt:seq`). Within one mounted view, a Restart now remounts every row collapsed instead of reusing the open/closed state of the previous generation's rows with the same `seq`. This is intended (D14) and covered by S2. The existing `historyRowFor` e2e helper matches by text and is unaffected.
- **New attributes and test ids.** `data-task-id`, `pipelines-list-scroll` and `pipeline-run-side-panel` are added. No existing locator matches them, so they can't create strict-mode double matches.
- **Fast-return guard (K3).** It rests on reasoning about motion's `AnimatePresence` re-entering a key that is still exiting. It isn't e2e-tested because it depends on sub-180 ms timing; whether motion re-uses the element or remounts it, the guard leaves the right outcome.
- **e2e flake surfaces.**
  - The toast's display window (B2, B4): click right after it becomes visible, as the existing specs do.
  - Layout-dependent geometry: computed in the page, with explicit preconditions.
  - Viewport narrowing (B6): reset after each path.
  - Run E1/E2 twice at the wave-2 barrier.
- **Engine difference.** Restore-on-remount only depends on writing offsets to a laid-out element, which the spike proved in WebKit 26.5. D17d's WebKit run guards the rest, and the owner smoke covers the real WKWebView.
- **Rollback.** Revert the commits. There's no data, migration, API or CLI/TUI impact, and memory is session-only.

## 8. Open questions / assumptions

The owner left nothing open (grill: "No owner-deferred items"). The assumptions below are planning-level. A1–A4 go a little beyond the grill record; the owner approved them with the plan as written (2026-10-20).

- **A1 — The side-panel signature adds two inputs to D13.**
  - **`run.startedAt`.** A Restart that rebuilds an identical-looking run (same status, count, block and active set, for example a cycle hitting the same `step-cap` again) would otherwise count as "unchanged" and restore an offset into rows that are now collapsed.
  - **An "awaiting review" flag per active execution.** An active step task in the `review` column adds the "Awaiting review" card near the panel's top (`:1063-1101`) without changing `run.status`, `history.length`, `blocked` or `active`.

  Both only make the panel start at the top in more cases, and only when its top content really changed, which is D12's stated purpose.
- **A2 — `HistoryRow`'s React `key` becomes the expansion key `startedAt:seq`.** It was `seq`, so remembered expansion and on-screen expansion now agree after a Restart (D14).
- **A3 — The side-panel memory has an LRU cap of 200 pipeline tasks.** This turns the grill's "effectively unbounded" into a hard bound. Task ids are UUIDs that are never reused, so entries for deleted tasks need no explicit pruning: they age out. Reads never create entries.
- **A4 — Fast-return guard (K3).** If the board is still mounted when the view returns to it, the departure record is discarded, so a stale record can't fire a reveal on some later return.
- **A5 — The departure is recorded when the navigation commits** (`onNavigated`), not on click. A cancelled leave confirm records nothing, and a confirm can't appear from the board in practice anyway.
- **A6 — An archived card's Open button** goes through the same `onOpen`, so it records a departure. In the active view the card isn't rendered, so the return is offsets only (D9). In the "all"/"archived" views it is rendered, and the reveal rule applies normally.
- **A7 — Test strategy for the three non-body card paths (B6).** The e2e makes the card entirely out of view on return by narrowing the viewport while away. That's deterministic and needs no column move. The card-body path uses the real column move (B3), and the control path proves the narrowing alone never reveals.
- **A8 — "Visible area" is the scroller's client box,** which leaves out the classic 10 px horizontal scrollbar (`index.css:148-164`). The Review column can sit right behind the scrollbar band.
- **A9 — The Pipelines list's cold-cache branch** is implemented as D11 requires, but it can't be observed in e2e: App warms the cache at boot (`App.tsx:315`), and a reload clears the stored offset. It is covered by reasoning and by L1's warm path.
- **A10 — There is one board offset across filters and the Archived view.** This is grill assumption 1, unchanged.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Board offsets restored on both axes for every leave path and every return path (Back, Pipelines Back, Escape, task vanished, delete from the run view, editor round-trip) | In this run | T1 (fix at the scroller's mount); E1 B1/B2/B3 |
| Departure recorded for the card body and both Open buttons | In this run | T1 (`openTaskFromBoard`); E1 B3/B5/B6 |
| Departure recorded for the amber Answer/Review button | In this run | T1 (`openAttention`); E1 B6 |
| Departure recorded for right-click → Open pipeline | In this run | T1 (menu action); E1 B6 |
| Non-card callers stay flag-less (toasts, OS notification, Worktrees, RunPanel strip, `openPipelineStep`, header, Manage pipelines, Settings) | In this run | T1 (untouched by construction); E1 B2 (toast) + B1/B6 control (header) |
| Reveal rule: entirely out of view only, instant, minimum distance on both axes, clamped | In this run | T1 `revealScrollDelta`; U1; E1 B3/B5/B6 |
| Multi-hop reveals the original card; record cleared after the first return | In this run | T1; E1 B4 (multi-hop), B3 second leg (cleared) |
| Missing, filtered or archived card means offsets only | In this run | T1 (`querySelector` returns null); A6 |
| StrictMode double ref call must not undo the reveal | In this run | T1 (synchronous save); exercised by E1 under Vite dev |
| Fast return during the 0.18 s exit window | In this run | T1 guard (A4); reasoning-covered (§7) |
| `data-task-id` on `TaskCard` | In this run | T1 |
| Pipelines list offset, including the cold-cache wait | In this run | T2; E2 L1 (warm path); A9 |
| Side-panel offset gated on an unchanged run | In this run | T2; U2; E2 S1/S2 |
| Signature extension (`startedAt`, awaiting-review flag) | In this run | T2; A1 (owner-approved with the plan) |
| Goal toggle and expanded rows restored; Restart collapses rows | In this run | T2; U2; E2 S1/S2 |
| `HistoryRow` key `seq` → `startedAt:seq` | In this run | T2; A2 |
| Side-panel memory growth | In this run | T2 LRU cap (A3); U2 |
| Pruning entries of deleted pipeline tasks explicitly | Out of scope | Not needed: ids are never reused and the LRU cap (A3) bounds the map |
| Test ids `pipelines-list-scroll` and `pipeline-run-side-panel` | In this run | T2 |
| Shared e2e helpers | In this run | T3 |
| Unit tests for the pure helpers (D17b) | In this run | U1, U2 |
| New Chromium e2e for every decided behavior (D17a) | In this run | E1, E2 |
| Typecheck and existing related e2e green (D17c) | In this run | Wave-1 barrier + V1 |
| One-off WebKit run, config not committed (D17d) | In this run | V1 |
| Owner manual smoke checklist (D17e) | In this run | §5 checklist, handed over by V1; the owner runs it before merge |
| CLAUDE.md item 19 sentence (D18) | In this run | T1 (text pinned in §4) |
| Commit the investigation, grill and plan docs | In this run | Wave-1 checkpoint commit |
| Editing `docs/plans/pipelines.md` | Out of scope | Owner (D18): historical record |
| Persisting positions across reloads (`localStorage`) | Out of scope | Owner (D2) |
| Keeping the board mounted (approach B) | Out of scope | Owner (D4) |
| Returning keyboard focus to the opened card | Out of scope | Owner (D15) |
| React Flow pan/zoom in the editor and run view | Out of scope | Owner (D16): `fitView` on each visit is intended |
| Editor `StepPanel` scroll, the handoff-JSON box's inner scroll, `PipelinePicker`/`SubagentDetailsDialog` scroll | Out of scope | Owner (grill dispositions) |
| Permanent WebKit Playwright project | Out of scope | Owner (D17d) |
| CLI, TUI or server changes | Out of scope | Owner (D19): none of them have these scrollers |
| Refactoring `pipelines-run.spec.ts` to share its REST helpers with T3 | Out of scope | A different ticket (a test-code refactor); T3 mirrors those helpers instead |
