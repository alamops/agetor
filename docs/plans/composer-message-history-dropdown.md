# Plan — Composer message-history dropdown (past sent messages across same-harness tasks)

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Source | /implement invocation: "a dropdown icon on the right side of the message input in the task details to be able to select a past sent message across tickets of same harness. Once selected, the message should be inputed in the message field, but not immediately sent" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/last-messages |
| Base SHA | 7a50d75ccb2aa8232a50c2b8f06262c3311bdc15 (tree clean at start) |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (owner not live); all assumptions logged in §8 |

## 1. Objective & success criteria

Add a dropdown trigger icon on the right side of the RunPanel composer textarea. Opening it lists past sent user messages drawn from **all tasks whose harness resolves to the same agent kind** as the current task. Picking an item **fills the composer without sending**.

Done means: new `GET /tasks/:id/messages/history` endpoint returns deduped user messages filtered by resolved agent kind; picker UI inserts text into the composer; `bun run typecheck` green; `bun test` green including new endpoint tests.

## 2. Context & constraints (Phase 1 findings)

Server side:
- `run_events(id, run_id, stream, data, ts, line_uuid, subagent_id)`; user messages are `stream='user'`, `data` = plain normalized text (no JSON envelope). Initial task prompt IS persisted as a `user` event (`orchestrator.ts:889`); follow-ups via `makeChunkHandler` (`orchestrator.ts:939-940`).
- Task↔events join: `run_events JOIN runs ON runs.id = run_events.run_id WHERE runs.task_id = ?` — template `runs.eventsForTask` (`db.ts:788-818`); `idx_runs_task` exists (migration 030).
- `tasks.agent` is a **harness id**, not a bare AgentKind — resolve via `harnesses.getByIdOrKind` (`db.ts:563-579`), which synthesizes fallback rows for legacy bare-kind ids a SQL join would miss. Filter cross-task by an IN-list of harness ids computed in JS.
- claude-code persists the same human turn **twice** (live echo without `line_uuid` + JSONL-tailer twin with one), and the twins can have **different text** (slash-command XML expansion, bare `\r` newlines). Client-side helpers `parseUserMessage`/`canonicalizeUserText` (`src/mainview/lib/command-message.ts`) already canonicalize this. codex/cursor persist exactly one row per turn.
- Route conventions: object-style `routes`, `authed()` wrapper, `corsHeaders(req)` on every response, `{ error }` + 400/401/404; closest template `/tasks/:id/events/page` (`server.ts:4330-4363`, limit clamp pattern).
- Test conventions: `db-events-paging.test.ts` — top-level `AGETOR_DATA_DIR` mkdtemp + unique `AGETOR_API_PORT`, dynamic import in `beforeAll`, `startApiServer()` + `API_TOKEN`, real `fetch` against Bun.serve, `afterEach` DELETE-from reset.

Webview side:
- Composer input row: `RunPanel.tsx` ~L2762-2849 — `relative flex-1` wrapper around `Textarea` (ref `sendRef`, value `input`) + Send `Button` sibling. Composer only renders on `activeStream === "main"` and non-archived-unsendable; textarea disabled only on `sending || backlogBusy` (typable pre-run and while `modalPending` by design).
- **No shared popover primitive.** Convention (per `search-select.tsx` L52-212 / `ExtensionPicker.tsx` L44-246): hand-rolled absolute popover, `document` mousedown outside-click close, Escape keydown close, and a **`data-popover-open` attribute on the open popover** (RunPanel's own Escape handler checks for it — without it, Escape closes the panel instead of the dropdown).
- RunPanel does **not** remount on task switch — per-task state must reset on `task.id` change (fleet memory af19c858; verified: no `key=` at call site L262-275).
- Programmatic composer set = `setInput(...)` (+ focus `sendRef`); draft autosave treats it like typing.
- `harnessKindOf` (RunPanel.tsx L80-82) maps `task.agent` → `AgentKind` client-side; `formatTime` (L169-176) for timestamps; icons: lucide-react (add `History`).
- api.ts: every call goes through `j<T>()` with Bearer token; ad-hoc response types live as local interfaces in api.ts (e.g. `TaskEventsPage`).

## 3. Approach & key decisions

- **Endpoint anchored on the reference task**: `GET /tasks/:id/messages/history?limit=N`. Server resolves the task's harness → kind, computes candidate harness ids = `[kind] ∪ {h.id | h.kind === kind}` (covers legacy bare-kind rows + custom harnesses of the same kind; falls back to exact `task.agent` match if the harness is unknown), then queries `run_events` `stream='user' AND subagent_id IS NULL AND trim(data) != ''` joined to runs+tasks with `tasks.agent IN (…)`.
- **Two-layer dedup** (decision rests on fleet knowledge 0e2ae6e0): SQL collapses byte-identical texts via `GROUP BY data` keeping `MAX(run_events.id)` (SQLite bare-column-with-single-MAX semantics); the client then CR-normalizes, runs `parseUserMessage` + strips the refs block, and dedups again on the cleaned text keeping the most recent — this is what actually kills the echo-vs-XML-twin pairs, reusing the existing pure parser rather than duplicating it Bun-side.
- **Insert = replace composer text** (`setInput(cleanText)`), focus textarea, close popover. Refs blocks are stripped and `sendRefs` untouched — past references point at other tasks' files.
- **UI**: new self-contained `MessageHistoryPicker` component (structural sibling of `ExtensionPicker`), trigger = small ghost `History` icon button absolutely positioned top-right **inside** the textarea's `relative flex-1` wrapper (textarea gains `pr-8`); popover opens upward, right-aligned, `data-popover-open`, fetches fresh on each open, rows show cleaned text (line-clamp-2) + task title + `formatTime`. Internal state (open/items) resets on `taskId` change.
- Alternatives rejected: client-side derivation from loaded events (only covers current task's loaded window, not cross-task); SQL-side kind resolution via `LEFT JOIN harnesses` (misses legacy bare-kind fallback that `getByIdOrKind` synthesizes in JS); Bun-side canonicalization (would duplicate `command-message.ts`; persisted events stay raw per prior decision 0e2ae6e0).

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| A | db query + server route | `src/bun/db.ts`, `src/bun/server.ts` | — | `runs.userMessageHistory(agentIds, limit)` returns `{id, data, ts, taskId, taskTitle}[]` newest-first, deduped, subagent/empty rows excluded; `GET /tasks/:id/messages/history` authed, 404 unknown task, limit default 50 clamp 1–200, response `{ messages }` |
| B | webview picker component + api helper | `src/mainview/components/kanban/MessageHistoryPicker.tsx` (new), `src/mainview/lib/api.ts` | — | `fetchMessageHistory(taskId, limit?)` in api.ts with local `SentMessageItem` interface; picker renders trigger + popover per conventions in §3, cleans + client-dedups items, calls `onPick(text)` |
| C | wire picker into RunPanel composer | `src/mainview/components/kanban/RunPanel.tsx` | A, B | trigger visible top-right of textarea (`pr-8` added), disabled on `sending \|\| backlogBusy`, pick fills `input` + focuses textarea, works pre-first-run and while `modalPending` |

Wave 1 = {A, B} (disjoint files). Wave 2 = {C}.

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| T1 | endpoint + query tests | `src/bun/message-history.test.ts` (new) | A: kind-matching across harness ids (bare kind + custom harness of same kind, different kind excluded), subagent/non-user/blank exclusion, exact-dup collapse keeps newest, ordering, limit clamp, 404, 401 |

**E2e: not applicable.** The webview has no DOM test harness (established repo fact; peers verify UI via `bun run dev:hmr`). Tasks B/C are verified by typecheck + Phase 5 review; a manual dev:hmr checklist is included in the final report. Run recipe for T1: `bun test src/bun/message-history.test.ts`; full suite `bun test` + `bun run typecheck`.

## 6. Execution waves

1. Wave 1: A (bun) ∥ B (webview) — disjoint.
2. Wave 2: C (RunPanel wiring).
3. Phase 5 review (opus) → Phase 6 T1 → Phase 7 run (haiku) → Phase 8 fixes if needed.

## 7. Blast radius & risks

- New route is purely additive; no schema migration needed (read-only query over existing tables).
- RunPanel composer edit risks: draft-autosave interplay (setInput flips pristine — same as typing, acceptable); Escape layering (must set `data-popover-open`); no-remount task switch (picker resets on taskId); tray-clipping gotcha does not apply (popover is absolutely positioned, not a capped tray).
- Cross-task data exposure: none — single-user local app, API already token-gated.
- Perf: review's EXPLAIN QUERY PLAN showed the original query full-scanned `run_events` (the `idx_runs_task` assumption did not hold — the plan drives from `run_events`, not `runs`). Fixed in Phase 8 with migration `035_run_events_user_history.sql` (partial covering index on `(stream, id DESC) WHERE subagent_id IS NULL`); verified the query now uses it.

## 8. Open questions / assumptions (autonomous mode — owner to audit)

1. "Same harness" interpreted as **same resolved AgentKind** (all claude-code-kind tasks share history, incl. custom harnesses of that kind) — not same exact harness id.
2. Messages from **archived** tasks are included (still useful as templates), and the current task's own messages are included.
3. Duplicate identical messages collapse to one entry, most recent occurrence shown.
4. Picking **replaces** existing composer text (standard history-picker semantics) rather than appending/splicing at caret.
5. Referenced-files blocks are stripped from inserted text; `sendRefs` untouched.
6. Default 50 items (clamp 1–200), no pagination in v1.
7. Trigger rendered whenever the composer renders (main stream, not archived-unsendable), enabled even when sending is gated — matches "composing decoupled from sending".
8. No new migration/index; both gates (grill, plan approval) bypassed under autonomous mode.
