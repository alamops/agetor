# Plan — App bar redesign (Harnesses button, stacks panel, responsive collapse, native menu)

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Pipeline task "Alamo Pipeline (No Video)" (request quoted in §2 and in `docs/plans/app-bar-redesign-investigation.md` §0); investigation `docs/plans/app-bar-redesign-investigation.md`; grill record `docs/plans/app-bar-redesign-grill.md` (28 decisions, answers in `docs/plans/app-bar-redesign-grill/round-{1,2}/answers.json`) |
| Flags | none |
| Gates | grilled (2 rounds, complete) + approved by owner as written (2026-11-18, including the planner calls in §8 #6–#13) |
| Status | executing — Wave 1 done |
| Branch | `fix/agetor-app-bar-ui-improvement` |
| Base SHA | `4d7f8bfb93320076aa86292d614d84d4b883ba7d` |

## 1. Objective & success criteria

Replace the window app bar's per-account chip strip with **one aggregate "Harnesses" button** that opens a portaled panel grouped by Harness Stack, make the bar fit any window width and UI zoom without ever scrolling the document sideways, and make every bar action reachable from the native macOS menu. Webview-first; the only core change is native-menu plumbing over the existing `/app/events` SSE channel.

Each criterion names the production path that produces it and the test that drives that path.

| # | Criterion | Production path | Proven by |
| --- | --- | --- | --- |
| S1 | The bar shows logo, wordmark, one **Harnesses** button, Git, Import, Worktrees, Pipelines, Settings — no per-account chips at any width. | `App.tsx` render → `<AppBar>` (T9) → `HarnessesButton` (T8) | E1 (`e2e/app-bar.spec.ts`), C2 |
| S2 | The button shows a worst-state dot, "Harnesses", the enabled count, one meter + its %, a failover badge, and "until HH:MM" when nothing can run; its tooltip/description names the meter's source. | `AppBar` → `buildHarnessBarModel` (T1) → `HarnessesButton` (T8) | U1, C1, E1 |
| S3 | The panel lists live stacks first (heading: kind, stack marker, member dots, headroom meter, earliest reset; member rows; Refresh; Manage stack…; Swap history), then the other accounts ordered running → problem → DB order; each row has today's popover content; failover tasks are listed under their stack and open on click. | `AppBar` → `HarnessesPanel` (T7) → `AccountUsageRow` (T6); callbacks from `App.tsx` (T10); Settings stack-history deep link (T5) | U1, C1, E1 |
| S4 | The bar is 40 px tall with an 80 px left inset at 100 % and 170 % UI zoom; it collapses by measured fit (wordmark → Import into ⋯ More → "Harnesses"/count/% → "until"); at 1440/1100/900/720 px × 100/170 % `document.documentElement.scrollWidth <= clientWidth`, and Settings, Pipelines, Git, Worktrees stay visible and clickable. | `AppBar` → `useAppBarFit` (T2) → `chooseFitStep` (T2) | U2, C2, E1 |
| S5 | Native menu: "Settings… ⌘," in the Agetor menu and a "Go" menu with Pipelines, Worktrees…, Git Pull Requests and Issues…, Import Sessions…; each opens its target in the webview, also with RunPanel open and with no window open (cold start). ⌘, also works in the webview. | `index.ts` `application-menu-clicked` → `menuActionFromClick`/`deliverMenuAction` (T3) → `broadcastAppEvent` / pending slot flushed by `/app/events` (T3) → `App.tsx` `menu_action` handler → `runMenuAction` (T10) | U3, E1 (SSE-injected `menu_action`), V1 live smoke |
| S6 | The task count moves from the bar into the board's filter row (`KanbanFilters`) and no longer shows on the Pipelines page. | `App.tsx` (T10) → `KanbanFilters` `taskCount` (T4) | U4, E1 |
| S7 | Escape closes only the topmost bar popover (panel or More), never RunPanel too; ⌘F stays live while the Harnesses panel is open. | `HarnessesPanel` (T7), `ContextMenu` (existing), RunPanel guards (unchanged) | E2 (updated `board-search-shortcut.spec.ts` (f)), E1 |

## 2. Context & constraints

### The request (quoted, not amended)

> "The App Bar is becoming polluted and broken when trying a responsive UI. With all the harnesses there (and even missing the Harness Stacks info). We must improve its UI/UX following the best practices."

It came with a screenshot of the owner's bar (seven chips: four Claude Code accounts, Codex, Cursor, OpenCode; trailing actions cropped). The screenshot is a task attachment and is **not** committed: it shows real account labels (repo rule: no real harness ids or account names in the repo). The investigation §0 describes it.

### Today's bar (grounded)

- **Render site**: inlined in `AppInner()` — comments `src/mainview/App.tsx:2604-2619`, `<header>` `:2620-2739`, chip map `:2632-2680` (`visibleTopbarAgents(agents, harnesses).map(…)`, inline placeholder copy `:2651-2654`), trailing cluster `:2683-2738` (task count `:2684-2690`, then Git, Import, Worktrees, Pipelines, Settings ghost icon buttons with native `title`).
- Header classes: `electrobun-webkit-app-region-drag flex h-10 shrink-0 items-center justify-between border-b border-border/60 pl-20 pr-4`; no `min-w-0`, no overflow rule. The whole chip strip and the whole trailing cluster are wrapped in `no-drag` (`:2632`, `:2683`), so the gaps between controls don't drag the window today.
- Imports to remove: `App.tsx:40-42` (`UsageMeter`, `UsagePopover`, `visibleTopbarAgents`), and `USAGE_SUPPORTED_KINDS` from `:33` once unused.
- **State already in App** (no new fetch): `agents`, `harnesses`, `harnessStacks`, `harnessLimitStates` (`:264-270`), all from one `GET /harnesses` (`refreshAgents` `:799-819`, reconciled by id, polled every 15 s `:949-954`, refreshed on `harnesses_auto_enabled` `:1387-1405`); `usage` (`:292`, seeded `:899-901`, pushed by `harness_usage` `:1370-1373`); `tasks` (2 s poll `:933`), `nonStepTasks` `:1903`, `visibleTasks` `:1911`.
- Handlers: `setGithubOpen(true)`, `setImportSessionsOpen(true)`, `setWorktreesOpen(true)`, `openPipelinesPage` `:2029` (routes through `navigate` `:462`, which asks before leaving a dirty editor), `setSettingsOpen(true)`, `openSettingsHarnesses` `:2012`, `openTask` `:618`, `openPipelineStep` `:600`; the `open_task` app-event handler `:1424` is the precedent for "find the task, refresh if missing, open it".
- `UsageMeter` (`src/mainview/components/usage/UsageMeter.tsx`) and `UsagePopover` (`…/usage/UsagePopover.tsx`) have one caller, App.tsx. `UsagePopover` renders in place (`absolute left-0 top-full`), `role="dialog"` **without** `data-popover-open` (knowledge entry `3f50b5d1`: Escape on it also closes an open RunPanel).
- `visibleTopbarAgents` `src/mainview/lib/usage.ts:82-87` (tests `src/mainview/lib/usage.test.ts:168-189`): kept and reused as the enabled filter.

### Harness Stacks helpers to reuse (never fork)

- `cooldownChips` `src/mainview/lib/stack-editor.ts:198-220` (reason, "until HH:MM", model; provider `message` is plain text), `groupHarnesses` `:245-264`.
- `stackPositionFor` `src/mainview/lib/stack-badge.ts:83`, `activeCooldown` `:119`, `formatResetClock` `:136`.
- `stackPositionText` `src/shared/harness-stack.ts:53` (null for < 2 members), `quotaSummary` `:450` (blocking meters, stale after 20 min).
- `BLOCKING_METER_IDS` `src/shared/harness-limits.ts:418`, `HARNESS_QUOTA_STALE_MS` `:424`, `harnessQuotaLooksExhausted` `:457`, `harnessQuotaResetAt` `:471` — the failover's own definition of "out of quota". The bar must use these, so it can never disagree with the failover.
- `STACK_KIND_LABEL` `src/mainview/components/settings/HarnessStackCard.tsx:6-9`.
- Types: `HarnessStack` `src/shared/types.ts:443`, `HarnessLimitState` `:492` (`model` null = account-wide), `TaskHarnessState` `:627` (`pendingSwap` `:637`, `allExhausted` `:653` with `earliestResetAtMs`), `QuotaStatus` `:1552`, `HarnessQuota` `:1583`, `USAGE_WARN_PERCENT`/`USAGE_CRIT_PERCENT`/`USAGE_SUPPORTED_KINDS` `:2600-2610`, `AppEvent` `:6733`, `FONT_SIZE_MIN/MAX` `:7238-7239` (100–170 %).
- Settings: the stack history view exists (`openStackHistory` in `src/mainview/lib/settings-dialog-view.ts`, rendered `src/mainview/components/settings/SettingsDialog.tsx:1002-1008`) but the dialog has **no deep link** to it: `entryView` `:313-322` only knows `initialSection` and `initialAgentProfileId`.

### Window chrome constraints

- `titleBarStyle: "hiddenInset"`, `trafficLightOffset: { x: 8, y: 8 }`, comment "keep `x` in sync with the header's `pl-20`" — `src/bun/index.ts:845-857`.
- UI zoom sets `document.documentElement.style.fontSize` (`src/mainview/components/font-size-provider.tsx:80-88`, `rootFontSizeStyle` `src/mainview/lib/font-size.ts:33`), so every rem in the bar scales; `size-9` icon buttons become 61 px at 170 %. **A 40 px pinned bar therefore needs px-pinned control boxes** (§3 D-P1).
- Electrobun 1.18.1 has no minimum window size (investigation §1).
- Drag regions: Electrobun's preload starts a window move on `mousedown` inside `.electrobun-webkit-app-region-drag` unless inside `.electrobun-webkit-app-region-no-drag`; the double-click zoom guard is `App.tsx:2622-2625` (`api.toggleWindowZoom`, comment `src/bun/server.ts:4436`).
- RunPanel: `fixed right-0 top-0 z-40 h-full`, 420 px – 90vw, default 720 px (`src/mainview/components/kanban/RunPanel.tsx:630-635`); it covers the bar's right side while open (kept, D13). Its Escape guards check `e.defaultPrevented` first, then `[role="dialog"][aria-modal="true"], [data-popover-open], …` (`RunPanel.tsx:602-603`, `:2335-2336`).
- Native menu: `installNativeMenu` `src/bun/index.ts:117-162` (About, Remote Access…, Hide…, Quit, Quit Completely; Edit; Window). Clicks: `Electrobun.events.on("application-menu-clicked")` `:524-545` handles `remote-access` and `quit-completely`. The cold-start deep-link precedent is `open-url` `:961-975` + `src/bun/pending-open.ts` (10 s TTL) + the flush at the top of `/app/events` (`src/bun/server.ts:9316-9322`).
- App events: `broadcastAppEvent` / `hasAppEventListeners` `src/bun/quit-guard.ts:42-48`; the route is `"/app/events": SSE_LEGACY` (`src/bun/route-policy.ts:482`, `SSE_LEGACY = { callers: "app+cli", … }` `:109`); the webview subscribes once (`api.subscribeAppEvents` `src/mainview/lib/api.ts:2341`, handler `App.tsx:1369`). The CLI's clone command also streams `/app/events` and filters on its own event type (`src/cli/commands/clone.ts:79`).
- Electrobun accelerators are parsed natively (`libNativeWrapper.dylib` knows the named keys `plus`, `space`, `escape`, `shift`, `option`, `command`, `ctrl`); `,` passes as a literal key. Checked with `strings -a node_modules/electrobun/dist-macos-arm64/libNativeWrapper.dylib` (main checkout, electrobun 1.18.1). The live smoke (V1) confirms ⌘, fires.

### Repo rules that bear on this change (CLAUDE.md unless noted)

- **Webview**: an overlay positioned `fixed` portals to `document.body`; a popover carries `data-popover-open=""` only while open and closes itself on Escape; WKWebView allows ~6 connections, 2 are SSE — no new stream (forward through `subscribeAppEvents`).
- **Document-level Escape listeners check `e.defaultPrevented` first, then the DOM markers** (knowledge entry `5b26b347`: React can flush a dismiss render between listeners, so the marker can vanish mid-event).
- `data-popover-keys="escape-only"` opts a popover out of blocking ⌘F (`FIND_SHORTCUT_BLOCKING_LAYERS` `src/mainview/lib/find-shortcut.ts:42`; `docs/architecture/prompt-composer.md:23`).
- `KanbanFilters`' search box yields Escape to any `[role="dialog"], [data-popover-open], [data-quote-open]` without `preventDefault` (`src/mainview/components/kanban/KanbanFilters.tsx` Escape handler in the search `Input`).
- **Theme tokens**: semantic `success`/`warning`/`info`/`danger` (+ `-solid` dot variants for success/warning/danger; no `info-solid`); never literal palette classes; literal class maps (`FILL_CLASS`) because Tailwind can't see `bg-${token}`.
- Keyboard shortcuts: `isMacPlatform()` (`src/mainview/lib/platform.ts:13`) and a pure predicate in `src/mainview/lib/` with a thin document listener.
- Layout chrome state in `localStorage` — not needed (no pin/hide, D20).
- React 19 StrictMode: mount-time DOM work (ResizeObserver) must be idempotent.
- `src/shared/` stays free of runtime imports from either process.
- Text from third parties (provider `reason`, cooldown `message`, CLI `reason`/`authHelp`) renders as plain React text only.
- Docs: update the subsystem doc in the same change; a code comment cites `docs/architecture/<doc>.md`, never a CLAUDE.md section (`src/bun/claudemd-citations.test.ts`).
- Memory: no real account labels or ids in code or fixtures; e2e uses synthetic ids.
- Tests: pure logic in `src/mainview/lib/*.ts` with co-located `bun test`; components via `renderToStaticMarkup` (`src/mainview/components/kanban/StackBadge.test.tsx` is the pattern); e2e with Playwright via `bun node_modules/@playwright/test/cli.js test …`, one run at a time across agents.

### Live facts checked

- `git log --oneline -1` → `4d7f8bfb` (base at planning time).
- No `node_modules` in this worktree: run `bun install` before any test.
- Owner's real setup (investigation, read-only sqlite): 7 enabled harnesses, one 2-member claude-code stack, two more unstacked Claude accounts. The e2e reproduces the shape with synthetic ids.

## 3. Approach & key decisions

**Shape.** A new `src/mainview/components/app-bar/` folder holds the bar. `App.tsx` keeps the data and the handlers, and renders `<AppBar …/>` in place of the inline header. All derivation is pure:

- `src/mainview/lib/harness-bar.ts` builds one **bar model** from the App state (account states, live stacks with headroom, ordered accounts, failover tasks, the button summary, `nextChangeAt`).
- `src/mainview/lib/app-bar-fit.ts` picks a **collapse step** from measured widths.

The components only render. The core gains a menu module (`src/bun/app-menu.ts`) and one new `AppEvent` (`menu_action`) on the existing `/app/events` stream, plus a cold-start pending slot.

### Decisions (E = rests on evidence, R = reasoning)

| ID | Decision | Basis |
| --- | --- | --- |
| D-G1 | One aggregate Harnesses button at every width, a portaled panel grouped by stack (grill 1–9). **This reverses harness-stacks grill decision 28** ("topbar keeps one usage chip per account in v1 (no grouping)", `docs/plans/harness-account-stacks-grill.md:47`), which deferred exactly this layout change. Recorded here as the owner's reversal. | owner (grill 1) |
| D-P1 | **Pinned chrome.** Header `h-[40px] pl-[80px]`. The control **boxes** are px too: the icon buttons are `size-[32px]`, the Harnesses button is `h-[32px]`, and the logo is `size-[28px]`. Glyphs (lucide icons sized in rem, text in rem) still scale with zoom, so widths still grow and the fit still re-measures. Without px boxes, a 61 px `size-9` button cannot fit a 40 px bar at 170 %. | E (font-size mechanism) + grill 15 |
| D-P2 | **Measured fit on a ghost.** An `inert`, `aria-hidden` measurement copy renders the bar at step 0 through each component's `measure` variant (no `data-testid`, no handlers, no ids, no accessible names). `useAppBarFit` measures its parts and the header's available width with two `ResizeObserver`s, and `chooseFitStep` picks the smallest step that fits. The ghost doesn't depend on the chosen step, so the fit can't oscillate; an 8 px hysteresis only absorbs subpixel jitter. The observers also catch a zoom change, because the ghost's width changes. | R (priority+ practice, investigation §1) |
| D-P3 | **Collapse ladder**: 0 all, 1 wordmark hidden, 2 Import → ⋯ More, 3 "Harnesses" + count + % hidden, 4 "until HH:MM" hidden. The logo, dot, meter, badge, Settings, Pipelines, Git, Worktrees and More (from step 2) never hide. Past step 4 the header clips (`overflow-x: clip`), and the Harnesses button is the one item that shrinks (`min-w-0`, truncating), so the document never scrolls sideways. | grill 12 + open assumption 1 |
| D-P4 | **Meter = tightest "what can still run"** (grill 3). The candidate units are: each live stack (its headroom, the lowest worst-blocking-meter % among its usable members; 100 when none is usable); each other enabled account that is available and logged in (its worst blocking meter from `quotaSummary`; 100 when it is cooling account-wide or `harnessQuotaLooksExhausted`). The button shows the unit with the highest %, ties going to the first in panel order. When no unit has a figure, the meter and % are omitted. Unavailable or logged-out accounts never feed the meter: they have no capacity, and the dot already reports them. | owner + R |
| D-P5 | **"until HH:MM"** shows only when at least one unit can run in principle and every such unit is blocked; it is the earliest known reset among them. With no reset known, the dot is amber and the summary says "every account is out of quota", with no time. | grill 2 + R |
| D-P6 | **Account state** precedence: `disabled` (stack members only) > `unavailable` (`!available`, or no status row: "Status unknown") > `logged-out` (`loggedIn === false`) > `cooling` (an active account-wide `HarnessLimitState`) > `out-of-quota` (`harnessQuotaLooksExhausted(quota, now, HARNESS_QUOTA_STALE_MS)`) > `ready`. Per-model cooldowns only add chips. Tones: unavailable → danger; logged-out, cooling and out-of-quota → warning; ready → success; disabled → muted. Dot = worst tone over the enabled accounts, grey when none are enabled. | grill 2, 21 + E (`harness-limits.ts`) |
| D-P7 | **Live stack** = ≥ 2 **enabled** members (grill 22, stricter than `stackPositionText`, which counts all members). Its disabled members show as muted dots and rows (grill 21). A stack with < 2 enabled members contributes its enabled member as a plain account row and hides its disabled ones. | owner |
| D-P8 | **Failover badge** counts non-archived tasks whose `harnessState` has `pendingSwap` or `allExhausted`, hidden pipeline steps included (they are real runs). A row reads "switching to <label>" when `pendingSwap` is set (it wins), else "waiting for quota until HH:MM" (or "waiting for quota" with no reset). A click opens the task: `openPipelineStep` for a step, `openTask` otherwise. Rows whose stack isn't live go in an "Other failover activity" group after the stacks. | grill 7 + R |
| D-P9 | **Panel Escape and ⌘F**: the panel carries `data-popover-open=""` **and** `data-popover-keys="escape-only"`, so ⌘F stays live while it is open. That keeps `board-search-shortcut.spec.ts` (f)'s current semantics. Its Escape listener is on `document` in the **bubble** phase, so React's root handlers (the search box's marker check) run first. It checks `e.defaultPrevented` first, then calls `preventDefault()` and closes. Focus goes back to the button only when focus was inside the panel. | E (knowledge `5b26b347`, `find-shortcut.ts:42`, test (f)) |
| D-P10 | **More menu** reuses `ui/context-menu.tsx` (portaled, roving focus, `data-popover-open`, focus restore). It is anchored at the More button's bottom-left via `placeContextMenu`, `label="More actions"`, `testId="app-bar-more-menu"`. Its one item is "Import sessions…". | E (`context-menu.tsx`) |
| D-P11 | **Menu transport**: the menu item ids are `webview:<action>`. `menuActionFromClick` validates against `APP_MENU_ACTIONS`. `deliverMenuAction` broadcasts `{type:"menu_action", action, ts}` when a client is attached, and otherwise parks it in a pending slot (same 10 s TTL as `pending-open.ts`) that `/app/events` flushes on connect. It focuses the window, or creates it when there is none. **No `ROUTE_POLICY` change**: no route is added or changed, and `/app/events` is already `SSE_LEGACY` (`app+cli`). A CLI client streaming `/app/events` sees an action id only, and its clone filter ignores it. | E (route-policy.ts:482, quit-guard.ts, pending-open.ts) — closes the grill's open item 5 |
| D-P12 | **One webview entry point for menu actions**: `runMenuAction(action)` in App.tsx. The `menu_action` handler and the ⌘, listener both call it. It is a no-op while an `aria-modal` dialog is open (the same reason a click on the bar is blocked by a modal overlay). Every action is an idempotent "open", never a toggle, so a ⌘, that reaches both the page and the native menu can't flip anything back. It bumps `dismissNonce`, which closes the panel and the More menu first. | R |
| D-P13 | **Menu layout**: "Settings…" (`Cmd+,`) right after About in the Agetor menu. A new top-level **"Go"** menu between Edit and Window holds "Pipelines", "Worktrees…", "Git Pull Requests and Issues…" and "Import Sessions…", with no accelerators (avoids colliding with webview shortcuts). | R (HIG: every toolbar item in the menu bar) |
| D-P14 | **Clock**: `useBarClock(nextChangeAt, panelOpen)` re-renders at the next cooldown, reset or stale-threshold instant (clamped to 1 s–30 min), and every 30 s while the panel is open (for "updated N ago"). One timer per bar. | grill assumption 4 |
| D-P15 | **Settings stack-history deep link**: `SettingsDialog` gains `initialStackHistoryId?: string \| null`. Precedence in `entryView` is agent profile, then stack history, then section. | R (grill 6 "Swap history") |
| D-P16 | **Task count** moves verbatim (`N tasks` / `X of N tasks`) into `KanbanFilters` as the optional `taskCount` prop, right-aligned, `data-testid="board-task-count"`. The filter row gains `flex-wrap gap-y-2 min-w-0`, so the row never widens the document at narrow widths. | grill 17 + R |
| D-P17 | **Tooltips**: icon buttons use `ui/tooltip.tsx` (labels = today's `title` text). Accessible names (`Git`, `Import Claude Code sessions and OpenCode sessions`, `Worktrees`, `Pipelines`, `Settings`) and `data-testid`s (`pipelines-button`, `import-claude-sessions-open`) stay unchanged. The Harnesses button's accessible name is `Harnesses`; its summary is the tooltip label and therefore its `aria-describedby`. `e2e/helpers.ts` `headerSettingsButton` moves to `getByRole("banner").getByRole("button", { name: "Settings", exact: true })`. | grill 23 |
| D-P18 | `UsageMeter.tsx` and `UsagePopover.tsx` are **deleted** in the same wave that removes their only importer (Wave 3). `BarMeter`, `StatusDot` and `AccountUsageRow` replace them; no orphan is left. | grill dispositions |

### Rejected alternatives

- **Per-chip priority+ strip / hybrid** — the owner chose the single button (grill 1).
- **CSS container queries in rem instead of measuring** — the button's content varies (badge, until, digit counts), so rem breakpoints would be either wasteful or wrong, and the owner accepted a measured fit (grill 12, 26).
- **A dependency (`react-responsive-overflow-list`, floating-ui)** — no new dependency (grill 26). The repo's primitives are hand-rolled.
- **Webview-only ⌘, with no native item** — the owner chose the full menu (grill 16). The HIG wants every toolbar item in the menu bar.
- **Electrobun RPC or `executeJavascript` for menu clicks** — the repo's browser ↔ core channel is the HTTP API + SSE by design (CLAUDE.md "Stack and architecture").
- **RunPanel below the bar / reserving `--run-panel-width`** — the owner kept RunPanel as is (grill 13). The menu covers reachability.

## 4. Work breakdown — implementation tasks

Pinned interfaces (agents in later waves code against these exactly):

```ts
// src/mainview/lib/harness-bar.ts (T1)
export type AccountTone = "danger" | "warning" | "success" | "muted";
export type AccountStateKind = "disabled" | "unavailable" | "logged-out" | "cooling" | "out-of-quota" | "ready";
export interface AccountState {
  harnessId: string; kind: AgentKind; label: string;
  state: AccountStateKind; tone: AccountTone;
  statusText: string;            // "Unavailable" | "Status unknown" | "Logged out" | "Cooling until 14:30" | "Out of quota until 14:30" | "Out of quota" | "Ready" | "Disabled"
  detail: string | null;         // CLI reason / authHelp / path — plain text only
  quota: HarnessQuota | null;
  usedPercent: number | null;    // worst blocking meter (quotaSummary), null when none or status !== "ok"
  stale: boolean;                // quotaSummary(...).stale for a present snapshot; false when quota is null
  blockedUntil: number | null;   // account-wide cooldown end, else harnessQuotaResetAt
  cooldowns: CooldownChip[];     // cooldownChips(limitStates, id, now)
  runningTasks: number;          // non-archived tasks in column "running" with agent === id
  usageSupported: boolean;       // USAGE_SUPPORTED_KINDS.includes(kind)
}
export interface StackMemberState extends AccountState { positionLabel: string } // "Primary" | "Backup 1" | …
export interface FailoverTask { taskId: string; title: string; parentId: string | null; stackId: string; kind: "switching" | "waiting"; text: string }
export interface StackUnit {
  stack: HarnessStack; kindLabel: string;            // STACK_KIND_LABEL
  members: StackMemberState[];                       // stack order, disabled members included (state "disabled")
  usableCount: number;
  headroomPercent: number | null; headroomSource: string | null; stale: boolean;
  blockedUntil: number | null;                       // set only when usableCount === 0
  failoverTasks: FailoverTask[];
}
export interface HarnessBarButton {
  dot: AccountTone | "none"; enabledCount: number;
  meter: { usedPercent: number; stale: boolean; source: string } | null;
  badgeCount: number; allBlocked: boolean; until: number | null;
  summaryText: string;                               // tooltip + aria-describedby
}
export interface HarnessBarModel {
  button: HarnessBarButton; stacks: StackUnit[]; accounts: AccountState[];
  otherFailoverTasks: FailoverTask[]; nextChangeAt: number | null;
}
export interface HarnessBarInput {
  agents: readonly AgentStatus[]; harnesses: readonly Harness[]; stacks: readonly HarnessStack[];
  limitStates: readonly HarnessLimitState[]; usage: Readonly<Record<string, HarnessQuota>>; tasks: readonly Task[];
}
export function accountState(/* harness, status, limitStates, quota, tasks, now */): AccountState;
export function buildHarnessBarModel(input: HarnessBarInput, now: number): HarnessBarModel;

// src/mainview/lib/app-bar-fit.ts (T2)
export type AppBarStep = 0 | 1 | 2 | 3 | 4;
export interface AppBarPartWidths { full: number; wordmark: number; importAction: number; more: number; harnessText: number; until: number }
export const APP_BAR_FIT_HYSTERESIS_PX = 8;
export function stepHides(step: AppBarStep): { wordmark: boolean; importInMore: boolean; harnessText: boolean; until: boolean };
export function requiredWidth(step: AppBarStep, w: AppBarPartWidths): number;
export function chooseFitStep(available: number, w: AppBarPartWidths, previous: AppBarStep): AppBarStep;
// src/mainview/components/app-bar/use-app-bar-fit.ts (T2)
export function useAppBarFit(headerRef: RefObject<HTMLElement | null>, ghostRef: RefObject<HTMLElement | null>): AppBarStep;
// ghost parts: [data-fit-part="wordmark" | "import" | "more" | "harness-text" | "until"], summed per value, each + its parent's column-gap

// src/shared/types.ts (T3)
export const APP_MENU_ACTIONS = ["settings", "pipelines", "worktrees", "git", "import-sessions"] as const;
export type AppMenuAction = (typeof APP_MENU_ACTIONS)[number];
// AppEvent member: | { type: "menu_action"; action: AppMenuAction; ts: number }

// src/mainview/lib/app-menu.ts (T3)
export const MENU_ACTION_BLOCKING_LAYERS = '[role="dialog"][aria-modal="true"]';
export function isAppMenuAction(v: unknown): v is AppMenuAction;
export function isSettingsShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, isMac: boolean): boolean;

// src/mainview/components/app-bar/AppBar.tsx (T9) — App.tsx (T10) codes against this
export interface AppBarProps {
  agents: AgentStatus[]; harnesses: Harness[]; stacks: HarnessStack[]; limitStates: HarnessLimitState[];
  usage: Record<string, HarnessQuota>; tasks: Task[];
  pipelinesActive: boolean; dismissNonce: number;
  onOpenGit(): void; onOpenImportSessions(): void; onOpenWorktrees(): void; onOpenPipelines(): void; onOpenSettings(): void;
  onOpenHarnessSettings(): void; onOpenStackHistory(stackId: string): void; onOpenFailoverTask(taskId: string): void;
  onRefreshUsage(harnessId: string): Promise<void>;
}
export const AppBar: React.MemoExoticComponent<(p: AppBarProps) => JSX.Element>;
```

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Pure bar model: account states, live stacks with headroom, ordered accounts, failover tasks, button summary, `nextChangeAt` | `src/mainview/lib/harness-bar.ts` (new); `src/mainview/lib/usage.ts` (doc comments only: the header and `visibleTopbarAgents` now feed the app bar's Harnesses button/panel; no code change) | — | (a) Given 7 enabled accounts, one 2-member stack, 2 unstacked Claude, `buildHarnessBarModel` returns 1 stack unit with members `[Primary, Backup 1]` and 5 accounts. (b) `enabledCount` = `visibleTopbarAgents(...).length`. (c) Each state of D-P6 in precedence order, including a per-model-only cooldown → `ready` with 1 chip, and a missing status row → `unavailable`/"Status unknown". (d) Headroom = min over usable members' worst blocking %; ignores members without a figure; 100 + earliest `blockedUntil` when none is usable; null when no usable member reports. (e) A stack with 1 enabled + 1 disabled member → no stack unit; the enabled member appears in `accounts`; the disabled one is absent. A 3-member stack with 1 disabled → a unit with a `disabled` member. (f) Meter = max-% unit, ties → panel order; omitted when no figure; unavailable/logged-out excluded; `stale` comes from the chosen unit. (g) `allBlocked`/`until` per D-P5, including "no reset known". (h) Dot: danger beats warning beats success; `none` at 0 enabled. (i) Accounts order running → problem (tone danger/warning or used ≥ `USAGE_CRIT_PERCENT`) → DB order, stable. (j) Failover per D-P8: archived excluded, `pendingSwap` wins, step task keeps `parentId`, unknown stack → `otherFailoverTasks`. (k) `nextChangeAt` = min future instant of cooldown ends, meter resets, `fetchedAtMs + HARNESS_QUOTA_STALE_MS`, `earliestResetAtMs`; null when none; never ≤ now. (l) Uses `harnessQuotaLooksExhausted`/`harnessQuotaResetAt`/`quotaSummary`/`cooldownChips`/`formatResetClock` — grep shows no re-implemented threshold. Proven by U1. | state | T8, T7 via T9 (`AppBar` calls `buildHarnessBarModel`) |
| T2 | Collapse ladder + measured-fit hook | `src/mainview/lib/app-bar-fit.ts` (new); `src/mainview/components/app-bar/use-app-bar-fit.ts` (new) | — | (a) `stepHides` matches D-P3 for 0–4. (b) `requiredWidth(0)=full`; each step subtracts its parts and step ≥ 2 adds `more`. (c) `chooseFitStep` returns the smallest fitting step; moving to a smaller step needs `required ≤ available − 8`; a larger step is taken as soon as `required > available`; nothing fits → 4; any non-finite or zero `full` → 0 (not measured yet). (d) Hook: two `ResizeObserver`s (header + ghost); available = header `clientWidth − padding-left − padding-right`; sums `[data-fit-part]` widths + parent `column-gap`; sets state only when the step changes; disconnects on cleanup (StrictMode double-mount leaves one observer pair). Proven by U2 + E1. | state | T9 (`AppBar` calls `useAppBarFit`) |
| T3 | Native menu → webview plumbing | `src/shared/types.ts` (`APP_MENU_ACTIONS`, `AppMenuAction`, `menu_action` member + its doc line in the `AppEvent` comment block; reword `Harness.enabled` `:397`, `HarnessQuota` `:1573` and `harness_usage` `:6715` comments from "topbar chip" to "app bar's Harnesses button/panel"); `src/bun/app-menu.ts` (new: `buildAppMenu()` with a local structural `MenuItem` type — no `electrobun` import — and `menuActionFromClick()`, `deliverMenuAction(action, deps)`); `src/bun/pending-open.ts` (`setPendingMenuAction`, `consumePendingMenuAction`, same TTL); `src/bun/server.ts` (`/app/events` flushes a pending menu action right after the pending open-task flush; reword the comment at `:4436` to name `components/app-bar/AppBar.tsx`); `src/bun/index.ts` (`installNativeMenu` → `ApplicationMenu.setApplicationMenu(buildAppMenu())`; the click handler routes `menuActionFromClick` hits to `deliverMenuAction` with real deps: `hasAppEventListeners`, `broadcastAppEvent`, `setPendingMenuAction`, `getMainWindow`, `focusMainWindow`, `windowLifecycle.createMainWindow`; update the `:845-850` comment to "keep `x` in sync with the app bar's `pl-[80px]`/`h-[40px]` in `components/app-bar/AppBar.tsx`"); `src/bun/usage/cursor-usage.ts` (comment `:797` "topbar popover" → "Harnesses panel"); `src/mainview/lib/app-menu.ts` (new, pinned above) | — | (a) `buildAppMenu()` keeps every existing item and role/accelerator, adds "Settings…" `Cmd+,` (action `webview:settings`) after About, and a "Go" menu between Edit and Window with the four `webview:*` items in D-P13 order. (b) `menuActionFromClick("webview:git") === "git"`; `"remote-access"`, `"quit-completely"`, `"webview:nope"`, `undefined` → null. (c) `deliverMenuAction`: with listeners → broadcast once, no pending; without listeners → pending set, no broadcast; no window → `createWindow` (no focus); with window → `focusWindow`. (d) Pending: set then consume within TTL → action; after TTL → null; consume clears. (e) `/app/events` sends `{type:"menu_action"}` to a client that connects within the TTL (U3 covers the pure halves; E1 covers delivery). (f) `isSettingsShortcut`: Mac needs `metaKey && !ctrlKey`, others `ctrlKey && !metaKey`; `altKey` or `shiftKey` disqualifies; key `","`. (g) No `ROUTE_POLICY` change; `bun test src/bun/route-policy.test.ts` stays green. (h) `bun run typecheck` green (the new union member breaks no exhaustive switch). | trust (a new message on an `app+cli` stream: action id only), external (native menu) | `src/bun/index.ts` boot (`installNativeMenu`, the `application-menu-clicked` handler); webview side wired by T10 |
| T4 | Task count in the filter row; the row can't widen the document | `src/mainview/components/kanban/KanbanFilters.tsx` | — | (a) Optional `taskCount?: { visible: number; total: number }`; absent → nothing rendered (keeps the Wave 1–2 barriers green). (b) `visible === total` → `"${total} tasks"`, else `"${visible} of ${total} tasks"` (verbatim from `App.tsx:2687-2689`), in `<span data-testid="board-task-count" class="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">`. (c) The row has `min-w-0 flex-wrap gap-y-2`. (d) The Escape handler is unchanged. Proven by U4 + E1. | none | T10 passes `taskCount` |
| T5 | Settings deep link to one stack's swap history | `src/mainview/components/settings/SettingsDialog.tsx` | — | (a) New optional prop `initialStackHistoryId?: string \| null`. (b) `entryView` is **exported** and takes it as a third arg: an agent profile beats a stack history, which beats a section, which beats General. (c) The derive-state block (`:347-357`) compares the new prop too, so reopening with a different stack id lands on that stack's history. (d) The sidebar shows Harnesses active on the stack-history view (existing `activeSection` behavior, unchanged). Proven by U4. | state | T10 passes `initialStackHistoryId` |
| T6 | Leaf components: compact meter, status dot, account row (today's popover content + status + cooldowns) | `src/mainview/components/app-bar/BarMeter.tsx` (new), `src/mainview/components/app-bar/StatusDot.tsx` (new), `src/mainview/components/app-bar/AccountUsageRow.tsx` (new) | — | T6 defines its own prop types, with field names identical to T1's `AccountState`/`AccountTone`, and imports nothing from `harness-bar.ts`, which lands in the same wave; T7 passes `AccountState` objects, which typecheck structurally. **BarMeter** `{ usedPercent, stale?, className? }`: track + fill, tier color via `warnTier`/`tierColorVar` and a literal `FILL_CLASS`; `opacity-60` when stale; `aria-hidden`. **StatusDot** `{ tone: AccountTone \| "none", label }`: literal class map (`bg-danger-solid`, `bg-warning-solid`, `bg-success-solid`, muted → `bg-muted-foreground/40`, none → `bg-muted-foreground/30`), `role="img" aria-label={label}`. **AccountUsageRow** props = the `AccountState` fields plus `positionLabel?`, `now`, `onRefresh(harnessId)`: icon, full label, position, a status text chip (tone colored, never color alone), running count, plan type, every meter (label · scope, %, bar, `formatResetsIn`), "updated N ago" (`formatUpdatedAgo`; prefixed "stale ·" and dimmed when stale), cooldown chips (`data-testid="harness-cooldown-chip"`, provider `message` as text), Refresh (`aria-label="Refresh usage"`, spinner while pending, errors swallowed as today). With no quota: "Usage tracking isn't supported for this harness yet." (unsupported, no Refresh) or "No usage data yet — the first poll runs shortly, or refresh now." (supported, Refresh). `quota.meters.length === 0` → `quota.reason ?? "No usage data"`. Root `data-testid="harnesses-panel-account-<harnessId>"`. Proven by C1. | trust (provider text rendered as text) | T7 |
| T7 | The portaled Harnesses panel | `src/mainview/components/app-bar/HarnessesPanel.tsx` (new), `src/mainview/components/app-bar/StackSection.tsx` (new), `src/mainview/lib/find-shortcut.ts` (comment only: add the Harnesses panel to the `escape-only` carrier list) | T1, T6 | Props `{ open, anchor: HTMLElement \| null, panelId, model: HarnessBarModel, now, onClose(opts?: { restoreFocus: boolean }), onRefreshUsage, onOpenHarnessSettings, onOpenStackHistory, onOpenFailoverTask }`. The panel's content is an exported, non-portaled `HarnessesPanelBody` (same props minus `open`/`anchor`), so C1 can render it statically (React's server renderer can't render portals, and no repo test mocks `createPortal`). (a) `createPortal` to `document.body`, `position: fixed`, placed under the anchor via `placeContextMenu`, `z-50`, width `min(24rem, 100vw - 16px)`, `max-h-[70vh] overflow-y-auto`; `role="dialog"`, `aria-label="Harnesses"`, `id={panelId}`, `data-testid="harnesses-panel"`, `data-popover-open=""`, `data-popover-keys="escape-only"` (all only while open). (b) Escape per D-P9; outside `mousedown` (not on the anchor) closes without moving focus; window `resize` closes; on open, the panel (`tabIndex=-1`) takes focus. (c) Order: stacks (`StackSection`), then "Other failover activity" when non-empty, then accounts; empty state "No harnesses enabled" + "Open Settings → Harnesses" button. (d) `StackSection` (`data-testid="harnesses-panel-stack-<stackId>"`): kind icon + stack label + a "Stack" marker (Layers icon + text), one `StatusDot` per member (label `"<label>: <statusText>"`), a headroom `BarMeter` + `NN%` (+ "stale"), "all out · resets HH:MM" when `usableCount === 0`, the failover task buttons (`data-testid="harnesses-panel-failover-<taskId>"`, text = title + `FailoverTask.text`), member `AccountUsageRow`s with `positionLabel`, then "Refresh usage" (refreshes every member, `Promise.allSettled`), "Manage stack…" (→ `onOpenHarnessSettings`) and "Swap history" (→ `onOpenStackHistory(stack.id)`). Every action closes the panel first. (e) Every provider/CLI string is a text child. Proven by C1 + E1. | trust, state | T9 |
| T8 | The Harnesses button (live + measure variants) | `src/mainview/components/app-bar/HarnessesButton.tsx` (new) | T1, T6 | Props `{ button: HarnessBarButton, hide: { harnessText: boolean; until: boolean }, open, panelId, onToggle, buttonRef?, measure?: boolean }`. (a) Live: `<button type="button" aria-label="Harnesses" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} data-testid="harnesses-button" class="electrobun-webkit-app-region-no-drag h-[32px] min-w-0 …">` wrapped in `ui/tooltip` with `label={button.summaryText}`. (b) Content order: `StatusDot` (`data-testid="harnesses-button-dot"`), "Harnesses", count (`harnesses-button-count`), `BarMeter` (`harnesses-button-meter`, when `meter`), `NN%`, badge (`harnesses-button-badge`, `ArrowLeftRight` icon + count, warning tokens, only when `badgeCount > 0`), "until HH:MM" (`harnesses-button-until`, only when `until`). `hide.harnessText` drops "Harnesses", the count and the %; `hide.until` drops the until text. (c) `measure`: renders everything (step 0), tags `data-fit-part="harness-text"` on "Harnesses", the count and the %, and `data-fit-part="until"` on the until text; no testids, no tooltip, no handlers, no ids, no aria attributes. Proven by C1. | none | T9 |
| T9 | The app bar shell: header, actions, More, ghost, panel state, clock | `src/mainview/components/app-bar/AppBar.tsx` (new), `src/mainview/components/app-bar/use-bar-clock.ts` (new) | T1, T2, T6, T7, T8 | (a) `AppBar` is `memo`'d. `now = useBarClock(model.nextChangeAt, panelOpen)` per D-P14 (one `setTimeout`, cleared on change/unmount). The model is `useMemo(buildHarnessBarModel)` keyed on the six input arrays + `now`. (b) `<header data-testid="app-bar" data-fit-step={step} class="electrobun-webkit-app-region-drag relative flex h-[40px] shrink-0 items-center justify-between gap-3 overflow-x-clip border-b border-border/60 pl-[80px] pr-4">`. The left group is logo (`size-[28px]`) + wordmark h1 (hidden at step ≥ 1) + `HarnessesButton`, with `min-w-0`. The right group is `shrink-0` with Git, Import (hidden at step ≥ 2), Worktrees, Pipelines (`variant="secondary"` when `pipelinesActive`), Settings, and More (step ≥ 2, `aria-label="More actions" aria-haspopup="menu" aria-expanded data-testid="app-bar-more"`). Icon buttons are `size-[32px]` with `electrobun-webkit-app-region-no-drag` on each button only (no wrapper carries `no-drag`), `ui/tooltip` labels = today's `title` strings, and aria-labels/testids unchanged (D-P17). (c) Double-click on empty bar space → `api.toggleWindowZoom()`, skipped when the target is inside `.electrobun-webkit-app-region-no-drag` (moved from `App.tsx:2622-2625`). (d) Ghost: a sibling `<div data-app-bar-ghost aria-hidden="true" inert class="pointer-events-none invisible absolute left-0 top-0 flex h-0 items-center gap-3 overflow-hidden whitespace-nowrap">` holding the step-0 contents through `measure` variants (logo, wordmark `data-fit-part="wordmark"`, `HarnessesButton measure`, the five icon replicas with Import `data-fit-part="import"`, and a More replica `data-fit-part="more"`) — no testids, no aria-labels, no handlers; `useAppBarFit(headerRef, ghostRef)`. (e) The panel opens on toggle, closes per T7, and `dismissNonce` changes close it and the More menu. (f) The More menu = `ContextMenu` per D-P10, anchored at the More button's `getBoundingClientRect()` bottom-left; selecting Import calls `onOpenImportSessions`. (g) The header's doc comment carries the drag-region, zoom-pinning and traffic-light notes (moved from `App.tsx:2604-2619`) and cites `docs/architecture/app-bar.md`. Proven by C2 + E1. | state, concurrency (timers, observers) | T10 (`App.tsx` renders `<AppBar>`) |
| T10 | Wire the app bar into App, menu actions, ⌘,, count, deep links; delete the old usage components | `src/mainview/App.tsx`; `src/mainview/lib/api.ts` (comment at `:652` only: the app bar now lives in `components/app-bar/AppBar.tsx`); delete `src/mainview/components/usage/UsageMeter.tsx` and `src/mainview/components/usage/UsagePopover.tsx` | T3, T4, T5 (+ pinned `AppBarProps`; T9 lands in the same wave) | (a) The header block `:2604-2739` is replaced by `<AppBar …/>` with the props pinned above; the imports `:40-42` and the now-unused `USAGE_SUPPORTED_KINDS` are removed; `grep -rn "UsagePopover\|UsageMeter\|components/usage" src` → nothing. (b) `onRefreshUsage` = `api.refreshHarnessUsage(id)` then `setUsage` (today's popover callback). (c) `openFailoverTask(taskId)`: find it in `tasksRef.current`; a step → `openPipelineStep(parentId, id)`, else `openTask(t)`; if missing, `await refresh()` once and retry, else no-op (mirrors the `open_task` handler `:1424`). (d) New state `settingsInitialStackHistoryId`; `openStackHistory(id)` sets section `harnesses` + that id + opens Settings; every other Settings entry point (`openSettingsHarnesses`, `openSettingsAgents`, the auto-enable toast, `openSettings`) clears it; passed to `SettingsDialog initialStackHistoryId`. (e) `runMenuAction(action)` per D-P12: `settings` → `openSettings()` (today's `setSettingsOpen(true)` semantics + clearing the stack-history id), `pipelines` → `openPipelinesPage()`, `worktrees`/`git`/`import-sessions` → their `set…Open(true)`; increments `appBarDismissNonce`. (f) `subscribeAppEvents` handler: `if (ev.type === "menu_action") { if (isAppMenuAction(ev.action)) runMenuAction(ev.action); return; }`. (g) A document `keydown` listener: `isSettingsShortcut(e, isMacPlatform())` → when a blocking layer is present, return without `preventDefault`; else `preventDefault()` + `runMenuAction("settings")`. (h) `KanbanFilters taskCount={{ visible: visibleTasks.length, total: nonStepTasks.length }}` (the m4 comment moves with it). (i) The comments at `:288-291`, `:811-816` and `:893-897` say "app bar" instead of "topbar chip"/"header's status dots". Proven by E1, E2, `bun run typecheck`. | state | `App.tsx` render tree (`AppInner`) |

Partition check (no path twice in one wave): Wave 1 = T1 {harness-bar.ts, usage.ts} · T2 {app-bar-fit.ts, use-app-bar-fit.ts} · T3 {shared/types.ts, bun/app-menu.ts, bun/pending-open.ts, bun/server.ts, bun/index.ts, bun/usage/cursor-usage.ts, mainview/lib/app-menu.ts} · T4 {KanbanFilters.tsx} · T5 {SettingsDialog.tsx} · T6 {BarMeter.tsx, StatusDot.tsx, AccountUsageRow.tsx} — disjoint. Wave 2 = T7 {HarnessesPanel.tsx, StackSection.tsx, find-shortcut.ts} · T8 {HarnessesButton.tsx} · U1–U4 (§5) — disjoint. Wave 3 = T9 {AppBar.tsx, use-bar-clock.ts} · T10 {App.tsx, api.ts, deletes under components/usage/} · C1 {four app-bar test files} · E2 {e2e/helpers.ts, e2e/usage-tracker.spec.ts, e2e/board-search-shortcut.spec.ts} — disjoint. Wave 4 = E1 {e2e/app-bar.spec.ts} · C2 {AppBar.test.tsx} · D1 {docs} — disjoint.

## 5. Work breakdown — test tasks

Every test task: each new test must be shown red against a broken copy of the behavior (flip a comparison, drop a branch, or delete the guarded line), then green. A missing env skips loudly, never passes silently.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U1 | unit | T1 | `src/mainview/lib/harness-bar.test.ts` (new) | One `describe` per T1 acceptance letter (a)–(l), with fixed `now`, synthetic ids (`acct-a`, `acct-b`, …) and fixtures built in the file. It includes: a stale snapshot dims but still counts; a credits meter with headroom → not out of quota (shared rule); a reset in the past → not blocked; two units tied at the max %; a deleted stack id on a failover task → `otherFailoverTasks`; a pipeline step failover task keeps `parentId`. Red proof: flip `>=` in the state precedence and a headroom `min`→`max`, and see failures. |
| U2 | unit | T2 (lib) | `src/mainview/lib/app-bar-fit.test.ts` (new) | `stepHides` table; `requiredWidth` arithmetic; `chooseFitStep` for: wide (→ 0), each threshold ±1 px, hysteresis (from 3, 1 px above the threshold of 2 stays 3; 8 px above goes to 2), nothing fits (→ 4), unmeasured (→ 0), `until = 0` (step 4 ≡ step 3 width). |
| U3 | unit | T3 | `src/bun/app-menu.test.ts` (new); `src/bun/pending-open.test.ts` (extend); `src/mainview/lib/app-menu.test.ts` (new) | T3 (a)–(d), (f): menu template snapshot of labels/actions/accelerators (incl. every pre-existing item); `menuActionFromClick` table; `deliverMenuAction` with fake deps for the 4 combinations (listeners × window); pending set/consume/TTL/clear; `isSettingsShortcut` matrix (mac/non-mac × modifiers × key); `isAppMenuAction` rejects non-members and non-strings. |
| U4 | unit/component | T4, T5 | `src/mainview/components/kanban/KanbanFilters.test.tsx` (new); `src/mainview/components/settings/SettingsDialog.test.ts` (extend) | KanbanFilters via `renderToStaticMarkup`: no `board-task-count` without `taskCount`; `"12 tasks"` / `"3 of 12 tasks"`; the row class contains `flex-wrap`. SettingsDialog: `entryView` precedence table (profile > stack history > section > General). |
| C1 | component | T6, T7, T8 | `src/mainview/components/app-bar/AccountUsageRow.test.tsx`, `BarMeter.test.tsx`, `HarnessesButton.test.tsx`, `HarnessesPanel.test.tsx` (all new) | `renderToStaticMarkup` (the `StackBadge.test.tsx` pattern). Row: each placeholder branch, meters/%/reset, a stale prefix, a cooldown chip with provider text containing `<b>` rendered escaped, the position label. Meter: tier class at 69/70/90, width clamped, stale opacity. Button: the full and `hide` variants; `measure` has no `data-testid`, no `aria-*`, and carries `data-fit-part`; badge/until/meter absent when the model says so. Panel: render `HarnessesPanelBody` (the portal wrapper is covered by E1): stack section before accounts, member dots with text labels, position labels, "Other failover activity", failover rows, and the empty state; `HarnessesPanel` with `open={false}` renders nothing. The open-state markers (`data-popover-open`, `data-popover-keys="escape-only"`, `role="dialog"`) are asserted in E1. |
| C2 | component | T9 | `src/mainview/components/app-bar/AppBar.test.tsx` (new) | `renderToStaticMarkup(<AppBar …/>)` with fixtures: every live testid (`app-bar`, `harnesses-button`, `pipelines-button`, `import-claude-sessions-open`) appears **exactly once** (the ghost adds none); the ghost has `aria-hidden="true"` and `inert`; the header has the drag class; each icon button has `no-drag` and no wrapper `div` does; the header has `h-[40px]` and `pl-[80px]`; step 0 markup shows the wordmark and Import; accessible names are unchanged. |
| E1 | e2e | S1–S7 end to end | `e2e/app-bar.spec.ts` (new) | `freshBackend`. **Arrange**: PATCH `antigravity` and `copilot` disabled and `codex`, `cursor`, `opencode` enabled; `createStackAccount` ×3 (`e2e-bar-a`, `e2e-bar-b`, `e2e-bar-c`, label = id); `createStackViaApi("e2e bar stack", "claude-code", [a, b])`; `seedHarnessUsage` for `claude-code`, `a` (blocking meters), `b`; `seedLimitState(b, +2h)`; the all-exhausted recipe from `e2e/harness-stack-swap.spec.ts:364-381` (task on `a` with `__agetor_fake_claude_limit__`, model `sonnet-4.6`, wait for `harnessState.allExhausted`), copied locally with its helpers; `installSseInjector(page, "/app/events")` before `gotoApp`. **Matrix**: widths 1440/1100/900/720 × zoom 100/170 (`gotoApp(page, ${bootBase}&fontSize=170)`, the `font-size.spec.ts:57-66` pattern) × `setViewportSize`: `scrollWidth <= clientWidth` on `documentElement`; header box height 40 and computed `padding-left` 80px; Settings, Pipelines, Git, Worktrees (by role/name in the banner) and the Harnesses button visible, `rect.right <= innerWidth`, and `click({ trial: true })` succeeds; Import is either a banner button or reachable via More (open More → menuitem "Import sessions…" visible → Escape closes, focus back on More); `data-fit-step` is 0 at 1440@100 and non-decreasing as width shrinks per zoom, and ≥ 1 at 720@170. **Button**: count "7", badge "1", meter present. **Panel**: open → `dialog "Harnesses"`; the stack section lists `e2e-bar-a` (Primary) then `e2e-bar-b` (Backup 1), b shows a `harness-cooldown-chip`, the failover row shows "waiting for quota" and opens the task's RunPanel on click; Escape closes and focus returns to the button; "Swap history" opens Settings on that stack's History. **RunPanel open** (the failover task's panel): at 1440 the Harnesses button is clickable, no sideways scroll at every width; inject `menu_action` for each of the five actions → Settings heading / `pipelines-page` testid / Git dialog / Worktrees dialog / Import dialog appear, each closed before the next; `ControlOrMeta+Comma` opens Settings. **Board**: `board-task-count` reads "N tasks"; the Pipelines page has no count. Cleanup: delete created harnesses, stack and task. |
| E2 | e2e | T9/T10 locator moves | `e2e/helpers.ts` (`headerSettingsButton` per D-P17; doc comment updated); `e2e/usage-tracker.spec.ts` (rewrite the chip test: banner → Harnesses button → its `harnesses-button-meter` fill is `bg-danger` with width `95%` → open the panel → `harnesses-panel-account-claude-code` shows "max", "Session (5h)" 42%, "Weekly" 95% with a `bg-danger` fill, "Refresh usage" → Escape closes; the "disabled harnesses render nothing" assertion becomes: no `harnesses-panel-account-{codex,cursor,gemini,fx}` rows in the open panel); `e2e/board-search-shortcut.spec.ts` (test (f) `:287`: chip → Harnesses button, popover → `dialog "Harnesses"`; same three-step assertions) | Both specs green, and each shown red against a pre-change copy of the bar (the old DOM lacks `harnesses-button`). |
| D1 | docs | all | `docs/architecture/app-bar.md` (new); `CLAUDE.md` (topic-map row); `docs/architecture/harness-stacks.md` (§ Surfaces → Webview `:1816`: add the app bar bullet; § "One-account stacks" `:1880`: note the bar's stricter enabled-member rule); `docs/architecture/prompt-composer.md` (`:23` carrier list: add the Harnesses panel as an `escape-only` carrier); `README.md` (`:67` usage-meter line: "…shown in the app bar's Harnesses panel, grouped by stack") | `app-bar.md` covers: layout and clusters, the collapse ladder and measured fit (ghost, hysteresis, observers), drag regions and the double-click guard, zoom pinning (D-P1) and the traffic-light offset, RunPanel overlap (kept) and menu reachability, the Harnesses button/panel model (D-P4…D-P8 rules, pointing to `lib/harness-bar.ts` as the single implementation), Escape/⌘F coordination (D-P9), the native menu actions (`menu_action`, pending slot, no ROUTE_POLICY change, `runMenuAction` and its modal guard), and test seams (`data-fit-step`, testids, SSE injection of `menu_action`). Topic-map row: `[app-bar.md](docs/architecture/app-bar.md)` · "the window app bar: Harnesses button and panel, collapse ladder and measured fit, drag regions, zoom pinning, native menu actions" · `components/app-bar/`, `lib/harness-bar.ts`, `lib/app-bar-fit.ts`, `lib/app-menu.ts`, `src/bun/app-menu.ts`. `bun test src/bun/claudemd-citations.test.ts` stays green. |

**E2E applies**: the change is a user-visible flow across widths and zoom levels, plus a core → webview event. The app runs locally.

**Run recipe**:

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                   # this worktree has no node_modules yet
bun run typecheck
bun test src/mainview/lib/harness-bar.test.ts src/mainview/lib/app-bar-fit.test.ts src/mainview/lib/app-menu.test.ts \
         src/bun/app-menu.test.ts src/bun/pending-open.test.ts src/mainview/components/app-bar \
         src/mainview/components/kanban/KanbanFilters.test.tsx src/mainview/components/settings/SettingsDialog.test.ts
bun test                                      # whole unit suite (check `uptime` first; serialize with other agents)
bun node_modules/@playwright/test/cli.js test e2e/app-bar.spec.ts e2e/usage-tracker.spec.ts e2e/board-search-shortcut.spec.ts
bun node_modules/@playwright/test/cli.js test # full e2e — one Playwright run at a time across agents
```

The Playwright config starts Vite (`bun run hmr`, :5173) and one isolated headless backend per worker (`e2e/fixtures.ts`). Seeds come from `e2e/helpers.ts` (`seedHarnessUsage`, `seedLimitState`, `createStackAccount`, `createStackViaApi`, `installSseInjector`/`injectSseFrame`). No credentials are needed (fake drivers).

**Live smoke (V1, needs the owner's screen; record as owner-check if run unattended)**: `bun run dev:hmr` (data dir `~/.agetor-dev`, never `~/.agetor`), then check:

- the "Settings… ⌘," and Go menu items are present and each opens its target, once;
- ⌘, opens Settings once, with focus in the board and inside the composer;
- a menu item opens a window first when the window was closed (⌘W, then the menu);
- the traffic lights stay centered in the bar at 100 % and 170 %;
- empty bar space drags the window, double-click zooms, and clicking a control does neither.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier (must be green before the next wave) |
| --- | --- | --- |
| 1 | T1, T2, T3, T4, T5, T6 | `bun run typecheck`; `bun test src/bun/route-policy.test.ts src/bun/pending-open.test.ts src/mainview/lib/usage.test.ts`; the app still renders the old bar (App.tsx untouched). Checkpoint commit. |
| 2 | T7, T8, U1, U2, U3, U4 | typecheck; the new unit tests green and each shown red once. Checkpoint commit. |
| 3 | T9, T10, C1, E2 | typecheck (T10 compiles against T9's real `AppBarProps`); `bun test src/mainview`; `grep` shows no `components/usage/` import; `e2e/usage-tracker.spec.ts` and `e2e/board-search-shortcut.spec.ts` green against the new bar. E2 is written in this wave, against the testids and accessible names pinned in T6–T9, so no barrier is knowingly red. Checkpoint commit. |
| 4 | E1, C2, D1 | the full gate below. Checkpoint commit. |
| 5 | V1 (verification, no owned files) | `bun run typecheck`; `bun test`; the targeted e2e, then the full e2e suite; the live smoke checklist; update this plan's `Status`. |

**Review points**: Wave 1 carries the `trust`/`external` tags (T3) and Wave 3 the `concurrency` tag (T9 timers and observers). Review T3 before Wave 2 builds on the event type, and T9/T10 before E1 is written against their DOM. If an E2 locator finds a pinned testid or name missing at the Wave 3 barrier, the fix goes to T9/T10 (the plan pins the DOM contract), not to the spec.

**Delivery**: one PR from this branch, reviewed commit by commit (one commit per wave). Size estimate: ~3.5k changed lines, ~45 % tests, one subsystem plus a small core plumbing slice. If a reviewer wants it smaller, split the slices as (1) T3 + the menu half of T10 + U3 + the menu part of E1 (wired: the menu opens the existing dialogs), then (2) everything else. Each slice is green on its own.

## 7. Invariants, runtime shape & risks

**Invariants** (each has one enforcement point; every path goes through it):

- "Out of quota", "cooling" and staleness in the bar are decided only in `accountState` (`src/mainview/lib/harness-bar.ts`). It delegates to `harnessQuotaLooksExhausted`/`harnessQuotaResetAt`/`quotaSummary`/`HARNESS_QUOTA_STALE_MS` (shared with the failover) and to `cooldownChips`. No component computes a threshold.
- A stack renders as a stack only through `buildHarnessBarModel`'s live-stack rule (≥ 2 enabled members). No component re-derives membership.
- Provider/CLI text (quota `reason`, cooldown `message`, status `reason`/`authHelp`/`path`) is rendered only as React text children, in `AccountUsageRow`, `StackSection` and the button summary. There is no `dangerouslySetInnerHTML` under `components/app-bar/` (C1 asserts it is escaped).
- Every bar overlay (panel, More menu, tooltips) is portaled to `document.body`. The panel and More carry `data-popover-open` only while open. Escape listeners check `e.defaultPrevented` first.
- Every menu action goes through `runMenuAction` in App.tsx: one modal guard, idempotent opens. On the core side, every click goes through `menuActionFromClick` → `deliverMenuAction`. Both sides validate against `APP_MENU_ACTIONS`.
- Only controls carry `electrobun-webkit-app-region-no-drag`. Empty bar space drags.
- The ghost renders only through `measure` variants (no testids, no accessible names), so the live bar's locators stay unique.

**Runtime shape**:

- One window, one local user. The bar adds no fetch, route, stream, DB column or preference.
- Timers: one `setTimeout` per mounted bar (next state change, 1 s–30 min), plus a 30 s tick while the panel is open. Two `ResizeObserver`s, disconnected on unmount (StrictMode-safe).
- A menu click while the webview is booting or the window is closed is parked for 10 s. A later reconnect can't replay it (TTL).
- The headless core has no native menu and never emits `menu_action`. A CLI client on `/app/events` receives the action id only and ignores it.
- The 2 s task poll re-renders `AppInner`. `AppBar` is `memo`'d, and its model is memoized on reconciled arrays, so an unchanged poll doesn't rebuild the model.

**Blast radius**: `App.tsx` (render site, menu/⌘, handlers, Settings deep links), `KanbanFilters` (count + wrap), `SettingsDialog` (one optional prop), the native menu (`index.ts`), `/app/events` (one flush line), the shared `AppEvent` union (one member), two e2e specs and `headerSettingsButton` (used by every spec's `gotoApp`). The other e2e that locate Git/Worktrees/Import/Pipelines by name or testid keep working because nothing collapses at 1280 × 100 % (step 0; the content is ≈ 700 px wide). E1 asserts `data-fit-step = 0` at 1440, and the full e2e run in V1 is the guard for 1280.

**Risks**:

- WKWebView may deliver ⌘, to the page before the menu, or the reverse. Both paths are idempotent and share one guard (D-P12); the live smoke checks Settings opens once.
- The `KanbanFilters` wrap changes vertical layout at narrow widths. `board-scroll-position.spec.ts` (880 px) measures horizontal reveal only, and V1's full e2e run covers it.
- `overflow-x: clip` needs Safari 16+/Chromium 90+, which macOS 13+ WKWebView and Playwright's Chromium both provide.
- Rollback: revert the branch. There is no data migration, and the native menu reverts with `index.ts`.

**Cross-repo dependencies**: none.

## 8. Open questions / assumptions

No one-way-door decisions: no auth, trust boundary, data or public contract changes. `menu_action` is additive on an existing stream.

Carried from the grill (planner's judgment, reversible):

1. **Collapse past step 3**: the count and the % hide with "Harnesses" (step 3), then "until HH:MM" (step 4). The dot, meter and badge always stay (D-P3).
2. **Empty state**: with no enabled harness the button stays (grey dot, "0"), and the panel says "No harnesses enabled" with a button to Settings → Harnesses.
3. **Meter absence**: no unit with a figure → no meter and no %.
4. **Expiry timer**: `useBarClock` (D-P14).
5. **Menu transport / ROUTE_POLICY**: **settled — no change** (D-P11).

New in planning (reversible; a reviewer should see them):

6. **Px-pinned control boxes** (D-P1): icon buttons 32 px, Harnesses button 32 px tall, logo 28 px; glyphs and text still scale. This follows from grill 15, since a 40 px bar can't hold 61 px buttons. *If wrong:* the bar would have to grow with zoom, which contradicts grill 15.
7. **Menu name "Go"** and no accelerators besides ⌘, (D-P13). *If wrong:* rename it or move the items into the Window menu (one-line change in `buildAppMenu`).
8. **Menu actions are no-ops while a modal dialog is open** (D-P12). *If wrong:* each action would need to close the open dialog first, which dirty-state guards complicate.
9. **The Harnesses panel is `escape-only`** (D-P9), so ⌘F works while it is open, matching today's behavior with the chip popover.
10. **Meter units exclude unavailable/logged-out accounts; stack headroom ignores usable members without data** (D-P4).
11. **The failover badge counts hidden pipeline step tasks and excludes archived ones** (D-P8).
12. **The filter row wraps** at narrow widths (D-P16), and the count text moves verbatim, "1 tasks" included.
13. **Cold-start pending menu action** (10 s TTL), so a menu click with no window still lands.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Per-account chip strip and inline placeholder logic (`App.tsx:2632-2680`) | In this run | T10 (replaced by `<AppBar>`), T6 (placeholder copy moves into `AccountUsageRow`) |
| `visibleTopbarAgents` (`usage.ts:82`) | In this run (reused as the enabled filter, doc comment updated; tests unchanged) | T1 |
| `UsageMeter.tsx`, `UsagePopover.tsx` | In this run (deleted when their only importer goes) | T10 |
| `UsagePopover` missing `data-popover-open` / not portaled | In this run (the replacement panel is portaled and marked) | T7 |
| Harness Stacks state in the bar (stack grouping, headroom, member dots, cooldowns, failover activity, Swap history, Manage) | In this run | T1, T7, T5, T10 |
| Grill-28 reversal recorded | In this run | §3 D-G1; D1 notes it in `app-bar.md` |
| Measured collapse, More menu, 720 px floor, no sideways scroll | In this run | T2, T9, T4 (filter row wrap) |
| Bar pinned at 40 px / 80 px under zoom; traffic-light comment in `index.ts:845` | In this run | T9, T3 |
| Native menu items + core → webview `menu_action` + cold-start pending | In this run | T3, T10 |
| ⌘, in the webview | In this run | T3 (predicate), T10 (listener) |
| Task count → `KanbanFilters`; gone from the Pipelines page | In this run | T4, T10 |
| Icon-button tooltips via `ui/tooltip.tsx`; names/testids unchanged | In this run | T9 |
| Settings deep link to a stack's history | In this run | T5, T10 |
| e2e locators: `headerSettingsButton`, `usage-tracker.spec.ts`, `board-search-shortcut.spec.ts:287` | In this run | E2 |
| New multi-width/zoom/RunPanel/menu e2e | In this run | E1 |
| Unit + component tests | In this run | U1–U4, C1, C2 |
| Comments naming removed components or "topbar chip": `types.ts:397/1573/6715`, `usage.ts` header, `App.tsx:288/811/893`, `api.ts:652`, `server.ts:4436`, `cursor-usage.ts:797`, `find-shortcut.ts` carrier list | In this run | T3, T1, T10, T7 |
| "topbar usage tracker" wording in `server.ts:4569`, `db.ts:3029`, `usage/claude-usage.ts:2`, `api.ts:754` | Out of scope | Still accurate: it names the feature (the usage tracker shown in the app bar), not a removed component |
| `src/bun/migrations/043_harness_usage.sql` comment | Out of scope | Applied migrations are never edited (CLAUDE.md) |
| Docs: `app-bar.md`, CLAUDE.md topic map, `harness-stacks.md` surfaces + one-account note, `prompt-composer.md` carrier list, `README.md:67` | In this run | D1 |
| Clear cooldown from the bar | Out of scope | Owner: Settings only (grill 6) |
| Per-harness pin/hide | Out of scope | Owner (grill 20) |
| RunPanel below the bar / reserving its width | Out of scope | Owner kept RunPanel as is (grill 13) |
| CLI/TUI header equivalent | Out of scope | `agetor harness ls` already shows it (grill 26) |
| Windows/Linux title bars | Out of scope | macOS-only releases (grill 26) |
| Historical plans (`harness-usage-tracker.md`, `hide-disabled-harnesses-topbar.md`, `harness-account-stacks*.md`) | Out of scope | Left as history; this plan records the reversal |
| Existing data to backfill | None | No schema or preference change |
| `ROUTE_POLICY` | No change needed | D-P11; `route-policy.test.ts` stays green (T3 acceptance g) |
