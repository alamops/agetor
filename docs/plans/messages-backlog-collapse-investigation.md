# Investigation — Collapse/expand the task messages backlog

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Change | Add a collapse/expand control to the task details **messages backlog** tray so a long list of saved drafts can be reduced to a compact header while reading the transcript. This brief decides the exact surface, the state lifetime, and the edge cases the plan must cover. |
| Agents | none (pipeline step forbids subagents) — inline reading, no spikes, one web lookup (WAI-ARIA APG disclosure pattern) |
| Flags | none |
| Branch | `feature/agetor-collapse-expand-messages-backlog` (clean at `a5593d16`) |
| Contract | No repo PRD. Source is the Agetor task **“Agetor: Collapse / Expand Messages Backlog on Tasks”** (id `df38cb35-4ba1-4073-8449-c6db9673d014`). Its prompt is quoted verbatim below and is the requirement of record for the plan. |

> On tasks, when we save many messages for later, the backlog can be very large and occuping a big part of the screen that would be for reading the messages stream.
>
> So, let’s add a collapse/expand feature for the backlog.

## 1. What we know

### 1.1 The surface: it is the saved-drafts tray, not the kanban column

- The only **messages backlog** UI in the webview is `BacklogTray`, rendered by `RunPanelBody` just above the composer — `src/mainview/components/kanban/RunPanel.tsx:4576-4605`.
- It is not the `backlog` kanban column (`ColumnId = "backlog"`, `src/shared/types.ts:3,264`); that column is unrelated and has no saved messages.
- The tray renders only when the main stream is active and the task has at least one saved draft:
  `activeStream === "main" && backlogItems.length > 0` — `RunPanel.tsx:4583`. It is intentionally absent on background-agent tabs and while the task has no saved drafts (`RunPanel.tsx:4576-4582`, `docs/architecture/messages-backlog.md:14`).
- Tray root: `shrink-0 border-t border-border/60` — it never shrinks, so every pixel it needs comes directly out of the transcript above it (`RunPanel.tsx:5003`).
- The transcript scroller above it is `flex-1 overflow-y-auto` — `RunPanel.tsx:4466`; the `<aside>` is a full-height flex column `h-full ... flex-col` — `RunPanel.tsx:574`. Collapsing the tray therefore hands its height straight back to the message stream, with no layout changes elsewhere.
- Current tray height is already capped:
  - header row `px-3 pb-1 pt-2 text-[11px]` — roughly 28–30 px;
  - list `max-h-40` (160 px) at rest;
  - list grows to `max-h-72` (288 px) while a row is in inline-edit mode, so the Save/Cancel row stays visible.
  - `RunPanel.tsx:5003-5022`; rationale in `docs/plans/fix-backlog-edit-save-button-clipped.md:15-36`.
  So an expanded tray is roughly 190–200 px of an 800 px panel (~24%), which matches the report that it feels like a large slice of the reading area. “Very large” is structural (the fixed 160 px cap plus header), not an unbounded list height.
- The header itself is currently a **non-interactive `div`**: Clipboard icon, “Backlog”, a count badge, and a hint (`saved messages — send when you're ready`, or the archived read-only variant) — `RunPanel.tsx:5004-5010`. There is no toggle or collapse state today.
- Each row is a read-only summary (`line-clamp-3`) with hover actions, or an inline editor (textarea + references picker + Save/Cancel) — `RunPanel.tsx:5054+`. Rows are `space-y-1`, scroll inside the capped list.

### 1.2 Data and server are already complete; this is a UI-only change

- `Task.backlog` is `BacklogMessage[]`, documented at `src/shared/types.ts:1813-1815`; the item shape `{ id, text, references, createdAt }` is at `src/shared/types.ts:2250-2262`.
- Persisted as a JSON column on `tasks`, migration 025: `src/bun/migrations/025_task_backlog.sql:1-5`; parsed/sanitized on read at `src/bun/db.ts:196-214,1016`.
- The server module is pure list transforms over `tasks.update` — `src/bun/db.ts:1718-1780` (`add`, `updateItem`, `remove`, `reorder`).
- Routes are `POST|PUT /tasks/:id/backlog` and `PATCH|DELETE /tasks/:id/backlog/:itemId` — `src/bun/server.ts:7426-7508`; every mutation returns the full updated `Task`, and archived tasks are frozen by `backlogGuard` (`src/bun/server.ts:645-658`).
- The webview has matching calls in `src/mainview/lib/api.ts:1836-1857`.
- No migration, API contract, type, or CLI change is needed. Collapse/expand is pure view chrome; `task.backlog` is untouched.

### 1.3 State and lifecycle constraints in the RunPanel

- `backlogItems` is seeded from `task.backlog` and re-synced on every poll, while mutations update it optimistically from the response — `RunPanel.tsx:2850-2854`; `saveForLater` at `:3416`, `sendBacklogItem` at `:3455`, `editBacklogItem` at `:3522`, `removeBacklogItem` at `:3542`, `moveBacklogItem` at `:3565`.
- `BacklogTray` is a **keyed child**: its key is `backlog-${task.id}` — `RunPanel.tsx:4584-4593`. `RunPanelBody` itself is one long-lived instance across task switches (`docs/architecture/run-panel.md:1-6`), so the key is what resets the tray's local state (`editingId`) between tasks. Any collapse state held inside `BacklogTray` will therefore reset on a task switch, a subagent-tab switch (tray unmounts), and a panel close/reopen (the body unmounts after the exit animation).
- The `[task.id]` reset effect in `RunPanelBody` deliberately does not touch tray-local state; it relies on the key (`RunPanel.tsx:1039-1041`).
- The 2 s task poll rebuilds `task.backlog` into fresh objects on every tick. `BacklogItemRow`'s edit effect intentionally depends only on `[editing]`, not on `item.text`/`item.references`, so it cannot clobber an in-progress edit (`RunPanel.tsx:5099-5115`). Any new effect (e.g. auto-expand) must not reintroduce an array-identity dependency.
- `BacklogTray` is intentionally “purely presentational — all mutations are handed back to RunPanelBody” — `RunPanel.tsx:4963-4966`. It still owns the inline-edit selection locally today.

### 1.4 Existing collapse idioms and the applicable house rules

- **House style for a collapsible block** is a hand-rolled `useState<boolean>` plus a full-width `<button>` carrying `aria-expanded` and a `ChevronDown`/`ChevronRight` (`size-3.5`); there is no Collapsible/Accordion primitive and one should not be added — `docs/plans/pr-diff-collapsible-sticky-headers.md:28,34`. That plan also chose **default expanded** and **no persistence** for PR diff files (`:67,70`).
- `RunsList` uses the same button + `aria-expanded` + `▲/▼` disclosure idea — `RunPanel.tsx:5453-5525`.
- `TerminalsSection` uses native `<details>/<summary>`; its body stays mounted while collapsed — `RunPanel.tsx:5619-5680`.
- `CompactionSummaryBlock` uses a `ChevronRight` rotated 90° and `aria-expanded`; its body is not mounted while closed — `src/mainview/components/kanban/CompactionSummaryBlock.tsx:39-56`.
- **Layout chrome collapse state is persisted in `localStorage`, not the server preferences API** — `CLAUDE.md:175`. The helper is `src/mainview/lib/panel-collapse.ts` (`agetor:*` key, read/write wrapped, lazy `useState` read so the first paint is correct). `NewTaskForm` is the existing user: `NewTaskForm.tsx:155-163`. Anything that affects a task or the agent belongs in `api.setPreference`, but this is chrome.
- `docs/architecture/messages-backlog.md:9,11,13-14` documents the tray's send/edit/delete/reorder behavior, the composer/send decoupling, and the archived/subagent visibility rules that must survive this change.
- WAI-ARIA APG’s disclosure pattern: the button is the disclosure control, `aria-expanded` reflects visibility, `aria-controls` is optional; Enter/Space activation is native to a button. Use a real `<button>`, not a clickable `div`.

### 1.5 Contract, standards, runtime and trust shape

- **Contract:** outside the repo — quoted task prompt above. The implementation plan should treat this brief as the repo-visible requirement. No external ticket text exists.
- **Standards that apply:** `CLAUDE.md:175` (localStorage chrome), `docs/architecture/run-panel.md:6` (keyed per-task state), `docs/architecture/messages-backlog.md` (tray contract), `docs/plans/pr-diff-collapsible-sticky-headers.md:28,34,67,70` (collapse style/default), `docs/plans/fix-backlog-edit-save-button-clipped.md:15-36` (the 160/288 px heights are intentional), and `CLAUDE.md:170` (semantic tokens only).
- **Runtime & trust shape:** one desktop webview (Electrobun/WKWebView) talking to a local Bun core. The tray itself has no privileged action beyond the existing backlog API; collapse is read-only view state. No multi-instance/leader/long-lived-connection concerns for this change. `localStorage` can throw under privacy/sandbox settings, so reuse the guarded helper.
- **Existing data:** none to backfill. `task.backlog` JSON stays as-is; collapse state is not task data.

### 1.6 Test and runnability picture

- `bun test` is scoped to `src/` by `bunfig.toml`; there is **no DOM/component test harness** in the repo (no jsdom/testing-library). React behavior is covered by Playwright e2e; pure logic lives in `src/mainview/lib/*.ts` with co-located `bun:test` files.
- `bunx playwright test` drives Chromium against a shared Vite server and a per-worker headless Bun backend (`playwright.config.ts`, `e2e/fixtures.ts`). Existing backlog coverage:
  - `e2e/task-switch-during-restore.spec.ts:401-435` seeds one draft via `POST /tasks/:id/backlog`, opens the task, and asserts the draft text is visible — **this pins the current default-expanded behavior**.
  - `e2e/at-file-autocomplete.spec.ts:657-702` opens the tray's inline editor and exercises the `@` popover.
  - No e2e or unit test references a collapse control, `backlog-tray`, `backlog-list`, or tray height (grep found only the component definition and comments).
- The panel can be opened for a task with no runs; the tray still renders because it is gated on `backlogItems.length`, not on a run. That makes an e2e spec seed-and-open-only, with no fake agent run needed.
- **E2E applies:** this is a user-visible disclosure and a height-reclaim behavior in the RunPanel; a unit test cannot observe the button/`aria-expanded`, the hidden list, or the transcript growing. A new Playwright spec is the right layer (plus optional unit coverage only if a pure helper is extracted).
- Current worktree has no `node_modules` installed, so no tests were run in this investigation; commands below are the documented recipe.

## 2. What we proved

| Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Is the tray height capped, or unbounded? | Capped: 160 px at rest, 288 px while editing. | `grep -n "max-h-40\|max-h-72" src/mainview/components/kanban/RunPanel.tsx` → `5015,5021`; the actual list classes are at `:5018-5022`. | repo at `a5593d16` | — |
| Is the tray header already interactive? | No. It is a `div` with an icon, label, count and hint; no state, no `aria-expanded`. | `RunPanel.tsx:5003-5010`. | same | — |
| Can a collapsed tray actually give space back to the transcript? | Yes, structurally: tray is `shrink-0`, transcript is `flex-1` in the same full-height flex column. | `RunPanel.tsx:574,4466,5003`. | same | — |
| Does any existing test pin the tray’s default visibility? | Yes — the task-switch regression asserts a seeded draft is visible without expanding anything. Default-collapsed would fail it. | `e2e/task-switch-during-restore.spec.ts:420,435`. | same | — |
| Is there any existing collapse state or test for the backlog? | No. `grep -rn "backlog-tray\|backlog-list\|Collapse backlog\|Expand backlog" src e2e` finds only the component/comment sites, no tests. | `RunPanel.tsx:4584,4967`; `e2e/task-switch-during-restore.spec.ts:406` (comment only). | same | — |
| Is there a safe persistence helper we can reuse? | Yes — `readCollapsed`/`writeCollapsed` in `panel-collapse.ts` swallow storage errors and default to expanded; its unit tests cover missing/junk/throwing storage. | `src/mainview/lib/panel-collapse.ts:38-60`; `src/mainview/lib/panel-collapse.test.ts`. | same | — |
| Would a naive toggle be caught by the current tests? | No — no test asserts tray height or collapse behavior, so the suite would stay green if the feature were wrong. New e2e coverage is required. | grep above; `bunfig.toml` scopes `bun test` away from e2e. | same | — |
| Is `BacklogTray` remounted on task switch / subagent tab / panel close? | Yes — keyed per task at `RunPanel.tsx:4593`; the tray is conditionally unmounted on non-main streams; `RunPanelBody` unmounts after the panel exit animation. Any local-only collapse state resets. | `RunPanel.tsx:4583-4593,503-510`; `docs/architecture/run-panel.md:6`. | same | — |
| Do we have a confirmed library/runtime requirement? | No new library or version dependency. The only platform behavior is `localStorage` (already used) and native `<button>` semantics. | `panel-collapse.ts`, `NewTaskForm.tsx:155-163`. | same | — |

**Spikes:** none run. Every question above is settled by source and existing tests; the only design unknowns are owner choices, listed in §4. In particular, a spike into “does collapse reclaim space” would only re-prove flexbox, and a DOM spike is not available without a test harness. The “would existing tests notice?” check was answered by reading (no coverage exists), which is sufficient to require a new e2e spec.

## 3. What we are assuming

- **“Backlog” means the saved-drafts tray in task details**, not the kanban column. This is strongly supported by the wording (“save many messages for later”) and by the only matching UI label (`RunPanel.tsx:5006`); if the owner meant something else, the entire plan changes.
- **Collapse hides the item list but keeps the header** (icon, “Backlog”, count, hint). A header-only summary is the natural, discoverable collapsed state; it also preserves the count so hidden drafts are not invisible. If the owner expects a narrow icon rail or a single-line preview instead, the layout changes.
- **Default is expanded.** This preserves current behavior and the existing e2e expectation (`e2e/task-switch-during-restore.spec.ts:435`), and it avoids hiding a draft the user just opened the task to see. If the owner wants default-collapsed or an automatic threshold, that is a small state-init change but a large UX change.
- **No backend change.** `task.backlog`, the routes, the DB and the CLI stay as they are. If collapse state were deemed task data (e.g. synced across machines), that would need a preferences/row change — not recommended by `CLAUDE.md:175`.
- **A per-task keyed tray is the right owner of the state.** The alternative is lifting it to `RunPanelBody`, which adds a reset/persistence story; only do that if auto-expand or per-task persistence is required.
- **An inline editor must not be silently discarded.** The current editor holds unsaved text in `BacklogItemRow` local state (`RunPanel.tsx:5054-5115`); conditionally unmounting the list on collapse would lose it. Keeping the list mounted but hidden, or disabling collapse while `editingId !== null`, avoids that.
- **Existing e2e can seed without a real run.** `POST /tasks` with `isolation: "none"` + `POST /tasks/:id/backlog` is enough; the tray does not require `hasOpenableRun`. This is inferred from the render gate and the existing test setup, not executed here.
- **No design-system component is needed.** The repo has no Collapsible primitive; adding one would violate the “no new primitive” convention in `docs/plans/pr-diff-collapsible-sticky-headers.md:28`.

## 4. What we must ask the owner

1. **Scope: is this the whole backlog tray, or each saved message individually?**
   The wording says “the backlog” and the complaint is about list height, so the recommended scope is the whole tray. If individual messages were meant, each row would need its own disclosure and the plan is much larger.

2. **What should the default be, and should it auto-collapse at a threshold?**
   Recommended: start expanded; remember the user’s explicit choice. If the owner wants it collapsed by default whenever there are “many” messages, define “many” (e.g. >3 or >5). Default-collapsed would break the current e2e expectation and hide a just-opened task’s drafts; auto-collapse would need a threshold and an explanation in the header.

3. **How long should the collapsed state live?**
   Options:
   - not persisted (local `useState`; resets on task switch, subagent tab, panel close, restart) — minimal, matches the PR-diff precedent;
   - persisted globally in `localStorage` (e.g. `agetor:backlogTrayCollapsed`) — one reading preference for every task, survives restarts, small code reuse via `panel-collapse.ts`;
   - persisted per task (key includes task id) — most precise, but adds unbounded keys and a cleanup question.
   Recommended: global persisted with default expanded, because the complaint is about repeatedly reclaiming reading space and the count stays visible. Confirm before the plan chooses.

4. **What happens if the tray is collapsed while a row is being edited?**
   Options:
   - disable (or `aria-disabled` + an explanatory hint) while `editingId !== null` (recommended: no data loss, no hidden-editor surprises; the copy can say “Save or cancel the edit first”);
   - keep the list mounted but `hidden` (preserves the draft, but a hidden open `@` popover leaves its `data-popover-open` marker in the DOM, which makes RunPanel’s Escape handlers yield and can make the panel unclosable until the popover is dismissed — `RunPanel.tsx:544,2258`; `AtFileAutocomplete.tsx:369`);
   - close/discard the editor on collapse (rejected: silent data loss).
   The current inline editor is the only place this matters.

5. **When a new draft is saved while the tray is collapsed, should it auto-expand?**
   Paths that add a draft:
   - “Save for later” / Enter in a non-sendable composer — `RunPanel.tsx:3416`;
   - DiffDialog’s “Save to backlog” — `DiffDialog.tsx:637-647`;
   - server-side re-stash of a withheld/failed send, surfaced by the `send-failed` global event — `App.tsx:1707`, `docs/architecture/messages-backlog.md:9`.
   Recommended: stay collapsed and let the count/hint update (plus the existing send-failed toast); auto-expanding every background re-stash would interrupt reading. If explicit “Save for later” should expand, that requires either a parent-controlled `collapsed` prop or an `expandNonce` signal; decide which paths count.

6. **Should the expanded state keep the current 160 px cap (288 px while editing), or should “expand” mean a taller view?**
   Recommended: keep the existing cap. The complaint is about giving the transcript more room, not about seeing more drafts at once; the list already scrolls. Changing the cap would risk the Save/Cancel visibility fix (`docs/plans/fix-backlog-edit-save-button-clipped.md:15-36`).

7. **Should the collapsed header retain the existing hint, or show a shorter “N saved messages · expand” summary?**
   Recommended: keep the existing hint and count, add the chevron/title; it is already short enough at the 420 px minimum panel width (header’s content is ~300 px). If the owner wants a preview of the newest draft, that is an extra design decision, not required.

8. **Should the toggle be available on an archived (read-only) task?**
   Recommended: yes — it is pure view state, and hiding the list does not mutate the frozen task; the read-only hint remains. If collapsed state is persisted globally, archived tasks inherit it; no special case needed.

## 5. Completeness inventory

- **Callers of what changes**
  - `BacklogTray` — one production call site: `RunPanel.tsx:4584-4604`. It is a local function, not exported; no other consumer.
  - `BacklogMessage` / `Task.backlog` — `src/shared/types.ts:1813-1815,2250-2262`; `src/bun/db.ts:196-214,1016,1718-1780`; `src/bun/server.ts:7426-7508`; `src/mainview/lib/api.ts:1836-1857`; `RunPanel.tsx:2850-2854,3416-3590`; `DiffDialog.tsx:637-647`; `App.tsx:1707` (send-failed backlog refresh).
  - `backlogGuard` — `src/bun/server.ts:645-658,7428,7450,7465,7499`.
  - `BacklogTray` key and per-task reset contract — `RunPanel.tsx:1039-1041,4584-4593`; `docs/architecture/run-panel.md:6`.
  - Existing e2e assumptions — `e2e/task-switch-during-restore.spec.ts:401-435`; `e2e/at-file-autocomplete.spec.ts:657-702`.
- **Entry points new code must be wired into**
  - `RunPanel` render path only (`RunPanel.tsx:4576-4605`). No route table, job registry, composition root, or config loading changes.
  - If persisted: `src/mainview/lib/panel-collapse.ts` (new key constant and doc update) and `src/mainview/lib/panel-collapse.test.ts` if a key-builder helper is added.
  - If controlled by the parent: `RunPanelBody` state near `backlogItems` (`RunPanel.tsx:2850-2854`) and the `[task.id]` reset effect (`RunPanel.tsx:956-1050`), plus the `BacklogTray` props.
- **Propagation surface**
  - Types: no change to `BacklogMessage` or `Task`.
  - Server/DB: no change; no migration.
  - API/client: no change.
  - localStorage: only if persistence is chosen; no server preference.
  - Docs: `docs/architecture/messages-backlog.md` (collapse behavior/state), `CLAUDE.md:175` if a new `panel-collapse.ts` user/key is added, and `docs/architecture/run-panel.md` only if state moves into `RunPanelBody`.
  - Tests: new Playwright spec; no unit test unless a pure helper is extracted (e.g. persistence key builder or auto-expand predicate).
- **Existing data a migration would have to backfill**
  - None. `task.backlog` is already populated; collapse state is not task data and no schema change is involved.
- **What the change would orphan**
  - Nothing. The existing `max-h-40`/`max-h-72` rules, `editingId`, `BacklogItemRow`, send/edit/delete/move handlers, `readOnly`, and the subagent-tab/empty-tray gates must all remain. If the header becomes a button, the old header `div` is replaced, not duplicated; no interactive element may be nested inside it.
- **Adjacent behavior that must stay intact**
  - `saveForLater` clears the composer draft and draft autosave (`RunPanel.tsx:3416-3445`).
  - `sendBacklogItem` consumes the item only after a successful send and refreshes on withheld/failed sends (`RunPanel.tsx:3455-3520`).
  - The archived `backlogGuard` freeze and `readOnly` rendering.
  - The tray is hidden on subagent tabs and when empty; it is not part of the transcript/search surface.
  - The 2 s poll and `reconcileById` identity behavior; do not add an effect keyed on the array object.

## 6. Runnability

- **Install:** `bun install` (dependencies are not installed in this worktree at investigation time).
- **Start locally:** `bun run dev:hmr` (Vite + Electrobun; `AGETOR_DATA_DIR=$HOME/.agetor-dev`, API port 4318) for UI work; `bun run dev` when changing `src/bun/*` (main-process changes do not HMR).
- **Unit tests:** `bun test` (root `src`, per `bunfig.toml`); single file `bun test src/mainview/lib/panel-collapse.test.ts`.
- **Typecheck:** `bun run typecheck`.
- **E2E:** `bunx playwright test` (Playwright config starts the shared Vite server; each worker gets an isolated headless backend + data dir; fake claude driver is available). Run one spec with `bunx playwright test e2e/<spec>.spec.ts`. Requires `bun install` and a Playwright Chromium install (`bunx playwright install chromium` if the cache is empty).
- **Manual check:** open a task, save several messages, click “Save for later”, then verify the tray header, count, collapse/expand, edit preservation, task switch, and archived read-only state.
- **E2E seeding recipe for the new spec:** `POST /tasks` with `{ title, prompt, isolation: "none", workdir: tmpdir() }`, then `POST /tasks/:id/backlog` once per draft, then `gotoApp` + click the task card. No run/start is needed for the tray to render.

## 7. Risks and blast radius

- **Default-collapsed changes the product and existing tests.** `e2e/task-switch-during-restore.spec.ts:435` expects a seeded draft to be visible. Default must remain expanded unless that test (and the UX) is deliberately changed.
- **Inline edit data loss.** Conditional unmount of the list loses `BacklogItemRow`'s local `draft`/`draftRefs` state. Prefer “keep list mounted but hidden” or “disable collapse while editing”; if hidden, ensure no `@` popover marker stays open behind `display:none` (`AtFileAutocomplete.tsx:369` + RunPanel’s `[data-popover-open]` Escape guards at `RunPanel.tsx:544,2258`).
- **Wrong state owner / missing reset.** Local tray state resets on task switch, subagent tab, and panel close. If the plan uses local state, that is expected; if it uses parent state, it needs a reset line or a persisted key. If it uses localStorage, it must be read lazily during first render to avoid an expanded-then-collapsed flash (`CLAUDE.md:175`).
- **2 s poll churn.** `task.backlog` is a fresh array every tick. Do not drive auto-expand or persistence effects off the array identity; use a count/createdAt/ids signature or no effect at all.
- **Accessibility regressions.** A clickable `div` or a nested button inside the header would be invalid/less usable. Use a single full-width `<button>`, `aria-expanded`, optional `aria-controls`, a real id, and keep the count visible so collapsed drafts are not invisible to screen readers or sighted users.
- **Header overflow at the 420 px minimum panel width.** The added chevron plus existing icon/label/count/hint must fit; use `min-w-0`/`truncate` on the hint rather than letting it wrap the header taller.
- **Regressing the prior “Save/Cancel clipped” fix.** Do not remove or shrink `max-h-72` while editing, and do not make the collapsed header hide the editing row unless edit state is handled.
- **Unexpected auto-expansion.** Auto-expanding on every backlog addition would make the tray pop open while the user is reading, including background `send-failed` re-stashes. Only do it for explicit save paths if the owner asks.
- **Collapse is not virtualization.** `items.map` mounts a `BacklogItemRow` for every draft today (`RunPanel.tsx:5023-5048`); keeping the list mounted-hidden preserves that render cost, while unmounting it would lose the inline edit draft. If a genuinely huge backlog has a rendering cost, that is a separate virtualization decision, not part of this collapse feature.
- **Shared file conflict risk.** `RunPanel.tsx` is huge and is touched by many features; this pipeline’s later steps should keep the change in `BacklogTray`/`panel-collapse.ts`/a new e2e spec and avoid unrelated reformatting. There is no concurrency-safe way to edit the same lines from multiple agents.
- **Blast radius:** `RunPanel.tsx` (tray only), optional `panel-collapse.ts` + test, docs, one e2e spec. No backend, DB, CLI, notifications, or terminal code.

## 8. Candidate implementation shapes (not a plan)

**A. Minimal, local state (matches the PR-diff precedent)**
- In `BacklogTray`: `const [collapsed, setCollapsed] = useState(false)` and `useId()` for the list id.
- Turn the header `div` into a full-width `<button>` with `aria-expanded={!collapsed}`, `aria-controls={listId}`, a rotating `ChevronRight`/`ChevronDown`, and a `title` that says “Collapse backlog” / “Expand backlog”. A `data-state="expanded|collapsed"` on the tray root (matching `CompactionSummaryBlock`) gives CSS/tests a stable hook.
- Keep the list mounted but visually hidden (`hidden` attribute or `hidden` class) so `editingId` and the inline draft survive; or disable the toggle while `editingId !== null`.
- Default expanded; resets on task switch/panel close. No new tests beyond a new e2e spec.

**B. Persisted global preference**
- Add `BACKLOG_TRAY_COLLAPSED_KEY = "agetor:backlogTrayCollapsed"` to `panel-collapse.ts` (and update its doc comment).
- `const [collapsed, setCollapsed] = useState(() => readCollapsed(BACKLOG_TRAY_COLLAPSED_KEY))`; persist with `writeCollapsed` in an effect.
- If explicit “Save for later” should expand: lift `collapsed` to `RunPanelBody` (or pass an `expandNonce` prop) and set it false after a successful `addBacklogItem`; decide whether DiffDialog and background re-stashes should do the same.
- Update `docs/architecture/messages-backlog.md` and `CLAUDE.md:175`; add an e2e assertion for reload/task-switch persistence.

**Test sketch for either shape**
- New `e2e/backlog-collapse.spec.ts`: create task + seed 8–12 drafts; open; assert header/count and first draft visible; click toggle; assert `aria-expanded=false`, list hidden, count still visible, tray height drops and `transcript-log` grows; click again; assert first draft visible. Add a second test for edit preservation and/or persistence only if the owner chooses those behaviors. Use `data-testid` on tray/toggle/list rather than brittle text.
- No new unit test is needed for a pure boolean toggle; if a persistence key builder or auto-expand predicate is extracted, add a co-located `bun:test`.

## 9. Resolved after implementation review

The shipped shape chose unmounting the list (not mounted-hidden) and a guarded `aria-disabled` toggle (see the plan's C2/C5 and decisions 5/9). A post-implementation review tightened two of the recommendations above:

- `aria-controls` is emitted **only while the list is mounted**; the candidate shape's unconditional `aria-controls` would point at an id that no longer exists while collapsed (same rule as `ui/info-tip.tsx`).
- The edit guard is `!collapsed && !readOnly && edited draft still present`, backed by a reset effect for stale editor ids. A bare `editingId !== null` check strands the tray (collapse while archived → unarchive → block) and can silently reopen an editor after its unsaved text was already dropped.
