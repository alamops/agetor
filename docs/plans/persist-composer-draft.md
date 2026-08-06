# Plan — Persist unsent composer draft in the task details modal

| Field | Value |
| --- | --- |
| Date | 2026-07-27 |
| Source | /implement — "closing the task details modal loses the unsent message text + attachments; persist until sent or removed" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/persist-task-details-unset-message |
| Base SHA | 4bf523249743f9c02676876eb50988c1864145ee (tree clean apart from this plan file) |

## 1. Objective & success criteria

Typing a message (and/or attaching references) in the task details modal's composer, then closing the modal, must not lose the draft. Reopening the task restores the exact text + references into the composer. The draft survives an app restart (owner's explicit choice). It disappears only when the user sends it, stashes it via "Save for later", or clears the composer themselves.

Success criteria:
- Type text + attach refs → close modal → reopen → composer shows the same text + refs.
- Quit agetor → relaunch → reopen task → draft still there.
- Send the message → draft gone (composer empty on next open, `task.draft` null server-side).
- "Save for later" → draft gone from composer slot (it became a backlog item).
- Manually clear the composer text + refs → draft cleared server-side (no zombie restore).
- Switching between tasks never leaks one task's draft into another's composer.
- `bun run typecheck` green; `bun test` green.

## 2. Context & constraints (Phase 1 findings)

- Composer state is `useState` inside `RunPanelBody`: `input` (RunPanel.tsx:769) and `sendRefs: TaskReference[]` (RunPanel.tsx:770). Cleared by `send()` (RunPanel.tsx:877-878) and `saveForLater()` (RunPanel.tsx:927-928).
- The modal is a hand-rolled slide-over, NOT keyed by task.id. On close, `mountedTask` lags 250ms (exit animation) then `RunPanelBody` unmounts (RunPanel.tsx:127-217) — that unmount is the data loss.
- `RunPanelBody` is a single instance across task switches (no `key`); a task-id-change effect is required for correct seeding, not just a mount initializer.
- No localStorage/sessionStorage anywhere in src/mainview. Durable persistence in this app is always Bun server + SQLite.
- Backlog precedent to mirror end-to-end: migration 025_task_backlog.sql, `parseBacklog`/`sanitizeRefs` in db.ts:88-127, `backlog` module db.ts:246-306, routes server.ts:3633-3713 with `backlogGuard` (server.ts:298-310), api client api.ts:1095-1116.
- `refs`/`backlog` are deliberately NOT in `ALLOWED_PATCH_FIELDS` (server.ts:275-277) — server-managed fields get dedicated routes. The draft follows the same pattern.
- Board polls `/tasks` every 2s; RunPanel receives refreshed `task` objects constantly. The composer must NOT reseed from `task.draft` on every refresh — only on task.id change.
- Webview tests are pure-lib only (`src/mainview/lib/*.test.ts`, bun:test); no component-mount tests. Bun-side endpoint tests exist (`backlog-endpoint.test.ts`, `backlog.test.ts`) and set `AGETOR_DATA_DIR` to a mkdtemp dir in `beforeAll`.
- Latest migration is 027; the new one is 028.

## 3. Approach & key decisions

**Server-persisted single-slot draft per task** — a nullable JSON column `tasks.draft` holding `{ text, references }`, upserted by a debounced autosave from the composer and restored on open.

Decisions:
- **Server-side, not in-memory/localStorage** — owner picked "survive app restart"; matches the app's only persistence idiom (SQLite via Bun server). Rejected: App-level Map (lost on restart), localStorage (no precedent, splits state across origins between dev/bundled).
- **Single slot per task, distinct from backlog** — the draft is "what's sitting in the composer", auto-managed and implicit; the backlog stays the explicit multi-item stash. Closing the modal does NOT auto-create backlog items (accidental Escape would pollute the tray).
- **Dedicated routes `PUT|DELETE /tasks/:id/draft`**, not the PATCH allow-list — mirrors the backlog/refs convention that server-managed JSON fields get narrow routes.
- **Draft writes are allowed on archived tasks** (unlike `backlogGuard`) — the composer stays typable on archived tasks by design (sending auto-unarchives); freezing draft writes would reintroduce exactly the data loss this feature fixes. Draft PUT/DELETE only 404s on a missing task.
- **Empty draft ⇒ NULL** — `text.trim() === "" && references.length === 0` normalizes to null at every layer (client normalize, server route, db parse). "Removed by the user" is just: they emptied the composer.
- **Debounced autosave (600ms) + flush on unmount** — protects against crash as well as close; a single save-on-unmount alone would lose drafts on a crash and complicates the 250ms-lagged teardown.
- **Send / Save-for-later clear the draft server-side** — after their existing success paths clear local state, fire `clearTaskDraft` so the draft can't resurrect on next open.

## 4. Work breakdown — implementation tasks

### Wave 1 — server contract + API client (one agent)

**T1 — Persistence + routes + client method.** Files owned (disjoint from T2):
- `src/shared/types.ts` — add `export type TaskDraft = { text: string; references: TaskReference[] }` next to `BacklogMessage`; add `draft: TaskDraft | null` to `Task`.
- `src/bun/migrations/028_task_draft.sql` — `ALTER TABLE tasks ADD COLUMN draft TEXT;` with a comment documenting the JSON shape (mirror 025's style). Register in `src/bun/migrations/index.ts` (append, never reorder).
- `src/bun/db.ts` — `parseDraft(raw): TaskDraft | null` mirroring `parseBacklog` tolerance (malformed/legacy ⇒ null; sanitize references via the existing ref sanitizer; empty text + no refs ⇒ null). Wire into `toTask`, `insert`, `update` (stringify or NULL). Add a `drafts` module: `set(taskId, draft: TaskDraft | null): Task | null` as a pure wrapper over `tasks.update`.
- `src/bun/server.ts` — `PUT /tasks/:id/draft` (body `{ text?: string; references?: unknown }`; sanitize refs server-side like the backlog routes do; normalize-empty ⇒ store null; returns full updated Task JSON) and `DELETE /tasks/:id/draft` (⇒ null; returns Task). 404 unknown task. **No archived guard** (documented above — do not reuse `backlogGuard`; write a narrow task-exists guard or inline lookup). Follow the object-style `routes` API.
- `src/mainview/lib/api.ts` — `setTaskDraft(taskId, draft: { text: string; references: TaskReference[] })` (PUT) and `clearTaskDraft(taskId)` (DELETE), both returning `Task`, mirroring `addBacklogItem`'s shape/error handling.

Acceptance: typecheck green; PUT/DELETE round-trip works against a scratch DB; `toTask` returns `draft: null` for all existing rows.

### Wave 2 — webview wiring (one agent, after Wave 1)

**T2 — Composer seed + autosave.** Files owned:
- `src/mainview/lib/draft.ts` (new) — pure helpers: `normalizeDraft(text: string, references: TaskReference[]): TaskDraft | null` (empty ⇒ null, text preserved verbatim when non-empty) and `draftsEqual(a: TaskDraft | null, b: TaskDraft | null): boolean` (order-sensitive deep compare of refs by path+isDirectory).
- `src/mainview/components/kanban/RunPanel.tsx` — in `RunPanelBody`:
  - Seed: a `seededTaskIdRef`; on first render and whenever `task.id` changes, set `input`/`sendRefs` from `task.draft` (empty when null) and set `lastSavedRef.current = task.draft ?? null`. Never reseed on mere `task` object refresh (2s poll).
  - Autosave: effect on `[input, sendRefs]` — skip until seeded; debounce 600ms; compute `normalizeDraft(input, sendRefs)`; if `draftsEqual(next, lastSavedRef.current)` skip; else call `api.setTaskDraft`/`api.clearTaskDraft` (null ⇒ clear), update `lastSavedRef` optimistically, swallow errors (draft autosave must never toast-spam; a failed save just retries on next keystroke/unmount).
  - Flush on unmount: keep `inputRef`/`sendRefsRef` mirrors; a mount-scoped effect whose cleanup cancels the pending timer and fires one final fire-and-forget save if unsaved changes exist. Also flush on `task.id` change (before reseeding — save the OLD task's draft using the old id held in the ref).
  - Clear on consume: in `send()` success path and `saveForLater()` success path, after the existing `setInput("")/setSendRefs([])`, set `lastSavedRef.current = null` and fire-and-forget `api.clearTaskDraft(task.id)`.

Acceptance: typecheck green; manual flow per §1 criteria; no reseed-on-poll regressions (typing is never overwritten by the 2s refresh).

## 5. Work breakdown — test tasks

**T3 — bun-side draft tests** (covers T1). Files owned: `src/bun/draft.test.ts` (db-level: parseDraft tolerance — malformed JSON, missing keys, bad ref shapes, empty⇒null; drafts.set round-trip; existing rows read as null) and `src/bun/draft-endpoint.test.ts` (route-level, mirroring `backlog-endpoint.test.ts`: PUT upsert returns Task with draft; PUT with empty text+refs clears to null; DELETE clears; 404 on unknown id; PUT succeeds on an archived task; refs sanitized). Use mkdtemp `AGETOR_DATA_DIR` in `beforeAll`, `isolation: "none"` tasks.

**T4 — webview lib tests** (covers T2's pure logic). File owned: `src/mainview/lib/draft.test.ts` — `normalizeDraft` (whitespace-only text ⇒ null, refs-only draft survives, text preserved verbatim) and `draftsEqual` (null/null, null/value, ref order, isDirectory differences).

T3 and T4 are file-disjoint → one wave, parallel (or one agent if grouped).

## 6. Execution waves

1. Wave 1: T1 (single agent) → checkpoint commit.
2. Wave 2: T2 (single agent) → checkpoint commit.
3. Phase 5: code review (opus) over the full diff.
4. Phase 6: T3 + T4 (parallel or grouped) → commit.
5. Phase 7: `bun test` + `bun run typecheck` (haiku background agent).
6. Phase 8: fixes if needed, re-run to green.

## 7. Blast radius & risks

- `Task` type gains a field → all `toTask` consumers and any exhaustive object literals constructing Task in tests may need the new key (bun structural typing: adding an optional-null field to returned objects is safe; test fixtures constructing full Task literals may need `draft: null`).
- Migration 028 runs on every user DB at next boot — pure additive `ALTER TABLE`, no data rewrite. Dev dogfooding hits `~/.agetor-dev` first (per project convention).
- The 2s `/tasks` poll now carries `draft` on every task — payload grows by the draft size; acceptable (same as backlog already does).
- Autosave adds a low-rate PUT stream while typing (≥600ms apart, only on change) — localhost, negligible.
- Reseed-on-poll is the main regression risk (typing overwritten every 2s) — explicitly guarded by seeding only on `task.id` change.
- Send-vs-autosave race: debounce fires after send cleared local state ⇒ normalize(null) ⇒ clear — converges to null either way.
- DiffDialog's composer has the same loss (explicit reset on close, DiffDialog.tsx:70-76) — **out of scope**, flagged as follow-up.

## 8. Open questions / assumptions

- Assumption: draft restore silently fills the composer (no "draft restored" badge/toast) — matches "persist them there".
- Assumption: AskUserQuestion custom-answer inputs and the backlog-item inline editor are out of scope (the former is interaction-scoped, the latter already server-persisted).
- Assumption: draft writes allowed on archived tasks (rationale in §3).
- Owner confirmed: survive app restart (server-persisted).
