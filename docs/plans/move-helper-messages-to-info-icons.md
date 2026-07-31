# Plan — Move New-Task-Panel Helper Messages to (i) Info Icons

| Field | Value |
| --- | --- |
| Date | 2026-07-31 |
| Source | /implement invocation (agetor task prompt) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/move-helper-message-to-i-icon-button |
| Base SHA | 5953e190c262b598ad36a10c449b984517bd19a1 |
| Mode | Autonomous — grill + plan-approval gates bypassed (no owner reachable mid-run); assumptions logged in §8 |

## 1. Objective & success criteria

Declutter the New Task form by moving two always-visible helper paragraphs into
click-triggered (i) info popovers, and enrich the Mode dropdown so each option
shows its name **and** its helper hint:

1. **Files / Folders** — helper text moves into a popover opened by a new (i)
   icon button placed to the right of the "Files / Folders" label.
2. **Mode** — the selected-mode hint paragraph under the dropdown is replaced
   by an (i) icon button to the right of the mode selector; clicking it shows
   the current mode's hint.
3. **Mode dropdown options** — the native `<select>` is replaced with the
   existing popover combobox (`SearchSelect`) in a new non-searchable variant,
   so each option renders `label` + `hint` (data already present in
   `AGENT_OPTIONS[kind].modes` in `src/shared/types.ts`).

Success: form renders without the two inline helper paragraphs; (i) buttons
toggle popovers on click (outside-click + Escape close); mode dropdown shows
name + hint per option; `bun run typecheck` and `bun test` green.

## 2. Context & constraints

- `src/mainview/components/kanban/NewTaskForm.tsx:739-741` — inline
  `selectedModeHint` paragraph (source: `modes.find(m => m.id === mode)?.hint`).
- `src/mainview/components/kanban/NewTaskForm.tsx:730-738` — Mode `Select`
  (native, `ui/select.tsx`) — native `<option>` cannot render two lines.
- `src/mainview/components/kanban/ReferencesPicker.tsx:222` — Files/Folders
  empty-state helper: "No files attached yet — use the buttons or drag from
  Finder. Absolute paths are inlined into the prompt as text."
- `src/mainview/components/ui/search-select.tsx` — hand-rolled popover combobox
  that already renders `label` + `hint` per item; has outside-click/Escape
  handling and a `data-popover-open` marker. Model for popover conventions.
- No tooltip primitive exists in `ui/`; native `title=` attrs are used
  elsewhere but the request is an explicit click-triggered tooltip.
- ReferencesPicker's label lives inside a `<details><summary>` — clicks inside
  the summary toggle the section, so the (i) button must `stopPropagation`
  (same trick as the Files/Folder buttons at ReferencesPicker.tsx:146).
- Frontend has no DOM test harness (no jsdom/testing-library); React behavior
  is tested only via pure logic extracted to `src/mainview/lib/*.ts`.
- Dark mode only; Tailwind v3 + shadcn HSL variables; form column is `w-80`.

## 3. Approach & key decisions

- **New `InfoTip` primitive** (`src/mainview/components/ui/info-tip.tsx`):
  lucide `Info` icon button + absolutely-positioned popover, click-toggled,
  closed on outside click / Escape, `data-popover-open` marker, right-aligned
  by default (both usage sites sit near the right edge of a w-80 column).
  Chosen over per-site inline popovers (two call sites already) and over
  pulling in a library (repo hand-rolls all primitives).
- **Extend `SearchSelect` with `searchable?: boolean` (default `true`)**
  rather than writing a parallel `OptionSelect`: when `false`, hide the search
  header and skip filtering/autofocus. Reuses existing trigger, item rendering
  (label + hint), and dismissal logic. Alternative (new component) rejected as
  duplication.
- Mode select keeps its 2-col Code/Plan pills untouched; only the dropdown
  row changes to `SearchSelect (searchable=false)` with the (i) button beside it.
- Model/Effort selects stay native — out of scope.

## 4. Work breakdown — implementation tasks

Single wave, single agent (files are small and interdependent enough that
splitting would cost more than it saves):

- **T1** (owns all four files):
  - `src/mainview/components/ui/info-tip.tsx` (new) — InfoTip primitive.
  - `src/mainview/components/ui/search-select.tsx` — add `searchable` prop.
  - `src/mainview/components/kanban/ReferencesPicker.tsx` — (i) + popover on
    the expandable variant's summary label; drop the long empty-state helper
    (keep a minimal "No files attached yet."); inline error `hint` unchanged.
  - `src/mainview/components/kanban/NewTaskForm.tsx` — Mode dropdown →
    `SearchSelect searchable={false}` with hints; (i) button to its right
    showing the selected mode's hint; remove the `selectedModeHint` paragraph.
  - Acceptance: §1 criteria; no behavior change to mode state logic
    (`setMode`, fallback effects, Code/Plan pills).

## 5. Work breakdown — test tasks

- No DOM harness exists, and this change introduces no new pure logic worth
  extracting (all JSX/positioning). **No new test files.** Verification =
  `bun run typecheck` + full `bun test` (existing suite must stay green).

## 6. Execution waves

- Wave 1: T1 (one sonnet agent). Then review (opus), then typecheck + tests.

## 7. Blast radius & risks

- `SearchSelect` is shared by ProjectPicker/BranchPicker/dialogs — the
  `searchable` prop must default to `true` so existing call sites are
  untouched.
- ReferencesPicker `inline` variant (RunPanel composer) must be unchanged.
- Popover overflow: the form column scrolls (`overflow-y-auto`) — popovers are
  absolutely positioned inside it, same as existing pickers, so clipping
  behavior matches the accepted status quo.

## 8. Open questions / assumptions (autonomous mode)

- "Tooltip on click" = click-toggled popover (not hover), dismissed by
  outside click / Escape / second click.
- The "Files / Folders helper message" = the empty-state paragraph at
  ReferencesPicker.tsx:222. Its text moves to the popover (rephrased to not be
  empty-state-specific); a minimal "No files attached yet." remains as the
  empty state so an open empty section doesn't look broken.
- The Mode (i) shows the *currently selected* mode's hint — kept even though
  hints now also appear per-option, per the explicit "additionally" in the ask.
- Model/Effort dropdowns intentionally left native (not requested).
