# Plan — X close button on the Diff Modal

| Field | Value |
| --- | --- |
| Date | 2026-07-23 |
| Source | /implement "add an X Icon Button to close the Diff Modal opened through the task card or task details" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/diff-close-button |
| Base SHA | 4bf523249743f9c02676876eb50988c1864145ee |
| Mode | **Autonomous** — grill (Phase 2) and plan approval (Phase 3) gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

Add a top-right "X" icon button to `DiffDialog` that closes it, matching the app's existing dialog convention. Done when:

- The X is visible in the dialog header in **every** state (loading, error, empty diff, populated diff) from both entry points (task card `GitCompare` button, RunPanel "Diff" button).
- Clicking it calls `onClose` (same path Escape/backdrop already use).
- `bun run typecheck` and `bun test` stay green.

## 2. Context & constraints

- `DiffDialog` (`src/mainview/components/kanban/DiffDialog.tsx:48`) renders a `<header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">` (:279) with a title block and a **conditional** right-side toolbar (`diff && diff.files.length > 0`, :290-302: file counts + Collapse/Expand all).
- The `Dialog` primitive (`src/mainview/components/ui/dialog.tsx`) is hand-rolled — no shadcn `DialogContent`, so no built-in X; each dialog renders its own. Escape (:70-74) and backdrop click (:119-125) already call `onClose`.
- Established X convention (SettingsDialog.tsx:326-333, TmuxInstallDialog.tsx:119-121, BranchNamingDialog.tsx:110-112):
  `<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>` — last element on the header's right side.
- `X` from `lucide-react` is already imported in DiffDialog (:4, used by the selection "Clear" button).
- Open state lives in `App.tsx:81` (`diffTask`); both surfaces call the same setter — one change in DiffDialog covers both entry points.

## 3. Approach & key decisions

Wrap the existing conditional toolbar and a new always-rendered X button in a right-side flex container (`flex items-center gap-2`, mirroring SettingsDialog's grouped right side), so the X is the last element and present regardless of diff-load state. No changes to the Dialog primitive, App.tsx, or the openers — the alternative (adding a built-in X to the `ui/dialog.tsx` primitive) was rejected because it would change every dialog in the app (blast radius) for a request scoped to the Diff Modal.

## 4. Work breakdown — implementation tasks

- **T1** — Add the X close button to DiffDialog's header. Owns: `src/mainview/components/kanban/DiffDialog.tsx` only. Deps: none. Acceptance: §1 criteria; follows the exact SettingsDialog button pattern; toolbar behavior unchanged when diff is populated.

## 5. Work breakdown — test tasks

None. `src/mainview` has no component-render harness (all `*.test.ts` are pure-logic `bun:test` files); the change is pure JSX wiring an existing prop with no extractable logic. The sibling X-button dialogs ship untested too. Verification = typecheck + full existing suite (Phase 7) in place of new tests.

## 6. Execution waves

Wave 1: T1 (single agent, `implementation` runner = sonnet). No further waves.

## 7. Blast radius & risks

- Single file; no API/data/shared-types changes. Both entry points funnel through the same mount, so no per-surface risk.
- Only layout risk: regrouping the header's right side must not visually shift the existing toolbar (keep `justify-between` header, counts + buttons order intact).
- GitHubDialog has the same header shape and also lacks an X — intentionally out of scope; noted as a possible follow-up for consistency.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: X always visible (all load states), not only when a diff rendered — assumed from "close the Diff Modal", which applies regardless of content.
- **A2**: Scope is DiffDialog only; GitHubDialog left as-is (follow-up candidate).
- **A3**: No new tests (see §5) — typecheck + existing suite is the verification bar.
