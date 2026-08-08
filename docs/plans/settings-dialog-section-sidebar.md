# Plan — Settings dialog left-side section sidebar

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Source | /implement — "add a left side menu for the settings page, so we can break up the config there" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/left-side-manu-options-for-settings-moda |
| Base SHA | 7a50d75ccb2aa8232a50c2b8f06262c3311bdc15 |

> Known-broken baseline: `bun run typecheck` at this SHA already fails with 8
> pre-existing "Property 'fast' is missing" errors in
> `src/bun/claude-followup-restart.test.ts` and `src/bun/claude-turn-routing.test.ts`
> (PR #152 fixtures; peer-reported). "Typecheck green" for this feature means
> *no new errors beyond those 8*.

## 1. Objective & success criteria

Replace the Settings dialog's single flat scrolling page with a left sidebar that
splits the config into three sections, each shown one at a time in the content pane:

- **General** — default-harness picker + tmux source picker
- **Harnesses** — harness list (enable/disable, terminal, edit, delete) + the
  existing Add-harness flow (template picker → editor)
- **Git Integration** — the existing `GitHubTokensSection`

Success criteria:
1. Opening Settings lands on **General** every time (owner decision — no persistence).
2. Clicking a sidebar item swaps the content pane; the active item is visually
   selected (`secondary` vs `ghost` Button variants — the repo's selected-state idiom).
3. The Add/Edit harness flows still work end-to-end and now return to the
   **Harnesses** section (not a generic "list") on cancel/save/back.
4. **Escape inside templates/editor pops back to Harnesses instead of closing the
   whole modal** (fixes an existing gap; the header X still always closes).
5. Dialog widens to `max-w-4xl`; PR #150's overflow contract is preserved — header
   stays fixed, only the content pane scrolls, nothing overflows at small viewport heights.
6. `bun run typecheck` green; new pure-logic unit tests pass under `bun test`.

## 2. Context & constraints (grounded)

- `src/mainview/components/settings/SettingsDialog.tsx` is the whole surface.
  Current `View` union at L35–38: `list | templates | editor`. Root component
  L164–464; `ListView` L466–639 contains the four flat groups (default harness
  L512–522, tmux L524–541, `<GitHubTokensSection />` L543, harness list L545–637);
  `TemplatePicker` L641–676; `Editor` L678–873.
- **PR #150 layout contract** (`5661761`, docs/plans/settings-dialog-max-height-scroll.md):
  Dialog panel `flex max-h-[85vh] w-full max-w-2xl flex-col p-0` (L344), header
  `shrink-0` (L347), body `min-h-0 flex-1 overflow-y-auto p-4 pt-0` (L378). The
  sidebar must be introduced as a **flex-row inside** that body slot — the outer
  flex-col + shrink-0 header must not change shape.
- **Canonical navigation pattern**: `src/mainview/lib/github-dialog-view.ts` — a
  pure discriminated-union module with navigation helpers and
  `resolveEscape(view): "pop" | "close"`, wired in `GitHubDialog.tsx` ~L3049–3062
  (Dialog `onClose` checks resolveEscape; only the root view actually closes).
  Unit-tested in `github-dialog-view.test.ts` (bun:test). Settings currently
  **lacks** resolveEscape — Escape from the editor closes the modal.
- Back-chevron idiom: `ChevronLeft`, `size="icon" variant="ghost"`,
  `aria-label="Back"` (SettingsDialog.tsx L349–358).
- Styling: semantic HSL tokens only (`border-border/60`, `bg-muted`, `text-muted-foreground`,
  `secondary`/`ghost`/`outline` Button variants); `cn()` from `@/lib/utils`. No literal
  palette classes. There is **no existing sidebar component** anywhere to reuse — net-new markup.
- Save model is save-per-action (no dirty state, no Save button) — the section
  split moves JSX, it must not change any handler logic. Failure toasts via
  `sonner` with `duration: Infinity`, no success toasts.
- Tests: repo convention is pure-logic `.ts` modules tested with `bun:test`; there
  is no React component-test harness and **no e2e harness** (recorded in the PR
  #150 plan). `bun test` at repo root discovers everything; typecheck is `tsc --noEmit`.
- Gotcha for sandboxed test shells: `bun` may be missing from PATH — prepend
  `$HOME/.bun/bin` and `/opt/homebrew/bin`.

## 3. Approach & key decisions

1. **Extract navigation into `src/mainview/lib/settings-dialog-view.ts`** (new file),
   mirroring `github-dialog-view.ts`:
   ```ts
   export const SETTINGS_SECTIONS = [
     { id: "general", label: "General" },
     { id: "harnesses", label: "Harnesses" },
     { id: "git", label: "Git Integration" },
   ] as const;
   export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

   export type SettingsView =
     | { kind: "section"; section: SettingsSectionId }
     | { kind: "templates" }
     | { kind: "editor"; harnessId: string | null; template: HarnessTemplate };
   ```
   Helpers (all pure): `initialView()` → General; `openSection(id)`;
   `openTemplates()`; `openEditor(harnessId, template)`; `backFromSubview()` →
   Harnesses section; `activeSection(view)` → which sidebar item highlights
   (templates/editor → `"harnesses"`); `resolveEscape(view)` → `"pop"` for
   templates/editor, `"close"` for any section. Type-only import of
   `HarnessTemplate` from `shared/types.ts` keeps it runtime-pure.
   *Rationale:* this is the exact shape the repo's own prior plan
   (github-modal-pr-detail-subpage) canonized; it replaces the old hardcoded
   `{ kind: "list" }` back-target, which has no section memory.
2. **Sidebar stays visible during templates/editor**, with Harnesses highlighted
   (unlike GitHubDialog's full-panel replacement). Clicking another section while
   mid-editor navigates away and discards the draft — identical to today's
   Cancel-then-navigate behavior, and the editor is short-lived CRUD, not precious state.
3. **Layout**: Dialog className → `flex max-h-[85vh] w-full max-w-4xl flex-col p-0`
   (width is the only change). Body slot becomes:
   `<div class="flex min-h-0 flex-1">` wrapping
   `<nav class="w-44 shrink-0 overflow-y-auto border-r border-border/60 p-2">`
   (full-width `justify-start` Buttons, `secondary` when active, `ghost` otherwise)
   and `<div class="min-h-0 flex-1 overflow-y-auto p-4 pt-0">` (the existing
   scroll container, unchanged classes, now scoped to content only).
4. **ListView splits** into `GeneralSection` (default harness + tmux pickers) and
   `HarnessesSection` (list + Add button); Git section renders `<GitHubTokensSection />`
   directly. All stay inside `SettingsDialog.tsx` (repo keeps dialog subcomponents
   in-file). Handler logic, props, and copy move verbatim — zero behavior change.
5. **Escape wiring**: Dialog gets `onClose={() => resolveEscape(view) === "pop"
   ? setView(backFromSubview()) : onClose()}`; the header X keeps calling the raw
   `onClose`. Header title stays "Settings" on section views ("Add/Edit harness"
   on subviews as today); back-chevron shows only on templates/editor and goes to
   `backFromSubview()`. The on-open reset (L228) becomes `setView(initialView())`.
6. **Out of scope** (owner decisions): no Environment section (unmerged
   `feat/env-settings-panel` stays shelved), no last-section persistence, no
   React component-test harness, no e2e harness.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| IMPL-1 | Create the view lib, then refactor SettingsDialog to the sidebar layout per §3 | `src/mainview/lib/settings-dialog-view.ts` (new), `src/mainview/components/settings/SettingsDialog.tsx` | — | Criteria 1–5 of §1; `bun run typecheck` green; no other files touched |

One task, one agent: the two files are one coherent change (the component imports
the lib), and nothing else in the repo is touched. No parallel fan-out needed.

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers | Acceptance |
| --- | --- | --- | --- | --- |
| TEST-1 | Unit-test every helper in the new view lib (initialView, openSection, openTemplates, openEditor, backFromSubview, activeSection, resolveEscape — incl. the templates/editor→harnesses highlight and pop-vs-close for every view kind) | `src/mainview/lib/settings-dialog-view.test.ts` (new) | IMPL-1 | Mirrors `github-dialog-view.test.ts` style; `bun test src/mainview/lib/settings-dialog-view.test.ts` green |

**E2e: not applicable.** No e2e harness exists (recorded decision, matching the
PR #150 precedent), and the rendered sidebar is markup + CSS over unchanged
handlers. Verification of the visual layout is manual: `bun run dev:hmr`
(AGETOR_DATA_DIR=~/.agetor-dev), open Settings, click through the three sections
and the add/edit flow.

## 6. Execution waves

- Wave 1: IMPL-1 (single agent, `sonnet`)
- Review barrier: Phase 5 review of the diff (`opus`)
- Wave 2: TEST-1 (single agent, `sonnet`)
- Phase 7: `bun run typecheck` + `bun test` (haiku runner; PATH fix per §2)

## 7. Blast radius & risks

- `App.tsx` passes `onClose={() => setSettingsOpen(false)}` — untouched; the
  pop-vs-close logic lives entirely inside SettingsDialog.
- `GitHubTokensSection` and its nested `GitHubSetupDialog` (stacked modal) are
  rendered unchanged; the dialog primitive's `openDialogStack` already handles
  stacked-Escape correctly, and our onClose wrapper only runs when Settings is topmost.
- Risk: regressing PR #150's overflow fix. Mitigated by keeping the outer
  flex-col/header untouched and reusing the exact scroll-container classes on the
  content pane; review explicitly checks this.
- Risk: `refresh()`/handler logic accidentally altered during the JSX split.
  Mitigated by verbatim-move instruction + review.
- Parallel-branch risk: history shows duplicate agents racing on this file
  (`fix/settings-no-max-height`); fleet peers were notified via echo_current_task.

## 8. Open questions / assumptions

- Assumption: sidebar labels "General" / "Harnesses" / "Git Integration" (owner
  approved the 3-way split; exact strings are mine).
- Assumption: `w-44` sidebar width and keeping `85vh` height (only width changes
  to `max-w-4xl`, per owner).
- Assumption: sidebar remains visible (Harnesses highlighted) during
  templates/editor subviews — chosen over GitHubDialog's full-panel replacement
  because a settings modal with a persistent rail is the more conventional UX.
