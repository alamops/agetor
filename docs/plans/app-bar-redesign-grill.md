# Grill — App bar redesign (harness status, Harness Stacks, responsive)

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Pipeline task "Alamo Pipeline (No Video)" step 2; request + screenshot (task attachment, outside the repo, restated in `docs/plans/app-bar-redesign-investigation.md` §0); investigation brief `docs/plans/app-bar-redesign-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 2 rounds. Round 1's serve process stopped before writing, so the owner pasted the form's JSON in chat and it was saved verbatim (marked `_provenance`). Round 2 was submitted through the form. |
| Answers | `docs/plans/app-bar-redesign-grill/round-1/answers.json`, `docs/plans/app-bar-redesign-grill/round-2/answers.json` |
| Flags | none |
| Spec | The investigation brief §0 restates the request in the repo. The original screenshot is a task attachment and is not committed. |

## Shape of the change

- **One aggregate "Harnesses" button** replaces the per-account chip strip. It opens a portaled panel that lists every enabled account, grouped by stack. This overrides the hybrid recommendation and **reverses harness-stacks grill decision 28** (`docs/plans/harness-account-stacks-grill.md:47`, "topbar keeps one usage chip per account in v1 (no grouping)"). That decision deferred exactly this layout change.
- Webview only, except for **native menu items**: Settings ⌘, plus every bar action. They need a core → webview menu-action event over the existing app SSE channel. No new stream, no route and no DB change.
- The bar is pinned at 40 px tall with an 80 px left inset under UI zoom. Collapse is measured, and the document never scrolls sideways.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Direction | What does the harness area become? | **(A) A single aggregate "Harnesses" button** that opens a panel listing everything, grouped by stack. No per-account chips in the bar, at any width. | owner (round-1/answers.json#direction; overrode the "hybrid" recommendation) |
| 2 | Button | What does the button show? | **A status dot** (worst state: red unavailable, amber logged out or cooling, green ok), **the text "Harnesses"**, **the count of enabled accounts**, **one usage meter**, **that meter's %**, **the failover badge**, and **"until HH:MM"** when every account that can run is out of quota. | owner (round-2/answers.json#button-content; added count and percent to the recommendation) |
| 3 | Button | Which usage does the meter show? | **The tightest "what can still run" figure.** A stack counts by its headroom; an account in no stack counts by its own worst blocking meter. The button shows the minimum remaining, and the tooltip names which stack or account it is. | owner (round-2/answers.json#button-meter; accepted recommendation) |
| 4 | Stacks | What does a stack's summary show (the stack heading in the panel)? | **Kind label with a stack marker, one dot per member** (ready / cooling / out of quota / unavailable / disabled), **a headroom meter**, and **the earliest reset** when every member is out. | owner (round-1/answers.json#stack-chip) |
| 5 | Stacks | Headroom vs the primary's meter (both were picked in round 1) | **Stack heading: headroom. Member rows: each member's own meter**, the primary's included. No meter appears twice. | owner (round-2/answers.json#stack-meters; accepted recommendation) |
| 6 | Stacks | Stack section contents | **Members in order (Primary / Backup n) with meter and status, cooldown chips, Refresh usage, Manage stack… (Settings → Harnesses), Swap history.** **Clear cooldown stays in Settings only.** | owner (round-1/answers.json#stack-popover; accepted recommendation) |
| 7 | Stacks | Live failover activity | **A count badge on the button.** It counts tasks whose `harnessState` has `allExhausted` or `pendingSwap` set. The panel lists them under their stack ("waiting for quota until 14:30" / "switching to <account>"), and clicking one opens that task. | owner (round-1/answers.json#failover-activity, round-2/answers.json#c-badge; accepted recommendation) |
| 8 | Panel | Account rows | Each row, stacked or not, shows the icon, the full label, the status as text, the plan, every meter with % and reset, "updated N ago" (dimmed when stale), cooldown chips and Refresh, i.e. today's per-chip popover content. Kinds without usage support (OpenCode) show the existing explanation. | owner (round-2/answers.json#c-panel-accounts; accepted recommendation) |
| 9 | Panel | Order | **Stacks first; then accounts in no stack ordered running → problem → DB order.** Rows in the lower section may move as state changes. | owner (round-1/answers.json#priority, round-2/answers.json#panel-order; accepted recommendation) |
| 10 | Actions | Always visible | **Settings, Pipelines, Git and Worktrees** never hide. **Import sessions** moves into a "⋯ More" menu when narrow. | owner (round-1/answers.json#actions-visible; overrode the recommendation of Settings and Pipelines only) |
| 11 | Responsive | Minimum width | **720 px**: the bar must look complete at that width. Below it, the bar still never overflows. | owner (round-1/answers.json#min-width; accepted recommendation) |
| 12 | Responsive | Collapse order | **Measured fit** that re-measures on resize and on zoom: (1) the wordmark hides, (2) Import moves into More, (3) the button's "Harnesses" text hides, while its dot, meter and badge stay. The logo, the button, Settings, Pipelines, Git, Worktrees and More never hide. The document never scrolls sideways at any width. | owner (round-1/answers.json#wordmark, round-2/answers.json#c-collapse; accepted recommendation) |
| 13 | Chrome | RunPanel overlap | **RunPanel stays as is** (`fixed top-0 right-0`, covering the bar's actions while open). The native menu keeps every action reachable. | owner (round-1/answers.json#runpanel-overlap; overrode the "below" recommendation) |
| 14 | Chrome | RunPanel and tests conflict | **The test adapts**: with RunPanel open it asserts no sideways scroll, a usable aggregate button, and every action reachable through the native menu. | owner (round-2/answers.json#runpanel-test; accepted recommendation) |
| 15 | Chrome | UI zoom | **Pin the bar's height (40 px) and left inset (80 px) in px.** Text and icons inside still scale. | owner (round-1/answers.json#zoom; accepted recommendation) |
| 16 | Chrome | Native menu | **Add "Settings… ⌘," and a menu with Pipelines, Worktrees, Git and Import sessions**, plus ⌘, handled in the webview. | owner (round-1/answers.json#native-menu; accepted recommendation) |
| 17 | Chrome | Task count | **Move it to the board's filter bar (`KanbanFilters`).** It no longer shows on the Pipelines page. | owner (round-1/answers.json#task-count; accepted recommendation) |
| 18 | Chrome | Wordmark | **Keep "Agetor", hidden first when narrow.** The logo stays. | owner (round-1/answers.json#wordmark; accepted recommendation) |
| 19 | Usage | Stale data | Meters older than 20 min (`HARNESS_QUOTA_STALE_MS`) are dimmed, and the tooltip and panel say "stale · updated N ago". | owner (round-1/answers.json#c-stale; accepted) |
| 20 | Scope | Customization | **No per-harness pin or hide.** Disabling a harness still hides it. | owner (round-1/answers.json#c-customize; accepted) |
| 21 | Stacks | Disabled harnesses | An account in no stack that is disabled stays hidden (#201). A disabled **stack member** shows as a muted "disabled" dot and row. | owner (round-1/answers.json#c-disabled-members; accepted) |
| 22 | Stacks | One-account stacks | Fewer than 2 enabled members: shown as a plain account row, with no stack marker and no "fails over" copy (`stackPositionText` rule). | owner (round-1/answers.json#c-one-member; accepted) |
| 23 | A11y | Tooltips and test hooks | Icon buttons use the portaled `ui/tooltip.tsx`. Accessible names and `data-testid`s stay unchanged, and the e2e `headerSettingsButton` locates Settings by accessible name. | owner (round-1/answers.json#c-tooltips; accepted) |
| 24 | A11y | Keyboard and ARIA | Plain buttons in tab order. The button and More follow the menu-button pattern (`aria-haspopup`, `aria-expanded`, arrow keys, Escape returns focus). Hidden copies are `inert`. Status is never conveyed by color alone. Every popover carries `data-popover-open`, closes on Escape and is portaled (this also fixes the `UsagePopover` Escape bug). | owner (round-1/answers.json#c-a11y; accepted) |
| 25 | Chrome | Drag regions | Empty bar space still drags the window and double-click still zooms. Only the controls are `no-drag`. | owner (round-1/answers.json#c-drag; accepted) |
| 26 | Scope | Platform and dependencies | macOS only; no new npm dependency (hand-rolled `ResizeObserver` plus `ui/context-menu.tsx`); no CLI or TUI change. | owner (round-1/answers.json#c-scope; accepted) |
| 27 | Acceptance | Tests | Unit tests (fit, button summary/capacity, panel order, failover count); component tests (`renderToStaticMarkup`); a new e2e spec with 7 harnesses and a 2-member stack at 1440, 1100, 900 and 720 px, at 100% and 170% zoom, and with RunPanel open (adapted per #14): `scrollWidth == clientWidth`, always-visible actions clickable when not covered, the panel and More open and close with Escape, the stack section shows members and cooldowns, and the badge counts a seeded all-exhausted task. Existing e2e specs stay green. | owner (round-1/answers.json#c-tests; accepted; RunPanel clause amended by round-2#runpanel-test) |
| 28 | Docs | Docs | New `docs/architecture/app-bar.md` (layout, collapse policy, drag regions, zoom, RunPanel, native menu), added to CLAUDE.md's topic map; app bar added to `harness-stacks.md` § Surfaces → Webview; `README.md` usage-meter line updated; Grill-28 reversal recorded in the plan. | owner (round-1/answers.json#c-docs; accepted) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Per-account chip strip, `visibleTopbarAgents` call site, the inline placeholder logic at `App.tsx:2632-2680` | in this change (replaced; `visibleTopbarAgents` is renamed or reused as the panel filter, with no orphan left) | Decision 1 |
| `UsagePopover` and `UsageMeter` | in this change (popover content moves into the panel rows; delete or reuse each, leaving no orphan) | Decision 8 |
| `UsagePopover` missing `data-popover-open` / not portaled | in this change | Decision 24 |
| Task count moves to `KanbanFilters` | in this change | Decision 17 |
| Native menu items and core → webview menu-action event | in this change | Decision 16 |
| Bar pinned in px under zoom, traffic-light comment in `src/bun/index.ts:845` kept in sync | in this change | Decision 15 |
| e2e locator updates (`headerSettingsButton`, `usage-tracker.spec.ts` chip and popover locators, `board-search-shortcut.spec.ts:301`) | in this change | Decisions 1, 23 |
| `Harness.enabled` doc comment ("window topbar", `src/shared/types.ts:397`) | in this change, if its wording no longer fits | completeness |
| Docs (app-bar.md, harness-stacks.md surfaces, README, CLAUDE.md topic map) | in this change | Decision 28 |
| Clear cooldown from the bar | out of scope | owner chose Settings only (Decision 6) |
| Per-harness pin or hide customization | out of scope | owner (Decision 20) |
| RunPanel moved below the bar | out of scope | owner kept RunPanel as is (Decision 13) |
| CLI or TUI header-equivalent | out of scope | `agetor harness ls` already covers it (Decision 26) |
| Windows or Linux title bars | out of scope | macOS-only releases (Decision 26) |
| Historical plans (`harness-usage-tracker.md`, `hide-disabled-harnesses-topbar.md`, `harness-account-stacks*.md`) | out of scope (left as history); the reversal is recorded in the new plan | repo convention |

## Assumptions still open

These are judgment calls for the plan. Each is reversible and needs no owner ratification, but a reviewer should see them.

- **Collapse past step 3.** At 720 px and 170% zoom, the scaled icons (5 × about 61 px) plus the button may still not fit after the "Harnesses" text hides. The plan adds further steps in the same spirit: the count and the percentage hide with the text, then the "until HH:MM" text. The dot, meter and badge stay, and all hidden text stays in the tooltip and panel. *If wrong:* the owner wants a different drop order.
- **Empty state.** With no enabled harnesses, the button stays with a grey dot and a "0" count, and the panel says "No harnesses enabled" with a link to Settings → Harnesses. *If wrong:* the button hides entirely.
- **Meter absence.** If no account reports usage (all unsupported or unavailable), the button omits the meter and percentage rather than showing an empty bar. *If wrong:* an empty "no data" meter is shown.
- **Expiry timer.** A cooldown that expires changes nothing in the `/harnesses` payload, so the button's summary recomputes on a timer set for the next cooldown or reset expiry, as RunPanel's countdown does.
- **Menu action transport.** A native menu click reaches the webview as a new app-event type on the existing `subscribeAppEvents` SSE channel. Whether that event needs a `ROUTE_POLICY` change is settled in planning; the expectation is none, because it adds no route.
