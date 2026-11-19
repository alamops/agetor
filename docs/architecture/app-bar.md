# The window app bar

The bar at the top of the window: logo, wordmark, **one Harnesses button** with a panel grouped by Harness Stack, and the actions (Git, Import, Worktrees, Pipelines, Settings). It stays usable at any window width and UI zoom, and every action is also in the native macOS menu. Plan and decisions D-P1…D-P18: `docs/plans/app-bar-redesign.md`. The grill record is `docs/plans/app-bar-redesign-grill.md`.

The bar replaced a per-account chip strip. That **reverses** harness-stacks grill decision 28 ("the topbar keeps one usage chip per account", `docs/plans/harness-account-stacks-grill.md`), which had deferred exactly this layout change.

## Files

| File | Role |
|---|---|
| `src/mainview/components/app-bar/AppBar.tsx` | the `<header>`, the actions, the More menu, the measurement ghost, panel state |
| `.../HarnessesButton.tsx` | the button: live variant and the `measure` variant |
| `.../HarnessesPanel.tsx`, `StackSection.tsx` | the portaled panel and one live stack's section |
| `.../AccountUsageRow.tsx`, `BarMeter.tsx`, `StatusDot.tsx` | leaf components |
| `.../use-app-bar-fit.ts`, `use-bar-clock.ts` | the measured collapse and the bar's one timer |
| `src/mainview/lib/harness-bar.ts` | **the single implementation** of every rule below (pure) |
| `src/mainview/lib/app-bar-fit.ts` | the collapse ladder as arithmetic (pure) |
| `src/mainview/lib/app-menu.ts`, `src/bun/app-menu.ts` | native-menu actions, webview and core sides |

`App.tsx` keeps the data (`agents`, `harnesses`, `harnessStacks`, `harnessLimitStates`, `usage`, `tasks`) and the handlers, and renders `<AppBar>`. The bar adds no fetch, route, stream, preference or DB column.

## Layout and chrome

- The header is **pinned at 40 px with an 80 px left inset** at every UI zoom (`h-[40px] pl-[80px]`). The inset clears the macOS traffic lights; `trafficLightOffset` in `src/bun/index.ts` is tuned to this height, so change them together.
- UI zoom sets the root font size, so every rem scales. The control **boxes** are px (icon buttons `32px`, the Harnesses button `32px` tall, the logo `28px`); the glyphs and text inside still scale. A rem-sized `size-9` would be 61 px at 170 % and cannot fit a 40 px bar.
- The header is a **drag region**. Only controls carry `electrobun-webkit-app-region-no-drag` (each button, never a wrapper), so empty bar space moves the window. A double-click on empty space calls `api.toggleWindowZoom()`; a double-click on a control must not (the handler skips targets inside `.electrobun-webkit-app-region-no-drag`). React events bubble through portals, so a double-click inside the portaled Harnesses panel or More menu also reaches the header's handler; `isBarZoomDoubleClick` (`AppBar.tsx`) rejects any target that is not inside the header's own DOM (`header.contains(target)`), so only empty bar space toggles the zoom.
- `overflow-x: clip` on the header is the last resort: the document never scrolls sideways. The Harnesses button is the one item that shrinks (`min-w-0`, truncating).
- Icon buttons use `ui/tooltip.tsx`. Accessible names and test ids are unchanged (`Git`, `Import Claude Code sessions and OpenCode sessions`, `Worktrees`, `Pipelines`, `Settings`, `pipelines-button`, `import-claude-sessions-open`). The e2e helper `headerSettingsButton` is the Settings button inside the `banner` landmark.
- **RunPanel** keeps its full-window backdrop while open, so a press on the bar closes it instead of reaching the bar. The native menu is the way to reach the bar's actions then.
- The task count (`N tasks`, `X of N tasks`) moved to the board's filter row (`KanbanFilters` `taskCount`, `data-testid="board-task-count"`) and is not on the Pipelines page. The filter row wraps (`flex-wrap`) so it can't widen the document.

## Collapse ladder and measured fit

`chooseFitStep(available, widths, previous)` (`lib/app-bar-fit.ts`) picks the smallest step whose content fits:

| Step | Hidden |
|---|---|
| 0 | nothing |
| 1 | the wordmark |
| 2 | Import moves into the **⋯ More** menu (see the note below: it frees no width on its own) |
| 3 | "Harnesses", the count and the % |
| 4 | "until HH:MM" |

The logo, dot, meter, failover badge, Git, Worktrees, Pipelines and Settings never hide. Past step 4 the header clips.

**Step 2 never wins alone.** Import and the More button are the same 32 px box with the same gap, so `requiredWidth(2) == requiredWidth(1)`: if step 1 does not fit, step 2 does not either, and the fit goes 0 → 1 → 3. Import therefore only moves into the More menu together with step 3 (`app-bar-fit.test.ts` pins this with equal Import and More widths). The step stays in the ladder (the owner's order, and it would start to matter if the two widths ever differ); it costs nothing.

The widths come from a **ghost**: an `inert`, `aria-hidden`, invisible copy of the bar at step 0, rendered only through `measure` variants (no test ids, accessible names, ids or handlers, so the live locators stay unique). Parts are tagged `data-fit-part` (`wordmark`, `import`, `more`, `harness-text`, `until`); each width is summed with its parent's `column-gap`, and `full` excludes the More replica. Because the ghost never depends on the chosen step, the fit cannot oscillate; an 8 px hysteresis only absorbs subpixel jitter (growing the step is immediate, shrinking needs 8 px of spare room). `useAppBarFit` watches the header and the ghost with two `ResizeObserver`s, so a window resize, a UI zoom change and a content change (a badge appears) all re-measure. The observers are created in a layout effect and disconnected on cleanup, which keeps React StrictMode's double mount to one pair. The chosen step is on the header as `data-fit-step` (a test seam).

## Harnesses button and panel

`buildHarnessBarModel(input, now)` (`lib/harness-bar.ts`) is the only place these rules live; components draw the result.

- **Account state** (`accountState`), by precedence: `disabled` > `unavailable` (not available, or no status row: "Status unknown") > `logged-out` > `cooling` (an active account-wide cooldown) > `out-of-quota` > `ready`. "Out of quota" and "stale" are the failover's own predicates (`harnessQuotaLooksExhausted`, `harnessQuotaResetAt`, `quotaSummary`, `HARNESS_QUOTA_STALE_MS`), so the bar can't disagree with it. A per-model cooldown only adds a chip.
- **Live stack**: two or more **enabled** members (stricter than `stackPositionText`, which counts all members). Its disabled members stay in the panel as muted rows. A stack with fewer than two enabled members shows its enabled member as a plain account.
- **Headroom** of a stack: the lowest worst-blocking-meter % among its usable members; 100 when none is usable (then "all out · resets HH:MM", the earliest known reset).
- **The button's meter** is the tightest unit that can still run: the highest % among live stacks (their headroom) and the other available, logged-in accounts. Unavailable and logged-out accounts never feed it. No figure anywhere means no meter and no %.
- **"until HH:MM"** shows only when every unit that can run in principle is blocked; with no reset known the text says "every account is out of quota" with no time.
- **Dot**: the worst tone over the enabled accounts; grey with none enabled.
- **Failover badge and rows**: non-archived tasks whose `harnessState` has `pendingSwap` ("switching to X") or `allExhausted` ("waiting for quota until HH:MM"). They are listed under their stack and open on click (`openPipelineStep` for a hidden step, `openTask` otherwise); rows on a stack that isn't live go in "Other failover activity".
- The panel lists live stacks first, then the other accounts ordered running → problem → DB order. Each row shows the status in words, so color is never the only signal.
- **Clock**: `useBarClock` re-renders at the next instant the model changes on its own (a cooldown ends, a meter resets, a snapshot goes stale; clamped 1 s – 30 min) and every 30 s while the panel is open. One timer per bar. `now` is re-read when the data changes.
- Provider and CLI text (quota `reason`, a cooldown's `message`, a status `reason`/`authHelp`) renders only as React text children. There is no `dangerouslySetInnerHTML` under `components/app-bar/`.

## Escape, focus and ⌘F

- The panel is a portaled, non-modal `role="dialog"` carrying `data-popover-open=""` **only while open**, so RunPanel and the board's search box yield Escape to it. It also carries `data-popover-keys="escape-only"`, so ⌘F stays live while it is open (`FIND_SHORTCUT_BLOCKING_LAYERS` excludes it).
- Its Escape listener is on `document` in the bubble phase (React's root handlers run first), checks `e.defaultPrevented` first, then claims the event. Focus returns to the button only when it was inside the panel. A press outside, a window resize and every action also close it.
- The More menu is the shared `ui/context-menu.tsx` (portaled, roving focus, focus restore), anchored at the More button.
- Any `position: fixed` overlay here portals to `document.body`: RunPanel's `<aside>` has a transform, which rebases `fixed` onto itself.

## Native menu actions

- `buildAppMenu()` (`src/bun/app-menu.ts`) is the template `installNativeMenu` installs. **Settings… (⌘,)** sits after About in the Agetor menu, and a **Go** menu holds Pipelines, Worktrees…, Git Pull Requests and Issues… and Import Sessions…, with no accelerators. The webview items have the ids `webview:<action>`; `APP_MENU_ACTIONS` (`src/shared/types.ts`) is the list both sides validate against.
- A click goes `application-menu-clicked` → `menuActionFromClick` → `deliverMenuAction`. With a window and a client attached it broadcasts `{ type: "menu_action", action }` on `/app/events`. Otherwise it parks the action in a pending slot (`pending-open.ts`, the same 10 s TTL as a notification deep link) that the `/app/events` route flushes to the next client, and it focuses the window or creates one (the cold start). A CLI client streaming `/app/events` receives an action id only and ignores it. **No `ROUTE_POLICY` change**: no route is added and `/app/events` is already `SSE_LEGACY`.
- In the webview `runMenuAction(action)` (`App.tsx`) is the one place an action runs. The event handler and the ⌘, listener (`isSettingsShortcut`) both call it. It does nothing while a modal dialog is open (`MENU_ACTION_BLOCKING_LAYERS`), and every action is an idempotent "open", never a toggle, so a ⌘, that reaches both the page and the native menu can't flip anything back. It bumps `dismissNonce`, which closes the panel and the More menu.

## Test seams

- `data-testid`: `app-bar`, `harnesses-button` (+ `-dot`, `-count`, `-meter`, `-badge`, `-until`), `harnesses-panel`, `harnesses-panel-stack-<id>`, `harnesses-panel-account-<id>`, `harnesses-panel-failover-<taskId>`, `harness-cooldown-chip`, `app-bar-more`, `app-bar-more-menu`, `board-task-count`. The header's `data-fit-step` is the collapse step.
- e2e injects `menu_action` into the webview's own `/app/events` stream (`installSseInjector`, `injectSseFrame`); the native menu itself needs the live smoke (`bun run dev:hmr`, data dir `~/.agetor-dev`).
- Pure rules are unit-tested (`harness-bar.test.ts`, `app-bar-fit.test.ts`, `app-menu.test.ts`, `src/bun/app-menu.test.ts`); components render statically (`components/app-bar/*.test.tsx`); `e2e/app-bar.spec.ts` covers widths, zoom, the panel and the menu actions.
