# Plan — Fix "missing" Save button in backlog draft edit mode

| Field | Value |
| --- | --- |
| Date | 2026-07-16 |
| Source | agetor task: "it's missing a save button in the edit mode for the backlog message (saved for later)" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/missing-save-button-for-editing-backlog |
| Base SHA | fee24308ec9e |
| Mode | Autonomous (agetor-driven run; grill + plan-approval gates self-resolved, assumptions logged below) |

## 1. Objective & success criteria

When the user clicks the pencil icon on a saved backlog draft in the RunPanel tray, the
inline editor — including its **Save** and **Cancel** buttons — must be fully visible
without the user having to discover a 160px-tall scroll area.

## 2. Context & findings

- The Save button **exists in code** (`src/mainview/components/kanban/RunPanel.tsx:1663-1669`)
  and has since the backlog feature landed in one commit (`dae328c`, PR #84). So the report
  is a visibility bug, not absent code.
- The tray's item list is capped at `max-h-40` (160px) with `overflow-y-auto`
  (`RunPanel.tsx:1562`).
- The inline editor is ~140px tall: `p-2` container + 2-row textarea + inline
  `ReferencesPicker` (~28px) + `h-8` button row + gaps.
- Therefore: with two or more drafts, or when editing any row not at the very top, the
  editor's bottom (the Save/Cancel row) falls below the fold of the 160px window. Nothing
  scrolls it into view on entering edit mode.

## 3. Approach

Two small changes, both in `RunPanel.tsx`:

1. **Grow the tray while editing** — the list container's class becomes
   `cn("space-y-1 overflow-y-auto px-2 pb-2", editingId ? "max-h-72" : "max-h-40")`,
   so the ~140px editor always fits in the 288px window with room for context rows.
2. **Scroll the Save/Cancel row into view on entering edit mode** — `BacklogItemRow` gets
   an `actionsRef` on the action-button row; the existing enter-edit effect (already keyed
   on `[editing]` only, per the poll-clobber gotcha) additionally calls
   `scrollIntoView({ block: "nearest" })`. Review note: the anchor is the action row (the
   form's last element), not the editor container — a draft with many reference chips can
   grow the form past even the enlarged window, and anchoring the container top would
   re-clip the buttons.

Alternatives considered: sticky action row inside the editor (fights the tiny scrollport),
removing the cap entirely (lets a long backlog eat the panel). Rejected in favor of the
minimal pair above.

## 4. Work breakdown

- T1 — `src/mainview/components/kanban/RunPanel.tsx` only: both changes above. Single task,
  single file; no fan-out (change too small to partition).

## 5. Tests

The webview has no DOM test harness (established convention: extract pure logic to
`src/mainview/lib/*.ts` for unit tests; visual behavior verified via `bun run dev:hmr`).
This fix is pure DOM/scroll behavior with no extractable logic, so: run the existing suite
+ typecheck to guard against regressions; manual visual verification is the remaining step.

## 6. Blast radius & risks

- The enter-edit effect keeps its `[editing]`-only deps — the 2s-poll clobber gotcha is not
  re-introduced.
- `max-h-72` only applies while an editor is open; the resting tray is unchanged.

## 7. Assumptions (autonomous mode)

- The report refers to the RunPanel BacklogTray inline editor — the only backlog-message
  edit surface in the app ("Backlog" in NewTaskForm is the kanban column, unrelated).
- Root cause is the clipping described above; no build the user can run has edit mode
  without the Save button in code (both shipped in `dae328c`).
