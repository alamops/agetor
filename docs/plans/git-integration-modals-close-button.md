# Plan — X close button on the Git Integration modals

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Source | /implement "an X close button on the Git Integration modals" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/a-x-close-button-for-git-integration-mod |
| Base SHA | 7a50d75ccb2aa8232a50c2b8f06262c3311bdc15 (clean tree) |
| Mode | **Autonomous** — grill (Phase 2) and plan approval (Phase 3) self-resolved; assumptions logged in §8 |

## 1. Objective & success criteria

Every git-integration modal has a one-click X close button in its header, matching the
existing house pattern. Success: X visible and functional in all views of the three
modals below; `bun run typecheck` green; `bun test` green.

## 2. Context & constraints

- No component is literally named "Git Integration". The git-integration modals that
  **lack** a header X are:
  - `src/mainview/components/kanban/GitHubDialog.tsx` — header toolbar ends at Refresh
    (~line 3278); no close control in any view.
  - `src/mainview/components/worktrees/WorktreesDialog.tsx` — has a **text** "Close"
    outline button (~line 392) instead of the icon X used everywhere else.
  - `src/mainview/components/kanban/ResolveConflictsDialog.tsx` — header (~line 226)
    has **no** close control at all.
- Already conformant (used as the reference pattern): `DiffDialog.tsx:643`,
  `SettingsDialog.tsx:373`, `GitHubSetupDialog.tsx:126`:
  `<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>`
- `GitHubDialog`'s `Dialog onClose` wrapper implements Escape/backdrop **pop** semantics
  (subpage → back to list, only list → close). The header back-chevron pops; an X must
  do a **full close** by calling the component's raw `onClose` prop, not the wrapper.
- Composer drafts in GitHubDialog already reset when `open` flips false (existing
  design, GitHubDialog.tsx:1198–1206); detail/panel views survive close/reopen. The X
  introduces no new data-loss path beyond what Escape-Escape already does.
- Fleet knowledge: dialog.tsx handles stacked dialogs via `openDialogStack` — no extra
  work needed when adding buttons; do not add new document-level key listeners.

## 3. Approach & key decisions

- Reuse the exact house pattern (ghost icon Button + lucide `X`, `aria-label="Close"`).
- **GitHubDialog**: append the X as the last button in the header's right-side toolbar,
  visible in *all* views (list, panel, detail, compose) — it is the only one-click full
  close from a subpage. Calls the raw `onClose` prop.
- **WorktreesDialog**: replace the text "Close" outline button with the icon X
  (keeping both would be redundant; icon is the house convention).
- **ResolveConflictsDialog**: add a right-side X to the header (`items-start
  justify-between` layout already reserves the slot).

## 4. Work breakdown — implementation tasks

Single wave, one agent (three trivial, file-disjoint edits grouped per sizing guidance):

- **T1** `GitHubDialog.tsx` — add X after the Refresh button block, outside the
  `!isComposeView` guard so it renders in every view; `onClick={onClose}` (raw prop).
- **T2** `WorktreesDialog.tsx` — swap text Close button for icon X.
- **T3** `ResolveConflictsDialog.tsx` — add header X; import `X` from lucide-react.

## 5. Work breakdown — test tasks

- **No new tests**: the change is pure JSX wiring onto existing `onClose` props — no
  new logic, and the repo has no React component-render harness (bun tests cover pure
  logic modules only). Standing up a component harness for a close button is
  disproportionate; recorded as a deliberate decision.
- **E2e: not applicable** — no e2e harness exists in the repo (bun test + manual
  Electrobun runs are the convention).
- Verification = `bun run typecheck` + full `bun test` (Phase 7).

## 6. Execution waves

Wave 1: one implementation agent (T1–T3) → review (opus) → typecheck + tests (haiku).

## 7. Blast radius & risks

- UI-only; no shared state, routes, or DB. Focus-trap picks up the new buttons
  automatically (`FOCUSABLE_SELECTOR` queries live DOM).
- GitHubDialog X in compose view discards the draft — identical to existing
  close-by-Escape-twice behavior; acceptable.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: "Git Integration modals" = GitHubDialog + WorktreesDialog +
  ResolveConflictsDialog (the git modals currently lacking an X). Others already have one.
- **A2**: WorktreesDialog's text "Close" is *replaced* by the X rather than kept alongside.
- **A3**: GitHubDialog X performs a full close (raw `onClose`), while Escape/backdrop
  keep their pop-first semantics.
