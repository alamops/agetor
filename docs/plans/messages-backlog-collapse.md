# Plan — Collapse/expand the task messages backlog

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Source | Agetor task `df38cb35-4ba1-4073-8449-c6db9673d014`; requirement quoted verbatim at `docs/plans/messages-backlog-collapse-investigation.md:12-14`; investigation `docs/plans/messages-backlog-collapse-investigation.md`; decisions `docs/plans/messages-backlog-collapse-grill.md` + `docs/plans/messages-backlog-collapse-grill/round-{1,2}/answers.json` |
| Flags | none |
| Gates | grilled + approved by owner (round 1: 12 accepted recommendations + 1 override, 1 `not_applicable`, 1 optional blank; round 2: 1/1; no one-way doors). Pipeline hands off to Implementing. |
| Status | implemented — I1 (`9090f18c`) + T1 (`ce9be918`); bug-fix round after code review (stale-editor guard + conditional `aria-controls`); typecheck and the full `e2e/backlog-collapse.spec.ts` (5/5, with red proof for the archive→collapse→unarchive case) green |
| Branch | `feature/agetor-collapse-expand-messages-backlog` (current worktree) |
| Base SHA | `46dbe0f4` (planning HEAD; `RunPanel.tsx` is identical to `a5593d16`) |

## 1. Objective & success criteria

The saved-drafts **Messages backlog** tray above the composer currently spends a fixed ~190–200 px of the RunPanel (header + a 160 px capped list), crowding out the transcript. Make the tray a disclosure: collapsed shows only its header and hands the list's height back to the message stream, while leaving every backlog mutation, the task data, and the API untouched.

| # | Criterion | Produced by (production path) | Proven by |
| --- | --- | --- | --- |
| C1 | A task with saved drafts opens the tray **expanded**: list visible, header button `aria-expanded="true"`, tray `data-state="expanded"`. | Card click → `App.tsx` selects the task → `RunPanel` → `RunPanelBody` renders `BacklogTray` at `RunPanel.tsx:4583-4604`; `BacklogTray`'s `useState(false)` (`RunPanel.tsx:4967`). | T1 test 1 |
| C2 | Clicking the header **collapses**: the list is unmounted (not merely hidden), `aria-expanded="false"` (and `aria-controls` dropped, since its target no longer exists), `data-state="collapsed"`; the icon, "Backlog", count and chevron stay visible; the hint becomes `saved messages — expand to review`. | `BacklogTray` header `<button>` + `{!collapsed && <div data-testid="backlog-list">…}` (I1). | T1 test 1 |
| C3 | Clicking again **expands** and restores the drafts; the resting/editing height caps stay `max-h-40` (160 px) / `max-h-72` (288 px). | Same conditional render; the list's existing class expression at `RunPanel.tsx:5018-5022` is unchanged (I1). | T1 tests 1–2; I1 acceptance 3 |
| C4 | Collapsing hands the freed height to the transcript: `transcript-log`'s bounding box grows by roughly the tray's shrink. | `aside` is a full-height flex column (`RunPanel.tsx:571-576`); transcript is `flex-1` (`:4465`); tray is `shrink-0` (`:5003`); list unmount removes its 160 px (I1). | T1 test 1 (box measurements) |
| C5 | Collapse is **blocked while a live inline editor is on screen** — expanded, editable (`!readOnly`) and the edited draft still present: the toggle is `aria-disabled`, the hint says `save or cancel your edit first`, clicking it leaves the list mounted and the unsaved editor text intact. Cancelling clears the block. A stale editor id (archived mid-edit, or draft deleted) can never block a collapsed tray from expanding. | `editorVisible` predicate (`!collapsed && !readOnly && editingId !== null && items.some(...)`) + a reset effect in `BacklogTray`; `editingId` is existing tray state (`RunPanel.tsx:5001`). | T1 tests 2, 5 |
| C6 | Every non-empty tray has the toggle, including a one-item tray and an archived (read-only) task; archived keeps the read-only expanded hint (`saved messages — unarchive the task to edit or send`), while collapsed still shows the expand hint. | Header button is rendered unconditionally by `BacklogTray`; `readOnly` only affects row actions and the expanded hint (I1). | T1 tests 3–4 |
| C7 | The choice is **session-only**: default-expanded on mount; reset on task switch, subagent tab, panel close, and after the tray empties (the next draft opens expanded). | `useState(false)` inside `BacklogTray`, whose key is `backlog-${task.id}` (`RunPanel.tsx:4584-4593`) and so remounts it per task; empty backlog unmounts the whole tray (`:4583`). No persistence code (I1). | T1 test 3 |
| C8 | Existing backlog behavior is intact: send/edit/delete/reorder, optimistic state, archived freeze, hidden on subagent tabs and empty, 160/288 px heights, no React sibling-key collision. | The diff is confined to `BacklogTray`'s header/list wrapper; all handlers, `BacklogItemRow`, and the render gate stay untouched (I1). | `bun run typecheck`, `bun test`, targeted `e2e/task-switch-during-restore.spec.ts` regression, T1 tests 1–2 |

## 2. Context & constraints

### The requirement

> On tasks, when we save many messages for later, the backlog can be very large and occuping a big part of the screen that would be for reading the messages stream.
>
> So, let’s add a collapse/expand feature for the backlog.

Quoted verbatim at `docs/plans/messages-backlog-collapse-investigation.md:12-14`; that investigation is the repo-visible requirement of record.

### Surface and layout (verified at `46dbe0f4`)

- The only messages-backlog UI is `BacklogTray`, a local function rendered above the composer at `src/mainview/components/kanban/RunPanel.tsx:4583-4604`. It is not the kanban `backlog` column.
- The tray renders only when `activeStream === "main" && backlogItems.length > 0` (`RunPanel.tsx:4583`); it is absent on background-agent tabs and when empty. On an archived task it renders with `readOnly` (`:4598`).
- The tray root is `shrink-0 border-t border-border/60` (`RunPanel.tsx:5003`); the transcript is `flex-1 overflow-y-auto` (`:4465-4466`) inside the full-height flex-column `aside` (`:571-576`). Removing the list therefore gives its height directly to the transcript.
- Current header is a non-interactive `div`: `ClipboardList`, "Backlog", count, and a hint (`RunPanel.tsx:5004-5013`). The list wrapper is `cn("space-y-1 overflow-y-auto px-2 pb-2", editingId !== null ? "max-h-72" : "max-h-40")` (`:5018-5022`). The 160/288 px heights are deliberate and must survive (`docs/plans/fix-backlog-edit-save-button-clipped.md:23-36`).
- `BacklogTray` owns only `editingId` today (`RunPanel.tsx:5001`); it is purposely presentational, with all mutations handed back to `RunPanelBody` (`:4961-4966`). `backlogItems` is seeded/resynced at `:2846-2854`; mutations are `saveForLater` `:3416`, `sendBacklogItem` `:3455`, `editBacklogItem` `:3522`, `removeBacklogItem` `:3542`, `moveBacklogItem` `:3565`.
- The tray is a keyed child: its key is `backlog-${task.id}` (`RunPanel.tsx:4584-4593`). `RunPanelBody` is one long-lived instance across task switches (`docs/architecture/run-panel.md:5-9`), so the key is what resets tray-local state. Any collapse state inside `BacklogTray` resets on task switch, subagent-tab switch (tray unmounts), and panel close (body unmounts after the exit animation).
- The 2 s task poll rebuilds `task.backlog` into fresh objects every tick. Do not add an effect keyed on the array identity; the existing edit effect deliberately depends only on `[editing]` (`RunPanel.tsx:5097-5114`). The collapse feature needs no effect at all.

### House rules that apply

- **House collapse idiom** is a hand-rolled `useState<boolean>` plus a full-width `<button>` carrying `aria-expanded` and a `ChevronDown`/`ChevronRight` (`size-3.5`); no Collapsible/Accordion primitive (`docs/plans/pr-diff-collapsible-sticky-headers.md:28,34`). Default expanded and no persistence were chosen there too (`:67,70`). `CompactionSummaryBlock` is the closest live pattern: `useState`, `data-state="expanded|collapsed"`, `aria-expanded`, rotated `ChevronRight`, body unmounted while closed (`src/mainview/components/kanban/CompactionSummaryBlock.tsx:28-57`).
- **Layout chrome persistence convention**: `CLAUDE.md:175` says collapsed-panel chrome lives in `localStorage` via `src/mainview/lib/panel-collapse.ts`, not the preferences API. The owner explicitly chose **session-only** for this tray (round-1 `#persistence` overrode the recommendation), so this change deliberately does not add a `panel-collapse.ts` key or touch `CLAUDE.md:175`. Recording the deviation is part of I1's doc update.
- **Theme**: semantic tokens only, never literal palette classes (`CLAUDE.md:170`). Reuse existing `text-muted-foreground`, `bg-muted`, `border-border/60`, `hover:bg-muted/40`, `ring-ring`.
- **RunPanel per-task state**: no new `RunPanelBody` state and no `[task.id]` reset line; the state belongs to the already-keyed `BacklogTray` (`docs/architecture/run-panel.md:6,9`).
- **Tray contract**: send/edit/delete/reorder, composer/send decoupling, archived read-only, and subagent/empty visibility are documented at `docs/architecture/messages-backlog.md:9-14` and must survive.

### Test and runnability picture

- `bun test` is scoped to `src/` by `bunfig.toml`; there is **no DOM/component harness** (no jsdom/testing-library). React behavior is covered by Playwright e2e; pure logic lives in `src/mainview/lib/*.ts` with co-located `bun:test` files. A boolean disclosure has no pure logic worth extracting, so **e2e is the only layer that can observe it**.
- Playwright drives Chromium against a shared Vite server and a per-worker headless Bun backend + data dir (`playwright.config.ts`, `e2e/fixtures.ts`). Existing tray coverage:
  - `e2e/task-switch-during-restore.spec.ts:401-448` seeds a draft, opens the task, asserts the draft is visible and that there is exactly one terminals section (the sibling-key regression). This pins **default-expanded**.
  - `e2e/at-file-autocomplete.spec.ts:657-699` opens the tray's inline editor and exercises the `@` popover. It must stay green.
- The panel opens for a task with no runs; the tray is gated on backlog count, not on a run. Seeding `POST /tasks` (`isolation: "none"`, a tmp `workdir`) + `POST /tasks/:id/backlog` is enough, so the new spec needs no fake agent run except (possibly) the archived case's fallback.
- **This worktree has no `node_modules`** (verified). Execution must run `bun install` before typecheck/e2e; if the Playwright browser cache is empty, `bunx playwright install chromium`.
- **Current state**: branch `feature/agetor-collapse-expand-messages-backlog`, HEAD `46dbe0f4` (`docs(plans): record grill decisions…`); the only working-tree changes are the untracked planning docs (`messages-backlog-collapse-investigation.md` and this plan). The grill commit is docs-only. The anchors above were re-read at this SHA with `grep -n`/`sed`; the archive path was checked against `src/bun/server.ts:5548+` and `src/bun/orchestrator.ts:8958-8971`.

### Runtime and trust shape

One desktop webview (Electrobun/WKWebView) talking to a local Bun core. The tray has no privileged action beyond the existing backlog API; collapse is read-only view state. No multi-instance, leader election, crash-between-steps, or dependency-outage concern. Reverting is a code revert with no data implications.

## 3. Approach & key decisions

**Chosen shape:** local `collapsed` state in `BacklogTray`; the entire header becomes a single full-width `<button>`; the list unmounts when collapsed; collapse is blocked while a row is editing; default expanded; no persistence; the hint swaps only while collapsed. This is the smallest shape that satisfies every owner decision and adds no new state owner, API, storage key, or component primitive.

**Pinned contract (I1 must match this exactly):**

```tsx
const [collapsed, setCollapsed] = useState(false);   // default expanded
const listId = useId();                             // aria-controls target
// Block only while a live editor exists. `readOnly` mirrors BacklogItemRow's
// own `editing && !readOnly` gate, so a task archived mid-edit (stale
// `editingId`) renders the row read-only and must not strand the toggle.
const collapseBlocked = editingId !== null && !readOnly;

<div
  data-testid="backlog-tray"
  data-state={collapsed ? "collapsed" : "expanded"}
  className="shrink-0 border-t border-border/60"
>
  <button
    type="button"
    data-testid="backlog-toggle"
    onClick={() => { if (!collapseBlocked) setCollapsed((c) => !c); }}
    aria-expanded={!collapsed}
    aria-controls={listId}
    aria-disabled={collapseBlocked || undefined}
    title={collapseBlocked ? "Save or cancel your edit first" : collapsed ? "Expand backlog" : "Collapse backlog"}
    className={cn(
      "flex w-full items-center gap-1.5 px-3 pb-1 pt-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
      collapseBlocked && "cursor-not-allowed opacity-60",
    )}
  >
    <ChevronRight
      className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
      aria-hidden
    />
    <ClipboardList className="size-3.5 shrink-0" />
    <span className="shrink-0">Backlog</span>
    <span className="shrink-0 rounded bg-muted px-1 text-[10px]">{items.length}</span>
    <span className="ml-1 min-w-0 truncate font-normal text-muted-foreground/70">
      {collapseBlocked
        ? "save or cancel your edit first"
        : collapsed
          ? "saved messages — expand to review"
          : readOnly
            ? "saved messages — unarchive the task to edit or send"
            : "saved messages — send when you're ready"}
    </span>
  </button>

  {!collapsed && (
    <div
      id={listId}
      data-testid="backlog-list"
      className={cn(
        "space-y-1 overflow-y-auto px-2 pb-2",
        editingId !== null ? "max-h-72" : "max-h-40",
      )}
    >
      {items.map(/* existing BacklogItemRow tree, untouched */)}
    </div>
  )}
</div>
```

Add `useId` to the React import and `ChevronRight` to the lucide-react import in `RunPanel.tsx`. Keep `BacklogItemRow` and every handler byte-for-byte unchanged.

**Decisions and alternatives:**

- **D1 — Session-only local state** (owner round-1 `#persistence`, overriding the recommendation). Rejected: global `localStorage` via `panel-collapse.ts` (would add a key, require a `CLAUDE.md:175` update, and contradict the owner); per-task keys (unbounded cleanup). The accepted cost is that the tray resets on task switch/panel close; round-2 `#empty-tray-state` accepts the empty-tray reset too.
- **D2 — Unmount the list when collapsed** (owner grill assumption). Rejected: keep it mounted with `hidden`. Because collapse is blocked while a live editor exists, there is no row-local draft to preserve, and unmounting avoids both the render cost and the hidden-`@`-popover `data-popover-open` Escape trap (`RunPanel.tsx:544,2258`; `AtFileAutocomplete.tsx:369`).
- **D3 — Block collapse while editing** (owner round-1 `#edit-conflict`). Rejected: close/discard the editor (silent data loss); keep it mounted-hidden (D2's trap). Enforcement is one guard on the only writer of `collapsed`, `editingId !== null && !readOnly`: `readOnly` is excluded because a stale `editingId` after an external archive has no live editor — `BacklogItemRow` already renders `editing && !readOnly` as view-mode (`RunPanel.tsx:5116-5119`), so blocking on the stale id would strand the toggle forever.
- **D4 — Whole header is one `<button>`** (owner round-1 `#interaction`), with the chevron leading, `aria-expanded` + `aria-controls`, and `data-testid`s. Rejected: a tiny chevron-only button (small hit target); a clickable `div` (invalid semantics); nesting a button inside the header (invalid HTML).
- **D5 — `aria-disabled` rather than native `disabled` while editing.** The control stays focusable and the `title`/hint can explain why; the handler is the real guard. Native `disabled` would remove it from the tab order and suppress hover help. This is an implementation detail inside D3, not a product change.
- **D6 — Hint precedence: blocked > collapsed > readOnly > normal.** A collapsed archived tray shows the expand hint (there is something hidden to reveal); expanding restores the archived read-only hint, matching decisions 7 and 11.
- **D7 — No height animation**, per owner round-1 `#interaction`; only the chevron rotates.
- **D8 — No new primitive, no config, no backend.** The repo has no Collapsible primitive and the house pattern is hand-rolled (`docs/plans/pr-diff-collapsible-sticky-headers.md:28,34`). Collapse is chrome, so it stays out of the preferences API and out of `task.backlog`.

Evidence vs reasoning: C1–C7 and D1–D7 rest on the owner's grill answers; the layout claims (C4, D2) rest on the verified flex structure at `RunPanel.tsx:4465,5003,571-576`; the test-layer claim rests on `bunfig.toml` and the absence of a DOM harness.

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | Add the collapse/expand disclosure to `BacklogTray` and document its contract | `src/mainview/components/kanban/RunPanel.tsx`; `docs/architecture/messages-backlog.md` | — | C1–C8, pinned contract above; `bun run typecheck` green; `bun test` green; diff limited to the tray header/list wrapper + imports + doc | `state`, `tests` | Existing call site `RunPanelBody` at `RunPanel.tsx:4583-4604`; no registration/config step |

**I1 acceptance detail (self-checkable without T1):**

1. Open a task with ≥1 saved draft. `backlog-tray` has `data-state="expanded"`, `backlog-toggle` has `aria-expanded="true"` and an `aria-controls` equal to `backlog-list`'s `id`, `backlog-list` is present, the draft text is visible, and the count equals `items.length`.
2. Click the toggle. `data-state="collapsed"`, `aria-expanded="false"`, `backlog-list` is absent from the DOM, the icon/label/count are still visible, the hint is exactly `saved messages — expand to review`, and the chevron points right. Click again: the list and drafts return; `max-h-40` is the resting class.
3. Click a row's Edit button. The header shows `save or cancel your edit first`, the toggle has `aria-disabled="true"`, and clicking it does not unmount the list; the editor keeps its typed value. Cancel: the toggle is no longer `aria-disabled`; it collapses again. The editing list still uses `max-h-72`.
4. On an archived task (`readOnly`), the toggle is still rendered; expanded shows `saved messages — unarchive the task to edit or send`; collapsed shows the expand hint. No Edit/Delete/Send/Move buttons are added. If the task is archived while a row is editing, the row falls back to read-only and the toggle is not blocked (`collapseBlocked` excludes `readOnly`).
5. A one-item tray still shows the toggle. A subagent tab and an empty backlog still hide the whole tray (existing gate, untouched).
6. Switching tasks or closing/reopening the panel returns the tray to expanded; removing the last draft and saving a new one returns it to expanded. (No persistence code anywhere.)
7. `grep` the diff: no `localStorage`, no `panel-collapse.ts`, no `task.backlog`/API/DB/type changes, no new `RunPanelBody` state, no key change to `backlog-${task.id}`.
8. At the 420 px minimum panel width, the header's icon/label/count/chevron plus the truncated hint stay on one line (the hint uses `min-w-0 truncate`).
9. The `BacklogTray` doc comment (`RunPanel.tsx:4961-4966`, currently "Manages only which item is currently in inline-edit mode") is updated to say it owns the inline-edit selection **and** the collapsed view state; the "purely presentational" sentence stays true (collapse is view state, like `editingId`).

The doc edit appends a paragraph to `docs/architecture/messages-backlog.md` after line 14: "**Collapsible tray.** The tray header is a disclosure `<button>` (`data-testid="backlog-toggle"`). It starts expanded; collapsing unmounts the draft list (`data-testid="backlog-list"`), keeps the icon, label and count, swaps the hint to `saved messages — expand to review`, and hands the freed height back to the transcript. Collapse is blocked while a row is inline-editing (the hint asks to save or cancel first), so no unsaved edit is discarded. The state is session-only — `BacklogTray`'s local state, reset on task switch, subagent tab, panel close, and when the tray empties (the next saved draft opens expanded). Archived tasks keep the toggle; the expanded hint stays the read-only one." That records the deliberate `CLAUDE.md:175` deviation without editing `CLAUDE.md`.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | e2e (Playwright) | I1; C1–C7; C8 regression slice | `e2e/backlog-collapse.spec.ts` (new; keep helpers local — do **not** edit `e2e/helpers.ts` or `e2e/fixtures.ts`) | Matrix below; red-proof mutations below; new spec green; targeted existing spec green |

**T1 test matrix** (all tests drive the real app: `gotoApp` + real card click + real backend):

| # | Scenario | Key assertions |
| --- | --- | --- |
| 1 | Default expanded → collapse → expand, with 8 seeded drafts | Seed eight non-numeric texts (e.g. `draft alpha` … `draft hotel`) so the count `8` assertion is unambiguous. `backlog-tray` visible, `data-state="expanded"`, `aria-expanded="true"`, `backlog-list` visible, its `id` equals the toggle's `aria-controls`, first draft visible, count `8` visible. Measure `transcript-log` and `backlog-tray` boxes. Click toggle: `data-state="collapsed"`, `aria-expanded="false"`, `backlog-list` count `0`, count `8` still visible, hint `saved messages — expand to review`. Tray shrinks >100 px; transcript grows >100 px. Click again: expanded, first draft visible, `max-h-40` resting list. |
| 2 | Blocked while inline-editing | Seed 2 drafts. Click the first row's `Edit` (`aria-label="Edit"`). Fill the editor with `edited but unsaved`. Assert the toggle has `aria-disabled="true"` and the hint `save or cancel your edit first`. Click the toggle: `data-state` stays `expanded`, `backlog-list` still present, editor still has the typed value. Click `Cancel`: `aria-disabled` gone; toggle collapses; list unmounts. |
| 3 | Session-only lifecycle + one-item toggle | Two tasks, one draft each. Open A: expanded; collapse. Use the context-menu "Open details" path (`[data-testid="task-context-menu-open"]`, copied from `e2e/task-switch-during-restore.spec.ts:205-210`) to switch to B while the panel stays open: B is expanded. Switch back to A: A is expanded (the collapse did not survive the keyed remount). Collapse A again; delete A's only draft via `DELETE /tasks/:id/backlog/:itemId`; wait for `backlog-tray` count `0`; `POST` a new draft; wait for the tray; assert `data-state="expanded"`. The one-item tray had a visible toggle throughout. |
| 4 | Archived read-only task | Create a task, seed one draft, `PATCH /tasks/:id {column:"done"}`, `POST /tasks/:id/archive`. `gotoApp`, `page.getByTitle("Filter by archive state").selectOption("archived")` (`KanbanFilters.tsx:175-184`), open the card (wait for the panel's `translate-x-0`, not a textarea — the archived footer replaces the composer). Assert the tray is visible, the expanded hint is `saved messages — unarchive the task to edit or send`, no `Edit`/`Delete` buttons exist inside the tray, the toggle is visible, clicking it collapses to the expand hint and unmounts the list, and expanding restores the read-only hint + draft. |
| 5 | Archive mid-edit → collapse → unarchive (regression) | Seed 2 drafts, open the first row's editor and type. `PATCH {column:"done"}` + `POST /tasks/:id/archive`; wait for the read-only hint and the editor to unmount, assert the toggle is not `aria-disabled`, collapse. `POST /tasks/:id/unarchive`; wait for `send-textarea` (the static archived footer is gone), assert the tray is still collapsed but the toggle is **not** `aria-disabled`, then expand successfully with the drafts visible and no resurrected editor. |

**Red proof (required before T1 is called done).** Every test must be shown failing on the assertion that targets its behavior, not on an import/compile error:

1. Check out the pre-I1 `RunPanel.tsx` (`git checkout 46dbe0f4 -- src/mainview/components/kanban/RunPanel.tsx`), run the new spec, confirm every test fails on missing `backlog-tray`/`backlog-toggle`; restore with `git checkout HEAD -- src/mainview/components/kanban/RunPanel.tsx`.
2. One-line mutation per distinct behavior, restored after each:
   - `useState(true)` → test 1 fails the default-expanded assertion.
   - Remove the `if (!collapseBlocked)` guard → test 2 fails because the editor is unmounted.
   - Remove the tray key (`backlog-${task.id}`) from the render site → test 3 fails because A stays collapsed after switching back.
   - Wrap the header button in `!readOnly` → test 4 fails because the archived toggle is absent.
   - Restore the old bare guard (`editingId !== null && !readOnly`, no reset effect) → test 5 fails with the collapsed toggle still `aria-disabled` after unarchive.
3. Restore every mutation; final `git status` must show only the intended I1/T1 files.

**E2e applicability:** applies — this is a user-visible disclosure and a height-reclaim behavior in the RunPanel; unit tests cannot observe the button/`aria-expanded`, the unmounted list, the archived variant, or the transcript growing. No new harness is needed.

**Run recipe:**

```bash
bun install
# only if the browser cache is empty:
bunx playwright install chromium

bun run typecheck
bun test

bunx playwright test e2e/backlog-collapse.spec.ts
bunx playwright test e2e/task-switch-during-restore.spec.ts -g "saved backlog draft"
```

Playwright starts the shared Vite server itself (`playwright.config.ts`'s `webServer`); each worker gets its own headless Bun backend + data dir (`e2e/fixtures.ts`), so no manual `dev` server is needed. For manual UI checks: `bun run dev:hmr` (Vite + Electrobun; API :4318, data dir `~/.agetor-dev`); save several drafts, then verify collapse/expand, the edit block, task switch, empty reset, archived mode, and the 420 px minimum width. `e2e/at-file-autocomplete.spec.ts` is serial and heavy; its tray-editor scenario is not required locally, but it must stay green in CI (the diff does not touch `BacklogItemRow`).

## 6. Execution waves

- **Wave 1 — I1** (implementation + doc). Single agent. Barrier: `bun run typecheck` green and `bun test` green; commit a checkpoint. This wave is green without the new e2e spec because no existing behavior changes.
- **Wave 2 — T1** (new spec). Depends on I1. Barrier: the red-proof sequence done, then `bunx playwright test e2e/backlog-collapse.spec.ts` green and the targeted `task-switch-during-restore` scenario green; commit a checkpoint.
- **Delivery slice:** one PR. The change is well under the ~1,500-line review threshold (one component + one doc paragraph + one spec), so no stacked PRs. The current branch `feature/agetor-collapse-expand-messages-backlog` at `46dbe0f4` is the base; `implement`/`execute-plan` may create its own branch from that SHA.

No two tasks in a wave own the same file: wave 1 owns `RunPanel.tsx` + the architecture doc; wave 2 owns only the new spec.

## 7. Invariants, runtime shape & risks

**Invariants and their single enforcement points:**

- **Collapse never discards an unsaved inline edit.** The only writer of `collapsed` is the header button; its `onClick` is a no-op when `collapseBlocked` (`editorVisible` = expanded ∧ editable ∧ the edited draft still exists), and the list is rendered only when `!collapsed`. Entering edit mode requires the list mounted, so a live editor implies `!collapsed`; a stale `editingId` (archived mid-edit or draft deleted) is cleared by the reset effect and can never arm the guard while the list is unmounted. Enforced in `BacklogTray`'s header handler/conditional (I1 + bug-fix round). Every path to collapse routes through it; there is no other setter.
- **Collapse is view-only.** No API/DB/type/config write; `task.backlog`, the backlog routes, `backlogGuard`, and the archived freeze are untouched. Enforced by the diff's file scope (I1).
- **The count is never hidden.** The count lives in the header, outside the conditional list. Enforced by the JSX structure (I1).
- **Default is expanded and state is session-only.** `useState(false)` in the keyed `BacklogTray`; no persistence. Enforced by the single mount site (I1).
- **Existing height caps survive.** The list class expression is copied unchanged into the conditional wrapper. Enforced by I1's acceptance 3 and T1 test 2.
- **No sibling-key collision.** The tray's key (`backlog-${task.id}`) is unchanged. Enforced by I1's "no key change" check and the existing `e2e/task-switch-during-restore.spec.ts:401-448` regression.

**Runtime shape:** one webview + local Bun process; no second instance, rolling deploy, background timer, or cross-process state. Collapse state exists only in one React tree and dies with it. If the webview is killed, the tray reopens expanded. No dependency can fail the feature at runtime; it is pure rendering. Revert = code revert, with no data or feature-flag cleanup.

**Blast radius:** `BacklogTray` is a local, non-exported function with one production call site (`RunPanel.tsx:4583-4604`); no other consumer. The diff touches only its header/list wrapper, two imports, and the tray's architecture doc. Existing e2e that can see the tray: `task-switch-during-restore.spec.ts` (default-expanded + sibling keys) and `at-file-autocomplete.spec.ts` (inline editor). No backend, DB, CLI, notification, pipeline, or terminal code.

**Cross-repo dependencies:** none.

## 8. Open questions / assumptions

No unratified one-way-door decisions: the grill's "One-way doors awaiting a human" is empty, and every blocking question was answered across two rounds. Proceeding on these logged assumptions:

1. **The collapsed list unmounts rather than stays hidden** (owner grill "Assumptions still open"). Safe only because collapse is blocked while a live editor exists; if a later requirement allows collapsing mid-edit, this must be revisited (D2). The guard was widened in the bug-fix round to require an actually rendered editor (`!collapsed` + item present + `!readOnly`).
2. **`aria-disabled` + a guarded handler** is used instead of native `disabled` while editing, so the control stays focusable and the title/hint explains the block (D5). If the repo prefers native `disabled`, it is a one-line change; tests assert `aria-disabled`, not `toBeDisabled()`.
3. **Collapsed hint wins over the archived read-only hint.** Collapsing an archived tray shows `saved messages — expand to review`; expanding restores `saved messages — unarchive the task to edit or send`. This follows decision 7's "swap while collapsed" plus decision 11's "the read-only hint remains when expanded" (D6).
4. **Exact copy** is `saved messages — expand to review` (em dash), per decision 7. The blocked copy is `save or cancel your edit first`, per decision 5's example.
5. **E2E height thresholds** are >100 px for both the tray shrink and the transcript growth. With 8 one-line drafts the list is capped at 160 px, so the real delta is ~168 px; the threshold leaves room for border-box/rounding without being vacuous. The transcript measurement is the primary proof of C4; the tray measurement is the cross-check.
6. **Archived e2e setup is cheap:** `PATCH {column:"done"}` is allowed on an unstarted task (the PATCH route has no run guard, `src/bun/server.ts:5548+`), and `archiveTask` gates only on `column === "done"` plus no live run (`src/bun/orchestrator.ts:8958-8971`). If that fails in practice, fall back to creating a fake-claude task and waiting for `review` before PATCH/archive (`e2e/compaction-summary.spec.ts:41-46`). This was checked by reading, not executed in planning.
7. **`aria-controls` is only present while expanded.** The list unmounts while collapsed, so pointing at its id would dangle (the repo's own `info-tip.tsx` omits `aria-controls` in exactly this case); `aria-expanded` alone describes the collapsed state. The owner's `aria-controls` decision is satisfied whenever the controlled region exists.
8. **No new unit test.** There is no DOM harness, and a boolean toggle has no pure logic worth extracting; the e2e layer is the honest coverage (`bunfig.toml`; investigation §1.6). T1 is the test task.
9. **No feature flag / rollout step.** Local UI in one component; revert is a code revert. The owner's grill has no flag decision, and the investigation §7 recommends none.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Collapse/expand disclosure in `BacklogTray` | In this run | I1 |
| `BacklogTray` doc comment still says "Manages only … inline-edit mode" | In this run | I1 (acceptance 9) — update it to cover `collapsed` too |
| `useState(false)` default expanded | In this run | I1 (decision 2) |
| Header becomes one full-width `<button>` with leading chevron | In this run | I1 (decision 9) |
| `aria-expanded`, `aria-controls` (only while expanded), `data-testid`s (`backlog-tray`/`backlog-toggle`/`backlog-list`/`backlog-chevron`), `data-state` | In this run | I1 (decision 9); bug-fix round made `aria-controls` conditional on the mounted list |
| List unmounted while collapsed | In this run | I1 (decision 5 + grill assumption) |
| Hint swap while collapsed (`saved messages — expand to review`) | In this run | I1 (decision 7) |
| Block collapse while a live editor exists (`editorVisible`) + explanatory hint; clear stale editor ids on archive/delete | In this run | I1 (decision 5); guard hardened in the bug-fix round (test 5) |
| Keep `max-h-40` / `max-h-72` heights | In this run | I1 (decision 8; existing expression unchanged) |
| Count always visible, including collapsed | In this run | I1 (decision 7) |
| Toggle on every non-empty tray, including one item | In this run | I1 (decision 10); T1 test 3 |
| Toggle on archived read-only tasks; read-only hint when expanded | In this run | I1 (decision 11); T1 test 4 |
| Session-only lifecycle reset (task switch / subagent / panel close) | In this run | I1 (decision 4); T1 test 3 |
| Empty-tray reset — next draft opens expanded | In this run | I1 (round-2 decision); T1 test 3, second half |
| New Playwright spec | In this run | T1 (decision 14) |
| `docs/architecture/messages-backlog.md` update | In this run | I1 (decision 14) |
| Existing `e2e/task-switch-during-restore.spec.ts` default-expanded expectation | No change; must stay green | Existing behavior preserved; targeted run in T1 |
| Existing `e2e/at-file-autocomplete.spec.ts` inline-editor coverage | No change; must stay green | `BacklogItemRow` untouched; CI regression |
| `panel-collapse.ts` key / `CLAUDE.md:175` change | Not needed | Session-only persistence (decision 4) |
| Persist collapse across sessions/tasks | Out of scope | Owner decision round-1 `#persistence` (overrode recommendation) |
| Per-task collapse memory | Out of scope | Same owner decision |
| Auto-collapse above a count | Out of scope | Round-1 `#auto-threshold` = `not_applicable` (default expanded) |
| Per-message collapse / expand-all / collapse-all | Out of scope | Round-1 `#non-goals` |
| Virtualization for a very large backlog | Out of scope | Round-1 `#non-goals`; separate render-cost ticket if ever needed |
| Backend/preference sync, Settings toggle, new keyboard shortcut | Out of scope | Round-1 `#non-goals`; collapse is chrome |
| `task.backlog` data migration/backfill | None needed | No schema or task-data change |
| `docs/architecture/run-panel.md` update | No change | State stays in the already-keyed `BacklogTray`; no new `RunPanelBody` state/reset line |
| Any other caller of `BacklogTray` | None | Local non-exported function; one call site verified at `RunPanel.tsx:4583-4604` |
| Subagent-tab hiding (tray absent on background streams) | No change; existing gate | `activeStream === "main"` untouched (`RunPanel.tsx:4583`); existing subagent-tab coverage |
| Empty backlog hides the whole tray | No change; existing gate | `backlogItems.length > 0` untouched; T1 test 3 observes the tray disappear after deleting the last draft |
| Send/edit/delete/reorder handlers, `BacklogItemRow`, `backlogBusy` | No change | Diff is confined to the header/list wrapper; acceptance C8 |
| `DiffDialog` "Save to backlog" / `App.tsx` send-failed re-stash | No change | Owner decision 6: stay collapsed and update the count; existing send-failed toast remains |
| `backlogGuard` archived freeze / read-only row affordances | No change; stale edit under `readOnly` handled by the guard + reset effect | Existing contract; only the header gains a toggle. Archiving mid-edit clears `editingId`, so collapse→unarchive can never strand the toggle (bug-fix round, test 5). |
| Height animation on collapse | Out of scope | Round-1 `#interaction` (only the chevron rotates) |
| Feature flag / rollout | None | Local UI; revert is a code revert (grill assumptions; investigation §7) |
| `data-popover-open` Escape trap from a hidden editor | Not reachable | List unmounts only when no live editor exists; blocked-while-editing guard (I1) |
