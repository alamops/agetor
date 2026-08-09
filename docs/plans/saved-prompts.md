# Plan — Saved Prompts

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Source | /implement conversation (saved prompts in Settings + picker category) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/saved-prompts (fast-forwarded to origin/main @ ce9a842 before planning) |
| Base SHA | ce9a842 (clean tree at Phase 4 start; only this plan file untracked) |

## 1. Objective & success criteria

Users can manage reusable prompt snippets ("saved prompts": name + content) in the Settings modal — add, edit, delete (delete gated by a confirmation dialog) — and use them from both composers:

- The MCP · Skills · Plugins picker (`ExtensionPicker`) gains a **Saved Prompts** category in the new-task panel's prompt field and the task-details (RunPanel) message input.
- The `/` slash autocomplete also matches saved prompt names in both composers.
- Selecting a prompt **inserts its content at the caret** (preserving existing text), mirroring the existing insertion UX.
- Prompts are **global** (not per-project/workdir).

Done = typecheck green, `bun test` green including new db + endpoint tests, and the flows above work in the UI.

## 2. Context & constraints (Phase 1 findings, re-verified after fast-forward to ce9a842)

- **Settings modal (post-#157 sidebar split)**: `src/mainview/components/settings/SettingsDialog.tsx` renders a left sidebar from `SETTINGS_SECTIONS` in `src/mainview/lib/settings-dialog-view.ts` (pure, unit-tested lib: `settings-dialog-view.test.ts`). View state is the `SettingsView` union (`section` | `templates` | `editor`); the content pane switches on `view.section` (SettingsDialog.tsx:417–463). A new section = one entry in `SETTINGS_SECTIONS`, one `case` in the switch, one new section component. Peer branch `fix/light-auto-theme` is concurrently adding a Theme row inside `GeneralSection` and app-wide semantic color tokens (`--success`/`--warning`/`--info`/`--danger`) — those tokens do **not exist yet**; do not use them (Tailwind silently emits no CSS for undefined tokens). Stick to existing tokens (`text-muted-foreground`, `text-destructive`, `bg-card`, …) and avoid raw palette classes that assume a dark background.
- Persistence analog: **harnesses** — table → `db.ts` CRUD module (`export const harnesses`) → `authed()` routes in `server.ts` → `api.ts` wrappers → Settings section. Wire types live in `src/shared/types.ts`; DB insert/patch input shapes stay local to `db.ts`.
- Migrations: **highest is now `039_run_events_user_history.sql`** → new migration is **`040_saved_prompts.sql`**, registered in `src/bun/migrations/index.ts` (text import; append, never reorder).
- Confirmation: `useConfirm()` from `@/components/ui/confirm` — promise-based, `variant: "destructive"` paints confirm red and defaults focus to Cancel.
- Picker: `ExtensionPicker` (`src/mainview/components/kanban/ExtensionPicker.tsx`) — hardcoded `KINDS` const (mcp/skill/plugin) grouping a flat `extensions: AvailableExtension[]` prop; `insert()` splices `ext.insert` at the caret and restores it via `requestAnimationFrame` + `setSelectionRange`. Used at NewTaskForm.tsx:648 and RunPanel.tsx:2663.
- Slash menu: `SlashAutocomplete` — `/`-typeahead over `AvailableCommand[]`; `insert()` replaces the `/query` slice (`findActiveQuery`). Native keydown listener with `preventDefault()`; RunPanel's Enter-to-send checks `e.defaultPrevented`. Used at NewTaskForm.tsx:668 and RunPanel.tsx:2824.
- **New precedent — `MessageHistoryPicker`** (#158, `src/mainview/components/kanban/MessageHistoryPicker.tsx`): a composer dropdown that takes `onPick: (text: string) => void`; RunPanel's handler (RunPanel.tsx:2841–2854) sets the input then re-focuses and **pins the caret to the end inside `requestAnimationFrame`** — with an explicit comment that a stale caret can land inside a `/command` token and pop SlashAutocomplete. Saved-prompt insertion must preserve the same caret discipline.
- Composers: `NewTaskForm.tsx` (`prompt`/`setPrompt`/`promptRef`) and `RunPanel.tsx` (`input`/`setInput`/`sendRef`). Both pass the same `value`/`onChange`/`textareaRef` triple to the picker components — designed to stack over one textarea. RunPanel's composer trigger row already hosts ExtensionPicker + MessageHistoryPicker; disabled conditions differ per composer (`!workdir.trim()` vs `sending || backlogBusy`).
- Saved prompts are workdir/agent-independent — they do **not** ride `/agent-discovery` (keyed on agent+workdir+branch); they get their own list fetch.
- Caret-splice helpers exist in `src/mainview/lib/textarea-insert.ts` (`spliceAtSelection`, `readCaret`, `restoreCaret`).
- Tests: `bun:test` only. DB-module tests set `AGETOR_DATA_DIR` to a mkdtemp dir at module top-level then dynamically import `db.ts` (harnesses.test.ts idiom). Endpoint tests additionally set `AGETOR_API_PORT`, start the real server via `startApiServer()` and authenticate with `API_TOKEN` (backlog-endpoint.test.ts idiom). Flat `test()` calls, no `describe`. No UI/e2e harness exists anywhere in the repo.

## 3. Approach & key decisions

- **Dedicated table** `saved_prompts` (not a JSON column) — prompts are user-global; harnesses-style CRUD is the house pattern. Columns: `id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`. Ids are `crypto.randomUUID()`. List order: `created_at ASC`.
- **REST**: `GET/POST /saved-prompts`, `PATCH/DELETE /saved-prompts/:id`, all `authed()`. Validation: `name` and `content` required non-empty after trim; unknown ids → 404 `{ error }`. No usage probe on delete — nothing references a prompt by id (content is copied into the field on insert).
- **Settings UI**: a **fourth sidebar section** — add `{ id: "prompts", label: "Saved Prompts" }` to `SETTINGS_SECTIONS`, a `case "prompts"` in the content switch, and a new self-contained `SavedPromptsSection.tsx` (list + inline add/edit form: name input + content textarea; Delete via `useConfirm({ variant: "destructive" })`). Update `settings-dialog-view.test.ts` only if the added section breaks its exhaustiveness expectations (that lib's tests live with the lib, not in Phase 6).
- **Picker category**: extend `ExtensionPicker` with a `savedPrompts?: SavedPrompt[]` prop and a fourth group ("Saved Prompts", lucide `BookText`-style icon) rendered from that prop rather than widening `AvailableExtension` — the insert semantic differs (full multi-line content vs short token). Selection inserts `prompt.content` at the caret (user decision: **insert at cursor, not replace**), then restores focus/caret per the MessageHistoryPicker discipline. Group hidden when empty; search matches prompt name + content.
- **Slash menu**: extend `SlashAutocomplete` with the same `savedPrompts?: SavedPrompt[]` prop; `/query` matches prompt names, shown as a distinct group; selection replaces the `/query` slice with `prompt.content + " "` (user decision: **slash access requested**), caret pinned after the inserted content.
- **Fetch**: one `api.listSavedPrompts()` per composer mount (NewTaskForm opens per use; RunPanel remounts per task via `key={task.id}`), plus a refetch when the picker popover opens so Settings edits are picked up mid-session. No SSE/push.
- **Not in scope** (recorded non-goals): the backlog draft inline editor keeps no picker; no per-project scoping (user decision: **global**); no import/export; no template variables (plain text v1); no MessageHistoryPicker changes.

## 4. Work breakdown — implementation tasks

**Wave 1**
- **T1 — Backend vertical slice.** Files owned: `src/bun/migrations/040_saved_prompts.sql` (new), `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/server.ts`, `src/shared/types.ts`, `src/mainview/lib/api.ts`.
  Add `SavedPrompt { id, name, content, createdAt, updatedAt }` to shared types; migration + registration; `db.ts` `export const savedPrompts = { list, get, insert, update, delete }` following the harnesses module shape (row mapper, timestamps); routes with validation per §3; `api.ts` wrappers (`listSavedPrompts`, `createSavedPrompt`, `updateSavedPrompt`, `deleteSavedPrompt`).
  Acceptance: `bun run typecheck` green; routes return full `SavedPrompt` objects.

**Wave 2** (after T1 — both depend on `SavedPrompt` + api wrappers; disjoint files)
- **T2 — Settings UI.** Files owned: `src/mainview/components/settings/SavedPromptsSection.tsx` (new), `src/mainview/components/settings/SettingsDialog.tsx` (sidebar case + render only — no restructuring), `src/mainview/lib/settings-dialog-view.ts` (add the section entry), `src/mainview/lib/settings-dialog-view.test.ts` (keep green after the entry is added).
  Section per §3: list, add, edit, delete-with-confirm, empty state; loading/error handling consistent with sibling sections; **use only existing color tokens** (see §2 theme-peer note).
  Acceptance: typecheck green; existing settings-dialog-view tests green; add/edit/delete flows work against the running API.
- **T3 — Composer integration.** Files owned: `src/mainview/components/kanban/ExtensionPicker.tsx`, `src/mainview/components/kanban/SlashAutocomplete.tsx`, `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/prompt-picker.ts` (new pure helper: filter/match saved prompts for a query, shared by both picker components — factored out for unit testing).
  Wire `savedPrompts` through both picker components in both composers; fetch per §3; insertion per §3 with the MessageHistoryPicker caret discipline; preserve the `preventDefault()`/`defaultPrevented` Enter convention.
  Acceptance: typecheck green; category appears in both composers; picker inserts content at caret; slash matches prompt names.

## 5. Work breakdown — test tasks

E2e: **not applicable** — the repo has no UI/e2e harness (no playwright/cypress/testing-library anywhere); house convention is `bun:test` on the bun side plus unit tests for pure `src/mainview/lib/*` helpers. Recorded as a decision; no new e2e infrastructure.

**Wave T** (after Wave 2 + review fixes)
- **TT1 — Backend tests.** Files owned: `src/bun/saved-prompts.test.ts` (new), `src/bun/saved-prompts-endpoint.test.ts` (new).
  DB-module tests per harnesses.test.ts idiom (mkdtemp `AGETOR_DATA_DIR` before dynamic import; CRUD, ordering, not-found, empty name/content rejection). Endpoint tests per backlog-endpoint.test.ts idiom (real server + bearer token; 200s, 400 validation, 404 unknown id, 401 without token).
- **TT2 — UI helper tests.** Files owned: `src/mainview/lib/prompt-picker.test.ts` (new).
  Cover the query-matching helper: empty query, name match, case-insensitivity, content match (picker search), non-match — per the contract T3 gave the helper.

Run recipe (Phase 7): `export PATH="$HOME/.bun/bin:$PATH"`, then `bun run typecheck` and `bun test` from the repo root.

## 6. Execution waves

1. Wave 1: T1 (single agent).
2. Wave 2: T2 ∥ T3 (two agents, file-disjoint).
3. Phase 5 code review over the full diff.
4. Wave T: TT1 ∥ TT2 (two agents, file-disjoint).
5. Phase 7 full-suite run; Phase 8 fixes if needed.

## 7. Blast radius & risks

- `SettingsDialog.tsx` / `settings-dialog-view.ts`: peer branch `fix/light-auto-theme` edits `GeneralSection` + color classes in the same file; our edits (new sidebar entry + case) are structurally disjoint but same-file — merge order coordinated with the peer (they confirmed no restructuring).
- `RunPanel.tsx` / `NewTaskForm.tsx` are churn hotspots (#158 just rewrote composer areas); our changes are confined to picker props + one fetch effect each.
- `ExtensionPicker`/`SlashAutocomplete` are shared by both composers — a regression affects both; helper extraction + unit tests mitigate.
- Migration 040: additive `CREATE TABLE` — no rebuild, no data risk. Dev DB is `~/.agetor-dev`; tests use mkdtemp dirs.
- No security surface change: routes sit behind the existing bearer-token `authed()` gate; prompt content stays local.

## 8. Open questions / assumptions

- Name uniqueness not enforced (ids are UUIDs). Assumed acceptable for v1.
- Content is plain text; no variable/placeholder expansion in v1.
- The backlog inline draft editor intentionally keeps no picker (matches today).
- Prompt list refetches on picker open + composer mount; no live push. Assumed acceptable staleness window.
