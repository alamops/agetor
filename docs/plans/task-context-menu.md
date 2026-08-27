# Plan — Task context menu (custom right-click quick actions)

| Field | Value |
| --- | --- |
| Date | 2026-08-24 |
| Source | `/implement` conversation — "get rid of the native right-click menu; add our own, tasks only for now; hoist task-detail features as quick actions" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema) |
| Flags | none |
| Gates | grilled + approved by owner (options list reviewed; D1/D2 decided) |
| Branch | `feature/agetor-quick-actions-menu` |
| Base SHA | `ef320a6ea8a6fbbb44947a1cfcd0f8f44a0bbe38` |

## 1. Objective & success criteria

Replace WebKit's native right-click menu with an in-app, theme-aware context
menu on kanban task cards that exposes the card's existing actions plus a
handful of task-details actions as quick actions.

Done means:

1. Right-clicking anywhere in the app **except** editable text
   (`input` / `textarea` / `contenteditable`) and the xterm terminal no
   longer shows WebKit's native menu (owner decision **D2 = (b)**).
2. Right-clicking a task card (board cards, including archived ones when the
   archived filter is on) opens an HTML context menu (**D1 = HTML**, not
   Electrobun's native `showContextMenu`) at the cursor, clamped to the
   viewport, in both themes.
3. The menu shows exactly these entries, gated by task state (owner-approved
   list — items 1–11 + "Mark as unread" + 16–17 from the review):

   | # | Entry | Shown when | Action |
   | --- | --- | --- | --- |
   | 1 | Open details | always | `setSelected(task)` |
   | 2 | Run | mirrors the card's Run precedence: `!archived && !awaiting && !active && !hasOpenableRun` | `start(task)` |
   | 3 | Stop | `active` (`running`/`blocked`), `!archived` | `cancel(task)` |
   | 4 | Mark done | `column === "review"`, `!archived` | `markDone(task)` |
   | 5 | Archive / "Stop & archive…" | `!archived && (column === "done" \|\| active)` (label + confirm when active) | `archive(task)` |
   | 6 | Unarchive | `archived` | `unarchive(task)` |
   | — | separator | | |
   | 7 | View changes | always | `setDiffTask(task)` |
   | 8 | Open in Finder | always | `api.openPath({ path: worktreePath ?? workdir, taskId })` |
   | 9 | View pull request | `task.prUrl` | same handler RunPanel's View PR uses (in-app detail when the PR number parses, else `openExternal`) |
   | — | separator | | |
   | 10a | Mark as read | `task.unread && !isOpen` | `POST /tasks/:id/seen` |
   | 10b | Mark as unread | `!task.unread && !isOpen && task.hasAssistantMessages` | **new** `DELETE /tasks/:id/seen` |
   | 11 | Copy branch name | `task.branch` | clipboard + toast |
   | 12 | Copy worktree path | `task.worktreePath` | clipboard + toast |
   | — | separator | | |
   | 13 | Delete… | always (danger-styled, last) | `del(task)` (existing confirm) |

   Same `App.tsx` callbacks and confirm dialogs as the hover buttons — the
   menu is additive; hover buttons stay.
4. Keyboard: ↑/↓ (wrapping, skipping separators/disabled), Home/End,
   Enter/Space activates, Escape/Tab closes. Outside mousedown, scroll,
   resize, and window blur close it. Escape closes the menu **before** any
   enclosing RunPanel/dialog Escape handler acts.
5. `bun run typecheck` green; `bun test` green; new Playwright spec green.

## 2. Context & constraints (Phase 1 findings)

- **There is no `contextmenu` handling anywhere in `src/`** — today's menu is
  WKWebView's default. `BrowserWindow` (`src/bun/index.ts:496-505`) exposes
  no context-menu option, so suppression is DOM-side.
- **Electrobun 1.18.1 does ship a native `showContextMenu`**
  (`node_modules/electrobun/dist/api/bun/core/ContextMenu.ts`, click events
  via `context-menu-clicked`), but using it would round-trip webview → HTTP →
  Bun → NSMenu → Bun → SSE → webview for UI-only actions, ignore the app
  theme, and be invisible to Playwright. Rejected (owner D1).
- **No menu primitive exists** (no Radix; `ui/` is hand-rolled). Template:
  `src/mainview/components/ui/info-tip.tsx` — `createPortal(document.body)`
  + `position: fixed` + `useLayoutEffect` viewport clamp
  (`VIEWPORT_MARGIN = 8`), outside-`mousedown` / Escape / scroll(capture) /
  resize close. A peer knowledge entry confirms the RunPanel `<aside>`'s
  `translate-x` transform breaks any **non-portaled** `fixed` descendant —
  portal is mandatory.
- **Tokens**: there is **no** `popover`/`popover-foreground` token in
  `index.css` or `tailwind.config.js` (CLAUDE.md records `bg-popover` as a
  shipped transparent-render bug). Menu surface uses
  `bg-card text-card-foreground border border-border shadow-xl`; hover
  `bg-accent text-accent-foreground`; danger item `text-destructive`.
- **Escape layering** is a documented cross-cutting contract
  (`RunPanel.tsx:240-268`, also lines ~1429/1449): every document-level
  Escape/Cmd+F handler bails when
  `document.querySelector('[role="dialog"][aria-modal="true"], [data-popover-open], [data-quote-open], [data-search-open]')`
  matches. The menu panel carries `data-popover-open=""` so those three call
  sites need **no** edits.
- **dnd-kit won't fight right-click**: `PointerSensor` bails on
  `!event.isPrimary || event.button !== 0`
  (`node_modules/@dnd-kit/core/dist/core.esm.js:1642`), so `onContextMenu`
  on the card root can't start a drag. Card root today:
  `<Card onClick={() => onOpen(task)} {...listeners} {...attributes}>`
  (`TaskCard.tsx:74-87`); the action row stops click propagation
  (`TaskCard.tsx:179`).
- **App.tsx ownership**: `start`/`cancel`/`markDone`/`archive`/`unarchive`/
  `del` are `useCallback`s at `App.tsx:840-939` with the optimistic pattern
  *patch one field → API → on error `surfaceError` + `refresh()`*.
  `Column` (`Column.tsx:101-116`) has an explicit memo comparator listing
  every callback prop — a new prop must be added there. `TaskCard` uses the
  default shallow memo. `isOpen` = `task.id === selected?.id`.
- **Board memo-stability rules** (peer entry, CLAUDE.md §8): server-managed
  watermark writes must **not** bump `updated_at`; optimistic UI updates
  merge single fields, never replace the `Task` snapshot.
- **Unread watermark** (`db.ts:285-296`, `409-447`): `unread =
  last_assistant_event_id != null && last_assistant_event_id >
  (last_seen_event_id ?? 0)`; `markSeen` is a guarded single UPDATE, no
  `updated_at` bump; route `POST /tasks/:id/seen` (`server.ts:4322`) is
  deliberately **not** archived-gated. `App.tsx:456-481` marks seen on panel
  open *and* close and merges only `unread` back. Client:
  `api.markTaskSeen` (`api.ts:1241`).
- **View PR** logic lives inline in App's `onViewPullRequest` prop
  (`App.tsx:1223-1236`): parse number → GitHub dialog detail prefill, else
  `api.openExternal(prUrl)` with a toast on failure.
- **Clipboard**: `navigator.clipboard.writeText` is already used in
  `md-components.tsx:99` and `TmuxInstallDialog.tsx:275` with a try/catch —
  proven in this webview; failures toast.
- **Global-listener precedent**: `font-size-provider.tsx:201-217` (document
  capture-phase keydown with a `.closest(".xterm")` carve-out). App-wide
  listeners otherwise live in `AppInner`'s effects (`App.tsx:360-427`).
- **Tests**: `bun test` is scoped to `src/` (`bunfig.toml`), pure logic goes
  in `src/mainview/lib/*.ts` + `*.test.ts`; **no DOM/component harness**
  (no happy-dom/testing-library) — React behavior is verified by typecheck +
  Playwright. E2E: `e2e/*.spec.ts`, per-worker headless Bun backend via
  `e2e/fixtures.ts` (`backend`, `request`), `gotoApp(page, backend.bootBase)`
  from `e2e/helpers.ts`, fake claude driver env baked in. Cards are located by
  `page.getByText(title, { exact: true })`. `data-testid` is kebab-case.
  **Run as `bun node_modules/@playwright/test/cli.js test`** (not `bunx`).
  Server-side unread tests: `src/bun/task-unread.test.ts` (port 4561).
- **House style** (git history): `feature: <summary> (#PR)` commits; pure
  logic in `lib/` with tests, thin components; a `docs/plans/<slug>.md`; a
  CLAUDE.md paragraph when a new architectural surface lands; no README
  edit for routine UI; no CHANGELOG.

## 3. Approach & key decisions

- **D1 HTML menu** (owner). Reasons in §2.
- **D2 suppression scope (b)** (owner): a single document-level
  `contextmenu` listener in `AppInner` calls `preventDefault()` unless
  `keepsNativeContextMenu(e.target)` — `closest()` against
  `NATIVE_CONTEXT_MENU_SELECTOR` (text-like `input`s, `textarea`,
  `[contenteditable]` not `"false"`, `.xterm`). Cmd+C/V/X/Z keep working
  everywhere regardless (`index.ts:52-93` installs the Edit-menu roles).
- **Controlled primitive, state in App.** `ui/context-menu.tsx` is a generic
  controlled `<ContextMenu open x y items onClose>`; `App.tsx` owns
  `taskMenu: { taskId, x, y } | null` and resolves the live `Task` from
  `tasks` on every render (so entries track the 2s poll; the menu closes if
  the task vanishes). `TaskCard` only reports `onContextMenu(task, {x, y})`
  — it never knows the entries. Rationale: every action is already an
  `App.tsx` callback; a provider/hook layer would add indirection for one
  consumer.
- **Entries are a pure builder** — `buildTaskContextMenu(task, { isOpen })`
  in `src/mainview/lib/task-context-menu.ts` returns
  `{ action, label, group, danger? }[]` (`group`: `primary | inspect |
  utility | danger` — four groups, three separators, matching the §1 table);
  App maps `action → handler` and inserts separators on group change. The
  visibility matrix is unit-tested without a DOM.
- **Run precedence mirrors the card exactly** (Answer > Stop > Open > Run,
  `TaskCard.tsx:41-51`): "Run" is hidden once a task has an openable run —
  same as the hover button — rather than exposing a re-run the card doesn't.
- **Mark as unread** = `last_seen_event_id = last_assistant_event_id - 1`,
  guarded on `last_assistant_event_id IS NOT NULL AND
  COALESCE(last_seen_event_id, 0) >= last_assistant_event_id` (idempotent;
  never moves an already-lower watermark *up*), **no `updated_at` bump**.
  `-1` rather than `0` keeps "exactly the latest message is unread"
  semantics for any future unread-count feature. Route:
  `DELETE /tasks/:id/seen` (pairs with the existing POST; same non-archived-
  gated treatment). The client gates the entry on a new derived, optional
  `Task.hasAssistantMessages` (`last_assistant_event_id != null`) so the
  "New messages" dot can never be shown for a task that has no assistant
  messages. Optional like `unread` so `src/bun/*.test.ts` fixtures need no
  edits.
- **Placement** = pure `placeContextMenu({ x, y, width, height,
  viewportWidth, viewportHeight, margin })`: open bottom-right of the cursor;
  flip left / above when it would overflow; then clamp to the margin.
  Keyboard-invoked `contextmenu` (clientX/Y = 0) anchors to the card's rect.
- **Keyboard nav** = pure `moveMenuIndex(current, delta, enabled[])`
  (wrap, skip disabled) driving roving focus on `role="menuitem"` buttons.
- **Copy** = `navigator.clipboard.writeText` → sonner `toast.success("Copied
  branch name" | "Copied worktree path")`, `toast.error("Couldn't copy to
  clipboard")` on failure — same idiom as `md-components.tsx`.
- **View PR** = extract App's inline `onViewPullRequest` body into a
  `useCallback viewPullRequest({ projectPath, prUrl })` shared by the
  RunPanel prop and the menu (no duplicated fallback logic).
- Not doing: right-click on empty column space, submenus, "Move to ▸",
  Create PR / Commit & push / Attach to tmux / Rename / Duplicate (owner
  scoped these out of v1).

## 4. Work breakdown — implementation tasks

### T1 — Mark-unread server path (Wave 1)
**Owns:** `src/bun/db.ts`, `src/bun/server.ts`, `src/mainview/lib/api.ts`. (`src/shared/types.ts`'s `hasAssistantMessages?: boolean` was added by the orchestrator before Wave 1 so T1 and T2 typecheck independently.)
- `db.ts`: `tasks.markUnread(taskId): Task | null` next to `markSeen`, doc
  comment mirroring its style (atomic guarded UPDATE, no `updated_at`);
  `toTask` adds `hasAssistantMessages: r.last_assistant_event_id != null`;
  the `this.get(t.id) ?? {…}` fallback in `insert` gets
  `hasAssistantMessages: false`.
- `types.ts`: `hasAssistantMessages?: boolean` right after `unread`, with a
  doc comment (derived, server-managed, optional for the same fixture
  reason).
- `server.ts`: add `DELETE` to the existing `"/tasks/:id/seen"` route object
  (`authed`, 404 on unknown id, returns the full Task, not archived-gated —
  extend the existing comment).
- `api.ts`: `markTaskUnread: (taskId) => j<Task>(\`/tasks/${taskId}/seen\`, { method: "DELETE" })`
  with a doc comment next to `markTaskSeen`.
- **Acceptance:** typecheck green; `POST` behavior unchanged; `DELETE` on a
  task with assistant events flips `unread` to true and is idempotent; on a
  task with none it's a no-op returning the task; `updated_at` untouched.

### T2 — Context-menu primitive + pure logic (Wave 1)
**Owns:** `src/mainview/components/ui/context-menu.tsx` (new), `src/mainview/lib/context-menu.ts` (new), `src/mainview/lib/task-context-menu.ts` (new).
- `lib/context-menu.ts`: `placeContextMenu(...)`, `moveMenuIndex(...)`,
  `NATIVE_CONTEXT_MENU_SELECTOR`, `keepsNativeContextMenu(target)` (accepts
  anything with a `closest` method so it's testable without a DOM). Doc
  comments in the `lib/pull-merged.ts` style.
- `lib/task-context-menu.ts`: `TaskMenuAction` union, `TaskMenuEntry`,
  `buildTaskContextMenu(task, { isOpen })` implementing the §1 table exactly
  (labels, groups `primary | inspect | utility | danger`, `danger` flag on
  delete). Pure — no React, no `api`.
- `ui/context-menu.tsx`: controlled `<ContextMenu>` per §3 — portal to
  `document.body`, `fixed z-50`, `role="menu"`, `aria-label`,
  `data-popover-open=""`, optional `testId` (rendered as `data-testid`),
  items as `<button role="menuitem" data-testid="<testId>-<id>">` with
  lucide icon slot, separators as `<div role="separator">`. Focus first
  enabled item on open; restore prior focus on close if still connected.
  Listeners attach only while open (`useEffect([open])`), matching
  search-select/info-tip. Verify `z-50` renders above the RunPanel aside
  and the DiffDialog (info-tip already does).
- **Acceptance:** typecheck green; the component is self-contained (no
  App/Task imports); pure functions are exported and documented.

### T3 — Board wiring + native-menu suppression (Wave 2)
**Owns:** `src/mainview/App.tsx`, `src/mainview/components/kanban/Column.tsx`, `src/mainview/components/kanban/TaskCard.tsx`.
- `TaskCard`: new optional prop `onContextMenu?: (t: Task, pos: { x: number; y: number }) => void`;
  root `<Card onContextMenu={…}>` → `preventDefault()`, anchor at
  `clientX/Y` (or the card rect's top-left when both are 0), call the prop.
  Comment why dnd-kit is unaffected (button-2 bail).
- `Column`: thread `onContextMenu` through and add it to the memo comparator.
- `App.tsx` (`AppInner`): global `contextmenu` suppressor effect using
  `keepsNativeContextMenu`; `taskMenu` state + `openTaskMenu` callback passed
  as `onContextMenu` to every `Column`; new callbacks `openInFinder`,
  `viewPullRequest` (extracted from the inline RunPanel prop, reused there),
  `markRead`, `markUnread` (optimistic single-field `unread` merge → API →
  merge returned `unread` only; `surfaceError` + `refresh()` on failure),
  `copyToClipboard(text, what)`; `useMemo` mapping
  `buildTaskContextMenu(menuTask, { isOpen })` → `ContextMenuItem[]` with
  icons (`FolderOpen`, `Play`, `Square`, `CheckCircle2`, `Archive`,
  `ArchiveRestore`, `GitCompare`, `Folder`, `GitPullRequest`, `MailOpen`/
  `Mail`, `GitBranch`, `Copy`, `Trash2`); render
  `<ContextMenu testId="task-context-menu" …>` next to `DiffDialog`; close
  when the task disappears from `tasks`.
- **Acceptance:** typecheck green; every §1 entry reachable and wired; the
  RunPanel's View PR still works through the shared callback; no new
  per-poll re-render churn (callbacks `useCallback`-stable, `Column`
  comparator updated).

### T4 — Architecture note (Wave 2)
**Owns:** `CLAUDE.md`.
- Add architecture item **9. Task context menu** after item 8 (unread
  indicator): native-menu suppression scope + `keepsNativeContextMenu`; the
  primitive (portal/fixed/clamp; `data-popover-open` marker is load-bearing
  for RunPanel's Escape layering); entries from the pure builder; the
  `DELETE /tasks/:id/seen` mark-unread semantics (`- 1`, guarded, no
  `updated_at` bump, `hasAssistantMessages` gate); single-field `unread`
  merge rule.

## 5. Work breakdown — test tasks

E2E **applies** — this is a user-visible, browser-observable flow
(right-click → menu → action → board state), and the repo's Playwright
harness runs the real Bun backend. Run recipe (from Phase 1):
`bun node_modules/@playwright/test/cli.js test e2e/task-context-menu.spec.ts`
— Playwright's `webServer` starts Vite (`bun run hmr`, :5173) and the
`backend` fixture spawns a headless Bun backend per worker (`bun
src/bun/headless.ts`, fake claude driver, tmpdir data dir); no credentials or
external services. Unit: `bun test`.

### TT1 — Server mark-unread tests (covers T1)
**Owns:** `src/bun/task-unread.test.ts` (extend).
DB-level: `markUnread` flips `unread` after an assistant event; idempotent;
no-op when `last_assistant_event_id` is NULL; `markSeen` after `markUnread`
re-clears; `updated_at` unchanged by both; `hasAssistantMessages` false →
true across the first assistant event. Route-level: `DELETE /tasks/:id/seen`
200 + full Task with `unread: true`; 404 unknown id; 401 without token; works
on an archived task.

### TT2 — Pure-logic tests (covers T2)
**Owns:** `src/mainview/lib/context-menu.test.ts` (new), `src/mainview/lib/task-context-menu.test.ts` (new).
`placeContextMenu`: fits → bottom-right; overflow right → flips left;
overflow bottom → flips up; both; tiny viewport → clamped to margin.
`moveMenuIndex`: wrap both directions, skips disabled, all-disabled returns
current. `keepsNativeContextMenu`: stub `closest` — textarea/input/
contenteditable/`.xterm` → true; card/body/null → false; `[contenteditable=false]` → false.
`buildTaskContextMenu`: table-driven matrix over column × archived × unread ×
isOpen × hasAssistantMessages × prUrl × branch × worktreePath ×
hasOpenableRun × pendingInteractionCount, asserting the exact ordered
action list and labels ("Stop & archive…" vs "Archive"; delete last + danger).

### TT3 — Playwright spec (covers T3/T4 end to end)
**Owns:** `e2e/task-context-menu.spec.ts` (new).
Create tasks via the API (mirror `e2e/unread-indicator.spec.ts`'s helpers,
including the todos-marker task for a real assistant event). Cases:
(a) right-click a card → `[data-testid="task-context-menu"]` visible, first
item focused, expected labels for a backlog task, Delete last;
(b) Escape closes; outside click closes;
(c) "Open details" opens the run panel (`aside` last) for that task;
(d) "Mark as unread" on a caught-up task with an assistant event → the corner
dot (`[aria-label="New messages"]`) appears; "Mark as read" → gone (poll
`GET /tasks/:id` like `waitForUnread`);
(e) "Copy branch name" → success toast text (grant `clipboard-read/write`
and read `navigator.clipboard.readText()` when supported; the toast is the
primary assertion);
(f) "Delete…" → confirm dialog visible → cancel → task still on the board;
(g) native-menu suppression: `page.evaluate` dispatching a cancelable
`contextmenu` MouseEvent on `document.body` → `defaultPrevented === true`;
on the New Task prompt `textarea` → `false`.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 1 | T1 (server + api client), T2 (primitive + libs) — file-disjoint | typecheck, commit `wave 1: …` |
| 2 | T3 (App/Column/TaskCard wiring), T4 (CLAUDE.md) — file-disjoint | typecheck, commit `wave 2: …` |
| Review | Phase 5 on `git diff <base>...HEAD` | fixes folded into Phase 8 |
| Tests | TT1, TT2, TT3 — file-disjoint, one wave | `bun test` + Playwright |

## 7. Blast radius & risks

- **`Task` JSON gains `hasAssistantMessages`** on every `/tasks` poll — a
  derived boolean; the `reconcileById` identity check compares JSON so this
  is stable per task unless the value flips (rare, once per task).
- **`DELETE /tasks/:id/seen`** is new surface; not in `ALLOWED_PATCH_FIELDS`
  territory; no migration needed (reuses migration 045 columns).
- **Global `contextmenu` suppression** touches every surface; carve-outs are
  the only place the native menu survives. If a future surface needs it,
  extend `NATIVE_CONTEXT_MENU_SELECTOR`.
- **Escape layering**: relies on the `data-popover-open` marker; if the
  RunPanel's bail-list selector is ever refactored, the menu must stay in it.
- **z-index**: `z-50` like info-tip; verified over the RunPanel aside in T2.
- **Clipboard** may be denied in exotic contexts → error toast, no crash.
- **Rollback**: pure additive UI + one additive route; reverting the PR is
  clean. No feature flag (house style for small UI additions).

## 8. Open questions / assumptions

- Hover buttons remain; right-click never selects/opens the card by itself.
- Right-clicking a card's hover button opens the same card menu (no special
  casing).
- No submenus in v1 (none of the approved entries need one).
- "Open in Finder" wording (app is macOS-only); RunPanel keeps its own
  "file manager" wording untouched.
- Keyboard-invoked context menu (Shift+F10 / menu key) is supported
  best-effort by anchoring to the card rect; not e2e-tested.
- E2E clipboard assertion falls back to the toast if `readText` is
  unavailable in the test browser.
- **Review-time reconciliation**: T2/T3 originally implemented five groups
  (`primary | inspect | read | copy | danger`), which drew a fourth separator
  between the read/unread and copy entries — the §1 table shows only three.
  The §1 table was authoritative; `read` and `copy` were collapsed into one
  `utility` group so the four entries render as the single block the table
  specifies.
- Entries are frozen at the moment the menu opens (the live `Task` is
  re-resolved only when an action actually fires); this was chosen over
  live-tracking the entry list against the 2s poll because rows shifting
  under the cursor while the menu is open risks a mis-click landing on
  `Delete…`.
- The card's right-button `mousedown` is default-prevented, so a
  partially-visible card isn't scrolled into view under the freshly opened
  menu — a scroll would trigger the menu's own scroll-close handler and
  dismiss it before the user could act.
- Post-review widening of D2 (b), approved by the owner: the suppressor also
  lets the native menu through while a non-empty read-only text selection
  exists (`hasTextSelection(window.getSelection())`), since that menu is the
  only mouse path to Copy / Look Up / Search With… on selected assistant
  output. Task cards are unaffected (their handler prevents default first).
- Post-delivery `/code-review` (fresh pass on the final state) — all four
  findings applied: the menu dismisses on user `wheel` (capture, outside the
  panel) instead of any `scroll`, because RunPanel's stream auto-pin and
  xterm output fire programmatic `scroll` events that were closing a fresh
  menu; the panel prevents default on its own `contextmenu` so a stale text
  selection can't let the native menu open over ours; field-derived actions
  (`view-pr`/`copy-*`) read the snapshot they were gated on instead of the
  live task with `!`; and keyboard navigation (Arrow/Home/End/Enter/Tab +
  focus restore) got an e2e case.
