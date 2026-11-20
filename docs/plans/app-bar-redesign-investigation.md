# Investigation — App bar redesign (harness status + Harness Stacks, responsive)

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Change | Redesign the window app bar (`<header>` in `src/mainview/App.tsx`) so it stops overflowing and wrapping at narrower widths, groups and summarizes harness status instead of one chip per account, and shows Harness Stacks state. Informs the owner grill and then the plan. |
| Agents | none (single-agent pipeline step, delegation disabled): inline codebase, git-history and web research, 1 layout spike |
| Flags | none |

## 0. The request

The pipeline task says: "The App Bar is becoming polluted and broken when trying a responsive UI. With all the harnesses there (and even missing the Harness Stacks info). We must improve its UI/UX following the best practices." It came with a screenshot of the owner's app bar.

The screenshot shows the logo, then seven chips on one row: four Claude Code accounts, Codex, Cursor and OpenCode. Three chips have a usage mini-bar. The trailing actions are cropped out. No chip shows that two of the Claude accounts form a stack, and those two chips sit six chips apart.

The screenshot is outside the repo (a task attachment). The plan must restate the request in the repo.

## 1. What we know

### The app bar today

- **Render site.** The bar is inlined in `AppInner()`: `src/mainview/App.tsx:2620-2739`. The comment block above it is at `:2604-2619`. It has three clusters:
  - Logo and the `Agetor` h1 (`:2628-2631`).
  - The harness chip strip (`:2632-2680`): `visibleTopbarAgents(agents, harnesses).map(...)`. Each chip is a `UsagePopover` button with the kind icon, the harness label, an optional `UsageMeter` and a status dot.
  - The trailing cluster (`:2683-2738`): the task count (`"N tasks"` / `"X of N tasks"`), then five ghost icon buttons: Git, Import sessions, Worktrees, Pipelines and Settings.
- **Layout classes.** `header`: `electrobun-webkit-app-region-drag flex h-10 shrink-0 items-center justify-between border-b border-border/60 pl-20 pr-4`. The left group is `flex items-center gap-3` and the chip strip is `flex items-center gap-2 text-xs`. The bar has no `min-w-0`, no `overflow` rule, no `flex-wrap` and no `whitespace-nowrap`. Nothing decides what happens when the chips don't fit.
- **Chip filter.** `visibleTopbarAgents` (`src/mainview/lib/usage.ts:82-87`) keeps the enabled harnesses only, in `/harnesses` order. That order is `SELECT * FROM harnesses ORDER BY is_builtin DESC, created_at ASC` (`src/bun/db.ts:2390`), so stack members are not adjacent.
- **Chip contents.** The meter is `UsageMeter` (`src/mainview/components/usage/UsageMeter.tsx:23-39`): a fixed `w-10` bar of the worst meter, colored by tier (70% warn, 90% crit; `src/shared/types.ts:2600-2603`). It ignores staleness.
  - The status dot shows red when the harness is unavailable, amber when it is logged out, and green otherwise.
  - The chip's `title` is the auth help, the reason or the path.
  - Without a snapshot, the popover explains why: the kind is unsupported, or the first poll is pending (`App.tsx:2649-2656`). `USAGE_SUPPORTED_KINDS` is claude-code, codex and cursor (`src/shared/types.ts:2610`).
- **Popover.** `UsagePopover` (`src/mainview/components/usage/UsagePopover.tsx`) is click-toggled, renders in place (`absolute left-0 top-full z-50`, not portaled) and closes on an outside click or Escape. It shows the plan type, each meter's bar, percent and reset, "updated N ago" and a Refresh button (`api.refreshHarnessUsage`). Its panel is `role="dialog"` **without** `data-popover-open` or `aria-modal`.
- **Data, already in App state, no extra fetch.**
  - `agents` (HarnessStatus), `harnesses`, `harnessStacks` and `harnessLimitStates` come from one `GET /harnesses` payload (`App.tsx:264-270`, `refreshAgents` `:799-819`). They are refreshed every 15 s (`:952-954`) and on `harnesses_auto_enabled` (`:1391`), reconciled by id so unchanged polls keep references.
  - `usage` (`Record<harnessId, HarnessQuota>`, `:292`) is seeded by `api.getAllUsage()` (`:899`) and pushed by the `harness_usage` app event (`:1370-1372`). The server's usage poll runs every 10 min (`USAGE_POLL_SWEEP_MS`, `src/shared/types.ts:2593`).
  - **A redesign needs no new route, SSE stream or DB column**, so there are no `ROUTE_POLICY` implications.
- **Handlers the actions call.** `setGithubOpen(true)`, `setImportSessionsOpen(true)`, `setWorktreesOpen(true)`, `openPipelinesPage`, `setSettingsOpen(true)`. A Settings → Harnesses deep link already exists: `openSettingsHarnesses` (`App.tsx:2012`). The `"stacks"` section id resolves to `harnesses` (`src/mainview/lib/settings-dialog-view.ts:19-24`).

### Window chrome constraints

- **Title bar.** `titleBarStyle: "hiddenInset"`, `trafficLightOffset: { x: 8, y: 8 }`, and "keep `x` in sync with the header's `pl-20`" (`src/bun/index.ts:845-857`). The bar shares a row with the macOS traffic lights.
- **No minimum window size.** Electrobun 1.18.1 has no min-size option or setter: `WindowOptionsType` and the `BrowserWindow` methods in `node_modules/electrobun/dist/api/bun/core/BrowserWindow.ts` have none. The bar must survive any width.
- **Drag regions.** Electrobun's preload (`node_modules/electrobun/dist/api/bun/preload/dragRegions.ts`) starts a window move on any `mousedown` whose target is inside `.electrobun-webkit-app-region-drag` and **not** inside `.electrobun-webkit-app-region-no-drag`. If a flex-filling chip strip is wrapped in `no-drag`, the title bar can no longer drag the window. Only the controls should be `no-drag`. Double-click zooms the window unless the target is inside a no-drag child (`App.tsx:2622-2625`).
- **Font size.** The UI zoom (Cmd+= / Cmd+-) scales the root font from 100% to 170% (`FONT_SIZE_MIN`/`MAX`, `src/shared/types.ts:7238-7239`). The bar is rem-based (`h-10`, `pl-20`, `text-xs`, `size-9` buttons), so at 170% it is 68 px tall and the traffic-light inset is 136 px. The native lights stay fixed at (8, 8) px and are no longer centered. No doc addresses this (`docs/plans/cmd-font-size-controller.md` never mentions the header).
- **RunPanel overlap.** RunPanel is `fixed right-0 top-0 z-40 h-full` (`src/mainview/components/kanban/RunPanel.tsx:630-635`). While open it **covers the right side of the app bar, all five actions included**. Its default width is 720 px, between 420 px and 90vw (`src/mainview/lib/panel-width.ts:22-31`). It publishes `--run-panel-width` on `<html>` while mounted (`RunPanel.tsx:493-498`).
- **Native menu.** The app menu (`src/bun/index.ts:118-162`) has About, Remote Access…, Hide, Quit, Edit and Window. It has **no "Settings… ⌘,"** and no entry for Git, Worktrees, Pipelines or Import, and the webview has no keyboard shortcut for them. The app bar is their only entry point.

### Harness Stacks — what exists to reuse

- **Model.**
  - A `HarnessStack` is a set of same-kind members (`claude-code` or `codex` in v1), where position 0 is the primary (`src/shared/types.ts:415-454`).
  - A `HarnessLimitState` row is a cooldown, either account-wide or per-model (`:492-502`).
  - **A stack has no global "active account"**: failover is per task (`TaskHarnessState`).
  - A stack with fewer than two members is inert, and no surface may show `n/m` or "fails over" copy for it (`stackPositionText`, `src/shared/harness-stack.ts:53`; `docs/architecture/harness-stacks.md` § Surfaces, "One-account stacks").
- **Helpers ready for an app-bar stack chip:**
  - `groupHarnesses(harnesses, stacks)` splits accounts into stack groups (members in order) and "others" (`src/mainview/lib/stack-editor.ts:245-264`).
  - `cooldownChips(limitStates, harnessId, now)` gives the reason, the "until HH:MM" time and the model for each cooldown (`stack-editor.ts:198-220`). Provider `message` text is third-party and must stay plain text.
  - `stackPositionFor` / `activeCooldown` / `formatResetClock` (`src/mainview/lib/stack-badge.ts:83`, `:119`, `:136`).
  - `quotaSummary` (blocking 5 h / weekly meters, stale after 20 min) is at `src/shared/harness-stack.ts:450`. It renders as `StackQuotaMeter` (`src/mainview/components/settings/HarnessAccountRow.tsx:36-84`), which dims a stale snapshot and shows "no quota data" when there is none.
  - `harnessQuotaLooksExhausted` / `harnessQuotaResetAt` (`src/shared/harness-limits.ts:457-480`) are the failover's own definition of "out of quota". Reuse them so the app bar can never disagree with the failover.
  - `stackBackupCanServe` (`src/mainview/lib/stack-launch.ts:17-32`) checks whether another member is enabled, available and logged in.
  - `STACK_KIND_LABEL` (`src/mainview/components/settings/HarnessStackCard.tsx:6-9`).
- **Where stacks show today.**
  - Settings → Harnesses: stack cards with per-member quota meters, cooldown chips, Clear and Restore.
  - TaskCard `StackBadge`, the New Task and launch-picker `StackPositionChip`, and the RunPanel account line, banner and switch.
  - Toasts.
  - CLI and TUI: `agetor harness ls` and stack display (`src/cli/stack-display.ts`, `src/cli/commands/harness.ts`).
  - **Not in the app bar.**
- **Prior decision this task reverses.** Grill 28 of the harness-stacks feature: "topbar keeps one usage chip per account in v1 (no grouping)", with the reason "grouping the topbar is a separate layout change" (`docs/plans/harness-account-stacks-grill.md:47,73`; `docs/plans/harness-account-stacks.md:143,694,779,794`). This task is that layout change. The plan should record the reversal.

### History

- The bar is unchanged since the initial commit (`3492804e`, 2026-05-17), apart from what later features appended:
  - #83 `ee151a82` Git button.
  - #117 `7e1bf09a` Worktrees.
  - #177 `4c22a04a` usage meters, CodexBar-inspired (`docs/plans/harness-usage-tracker.md`).
  - #179 `6ba316c0` placeholder popover.
  - #201 `4b8a46af` hides disabled harnesses (`docs/plans/hide-disabled-harnesses-topbar.md`).
  - #244 `6cd0241a` Pipelines.
  - #272 `3873e013` Import sessions.
- Each feature appended one more item, and **no change ever set an overflow policy**.
- The RunPanel header went through the same kind of cleanup on `feature/better-task-details-header-ui`: an icon-only button row with the portaled `ui/tooltip.tsx` instead of native `title`. That is the precedent for this bar's icon buttons.

### Owner's real setup (read-only, `sqlite3 -readonly ~/.agetor/agetor.sqlite`)

- 7 enabled harnesses: 4 claude-code accounts, codex, cursor and opencode. Labels run from 5 to 22 characters.
- 1 stack, claude-code, with 2 members: the built-in Claude Code as primary and one custom account as backup.
- 2 more claude-code accounts are **in no stack**.
- Usage snapshots: 3 harnesses `ok` (the two stack members and codex), 3 `unavailable` (the two unstacked Claude accounts and cursor), 1 none (opencode is unsupported). No active cooldowns.

### Standards that apply

- **Fixed overlays portal to `document.body`.** A popover in a container with `overflow` hidden is clipped (CLAUDE.md "Webview"; `ui/tooltip.tsx:43-52` explains both traps). Any priority+ strip with `overflow:hidden` forces the chip popovers to portal.
- **Escape layering.** A popover carries `data-popover-open` while open and closes itself on Escape. RunPanel's Escape handler bails only on `[role="dialog"][aria-modal="true"], [data-popover-open], …` (`RunPanel.tsx:603`, `:2336`; `src/mainview/lib/find-shortcut.ts:42-43`).
  - **Existing bug:** `UsagePopover` sets neither, so with RunPanel open, Escape on a chip popover also closes the panel.
- **Colors and tokens.**
  - Use the semantic tokens only (`success`/`warning`/`info`/`danger`, plus the `-solid` dot variants for success, danger and warning). There is **no `info-solid`**, and a new token must land in both `src/mainview/index.css` and `tailwind.config.js` (the undefined-token trap).
  - Tailwind can't see `bg-${token}` built at runtime: use literal maps like `FILL_CLASS`.
- **Layout chrome state lives in `localStorage`** (`src/mainview/lib/panel-collapse.ts`, `agetor:*` keys, read synchronously in a lazy `useState`). A collapsed bar or pinned harnesses would go there, not in `api.setPreference`.
- **No new event streams.** WKWebView allows about 6 connections and 2 are SSE. The redesign needs none.
- **Keyboard shortcuts.** Use `isMacPlatform()` and pure predicates in `src/mainview/lib/` (CLAUDE.md "UI conventions").
- **Tests.**
  - Webview logic goes in pure `src/mainview/lib/*.ts` with co-located `bun test`.
  - Components are tested with `renderToStaticMarkup` (`src/mainview/components/kanban/StackBadge.test.tsx`).
  - E2E covers user-visible flows (`docs/plans/hide-disabled-harnesses-topbar.md` §5 used e2e for the bar).
- **React 19 StrictMode.** Mount-time DOM work must be idempotent (fleet note on `src/mainview/main.tsx`). This applies to a ResizeObserver measure.
- **Docs.** Update the subsystem doc in the same change. No architecture doc covers the app bar. `docs/architecture/harness-stacks.md` § Surfaces → Webview (`:1816-1871`) lists every stack surface and would gain the app bar.

### Runtime and trust shape

- **Runtime.** This is webview chrome only: one window and one local user. Data comes from the local core over the master-token HTTP API that is already in use.
- **Trust.** Provider text (`quota.reason`, cooldown `message`) is third-party: render it as plain text and never as markup.
- **No privileged actions.** The bar adds none. Clearing a cooldown stays in Settings (it has a confirm).

### Best practices (web)

- **Apple HIG — Toolbars** ([developer.apple.com](https://developer.apple.com/design/human-interface-guidelines/toolbars)):
  - "Choose items deliberately to avoid overcrowding… define which items move to the overflow menu as the toolbar becomes narrower."
  - "Items on the trailing edge remain visible at all window sizes". The center section collapses into the overflow menu.
  - "Minimize the number of groups… aim for a maximum of three."
  - "Prefer simple, recognizable symbols for items instead of text."
  - "Make every toolbar item available as a command in the menu bar."
  - "Don't title windows with your app name".
  - Consider letting people customize the toolbar in long-session apps.
- **Priority+ pattern.** Show the highest-priority items that fit and move the rest into a "More" control. Implementations measure with `ResizeObserver` and hide the overflowed copies from assistive tech (examples: [priority-plus](https://cdn.jsdelivr.net/npm/priority-plus@1.5.1/README.md), [react-responsive-overflow-list](https://cdn.jsdelivr.net/npm/react-responsive-overflow-list@0.4.0/README.md)). No dependency is needed. The repo has no Radix and no floating-ui; its primitives are hand-rolled.
- **WAI-ARIA APG** ([toolbar](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/), menu button):
  - `role="toolbar"` with roving `tabindex`.
  - The "More" trigger is a menu button: `aria-haspopup="menu"` and `aria-expanded`. Enter or Space opens it and focuses the first item, arrow keys move, and Escape closes it and returns focus to the button.
  - `ui/context-menu.tsx` already implements the menu side: portaled, roving focus, `data-popover-open`, focus restore. It is anchored by x/y, so it can be placed under a button's rect.
- **CodexBar** (the stated inspiration for #177; [README](https://github.com/steipete/CodexBar)):
  - "One status item per provider, or Merge Icons mode with a provider switcher."
  - "highest-usage auto-selection".
  - Errors and stale data dim the icon.
  - These are precedents both for a merged status item and for dimming stale data.
- **VS Code status bar UX guidance** ([status bar](https://code.visualstudio.com/api/ux-guidelines/status-bar)): keep items minimal, use short labels, and use icons only where the metaphor is clear.

## 2. What we proved

| Question | Verdict | Evidence (command → output / measurement) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does today's bar break with the owner's 7-harness shape, and how? | **Yes, three ways** | A static replica of `App.tsx:2620-2739` with the exact class strings, compiled with the repo's `tailwind.config.js` and `index.css` (`tailwindcss -c … --content replica.html`). It has 7 chips with the owner's label lengths (11/5/6/8/12/12/22 characters) and 3 meters. Measured with Playwright in WebKit and Chromium at widths 1600→700 and fonts 100/130/170%. Results below the table. | Playwright 1.62.1 (WebKit, Chromium); Tailwind 3.4.19 | session scratchpad `spikes/header-overflow/` (`replica.html`, `measure.mjs`, `budget.mjs`, PNGs); ephemeral. Re-create from this row if needed. |
| Would the existing tests notice a broken or overflowing bar? | **No** (by reading) | Playwright's project is `devices["Desktop Chrome"]` (1280×720; `playwright.config.ts:94`). Only claude-code is enabled by default, and `e2e/usage-tracker.spec.ts` asserts one chip's meter and popover. No spec narrows the viewport with the bar or enables several harnesses for it. `src/mainview/lib/usage.test.ts` covers the filter only. A redesign needs new tests that pin overflow behavior. | — | — |

Results of the first spike, at 100% font:

- **≥1440 px:** one line. The 7 chips are 824 px wide (143/106/64/86/101/112/212 px).
- **≤1280 px:** every multi-word label wraps to 2–3 lines inside the fixed 40 px bar, and "12 tasks" wraps too.
- **≤~1100 px (1024 measured):** Pipelines and Settings are pushed off-screen, so `scrollWidth` is 1099 at 1024 and the whole document scrolls sideways.

At 130% the labels wrap at 1600 px and the actions are off-screen at ≤1280 px. At 170% the actions are off-screen even at 1600 px (`scrollWidth` 1829). WebKit and Chromium give identical numbers.

The fixed parts are measured too: the logo cluster ends at 165 px and the trailing cluster is 266 px wide. That leaves ≈ window width − 460 px for the strip at 100%.

## 3. What we're assuming

- **Webview only.** No server, route, DB or CLI/TUI change. The CLI and TUI already print stack and quota state (`agetor harness ls`, `src/cli/stack-display.ts`). *If wrong:* a parity task is added (e.g. if the owner wants a header-equivalent `agetor status`).
- **macOS only** (arm64 releases, `hiddenInset`). Windows and Linux title bars are not considered. *If wrong:* the traffic-light inset must become conditional.
- **The owner wants the Grill-28 "no grouping in the topbar" decision reversed.** "Missing the Harness Stacks info" implies it. *If wrong:* stacks get a badge on member chips only, with no group chip.
- **Disabled harnesses stay hidden from the bar** (#201), including disabled stack members in the collapsed chip. *If wrong:* the filter and the e2e assertion in `usage-tracker.spec.ts` change.
- **"Responsive" means narrow desktop windows** (window resize, split screen, RunPanel open, UI zoom up to 170%), not phone widths. *If wrong:* a much more aggressive collapse, e.g. a hamburger, is needed.
- **No new dependency.** The overflow logic is hand-rolled (`ResizeObserver` + `ui/context-menu.tsx`), like every other primitive here. *If wrong:* the plan evaluates a library such as `react-responsive-overflow-list`.

## 4. What we must ask the owner

1. **Design direction for the harness area.** Pick one:
   - (A) A single aggregate "Harnesses" status button (worst state, worst meter, counts) that opens a panel listing everything grouped by stack. It is the most compact and scales to any count, but you lose the at-a-glance per-account meters.
   - (B) A grouped chip strip with **priority+ overflow** (`+N` menu). It keeps per-chip meters but needs measurement logic.
   - (C) A hybrid: compact grouped chips (icon + meter, label on hover) that collapse into the aggregate button when they don't fit.
   - (D) Move harness status out of the bar, into a status bar at the bottom of the window or the New Task sidebar.

   The spike shows today's strip needs ≈1330 px to fit on one line. Recommendation: (C).
2. **What a stack chip shows when collapsed.** A stack has no global active account, so the choice is:
   - The stack label, plus one dot per member (ready / cooling / out of quota / unavailable / disabled).
   - A "headroom" meter: the least-used *usable* member's worst blocking meter, from `quotaSummary` / `harnessQuotaLooksExhausted` (i.e. how much the stack can still run).
   - Or the primary's meter.

   Recommendation: the label, member dots and the headroom meter, with the earliest reset in the tooltip.
3. **The stack popover's contents.** Members in order (Primary / Backup n), each with its `StackQuotaMeter`, cooldown chips ("usage limit · until 14:30 · for <model>") and status. Then Refresh usage, **Manage stack…** (Settings → Harnesses) and **History**. Should **Clear cooldown** be offered here, or stay in Settings only? Recommendation: Settings only.
4. **Live failover activity in the bar.** Should the bar surface tasks currently waiting on an all-exhausted retry, or mid-swap, as a count badge that links to them? Today that is only in RunPanel, TaskCard and toasts.
5. **Unstacked accounts of the same kind** (the owner has 2 unstacked Claude accounts next to a 2-account Claude stack). Group them per kind ("Claude Code ×3"), or keep one compact chip each?
6. **Priority order once space runs out.** Which chips stay visible first: stacks, accounts with running tasks, warn/crit usage, user-pinned, or plain DB order (built-ins first, then by creation)?
7. **The trailing actions** (Git, Import sessions, Worktrees, Pipelines, Settings). Which must stay visible at every width (HIG: the trailing edge never collapses), and which may move into a "⋯ More" menu when narrow? Also: should Import sessions move permanently into More, since it is rarely used? Recommendation: Settings and Pipelines always visible, the rest in More when narrow.
8. **The task count** ("12 tasks"). Keep it in the bar, move it into the board's filter bar (`KanbanFilters`, where the filter that drives it lives), or drop it? Today it also shows on the Pipelines page, where it means nothing.
9. **UI zoom and the native traffic lights.** Pin the bar's height and left inset in px, so it stays 40 px and stays aligned with the fixed (8, 8) lights at 110–170%? Or keep scaling the chrome with Cmd+=?
10. **RunPanel covering the bar.** Keep it as is (the panel owns the top-right corner, and every action hides while it is open), reserve `--run-panel-width` so the actions and the overflow control stay visible left of the panel, or start the panel below the bar (`top-10`)?
11. **The minimum width to design for.** Electrobun can't enforce a minimum window size. What is the smallest width where the full bar must work, e.g. 800 px? Below it, should only the logo, the aggregate status and the essential actions show?
12. **Native menu backstop.** Add "Settings… ⌘," (and maybe Pipelines, Worktrees and Git) to the app menu, per the HIG's "every toolbar item in the menu bar"? Is that in scope?
13. **Stale usage in the bar.** Dim meters older than 20 minutes and mark them "stale", as Settings and CodexBar do? Recommendation: yes.
14. **Customization.** Let users pin or hide individual harnesses in the bar (stored in `localStorage` chrome state)? Or is automatic priority enough?
15. **Icon-button tooltips.** Switch the bar's icon buttons from native `title` to the portaled `ui/tooltip.tsx`, as the RunPanel header did? The e2e helper `headerSettingsButton` locates Settings by its `title`.
16. **App title.** Keep the "Agetor" wordmark in the bar? The HIG advises against titling windows with the app name, but it's branding, and it takes ~90 px.

## 5. Completeness inventory

- **Callers and render site.**
  - `src/mainview/App.tsx:2604-2739` (the header and its comments), `:2632-2680` (chip map), `:2683-2738` (actions).
  - `src/mainview/lib/usage.ts:82` `visibleTopbarAgents` (only caller: App.tsx).
  - `src/mainview/components/usage/UsageMeter.tsx` and `UsagePopover.tsx` (only caller: App.tsx).
  - `src/mainview/components/kanban/AgentIcon.tsx`.
- **State and plumbing.** `App.tsx:264-292` (`agents`, `harnesses`, `harnessStacks`, `harnessLimitStates`, `usage`), `:799-819` `refreshAgents`, `:899` usage seed, `:952-954` 15 s poll, `:1370-1372` `harness_usage` event, `:1391` auto-enable refresh, `:2012` `openSettingsHarnesses`.
- **Entry points for new code.**
  - New components under `src/mainview/components/` (e.g. an `app-bar/` folder).
  - Pure logic in `src/mainview/lib/` (overflow fitting, stack summary, priority order), wired in at `App.tsx`'s header.
  - Optionally the native app menu (`src/bun/index.ts:118`) with a menu-action route to the webview, if Q12 is yes.
  - No route table or `ROUTE_POLICY` change unless Q12 adds a menu action that needs one.
- **Reusable helpers** (don't fork):
  - `stack-editor.ts` `groupHarnesses` and `cooldownChips`.
  - `stack-badge.ts` `stackPositionFor`, `activeCooldown` and `formatResetClock`.
  - `shared/harness-stack.ts` `quotaSummary` and `stackPositionText`.
  - `shared/harness-limits.ts` `harnessQuotaLooksExhausted`, `harnessQuotaResetAt` and `HARNESS_QUOTA_STALE_MS`.
  - `stack-launch.ts` `stackBackupCanServe`.
  - `HarnessAccountRow.tsx` `StackQuotaMeter`.
  - `usage.ts` `warnTier`, `worstMeter` and `tierColorVar`.
  - `ui/context-menu.tsx` (the More menu), `ui/tooltip.tsx`, `ui/info-tip.tsx` (the popover pattern) and `ui/button.tsx`.
- **Propagation surface.** No shared types change. The `Harness.enabled` doc comment says "window topbar" (`src/shared/types.ts:397`); update it if the wording changes. `USAGE_SUPPORTED_KINDS` placeholder copy moves with the chip.
- **Tests that pin the current DOM** (they must be updated or kept green):
  - `e2e/usage-tracker.spec.ts` (banner → `button "Claude Code"` exact, mini-bar `span.bg-danger` inside the chip, popover `dialog "Claude Code usage"`, `Refresh usage`, Escape).
  - `e2e/board-search-shortcut.spec.ts:301` (banner chip button).
  - `e2e/helpers.ts:75-83` `headerSettingsButton` = `getByTitle("Settings", { exact: true })`, used by `gotoApp` readiness, so every spec depends on it.
  - `getByRole("button", { name: "Git", exact: true })`: `pr-merged-state.spec.ts:216`, `agent-profiles-dialogs.spec.ts:289`, `issue-task.spec.ts:310,334`, `resolve-conflicts.spec.ts:211,231`, `at-file-autocomplete.spec.ts:790`.
  - `name: "Worktrees"`: `multi-repo-task.spec.ts:419`.
  - `name: "Import Claude Code sessions"`: `import-claude-sessions.spec.ts:71,89,111`.
  - `data-testid="pipelines-button"`: 6 specs.
  - `src/mainview/lib/usage.test.ts`.
- **Moving an action into a "More" menu** changes its role from `button` to `menuitem` at narrow widths only. At the default e2e width of 1280 the plan must keep the actions visible, or update all the locators above.
- **E2E seams available.** `seedHarnessUsage` (`e2e/helpers.ts:145`), `seedLimitState` (`:345`), `createStackAccount` (`:413`), `createStackViaApi` (`:438`). `page.setViewportSize` has a precedent in `e2e/board-scroll-position.spec.ts:404-415`. Font size goes through `PUT /preferences` (`e2e/font-size.spec.ts`).
- **Existing data to backfill.** None.
- **Docs and config that describe current behavior.**
  - `docs/architecture/harness-stacks.md` § Surfaces → Webview (`:1816-1871`): add the app bar.
  - `README.md:67` ("Usage meter").
  - Historical plans (`docs/plans/harness-usage-tracker.md`, `hide-disabled-harnesses-topbar.md`, `harness-account-stacks*.md`): leave them; record the Grill-28 reversal in the new plan.
  - CLAUDE.md, only if a new everywhere-rule emerges (e.g. drag-region or overflow conventions).
- **What the change would orphan.** `visibleTopbarAgents` (rename or keep), the inline placeholder logic in App.tsx, and possibly `UsageMeter` if chips change shape. `UsagePopover` would be reworked rather than orphaned.

## 6. Runnability

- **Start locally.**
  - `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
  - This worktree has **no `node_modules`**: run `bun install` first.
  - `bun run dev:hmr` (Vite + Electrobun, `AGETOR_DATA_DIR=$HOME/.agetor-dev`; never point a branch build at `~/.agetor`).
- **Tests.**
  - `bun run typecheck`.
  - `bun test src/mainview/lib/<file>.test.ts` (pure logic), `bun test src/mainview/components/<dir>` (`renderToStaticMarkup`), then `bun test`.
- **E2E.**
  - Playwright 1.62: `bun node_modules/@playwright/test/cli.js test e2e/<spec>.ts` (not `bunx`).
  - The config starts Vite (`bun run hmr`, :5173, or `E2E_VITE_PORT`) and one isolated headless Bun backend per worker (`e2e/fixtures.ts`).
  - Run one Playwright run at a time across agents (port and HMR collisions).
  - Chromium only: the app's real engine is WKWebView, and the spike shows WebKit and Chromium lay out this bar identically.

## 7. Risks and blast radius

- **Drag region.** The strip's filler space must stay draggable: `no-drag` goes on the controls only. Keep the double-click zoom guard working.
- **Clipping.** An `overflow:hidden` strip clips today's in-place `absolute` popover. Portal every bar popover and menu to `document.body` with `position: fixed`, as `ui/tooltip.tsx` and `ui/context-menu.tsx` do.
- **Escape.** New popovers and menus must carry `data-popover-open` and close on Escape, or Escape also closes RunPanel. Fix `UsagePopover`'s existing omission at the same time.
- **Measurement.**
  - A ResizeObserver fit loop can flicker or oscillate. Measure on a hidden copy of the strip (or with fixed per-chip widths), keep a hysteresis, and make it StrictMode-safe.
  - Re-measure on font-size change: the root font changes without a window resize.
- **Timers.** A cooldown that expires changes nothing in the `/harnesses` payload, and `reconcileById` keeps references stable, so a "cooling" chip would linger. The summary needs a timer for the next expiry, as RunPanel's countdown does.
- **Re-renders.** `AppInner` re-renders on every 2 s task poll. Memoize the bar's derived view, keyed on the reconciled arrays.
- **Accessibility.**
  - `role="toolbar"` with roving `tabindex`, or plain buttons in tab order.
  - The More button uses `aria-haspopup="menu"`, and chips hidden by the overflow carry `aria-hidden` / `inert`.
  - Color is never the only signal: dots need text in the tooltip or aria-label, as `StackBadge` does.
- **RunPanel.** If the bar reserves `--run-panel-width`, the fit logic must react to panel resize and open/close (the variable is removed when the panel unmounts).
- **E2E churn.** Changing names or roles of Git, Worktrees, Import, Settings or Pipelines ripples into about 15 specs. Prefer keeping the accessible names and `data-testid`s stable.
- **Rollback.** The change is webview-only (App.tsx plus new components and libs), so reverting the files is enough. There is no data migration.
