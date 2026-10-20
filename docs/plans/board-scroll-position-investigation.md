# Investigation — keep the board's scroll position across pipeline pages

| Field | Value |
| --- | --- |
| Date | 2026-10-20 |
| Change | Stop the kanban board from snapping back to its top-left scroll position after the user opens a pipeline task (full-page run view) or the Pipelines page and then comes back to the board. This informs the choice between "restore the position when the board remounts" and "never unmount the board". |
| Agents | none (the pipeline step forbade subagents): codebase, git-history and web research done inline, plus 1 spike |
| Flags | none |

## 1. What we know

**Root cause: switching views unmounts the board, so its scroll container is rebuilt at 0,0.**

- `App.tsx` keeps the current page in `view: AppView` (`src/mainview/App.tsx:203-206`, state at `:271`). `<main>` renders exactly one page under `<AnimatePresence mode="wait">` (`:2373-2558`): the board (`view.kind === "board"`, `key="board"`, `:2374-2477`), the Pipelines list (`:2479-2502`), the pipeline editor (`:2504-2535`) and the pipeline run view (`:2537-2557`). `viewMountKey` (`:211-220`) states the rule outright: a different key means the previous page is unmounted.
- The board's only scroll container is `<div className="kanban-scroll absolute inset-0 overflow-x-scroll">` (`App.tsx:2425`), inside the board's `motion.div`. Columns (`src/mainview/components/kanban/Column.tsx:56-92`) have no height cap and no overflow of their own, so this one element scrolls **both** axes. `overflow-x: scroll` makes `overflow-y` compute to `auto` (the spike confirmed this in WebKit and Chromium). Styling lives in `src/mainview/index.css:150-164`.
- Nothing saves or restores that element's `scrollLeft` or `scrollTop`. No code in `src/mainview` writes a scroll offset for the board (the `scrollIntoView`/`scrollTo` writes are all in RunPanel, the autocompletes, the context menu and `expand-on-jump.ts`). Every trip off the board therefore brings it back as a fresh element at `(0, 0)`. The spike reproduced this: `remountNoRestore = [0,0]`.
- **This is a regression from the Pipelines feature** (#244, `6cd0241`, 2026-09-29). Before that commit `App.tsx` had no `view` state and no `AnimatePresence`, and the board was always mounted (`git show 6cd0241^:src/mainview/App.tsx`: `.kanban-scroll` at `:1667`, no `view.kind`). `docs/plans/pipelines.md` D5 (`:58`) introduced "the first true page-swap in the app", and its research note says outright that the board is unmounted (`:34`).
- The filter state survives because it lives in `AppInner` (`textQuery`, `repoFilter`, `statusFilter`, `archivedView`, `harnessFilter`, `typeFilter`, `App.tsx:274-279`). Only DOM-level state such as scroll offsets, and component-local state inside the board subtree, is lost.
- Opening an ordinary task does **not** reset the board: `RunPanel` is an overlay (`App.tsx:2560+`) and the board stays mounted. Only pipeline pages swap the board out. `dialog.tsx:87-88` locks `body` overflow, but `body` is not the scroller, so that is not a factor.

**Every way to leave the board** (all of them unmount it):

| Path | Code |
| --- | --- |
| Pipeline-parent card body or its Open button | `openTask` → `openPipelineRun` (`App.tsx:541-549`, `:479-484`) |
| Pipeline-parent card's amber Answer/Review button | `openAttention` → `openPipelineAttention` (`:557-563`, `:501-513`) |
| Context menu "Open pipeline", Worktrees row, RunPanel "Open pipeline" strip, "Pipeline finished" toast | `openPipelineRun` |
| "Waiting on you" / "Pipeline needs you" toasts, OS-notification `open_task` | `openPipelineAttention` |
| Step-named `files-sent` / `fx-auto-resume` toasts | `openPipelineStep` (`:523-528`) |
| Header "Pipelines" button, New Task's "Manage pipelines…" | `openPipelinesPage` (`:1686-1688`; button at `:2289-2298`) |
| Settings → Pipelines "Open editor" / "Edit" / "New pipeline" | `onSettingsOpenPipelines` (`:1694-1699`) |

All of these go through `navigate` → `switchView` → `setView` (`:417-438`, `:387-404`).

**Every way back to the board:** the run view's Back button (`setView({kind:"board"})` directly, `:2554`; test id `pipeline-run-back`, `PipelineRunView.tsx:841`), the Pipelines page Back button (`navigate`, `:2492`; `pipelines-back`, `PipelinesPage.tsx:88`), Escape on a page view (`:1096-1112`), the pipeline task disappearing while its run view is open (`:927-931`), and deleting the pipeline task from its run view (`:1932-1934`). Because a fix at the board's mount point catches every one of these, a per-path fix isn't needed.

**Timing facts any fix must respect:**

- With `mode="wait"`, the board only mounts after the exiting page finishes its 0.18 s exit (`transition={{ duration: 0.18 }}`). Its `motion.div` then enters from `opacity: 0, y: 8`. A restore therefore has to run when the board (re)mounts, not inside `navigate`. Peer KB entry *"a page leaving via App.tsx AnimatePresence stays mounted ~180ms"* (`e97535c8`) documents the same exit window.
- The board's content is complete on its first render after a remount, because `tasks` and the filters are `AppInner` state. A restore in the commit or layout phase therefore has its full scroll range. The spike showed a synchronous write right after insertion sticks, including under motion's initial `opacity: 0` and `translateY(8px)`.
- Keyboard focus: a left-click focuses the card (`tabIndex=0` from dnd-kit). The comment at `TaskCard.tsx:141-152` notes that WebKit then scrolls a partly visible card into view. A position saved on scroll would capture that small adjustment, which is harmless.

**The tests would not notice a regression.** No e2e spec asserts the board's scroll position. The only specs that touch `.kanban-scroll` *write* `scrollLeft` to bring a card into view (`e2e/task-context-menu.spec.ts:171-190`, `e2e/fx-recovery.spec.ts:305-316`). `e2e/pipelines-run.spec.ts` already goes board → run view → Back → board (`:372`, `:391`, `:1044`) and never checks the position. A fix needs its own test.

**Pinned versions** (`bun.lock`; main checkout `node_modules`): react / react-dom 19.2.8 (exports a stable `Activity`), motion 13.4.1, @dnd-kit/core 6.3.1, @xyflow/react 12.11.6, @playwright/test 1.62.1 (Chromium 151.0.7922.34, WebKit 26.5).

**Web research:**

- React's `<Activity mode="hidden">` hides children with `display: none`, keeps their DOM and state, and tears down their Effects ([react.dev/reference/react/Activity](https://react.dev/reference/react/Activity)). The docs say nothing about scroll offsets.
- Older reports (Chrome 5/15, Safari 4/5.1) say an ancestor's `display:none` zeroes a child's scroll offset ([snook.ca](https://snook.ca/archives/html_and_css/css-display-resets-scroll), [WebKit bug 25835](https://bugs.webkit.org/show_bug.cgi?id=25835)). A WebKit layout test expects the position to be restored ([setting-scrollTop-after-hide-show](https://webkit.googlesource.com/WebKit/+/master/LayoutTests/fast/overflow/setting-scrollTop-after-hide-show-expected.txt)).
- These sources disagree with each other and are stale, which is why the spike below was run.

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does a scroller like `.kanban-scroll` scroll vertically too? | **Yes** | `getComputedStyle(sc).overflowY` → `"auto"` in both engines | WebKit 26.5, Chromium 151 | spike below |
| If the board stays mounted but an ancestor is hidden with `display:none !important` (what `<Activity mode="hidden">` or a `hidden` class does), does the offset survive? | **Yes in both engines.** It reads `[0,0]` while hidden and comes back as `[500,900]` when shown | `node spike.mjs <main-checkout>/node_modules` → `"before":[500,900],"whileHidden":[0,0],"afterUnhideAncestor":[500,900]` (same for WebKit and Chromium; `display:none` on the scroller itself and `visibility:hidden` also preserved it) | as above | spike below |
| Does a remount (new element, what today's `AnimatePresence` key swap does) lose the offset? | **Yes**, this is the bug mechanism | `"remountNoRestore":[0,0]` | as above | spike below |
| Does writing `scrollLeft`/`scrollTop` synchronously right after the new element is inserted restore it, including under motion's initial `opacity:0; translateY(8px)`? | **Yes** | `"remountSyncRestore":[300,650]`, `"remountRestoreAfterFrame":[300,650]`, `"restoreUnderMotionInitial":[333,777]` | as above | spike below |

Spike artifact: `/private/tmp/claude-501/-Users-alamosaravali--agetor-worktrees-3e24270e-e095-4fd4-9e90-62032884666d/83e4b814-0888-4eb4-959b-28c88860530d/scratchpad/spikes/display-none-scroll/spike.mjs`. Re-run it with `node spike.mjs /Users/alamosaravali/Projects/alamops/agetor/node_modules`. It uses that checkout's `playwright-core` and the installed `webkit-2336` / `chromium-1234` builds.

## 3. What we're assuming

- **Playwright's WebKit 26.5 matches the app's real WKWebView** (macOS 26, Darwin 25.6). This only matters for a "keep the board mounted but hidden" fix. A restore-on-remount fix depends only on writing `scrollTop`/`scrollLeft` to a laid-out element. If the assumption is wrong, the keep-mounted option could still lose the position in production while the Chromium e2e passes, which argues for restore-on-remount.
- **Exact scroll offsets are what the user means by "position".** If they mean "the card I clicked", the fix would scroll that card into view instead. That is different whenever the card changed column while the user was away (for example, a finished pipeline moves to Review). See must-ask 3.
- **Keeping the position for the app session (in memory) is enough.** If it should survive a reload or relaunch, the value moves to `localStorage` following the `lib/panel-collapse.ts` convention (`agetor:*` key, every access wrapped). See must-ask 2.
- **Board content is fully rendered on the first commit after a remount.** That holds today because the data lives in `AppInner`. If cards ever become lazy or virtualized, a restore would be clamped and would need a retry after layout. The browser clamps an out-of-range offset either way (cards deleted while away), and that's acceptable.

## 4. What we must ask the owner

1. **Scope: just the board, or the Pipelines list too?** The Pipelines list page has its own scroller (`PipelinesPage.tsx:102`, `overflow-y-auto`). It resets the same way when you go list → editor → list, because the editor swap unmounts it (`App.tsx:2525-2529`). The run view's side panel (`PipelineRunView.tsx:981`) also starts at the top each time. The report only names the board. Recommendation: fix the board, and decide explicitly whether the Pipelines list joins it in this change. It's the same mechanism and about a 5-line addition.
2. **Lifetime:** keep the position for this app session only (in memory, gone after a reload or relaunch), or persist it? Recommendation: session only. A restored scroll position from days ago, on a board whose cards have since moved, would be surprising.
3. **Exact offsets vs "keep the card I opened in view".** Recommendation: restore exact horizontal and vertical offsets, which is what "the position they want" describes. Card-centric scrolling would jump to the card's new column when it moved while the user was away.
4. *(Approach, only if the owner has a preference.)* There are two working fixes (§7). **(A) Restore on remount:** save the offsets on scroll, write them back when the scroller mounts. The board keeps its fade/slide transition and the "board unmounts" invariant other code relies on. **(B) Never unmount the board:** `<Activity>` or a `hidden` wrapper outside `AnimatePresence`. B also keeps any other board-local state, but it loses or reworks the board's exit/enter animation and has the blast radius listed in §7. Recommendation: A.

## 5. Completeness inventory

- **Code that unmounts the board:** `App.tsx:2373-2558` (`AnimatePresence`), `viewMountKey` `:211-220`, `navigate` `:417-438` / `switchView` `:387-404`, direct `setView` calls `:2525`, `:2529`, `:2554`.
- **Callers that leave the board** (direct and indirect): `openTask` `:541`, which every board card reaches through `Column`'s `onOpen`. Also `openAttention` `:557` (card `onOpenAttention`), `openPipelineRun` `:479` (context-menu action map, Worktrees dialog row, RunPanel strip `onOpenPipeline`, toasts), `openPipelineAttention` `:501` (toasts, OS-notification `open_task` handler), `openPipelineStep` `:523`, `openPipelinesPage` `:1686` (header button `:2293`, `NewTaskForm`'s `onOpenPipelines` `:2318`), and `onSettingsOpenPipelines` `:1694` (SettingsDialog). Because the fix sits at the board's mount, none of these callers need to change.
- **Callers that return to the board:** `:2492`, `:2554`, `:1108`, `:930`, `:1933`.
- **The scroller:** `App.tsx:2425`, plus its CSS in `index.css:150-164` (only the horizontal scrollbar is styled; the vertical one is the default).
- **Propagation surface:** none. No types, API, DB, CLI or TUI change; this is webview layout only. `AppView` and `viewMountKey` are unchanged under approach A.
- **Existing data or backfill:** none. Under the localStorage variant of must-ask 2, one new `agetor:*` key with no migration.
- **Docs that describe current behavior:** `CLAUDE.md` item 19's UI paragraph ("`App.tsx`'s `view` state is a union … `<main>`'s content swaps under `<AnimatePresence mode="wait">`"), which should gain one sentence on scroll preservation. Also `docs/plans/pipelines.md` D5 (`:58`, `:34`), which records the unmount. Optionally the "UI conventions" section of `CLAUDE.md`.
- **Tests touching this area:** `e2e/pipelines-run.spec.ts` (`createPipelineTaskRest` `:164-176`, `boardCard` `:208-210`, Back clicks `:372/:391/:1044`), `e2e/task-context-menu.spec.ts:171-190`, `e2e/fx-recovery.spec.ts:305-316`, and `e2e/pipelines-editor.spec.ts` (Pipelines page Back).
- **What the change would orphan:** nothing.

## 6. Runnability

- **Setup (fresh worktree, no `node_modules` yet):** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; bun install`.
- **Start locally:** `bun run dev:hmr` (Vite :5173 + Electrobun, data dir `~/.agetor-dev`; never point an unmerged build at `~/.agetor`).
- **Type check:** `bun run typecheck`.
- **Unit tests:** `bun test`. There's no jsdom or testing-library in the repo, so rendering behavior like this one is tested in Playwright, not unit tests. Three unit tests (two tmux-socket, one reconcile-cancel) fail on `main` already.
- **E2E harness:** Playwright, Chromium only (`playwright.config.ts`). Run with `bun node_modules/@playwright/test/cli.js test e2e/<spec>.spec.ts` (not `bunx`). Vite is a single `:5173` with `strictPort`; each worker gets its own headless backend via `e2e/fixtures.ts`. Run one Playwright invocation at a time across agents. Pipeline tasks are seeded over REST (`POST /pipelines`, `POST /tasks {pipelineId, isolation:"none"}`) with the fake drivers, as `e2e/pipelines-run.spec.ts:120-176` does.
- **Viewport for a new test:** Desktop Chrome's 1280×720. Six columns × 288 px plus gaps, beside the 320 px New Task sidebar, already overflow horizontally. Vertical overflow needs about 8 or more cards in one column (or a shorter viewport). The test should check both axes after run view → Back, after the Pipelines page → Back, and after Escape.

## 7. Risks & blast radius

- **Approach A (restore on remount)**
  - The restore must run when the scroller mounts (a layout-phase write from a stable callback ref or `useLayoutEffect`), never in `navigate`. With `mode="wait"`, the board mounts about 180 ms after the navigation.
  - **A callback ref must have a stable identity** (`useCallback(…, [])`). React calls an unstable ref callback with `null` and then the element on every render. App re-renders on every 2 s task poll, so the restore would yank the board back mid-scroll.
  - Saving on `onScroll` into an `AppInner` ref is cheap. Don't read the offsets at unmount time: a hidden or detached element reads `0,0` (spike `whileHidden`).
  - The programmatic restore fires a `scroll` event that writes back the (possibly clamped) value. That is fine.
- **Approach B (keep the board mounted)**
  - The board's own exit/enter animation goes away or has to be rebuilt, since D5's "smooth board↔page transitions" was a stated requirement in `docs/plans/pipelines.md:19`.
  - The hidden board keeps re-rendering on every task poll. Plain `display:none` also keeps its effects running, such as TaskCard countdowns and dnd-kit registrations; `<Activity>` tears those down.
  - The Cmd/Ctrl+F handler (`App.tsx:1069-1083`) would find a non-null `boardSearchRef` while on a pipeline page and call `preventDefault` on a hidden input. It would need a `view.kind` gate.
  - Hidden board cards stay in the DOM, so CSS and text locators in e2e can match them twice (strict-mode "resolved to 2 elements", for example a pipeline's title on both the run view and its hidden card).
  - `viewMountKey` / the leave-guard reasoning (`:419-422`) assumes the board unmounts.
- **Sibling surfaces with the same mechanism, not covered unless must-ask 1 says so:** the Pipelines list scroller (`PipelinesPage.tsx:102`) and the run view side panel (`PipelineRunView.tsx:981`).
- **Rollback:** a pure webview change, so reverting one commit undoes it. No data or contract impact, and no CLI/TUI parity concern since the CLI and TUI have no board scroll.
