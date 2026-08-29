# Plan — Hide disabled harnesses from the window topbar

| Field | Value |
| --- | --- |
| Date | 2026-08-28 |
| Source | /implement: "don’t show disabled harnesses in the agetor window topbar" |
| Config | AGENTS_CONFIG.yml (v1 balanced-style; `/implement --update` available) |
| Flags | none (grill questions skipped — assumptions in §8) |
| Gates | grill skipped by owner; plan approved |
| Branch | feature/don-t-show-disabled-harnesses-in-topbar |
| Base SHA | 36b46ff070337d4c28d5c2353423dcd8482a2caf |

## 1. Objective & success criteria

Disabled harnesses (`Harness.enabled === false`, the Settings toggle) must not appear as chips in the Agetor window topbar. Enabled-but-unavailable chips (binary missing / not logged in) still render. Settings, the Kanban harness filter, and `agetor harness ls` are unchanged.

Success:

- Default boot (only `claude-code` enabled) shows that chip and not Codex / Cursor / Gemini / fx.
- Toggling a harness off in Settings removes its chip on the next harness refresh (15s poll, or immediately after the Settings mutation already refreshes the list).
- Toggling it back on restores the chip.
- `bun test` covers the filter helper; `e2e/usage-tracker.spec.ts` asserts disabled chips are absent from the banner; `bun run typecheck` stays green.

## 2. Context & constraints

- **Render site:** inlined app-bar in `src/mainview/App.tsx` (~1386–1439). `agents.map(...)` walks every `AgentStatus` from `GET /harnesses` with **no `enabled` filter**. The matching `Harness` row is only used for label + an `enabled` check that feeds a usage-popover *placeholder*, not visibility.
- **Disabled ≠ unavailable.** `Harness.enabled` is the persisted Settings toggle (`src/shared/types.ts` ~169–175). `HarnessStatus.available` / `loggedIn` are live probes. This change is only about `enabled`.
- **Existing hide-disabled convention** (inline `.filter((h) => h.enabled)`): New Task form, `TaskLaunchPickers`, Settings default-harness selector, onboarding `enabledHarnessIds`, CLI `agetor add`. No shared helper exists; this plan adds one only for the topbar (usage-chip list), not a drive-by refactor of those call sites.
- **Deliberate show-disabled surfaces (out of scope):** Settings harness list, `KanbanFilters` (find tasks on a since-disabled harness), CLI `agetor harness ls`.
- **#179 (`6ba316c`) chose explain-don’t-hide** for disabled chips (“Usage tracking is off because this harness is disabled — enable it in Settings…”). This request reverses that for the topbar. After hide, that `!enabled` placeholder branch is dead and must be removed.
- **Server:** `harnesses.list()` / `checkAllHarnesses()` return every row. Client-side filter matches New Task and keeps probe/usage SSE behavior intact. Do not skip server probes in this run.
- **Tests:** webview unit tests are pure `src/mainview/lib/*.ts` under `bun test`. Playwright e2e exists (`bunx playwright test`); `e2e/usage-tracker.spec.ts` currently *documents* that disabled Codex/Cursor/Gemini chips still render.

## 3. Approach & key decisions

1. **Client-side filter only.** `visibleTopbarAgents(agents, harnesses)` returns statuses whose harness row is `enabled`. Missing harness id → hidden (same as today’s `harness?.enabled ?? false`).
2. **Put the helper in `src/mainview/lib/usage.ts`.** That module already owns topbar-chip presentation; `App.tsx` stays thin wiring. Do not invent a new file for a one-function filter.
3. **Drop the #179 disabled placeholder** once those chips never render. Keep the unsupported-kind and “first poll pending” placeholders.
4. **Do not hide unavailable/logged-out enabled chips.** Status dots stay.
5. **Immediate hide on disable**, including while a task on that harness is still running. In-flight runs keep going (existing orchestrator policy); the topbar is not a run indicator.
6. **No shared `getEnabledHarnesses` refactor** of New Task / pickers / CLI. Different ticket.

Decision 1–3 rest on codebase evidence; 4–6 are the §8 assumptions from the skipped grill.

## 4. Work breakdown — implementation tasks

- **T1 — Filter topbar chips and delete dead disabled copy.**
  - **Owns:** `src/mainview/lib/usage.ts`, `src/mainview/App.tsx`, `src/mainview/components/usage/UsagePopover.tsx`, `src/shared/types.ts` (doc comment on `Harness.enabled` only — add “window topbar” to the hide list).
  - **Does:** export `visibleTopbarAgents(agents, harnesses)`; `App.tsx` maps that list instead of raw `agents`; remove the `!enabled` placeholder branch and the now-unused `enabled` local; tighten the UsagePopover `quota === null` comment so it no longer lists “disabled harness” as a reason a chip is shown.
  - **Does not:** change `GET /harnesses`, Settings, KanbanFilters, CLI, onboarding derivation, usage poller.
  - **Acceptance:** disabled ids never enter the chip map; enabled-but-unavailable still do; no remaining string “this harness is disabled — enable it in Settings”.

## 5. Work breakdown — test tasks

- **T2 — Unit tests for the helper.** Owns `src/mainview/lib/usage.test.ts`. Covers: enabled pass through; disabled dropped; missing harness id dropped; empty lists; does **not** drop an enabled-but-we-don’t-have-status-fields agent (helper only looks at `harness.enabled`). Layer: unit (`bun test src/mainview/lib/usage.test.ts`). Covers T1.
- **T3 — E2E: banner shows enabled only.** Owns `e2e/usage-tracker.spec.ts`. Update the file comment (disabled chips no longer render). After goto, assert the banner’s Claude Code chip is visible and that Codex / Cursor / Gemini / fx labels are **not** in `getByRole("banner")`. Existing popover/mini-bar assertions stay. **E2e applies** — this is the user-visible topbar flow; harness already exists.

**E2e run recipe:** `bunx playwright test e2e/usage-tracker.spec.ts` (no package.json script). Playwright config starts Vite (`bun run hmr`, :5173) and one isolated headless Bun backend per worker (`e2e/fixtures.ts`: own `AGETOR_DATA_DIR` / port / token, claude/tmux stubbed to `/bin/echo`). No extra credentials.

**Full suite:** `bun test` and `bun run typecheck`. E2e targeted spec above; full `bunx playwright test` only if the targeted spec is green and time allows — not required to close the loop given the change is banner-local.

## 6. Execution waves

- **Wave 1:** T1 (single agent). Barrier: typecheck optional sanity.
- **Then Phase 5 review** of the impl diff.
- **Wave 2 (Phase 6):** T2 + T3 in parallel (disjoint files).
- **Phase 7:** `bun test` + targeted Playwright spec.
- **Phase 8:** fix if needed.

## 7. Blast radius & risks

- **#179 UX reversal:** users who clicked a disabled chip to learn they must enable it in Settings lose that in-topbar hint. Settings remains the enable surface. Accepted by the request.
- **E2e locator drift:** other chips becoming buttons (all chips are already `UsagePopover` `<button>`s) is why T3 must use the banner scope and `exact: true`, same as the existing Claude Code query.
- **SSE `harness_usage` for hidden ids:** still updates `usage` state; no chip reads it until re-enabled. Harmless; leave it.
- **Onboarding / New Task:** already enabled-only. No change expected.
- **Rollback:** revert the four files.

## 8. Open questions / assumptions

Grill questions were presented and skipped. Assumptions used for this plan:

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| Hide vs dim vs keep #179 copy? | Hide entirely; delete the disabled placeholder as dead code. | Literal request + New Task filter convention | High (request wording); medium that #179’s hint is expendable |
| Chip while an in-flight run still uses a just-disabled harness? | Hide immediately. | Reversible default; topbar is not a run list | Medium |
| Enabled-but-unavailable / logged-out? | Still show. | Request named *disabled*, not unavailable | High |
| Client-only vs also skip server probes? | Client-only. | Minimal blast radius; matches pickers | High |
| Settings / Kanban filter / `harness ls`? | Out of scope. | Those surfaces need disabled rows | High |

No one-way doors in this run.
