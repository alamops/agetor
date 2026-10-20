# Grill — keep the board's scroll position across pipeline pages

| Field | Value |
| --- | --- |
| Date | 2026-10-20 |
| Source | Pipeline goal ("board position resets after opening a pipeline task or pipeline and navigating back"), plus the investigation brief `docs/plans/board-scroll-position-investigation.md` |
| Mode | interactive, answered by the owner (four AskUserQuestion passes) |
| Flags | none |

## What was already settled (not asked)

- **Root cause** (investigation §1): `App.tsx:2373-2558` renders one page at a time under `<AnimatePresence mode="wait">`, keyed by `viewMountKey` (`:211-220`). Going to a pipeline page unmounts the board, and its only scroller, `.kanban-scroll` (`App.tsx:2425`, both axes), comes back at `0,0`. This is a regression from Pipelines #244 (`6cd0241`).
- **Only scroll is lost on the board.** `Column.tsx`, `KanbanFilters.tsx` and `TaskCard.tsx` have no `useState` (checked with awk during this grill; `TaskCard`'s `useCountdown` is derived from server state). Filters live in `AppInner`.
- **Opening an ordinary task does not reset the board.** `RunPanel` is an overlay, so the board stays mounted.
- **The run-view side panel's top content changes between visits.** History renders newest-first (`PipelineRunView.tsx:1108`). The Blocked banner with Retry/Advance sits at the top (`:1000`). The Goal toggle (`:275`) and each `HistoryRow`'s expanded state (`:1182`) are component-local, so both reset on every mount. The panel's data arrives asynchronously from `api.getPipelineRun` (`:334`).
- **`seq` restarts on a pipeline Restart** (CLAUDE.md item 19). Remembered expanded rows must therefore be keyed by run generation (`run.startedAt`) plus `seq`.
- **No CLI, TUI or server surface** has these scrollers.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Scope | Which scrollers keep their position? | **Three:** the board (`.kanban-scroll`, both axes), the Pipelines list (`PipelinesPage.tsx:102`), and the pipeline run view's side panel (`PipelineRunView.tsx:981`) | owner |
| D2 | Lifetime | How long is a position remembered? | **This app session only, in memory.** A reload or relaunch starts at the top. No `localStorage`. | owner |
| D3 | Board restore | What comes back on the board? | **Exact horizontal and vertical offsets, then a reveal of the opened card** if the reveal rule (D5–D7) applies | owner |
| D4 | Approach | Restore on remount (A) or keep the board mounted hidden (B)? | **A.** Save offsets as the user scrolls, then write them back when the scroller mounts again. This keeps the board's fade/slide transition and the "board unmounts" invariant that `viewMountKey` and the leave guard rely on. B is rejected. | owner (investigation recommendation) |
| D5 | Reveal: which departures | Which ways of leaving count as "leaving from a card"? | **The card body, its Open button, its amber Answer/Review button, and right-click → Open pipeline.** Toasts, OS notifications, the Worktrees row, the RunPanel "Open pipeline" strip, the header Pipelines button, New Task's "Manage pipelines…" and Settings → Pipelines restore offsets only. | owner |
| D6 | Reveal: threshold | When is the card "off-screen"? | **Only when it is entirely outside the board scroller's visible area.** If any part is visible, nothing moves, so a partly visible card that didn't move comes back exactly as it was. | owner |
| D7 | Reveal: how | Smooth or instant, how far? | **Instant, the minimum distance on both axes** (nearest edge), applied after the offsets are restored | owner (confirmed default 5) |
| D8 | Reveal: multi-hop | Board → run view A → toast → run view B → Back | **Reveal A**, the card the user left the board from. The departure record is cleared after the first return to the board. | owner (confirmed default 3) |
| D9 | Reveal: missing card | The card is now filtered out, archived or deleted | **Offsets only, no reveal** | owner (confirmed default 4) |
| D10 | Clamping | Content shrank, or the window was resized while away | **The browser clamps the offset, and that is accepted.** No retry loop. | owner (confirmed default 6) |
| D11 | Pipelines list | What does the list keep? | **One vertical offset for the session**, not one per pipeline. It is restored once the list has rendered; on a cold module cache it waits for the first load to land. | owner (confirmed default 7) |
| D12 | Side panel: offset | Restore the side panel's offset when you return to a pipeline's run view? | **Per pipeline task id: restore the exact offset only if the run is unchanged since you left.** Otherwise start at the top, so a new status or a fresh Blocked banner is visible. | owner |
| D13 | Side panel: "unchanged" | What counts as unchanged? | Run status, history record count, blocked entries (kind / step / task) and the active executions all match the values seen when you left | owner (confirmed default 8) |
| D14 | Side panel: expansion | Restore the Goal toggle and the expanded history rows? | **Yes, per pipeline task id, for the session.** Expansion comes back even when the run changed (only the offset resets to the top). Rows are keyed by run generation (`startedAt`) plus `seq`, so after a Restart every row starts collapsed. | owner (D14 itself + confirmed default 8) |
| D15 | Focus | Return keyboard focus to the opened card? | **No, out of scope.** Focus behaves as it does today. | owner (confirmed default 1) |
| D16 | Canvas viewports | Keep pan/zoom in the editor and the run view? | **No, out of scope.** `fitView` on every visit is deliberate. | owner (confirmed default 2) |
| D17 | Acceptance | What does "done" require? | **(a)** A new Chromium e2e covering every behavior decided here. Board on both axes after run view Back, after Pipelines Back and after Escape. The reveal rule: a card that moved fully off-screen while away is revealed, a toast departure is not, and a partly visible card that didn't move leaves the board unchanged. The Pipelines list after list → editor → list and after board → list → board → list. The side panel when the run is unchanged (offset and expansion restored) and when it changed (top, expansion restored). **(b)** Bun unit tests for the pure helpers: the "entirely out of view" decision, the run signature that decides "unchanged", and the expansion key. **(c)** `bun run typecheck` green and the existing e2e specs that touch this area still green. **(d)** One extra, one-off run of the new spec under Playwright WebKit, without adding a webkit project to `playwright.config.ts`. **(e)** A manual smoke by the owner in the dev app (`bun run dev:hmr`, `~/.agetor-dev`) before merge. The pipeline's later steps hand the owner a short checklist for it. | owner |
| D18 | Docs | What gets documented? | One sentence in CLAUDE.md item 19's UI paragraph. `docs/plans/pipelines.md` stays as written, since it is a historical record. | owner (confirmed default 9) |
| D19 | Parity | Any CLI, TUI or server change? | **None.** Neither has these scrollers. | owner (confirmed default 10) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Board scroll restore (both axes) over every leave and return path (inventory in investigation §1/§5) | in this change | owner (D1, D3, D4). The fix sits at the scroller's mount point, so no leave or return caller needs changing. |
| Reveal of the opened card (D5–D9) | in this change | owner |
| Pipelines list scroll restore | in this change | owner (D1, D11) |
| Run-view side panel offset and expansion restore | in this change | owner (D1, D12–D14) |
| New e2e spec, unit tests for the helpers, one-off WebKit run, owner smoke checklist | in this change | owner (D17) |
| CLAUDE.md item 19 sentence | in this change | owner (D18) |
| Persisting positions across reload/relaunch (`localStorage`) | out of scope | owner chose session-only (D2) |
| Keeping the board mounted (approach B) | out of scope | owner chose A (D4) |
| Returning keyboard focus to the opened card | out of scope | owner (D15). This is focus management, a separate ticket. |
| React Flow pan/zoom in the editor and the run view | out of scope | owner (D16). `fitView` on mount is intended. |
| Pipeline editor `StepPanel` scroll (`StepPanel.tsx:79`) | out of scope | owner. The editor discards its selection and draft on every leave by design, so there's nothing meaningful to restore. |
| Inner scroll of an expanded history row's handoff-JSON box (`PipelineRunView.tsx:1230`) | out of scope | owner. The row's expansion comes back, but not its inner scroll. |
| `PipelinePicker` list and `SubagentDetailsDialog` scroll | out of scope | owner. They're transient UI that opens fresh by nature. |
| Adding a permanent webkit project to `playwright.config.ts` | out of scope | owner chose a one-off WebKit run (D17d) |
| Editing `docs/plans/pipelines.md` D5 | out of scope | owner (D18). It's a historical plan record. |

No owner-deferred items. Nothing was deferred silently.

## Assumptions still open

These are planning-level details the owner did not need to decide. They are stated so the plan builds on them explicitly.

- **There is one board offset, whatever the filters or Archived view are.** This matches today's in-place behavior: the scroller is the same element across filter toggles. If per-view offsets were wanted, the store would key on `archivedView`, but nothing suggests that.
- **The side-panel memory is an in-memory map keyed by pipeline task id.** It is effectively unbounded for a session (one small entry per pipeline task visited). The plan may drop an entry when its task is deleted. No eviction is otherwise required.
- **"Departure card" is recorded only by the card-origin paths in D5** (`openTask` / `openAttention` on a pipeline-parent card, and the context menu's Open pipeline action). The other callers of `openPipelineRun` / `openPipelineAttention` must not record one. The plan has to thread an origin flag (or record the card in the card and menu handlers) rather than infer it inside `openPipelineRun`, which those other callers share.
- **The restore runs at mount from a stable callback ref or `useLayoutEffect`**, never inside `navigate`, because the board mounts about 180 ms after navigation under `mode="wait"`. Offsets are saved from `onScroll`, never read at unmount, since a detached or hidden element reads `0,0` (investigation §7).
- **The side panel and the Pipelines list restore once their data has rendered**, not at the first commit, because both get content asynchronously on a cold load. If the plan finds the run view's first `getPipelineRun` result renders in the same commit as the mount, this collapses to the board's mount-time restore.
- **The one-off WebKit run needs the installed Playwright WebKit build** (`webkit-2336`, present per the investigation) and a temporary config that adds a webkit project. It must not be committed.
- **The e2e needs vertical overflow on the board.** That means about 8 or more cards in one column at Desktop Chrome's 1280×720, or a shorter viewport. The side-panel test needs enough history records to scroll the `w-96` panel. Both get seeded over REST with the fake drivers, as `e2e/pipelines-run.spec.ts:120-176` does.
