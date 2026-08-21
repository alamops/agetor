# Plan — Unread Colored Bullet Indicator on Task Cards

| Field | Value |
| --- | --- |
| Date | 2026-08-20 |
| Source | /implement conversation (owner grilled via AskUserQuestion, all four decisions confirmed) |
| Config | AGENTS_CONFIG.yml (balanced preset) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | feature/unread-colored-bullet-indicator (already checked out — agetor worktree) |
| Base SHA | 8a7e4b066f7eeb89856365acd86704a396ad4b8d (tree clean at Phase 4 start) |

## 1. Objective & success criteria

A small colored bullet pinned to the **top-right corner** of a kanban `TaskCard` indicating the task has **assistant messages the user hasn't read yet**.

Success criteria:
- An assistant message landing on a task whose details panel is **not** open makes the bullet appear on the board within one poll cycle (≤2s).
- Opening the task's details (RunPanel) clears it; messages streamed **while** the panel is open never show the bullet for that task, and are considered read when the panel closes.
- Tool activity, thinking, status lines, the user's own messages, and subagent-attributed events never trigger it.
- Static dot using the `--info` semantic token (theme-aware in light/dark); no animation — the amber awaiting-pulse remains the only animated attention state.
- Upgrading an existing DB does not light up the whole board (all pre-existing tasks start read).
- `bun run typecheck`, `bun test`, and the Playwright e2e suite green.

## 2. Context & constraints (Phase 1 findings)

- **Vertical-slice blueprint**: `todo_progress` (PR #182, commit `be48985`) — migration `044_todo_progress.sql`, tolerant parse in `src/bun/db.ts` (~L79, L217–239, L282, L335/362), detector inside `makeChunkHandler` (`src/bun/orchestrator.ts` ~L1131–1214, try/catch-wrapped so detection bugs never break run settlement), optional server-managed field on `Task` (`src/shared/types.ts` L820–837 — optional so hand-built test fixtures don't break), badge on `TaskCard.tsx` (L122–136), e2e spec `e2e/todo-progress.spec.ts`.
- **`run_events.id` is globally monotonic** (`001_init.sql` L23–31: `INTEGER PRIMARY KEY AUTOINCREMENT`) → a watermark comparison cleanly defines "unread" with no set/clear race.
- **Server-managed fields are excluded from `ALLOWED_PATCH_FIELDS`** (`src/bun/server.ts` ~L304); mutations to them go through narrow dedicated routes (plan-approve pattern). Mark-seen must follow that rule.
- **TaskCard** (`src/mainview/components/kanban/TaskCard.tsx`): root `<Card>` at L69–82 has **no `relative` class** — required for an absolutely-positioned corner dot. Card is `memo`'d (L232) relying on `App.tsx`'s `reconcileById` (L113) identity preservation: a changed `unread` value produces a new object from the poll, so the memoized card re-renders naturally.
- **App.tsx** knows the open task: `selected` state (L178), `selectedIdRef` idiom (L554), 2s `/tasks` poll (L310–323, armed ~L405, paused under `document.hidden`).
- **RunPanel is a single always-mounted instance** (no remount per task; effects re-key on `task.id`).
- **Boot reattach replays JSONL with `line_uuid` dedupe** — already-persisted events don't re-append, so a restart can't spuriously mark tasks unread; genuinely-new events appended during reattach *do* mark unread, which is the desired "arrived while app was closed" behavior.
- **Styling**: semantic tokens only (`bg-info`), both `:root` and `.dark` already define `--info`. Existing small-dot precedent: RunPanel's subagent "live" dot (`size-2 rounded-full bg-success`).
- **Test landscape**: no component-test harness; UI behavior is covered by Playwright e2e (`playwright.config.ts`, `e2e/fixtures.ts`/`helpers.ts`, fake drivers via `AGETOR_*_DRIVER=fake`) plus `bun test` unit files per concern in `src/bun/`.

## 3. Approach & key decisions

**Watermark pair on the `tasks` row, `unread` computed on read** (chosen over a plain `unread` boolean):

- `tasks.last_assistant_event_id INTEGER NULL` — bumped by the orchestrator's chunk handler whenever a top-level assistant event is appended.
- `tasks.last_seen_event_id INTEGER NULL` — bumped by a dedicated mark-seen route.
- `Task.unread = lastAssistantEventId != null && lastAssistantEventId > (lastSeenEventId ?? 0)` — computed in `db.ts`'s `toTask`, never stored.

Why: monotonic ids make read/unread race-free (marking seen while a chunk lands cannot "lose" the newer message — the newer id stays greater), NULL defaults mean migrated DBs start all-read, and it leaves room for a future unread *count* without schema change. A boolean column would need careful set/clear ordering to avoid exactly that race.

**Read semantics** (owner-confirmed): opening the RunPanel marks seen; closing it marks seen again (covers messages streamed while watching); while open, the board suppresses the dot for that task via an `isOpen` prop (deterministic — no 2s flash windows). Accepted micro-gap: quitting the app with the panel open leaves messages that streamed during that viewing marked unread on next boot (rare, self-heals on next open).

**Trigger scope** (owner-confirmed): only `stream === "assistant"` events **not attributed to a subagent** (no `subagent_id`). `user`, `status`, `thinking`, `tool_use`, `tool_result`, `subagent` streams never bump the watermark.

**Visual** (owner-confirmed): static `size-2.5 rounded-full bg-info` dot, absolutely positioned at the card's top-right corner (`absolute -top-1 -right-1` on a now-`relative` Card), with a `ring-2 ring-background` so it reads crisply over both themes and the card border; `title="New messages"` doubles as the e2e/a11y hook.

**Cross-task contract** (binding for both Wave-1 agents):
- `src/shared/types.ts`: `Task.unread?: boolean` — optional, server-managed, always populated by `db.ts` on read; documented like `todoProgress` (not patchable, excluded from `ALLOWED_PATCH_FIELDS`).
- Route: `POST /tasks/:id/seen` → 200 with the **full updated `Task` JSON** (same shape as the backlog routes); 404 on unknown id; allowed on archived tasks (marking seen is user-side state, not a task mutation — lets the "archived" board view clear dots).
- Webview API: `markTaskSeen(taskId: string): Promise<Task>` in `src/mainview/lib/api.ts`.

## 4. Work breakdown — implementation tasks

### Wave 1 (parallel — disjoint files)

**Task A — backend watermark + route** (owns: `src/bun/migrations/045_unread_watermarks.sql` [new], `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/server.ts`, `src/bun/orchestrator.ts`, `src/shared/types.ts`)
- Migration 045: `ALTER TABLE tasks ADD COLUMN last_assistant_event_id INTEGER;` + `ADD COLUMN last_seen_event_id INTEGER;` with the house-style doc comment; register in `migrations/index.ts` (append, no aliases).
- `db.ts`: row-type fields, read both columns in `toTask`, compute `unread` there, include columns in insert/update SQL; add `tasks.markSeen(taskId)` (sets `last_seen_event_id = max(last_assistant_event_id, last_seen_event_id)`, returns updated Task) and a `tasks.noteAssistantEvent(taskId, eventId)` (monotonic bump: only if greater than current).
- `orchestrator.ts`: in `makeChunkHandler`, alongside `maybeUpdateTodoProgress` (~L1143), after `runs.appendEvent` — if the chunk is a top-level assistant event (stream `assistant`, no subagent attribution), bump the watermark with the appended event's id (extend `appendEvent` to return the inserted row id if it doesn't already — verify; `bun:sqlite` exposes `lastInsertRowid`). Wrap in try/catch per house pattern.
- `server.ts`: `POST /tasks/:id/seen` route per the contract; do **not** add anything to `ALLOWED_PATCH_FIELDS`.
- `types.ts`: `Task.unread?: boolean` with a `todoProgress`-style doc comment.
- Acceptance: an assistant event on a task flips `unread` to true on `GET /tasks`; `POST /tasks/:id/seen` flips it back; a later assistant event flips it true again; `user`/`status`/subagent events never flip it; fresh + migrated DBs default to `unread: false`.

**Task B — board dot + mark-seen wiring** (owns: `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/App.tsx`, `src/mainview/lib/api.ts`, plus the intermediate board/column component if one sits between App and TaskCard and needs the prop threaded)
- `api.ts`: `markTaskSeen` per the contract.
- `TaskCard.tsx`: add `relative` to the root Card `cn(...)`; render the dot (spec in §3) when `task.unread && !isOpen`; new optional `isOpen?: boolean` prop (only the selected card's prop flips, so memo cost is two cards per selection change).
- `App.tsx`: effect on `selected?.id` — when it changes, `markTaskSeen` for the newly opened id and for the previously open id (close); reconcile the returned `Task` into `tasks` state immediately (optimistic clear, don't wait for the next poll); thread `isOpen` down to the rendered cards. Fire-and-forget with catch — a failed mark-seen must never break opening a task.
- Acceptance: dot renders top-right on unread cards in both themes; opening clears within one render (optimistic); no dot on the open task while messages stream; dot gone after close.

Both agents code against the §3 contract verbatim; typecheck reconciles at the wave barrier.

## 5. Work breakdown — test tasks

E2E **applies** (user-visible board flow through the real orchestrator; Playwright harness exists). Run recipe: `bun test` for unit/integration; Playwright per `playwright.config.ts` (runner agent discovers the exact script in `package.json`); fake agent drivers via `AGETOR_*_DRIVER=fake` env as in `e2e/todo-progress.spec.ts`; dev data dir isolation via `AGETOR_DATA_DIR` tempdir per existing fixtures.

### Wave T (parallel — disjoint files, after Phase 5 review)

**Task T1 — backend unit tests** (owns: `src/bun/task-unread.test.ts` [new])
- Covers Task A's acceptance list: watermark bump on assistant events only (not user/status/tool/subagent-attributed), monotonicity, `markSeen` clearing + re-flagging, `POST /tasks/:id/seen` route behavior incl. 404 and archived tasks, migrated-DB default false. Uses tempdir `AGETOR_DATA_DIR` in `beforeAll` + fake driver / direct db-module calls per existing `src/bun/*.test.ts` conventions.

**Task T2 — e2e spec** (owns: `e2e/unread-indicator.spec.ts` [new])
- Modeled on `e2e/todo-progress.spec.ts`: fake-driver task emits an assistant message → board card shows `[title="New messages"]` dot; open task details → dot clears; close → stays cleared.

## 6. Execution waves

1. **Wave 1**: Tasks A + B in parallel (`implementation` → sonnet). Barrier: `bun run typecheck` + commit.
2. **Phase 5**: code review of the wave diff (`code_review` → opus).
3. **Wave T**: T1 + T2 in parallel (`tests_creation` → sonnet). Barrier: commit.
4. **Phase 7**: one background runner (`tests_running` → haiku): typecheck + `bun test` + Playwright e2e.
5. **Phase 8**: fix loop if needed (`tests_fixes` → sonnet), re-run to green, cap 3 rounds.

## 7. Blast radius & risks

- `tasks` insert/update SQL in `db.ts` touches every task write path — the tolerant-NULL pattern and existing tests guard this; migration is additive only.
- `makeChunkHandler` runs on every chunk of every run — detector must stay cheap (stream check before any DB write) and try/catch-wrapped.
- `TaskCard` memo: `unread` rides the poll's identity change; `isOpen` prop changes identity for at most two cards per selection — negligible.
- The amber awaiting-pulse ring and the dot can coexist on one card (agent asked a question *and* has unread output) — visually compatible: ring is an outline, dot is a corner point; no z-index conflict expected but review should eyeball it.
- Rollback: revert the commits; migration is additive (columns simply go unused — the runner has no down-migrations, house style).
- Subagent event shape (whether subagent assistant text arrives as `stream: "assistant"` + `subagent_id` or as `stream: "subagent"`) must be **verified in code** by Task A, not assumed — the exclusion rule is "no subagent attribution" either way.

## 8. Open questions / assumptions

- **Assumption (accepted)**: quitting the app with a panel open can leave watched messages unread on next boot; self-heals on next open. Owner not asked — micro-edge, reversible.
- **Assumption**: single webview per daemon today; server-authoritative state makes multi-window correct anyway.
- **Assumption**: `runs.appendEvent` can return (or be trivially extended to return) the inserted event id via `lastInsertRowid`. Task A verifies.
