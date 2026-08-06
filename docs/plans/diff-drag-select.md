# Plan — Drag-to-select diff lines in DiffDialog

| Field | Value |
| --- | --- |
| Date | 2026-07-29 |
| Source | /implement: "user needs to click each line; add click-and-drag to select multiple lines" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/drag-n-drop-selection-on-git-diff |
| Base SHA | ce9177b34816982f2aeebbba15fefb8dde8bd827 (tree clean at start) |

## 1. Objective & success criteria

Add a click-and-drag gesture to the compose-from-diff feature: mouse down on a diff line, drag across adjacent lines, release → every selectable line in the dragged range is selected. Existing gestures are unchanged: plain click still toggles one line; shift-click still range-extends from `lastClicked`.

Success = drag paints a contiguous range as selected (additive, never deselects), clamped to the file where the drag started, with edge auto-scroll in the diff panel; a mousedown+mouseup on the same row still behaves exactly like today's click; `bun run typecheck` green; new unit tests green.

Owner decisions (confirmed 2026-07-29): drag **always selects** (additive paint); **same-file only**; **auto-scroll yes**.

## 2. Context & constraints (Phase 1 findings)

- Selection state: `Map<string, Set<number>>` keyed by `file.path` → set of row indices into `toRows(f.hunks)` — `DiffDialog.tsx:57`. `lastClicked: {path, index} | null` at `:58` anchors shift-click (same-file only, `:133`).
- Click wiring: per-row `onClick` → `handleRowClick(path, index, rows, shiftKey)` (`DiffDialog.tsx:126-152`), functional-updater style (`new Map(prev)` / `new Set`), empty per-file sets deleted from the map. Existing `onMouseDown` preventDefault for shift only (`:498`) to suppress native shift text-selection.
- Selectable kinds `ctx|add|del` — duplicated as `SELECTABLE_KINDS` in `DiffDialog.tsx:38` and `lib/diff-selection.ts:18`.
- Rendering: `FileBlock` → `DiffBody` (`:478-531`), row divs keyed by array index, `isSelected` computed inline (`:494`); whole file's rows re-render on any selection change → drag must not commit to `selected` per mousemove.
- Scroll container: `overflow-y-auto` div at `DiffDialog.tsx:310` (vertical), per-file `overflow-x-auto` at `:491`.
- Diff text span (`:525`) allows native text selection today; gutters/markers are `select-none`.
- No DOM test harness in this repo (peer knowledge entry, confirmed by repo scan): test React behavior by extracting pure logic into `src/mainview/lib/*.ts` + bun test. Existing pure tests: `src/mainview/lib/diff-selection.test.ts`.
- dnd-kit is kanban-only; not reusable for drag-select. Raw pointer events it is.

## 3. Approach & key decisions

**Gesture model** — mousedown (primary button, no shift) on a selectable row arms a *pending* drag (`{path, anchorIndex, currentIndex}` — kept in one small state value + a ref mirror for document-level listeners). The drag *activates* only when the pointer crosses onto a different row index. Until then nothing changes, so:

- mousedown+mouseup on the same row → drag never activates → the native `click` fires → today's toggle path, untouched.
- Once active: a `didDrag` ref suppresses the trailing `click` event so the anchor row isn't double-toggled (the committed range already includes it).

**Native text selection** — we do *not* preventDefault on plain mousedown (within-row text drag still yields a normal copyable text selection). On drag activation (first row-boundary crossing) we clear the native selection (`window.getSelection()?.removeAllRanges()`) and set a `dragActive` flag that applies `select-none` to the diff container until mouseup. Shift-click keeps its existing preventDefault.

**Tracking** — document-level `mousemove` + `mouseup` listeners installed only while a drag is armed (mirrors the document-level listener pattern in `ui/dialog.tsx`). Rows get `data-diff-path` / `data-diff-index` attributes; mousemove resolves the hovered row via `event.target.closest("[data-diff-index]")`. Same-file clamp: if the pointer is over another file or dead space, clamp by comparing `clientY` against the anchor file's `DiffBody` bounding rect (above → first selectable index, below → last). State updates only when `currentIndex` changes (row-boundary granularity), not per pixel.

**Visual preview** — during the drag, rows show as selected if committed-selected OR inside the pending drag range (selectable kinds only). Commit to the real `selected` map happens once, on mouseup — cheap re-renders during drag (one small state object), one Map rebuild at the end.

**Commit + pure logic extraction** — the range math (walk `rows[lo..hi]`, keep `SELECTABLE_KINDS`, union into the file's set) is exactly what shift-click already does inline. Extract it into `lib/diff-selection.ts` as pure helpers, e.g. `selectableIndicesInRange(rows, a, b): number[]` and `addRangeToSelection(map, path, rows, a, b): Map` (immutable, deletes-empty-sets convention preserved), plus `isRowInDragRange(drag, path, index)` for the preview. `handleRowClick`'s shift branch and the drag commit both call these — one source of truth, unit-testable without a DOM. On mouseup, `lastClicked` updates to the drag endpoint so a follow-up shift-click extends from there.

**Auto-scroll** — while a drag is active, a rAF loop scrolls the `overflow-y-auto` container (`:310`, gets a ref) when the last known `clientY` is within an edge zone (~40px), speed proportional to proximity. After each scroll step, re-resolve the hovered row via `document.elementFromPoint(lastClientX, lastClientY)` (mousemove doesn't fire on scroll-under-pointer). Loop starts on drag activation, stops on mouseup/unmount. rAF suspension in occluded WKWebViews is irrelevant mid-drag (window is foregrounded).

**Alternatives considered** — per-row `onMouseMove` (rejected: hundreds of handlers, misses fast drags); committing to `selected` on every move (rejected: full-file re-render per pixel); pixel-threshold click-vs-drag discrimination (rejected: row-boundary crossing is simpler and unambiguous); dnd-kit (rejected: wrong tool — it does element reordering, not range multi-select).

## 4. Work breakdown — implementation tasks

**T1 — pure selection helpers** (`src/mainview/lib/diff-selection.ts`)
Add `selectableIndicesInRange`, `addRangeToSelection`, drag-range types + `isRowInDragRange`. Preserve existing exports untouched. Acceptance: typecheck green; helpers mirror the inline shift-click semantics exactly (inclusive lo..hi, selectable kinds only, empty-set deletion).

**T2 — DiffDialog gesture wiring** (`src/mainview/components/kanban/DiffDialog.tsx`)
Pending-drag state + refs, row `data-*` attributes, mousedown arming, document mousemove/mouseup, click suppression after drag, preview styling, `select-none` while dragging, scroll-container ref + edge auto-scroll rAF loop, refactor shift-click branch to call the T1 helpers, `lastClicked` update on drag end. Acceptance: all §1 success criteria; no changes to any other file.

T1 and T2 touch different files but T2 depends on T1's exports → **one agent does both sequentially** (single wave, single agent — fan-out would add cost, not speed, at this size).

## 5. Work breakdown — test tasks

**TT1 — unit tests** (`src/mainview/lib/diff-selection.test.ts` only)
Extend the existing bun-test file, matching its fixture style (`rows(...)` helper): range over mixed kinds skips `hunk`/`meta`; reversed anchor/current normalizes; additive union with pre-existing selection; single-row range equals that row; `addRangeToSelection` immutability (input map/set not mutated) + empty-set-deletion convention; `isRowInDragRange` path mismatch / bounds / inactive drag. Covers T1 directly and T2's commit/preview logic indirectly (the component itself has no DOM harness — by design).

## 6. Execution waves

- Wave 1 (Phase 4): one agent — T1 then T2.
- Phase 5: review diff `<base>..HEAD` (opus).
- Wave 2 (Phase 6): one agent — TT1.
- Phase 7: `bun test` + `bun run typecheck` (haiku).

## 7. Blast radius & risks

- `handleRowClick` shift branch refactored onto shared helpers — behavior must be identical (tests + review focus).
- Trailing-click suppression must not eat legitimate clicks (reset `didDrag` in the click handler / on next mousedown).
- Document listeners must detach on mouseup and on unmount/dialog close (cleanup in effect return); leaked listeners would ghost-select in a reopened dialog.
- Native text-copy by dragging *across* lines is superseded by drag-select (within one line still works). Accepted tradeoff — composing the snippet is the feature's whole point.
- No server/API/schema impact; webview-only.

## 8. Open questions / assumptions

- Assumption: drag with shift held is treated as plain shift-click on mouseup (drag arming requires no-shift), so the two gestures can't interleave.
- Assumption: no minimum drag distance — row-boundary crossing is the discriminator.
- Assumption: horizontal `overflow-x-auto` edge auto-scroll is out of scope (vertical only).
