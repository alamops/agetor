# Plan — Cmd/Ctrl+F focuses the kanban board search field

| Field | Value |
| --- | --- |
| Date | 2026-09-04 |
| Source | `/implement cmd+f should be a shortcut to auto focus on the kanban board search field when no task details is opened` |
| Config | AGENTS_CONFIG.yml (balanced, v1) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | feature/cmd-f-auto-focus-on-search-field |
| Base SHA | a59ba44 |

## 1. Objective & success criteria

Pressing the platform find chord (⌘F on macOS, Ctrl+F elsewhere) while **no task
details panel is open** focuses the kanban filter bar's free-text search box and
selects its current contents, so typing replaces the query. While a task's
details panel is open, the chord keeps doing what it does today (opens the
panel's message search — `RunPanel.tsx`). Modal dialogs and open popovers keep
winning over both, as today.

Done means:

- ⌘F / Ctrl+F on the bare board → the search box is `document.activeElement`
  and its existing text is selected. Works from anywhere on the board, including
  while focus sits in the New Task form's inputs (owner decision).
- With a task open, ⌘F still opens the panel's message search; the board box
  does not steal focus. After the panel closes, ⌘F goes back to the board.
- With any modal dialog (`[role="dialog"][aria-modal="true"]`) or a
  non-escape-only popover open, ⌘F does nothing on the board (mirrors RunPanel).
- Escape while the board search box is focused **blurs it and keeps the query**
  (owner decision: blur only, no clear).
- One shared predicate decides what "the find chord" is, used by both the board
  and RunPanel; one shared platform sniff replaces the two copies that exist
  today.
- Unit tests for the predicate + platform helper (bun:test) and a Playwright
  e2e spec for the user-visible flows. `bun run typecheck` green.

## 2. Context & constraints (Phase 1 findings)

- **Search box**: `src/mainview/components/kanban/KanbanFilters.tsx:113-119` —
  a plain `<Input>` (`ui/input.tsx`, `forwardRef`, so a ref attaches with no
  primitive change) bound to `textQuery` / `setTextQuery` in `App.tsx:177`,
  rendered at `App.tsx:1476`. No ref, id, aria-label or test id today. Sole
  consumer of `KanbanFilters` is `App.tsx` (`WorktreesDialog.tsx:71` only
  mentions it in a comment).
- **Existing Cmd+F owner**: `RunPanel.tsx:1640-1667`. Attached only while the
  panel's `open` state is true; `open` is set `false` synchronously in the
  effect that sees `task === null` (`RunPanel.tsx:352-368`) and `true` one rAF
  after a task arrives. So "panel open" (RunPanel handles) and "no task
  selected" (board handles) are complementary except for a one-frame gap on
  open, which is pre-existing and harmless. Its chord check is inline:
  `e.key.toLowerCase() !== "f" || e.altKey` + `IS_MAC_PLATFORM ? (metaKey &&
  !ctrlKey) : ctrlKey`; its blocking-layer guard is
  `'[role="dialog"][aria-modal="true"], [data-popover-open]:not([data-popover-keys="escape-only"])'`
  (knowledge entry a851070a explains the `escape-only` carve-out); it also
  bails on focus inside `.xterm`.
- **Platform sniff exists twice**: `RunPanel.tsx:208-209` (`IS_MAC_PLATFORM`,
  not exported) and `src/mainview/lib/font-size.ts` (`isMacPlatform()`, whose
  doc comment says it is a duplicate because RunPanel's isn't exported).
  Consumers of the latter: `font-size-provider.tsx:7`, `SettingsDialog.tsx:17`,
  and a comment in `e2e/font-size.spec.ts:79`.
- **Pure-shortcut idiom to mirror**: `fontSizeShortcutAction(e, isMac)` in
  `lib/font-size.ts` — DOM-free predicate, table-driven bun:test in
  `font-size.test.ts`, thin document listener in `font-size-provider.tsx`
  (capture phase, `e.repeat` guard). Its modifier rule is stricter than
  RunPanel's on non-Mac (`ctrlKey && !metaKey`); the shared predicate adopts
  the stricter form.
- **App-level listeners**: `App.tsx` already keeps `selectedIdRef`
  (`App.tsx:628`, synced at `:634`) precisely so once-attached document
  listeners can read the current selection without re-subscribing every 2 s
  poll. The new keydown listener reads it the same way.
- **Terminals** (`TerminalView.tsx`) mount only inside RunPanel
  (`RunPanel.tsx:4062`), so the board handler never has to dodge `.xterm`.
- **Native menu** (`src/bun/index.ts:53-92`) has no ⌘F item (only Ctrl+⌘F for
  fullscreen), so the keydown reaches the webview — proven by RunPanel's
  handler working today.
- **e2e harness**: Playwright, one Vite dev server + one headless backend per
  worker (`e2e/fixtures.ts`), run with
  `bun node_modules/@playwright/test/cli.js test <spec>` (one run at a time;
  port 5173 was free at plan time). Keyboard idiom: in-page Meta/Control sniff
  (`e2e/font-size.spec.ts:75-81`). The board box is already located by
  placeholder in `e2e/identifier-inputs.spec.ts:267`. Task creation + panel
  opening idiom: `e2e/run-panel-header.spec.ts` (`createAndStartFakeClaudeTask`,
  `openTask`, `runPanel()` = `page.locator("aside").last()`).
  **Gotcha (knowledge 949cd1d9)**: RunPanel's listeners are rAF-gated on `open`;
  a spec must wait for the aside to carry `translate-x-0` before pressing the
  chord, and must close the panel via the "Close task panel" button, never
  `Escape`.
- **Bun on PATH**: `export PATH="$HOME/.bun/bin:$PATH"` first in this worktree.
  Bun's `navigator.platform` is `"MacIntel"` under `bun test`, so the platform
  helper takes an injectable navigator for deterministic tests.
- Spikes: none needed — every assumption was settled by reading code.

## 3. Approach & key decisions

1. **Shared chord predicate** `isFindShortcut(e, isMac)` in a new
   `src/mainview/lib/find-shortcut.ts`, plus the exported selector constant
   `FIND_SHORTCUT_BLOCKING_LAYERS` (the dialog/popover guard string RunPanel
   uses today). Both the board and RunPanel call these. *Reasoning + owner
   decision (grill Q3).* Shift is tolerated (`key.toLowerCase() === "f"`) for
   parity with RunPanel's current behavior; Alt disqualifies; the primary
   modifier must be held without the other one (font-size's stricter rule).
2. **One platform sniff**: new `src/mainview/lib/platform.ts` exporting
   `isMacPlatform(nav = globalThis navigator)`. `font-size.ts` drops its copy;
   `RunPanel.tsx` derives its module-level `IS_MAC_PLATFORM` from it. *Reasoning:
   the duplication was already flagged in code comments; the new module would
   otherwise be a third copy.*
3. **Board handler lives in `App.tsx`**, not `KanbanFilters`: App owns
   `selected`/`selectedIdRef` (the gate) and the document-listener pattern;
   `KanbanFilters` just exposes the input through a `searchInputRef` prop.
   Listener attached once (`[]` deps), reads `selectedIdRef.current`, bails on
   `FIND_SHORTCUT_BLOCKING_LAYERS`, then `preventDefault` + `focus()` +
   `select()`. Bubble phase (like RunPanel), not capture — the font-size
   capture listener is unrelated (different keys).
4. **Escape-blur** is a local `onKeyDown` on the input itself (only fires while
   focused): `preventDefault()` + `currentTarget.blur()`; no `stopPropagation`
   — the repo coordinates document-level Escape via DOM markers, and
   `dialog.tsx` already honors `defaultPrevented`.
5. **Accessible name**: the input gains `aria-label="Search tasks"` (it has only
   a placeholder today), which also gives the e2e spec a stable locator.
6. **Focus + select** on the chord (owner decision, grill Q1), matching
   RunPanel's message search and native find fields.

Alternatives passed on: a `data-board-search` DOM query from App instead of a
ref (fragile, non-idiomatic here); putting the listener in `KanbanFilters` and
threading `panelOpen` down (spreads the gate across two components); a capture-
phase listener (would pre-empt popover/dialog handlers that today legitimately
run first).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Shared platform helper + find-chord predicate; retire the font-size copy | `src/mainview/lib/platform.ts` (new), `src/mainview/lib/find-shortcut.ts` (new), `src/mainview/lib/font-size.ts`, `src/mainview/components/font-size-provider.tsx` (import line), `src/mainview/components/settings/SettingsDialog.tsx` (import line), `e2e/font-size.spec.ts` (comment line ~79 only) | — | `platform.ts` exports `isMacPlatform(nav?)`; `find-shortcut.ts` exports `isFindShortcut(e, isMac)` and `FIND_SHORTCUT_BLOCKING_LAYERS`; `font-size.ts` no longer defines `isMacPlatform`; both consumers import from `@/lib/platform`; typecheck green |
| T2 | Expose the board search input + Escape-blur + aria-label | `src/mainview/components/kanban/KanbanFilters.tsx` | — | New optional prop `searchInputRef?: React.Ref<HTMLInputElement>` forwarded to the `<Input>`; `aria-label="Search tasks"`; `onKeyDown` Escape → `preventDefault` + `blur()`; nothing else changes |
| T3 | Board ⌘F handler | `src/mainview/App.tsx` | T1, T2 | `boardSearchRef` created, passed as `searchInputRef`; once-attached document `keydown` listener per §3.3, placed after `selectedIdRef` is declared; comment explains the complementary gate with RunPanel |
| T4 | RunPanel uses the shared predicate/selector/platform helper | `src/mainview/components/kanban/RunPanel.tsx` | T1 | `IS_MAC_PLATFORM = isMacPlatform()` from `@/lib/platform` (comment trimmed); the ⌘F handler's key/modifier check becomes `isFindShortcut(e, IS_MAC_PLATFORM)` and its guard uses `FIND_SHORTCUT_BLOCKING_LAYERS`; `.xterm` bail, `searchOpen` branches and Escape handler untouched; behavior identical except the non-Mac Ctrl+Meta+F edge now disqualifies |
| T5 | Document the convention | `CLAUDE.md` (UI conventions section) | T1–T4 | One bullet: keyboard shortcuts use `lib/platform.ts` + a pure chord predicate in `lib/`; ⌘F ownership is complementary (board when no task is selected, RunPanel while open) and both share `FIND_SHORTCUT_BLOCKING_LAYERS`; Escape in the board box blurs without clearing |

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| TT1 | unit (bun:test) | T1 | `src/mainview/lib/find-shortcut.test.ts` (new), `src/mainview/lib/platform.test.ts` (new) — table-driven like `font-size.test.ts`: f/F with Meta on Mac, Ctrl elsewhere; Alt disqualifies; wrong-platform modifier rejected; both modifiers rejected; other keys rejected; `isMacPlatform` with injected `{platform}` / `{userAgent}` / neither / undefined |
| TT2 | e2e (Playwright) | T2–T4 | `e2e/board-search-shortcut.spec.ts` (new) — (a) chord on bare board focuses the box and selects pre-typed text; (b) chord while focus is in the New Task prompt textarea still jumps to the box; (c) task open (aside has `translate-x-0`) → chord opens the panel's "Search messages" input, board box not focused; close via "Close task panel" button → chord returns to the board; (d) Settings dialog open → chord leaves the box unfocused; (e) Escape in the focused box blurs it and keeps the query |

E2e **applies**: the feature is a user-visible keyboard flow whose correctness
is entirely in the wiring between two document listeners and React state.
Run recipe: `export PATH="$HOME/.bun/bin:$PATH"`, then
`bun node_modules/@playwright/test/cli.js test e2e/board-search-shortcut.spec.ts`
(Playwright's `webServer` starts Vite on 5173; `e2e/fixtures.ts` spawns the
headless backend per worker with the fake claude driver — no credentials, no
services). One Playwright run at a time.

## 6. Execution waves

- **Wave 1** (one implementation agent, sequential inside): T1 + T2 — file-disjoint, no dependencies. Barrier: `bun run typecheck`.
- **Wave 2** (one implementation agent): T3 + T4 + T5 — all depend on T1's exports. Barrier: `bun run typecheck`, commit.
- **Review** (opus): diff `a59ba44...HEAD`.
- **Wave 3** (two test agents in parallel): TT1, TT2 — file-disjoint.
- **Run** (haiku, background): `bun run typecheck`; `bun test src/mainview/lib/`; full `bun test`; the e2e spec plus `e2e/font-size.spec.ts` (touched comment + moved helper).

Fan-out is deliberately small: the whole change is ~80 lines across 8 files.

## 7. Blast radius & risks

- `RunPanel.tsx` is edited by many concurrent branches; T4 is a ~6-line
  surgical change to keep merge conflicts trivial.
- `font-size-provider.tsx` / `SettingsDialog.tsx` only change an import path;
  the font-size shortcuts and the Settings hint are unaffected (e2e
  `font-size.spec.ts` re-run confirms).
- Behavior change in RunPanel on non-Mac: Ctrl+Meta+F no longer counts as the
  chord (was accepted before). Agetor ships macOS-only; dev-in-browser only.
- Once-attached listener in App reads a ref: if a future refactor removes
  `selectedIdRef`, the gate silently breaks — the comment names the dependency.
- Rollback: revert the branch; no persistence, no migrations, no API change.

## 8. Open questions / assumptions

Owner answered all four grill questions (focus + select all; chord works from
any board input; fold RunPanel onto the shared predicate; Escape blurs only).
Assumptions proceeding on:

- Platform-aware chord (Meta on Mac, Ctrl elsewhere) like every sibling handler.
- Bail **without** `preventDefault` while a modal/popover is up (mirrors RunPanel).
- The panel's 250 ms exit animation counts as "closed" — the board takes ⌘F as
  soon as `selected` is null.
- Shift+⌘F is tolerated (parity with RunPanel today); Alt+⌘F is not.

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Both ⌘F handlers agree on the chord + blocking layers | in this run — T1, T3, T4 |
| Two copies of the platform sniff (`RunPanel`, `font-size.ts`) | in this run — T1, T4 |
| `e2e/font-size.spec.ts` comment pointing at the old `isMacPlatform` home | in this run — T1 |
| CLAUDE.md documents the shortcut convention | in this run — T5 |
| Escape in the board box | in this run (blur only) — T2, per owner |
| Escape *clearing* the query | out of scope — owner chose blur-only (grill Q4) |
| `.xterm` bail on the board handler | out of scope — unreachable: terminals mount only inside RunPanel (`RunPanel.tsx:4062`), where the board handler is off |
| ⌘F inside WorktreesDialog / GitHubDialog search boxes | out of scope — modal dialogs; today the chord is inert there and stays so (different ticket) |
| TUI / CLI analog | out of scope — no board search exists in those surfaces |
| e2e + unit coverage for the above | in this run — TT1, TT2 |

No owner-deferred rows.
