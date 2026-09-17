# Plan — First load reaches the last user message

| Field | Value |
| --- | --- |
| Date | 2026-09-17 |
| Source | Task: "load earlier messages cap is also ignoring the last user message … make sure the first load includes at least up to the last user sent message" |
| Config | AGENTS_CONFIG.yml (balanced, schema v1) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | fix/load-earlier-messages-up-to-last-user-me |
| Base SHA | 4f2624d428d647789da90a82f998554d3ed4d9fb |

## 1. Objective & success criteria

Opening a task's details must show the transcript from (at least) the user's most recent message onward, in one load, without pressing "Load earlier messages" — as long as that span fits a generous ceiling.

Done means:
- The SSE replay window (`GET /tasks/:id/events`) starts at or before the newest main-stream `user` event whenever the span from that event to the newest event is ≤ 3000 events and ≤ 16 MB. Otherwise today's window (800 events / 4 MB, floor 20) is returned unchanged.
- The auto-rebuild-from-JSONL snapshot (`GET /runs/:id/rebuild-events?limit=`) applies the same anchor + ceiling to the mapped JSONL events.
- `earliestId`/`hasMore` stay correct, so "Load earlier" still pages everything older.
- `/tasks/:id/events/page` is byte-identical to today (paging is unchanged).
- A task whose last user message already sits inside today's window returns a byte-identical window (no behavior change for the common small case).
- Unit tests pin the db helper, both routes and the ceiling fallback; a Playwright spec proves the prompt bubble is visible on first open of a task whose agent reply is longer than the 800-event cap.

## 2. Context & constraints (grounded findings)

- **Window construction** — `runs.eventsForTask(taskId, {limit, beforeId?, maxBytes?, minEvents?})` in `src/bun/db.ts` (~L1835): step 1 selects the newest `limit` ids + `LENGTH(CAST(data AS BLOB))` (DESC), `clampWindowByBytes` (pure, exported, ~L1590) raises `minId` to fit `maxBytes` keeping ≥ `minEvents`; step 2 fetches `[minId, beforeId)` ASC with `LIMIT limit`. The knowledge entry "eventsForTask SSE-replay query — ids-first two-step" (jubarteai `02d13812`) explains why it is two queries and that `beforeId` must be applied in both steps.
- **SSE replay route** — `src/bun/server.ts` ~L5894: `eventsForTask(taskId, {limit: EVENTS_REPLAY_LIMIT, maxBytes: EVENTS_REPLAY_MAX_BYTES, minEvents: MIN_REPLAY_EVENTS})`, then `earliestId = window[0].id`, `hasMore = runs.hasEventsBefore(taskId, earliestId)`, `replay_meta` frame first.
- **Page route** — `src/bun/server.ts` ~L5767 `/tasks/:id/events/page`: same helper with `beforeId` + `EVENTS_PAGE_MAX_BYTES`. Unchanged by this plan.
- **Rebuild route** — `src/bun/server.ts` ~L5361 `/runs/:id/rebuild-events`: with `?limit=` it slices the in-memory mapped `events` from the END (count cut, then `clampWindowByBytes` on `Buffer.byteLength`), reports `hasMore` when either cut removed events. The no-`limit` branch returns the complete history and must stay unbounded (third review round of `docs/plans/task-details-blank-while-session-restores.md`).
- **Client** — `RunPanel.tsx`: the auto-rebuild effect (~L1620) calls `api.rebuildRunEvents(latestRun.id, EVENTS_WINDOW_MAX)`; the SSE flush trims to `EVENTS_WINDOW_MAX` = 3000 via `eventWindowKeepCount` only when `length > max` (so a replay ≤ 3000 events is never trimmed). `replay_meta` handler takes `min(prev, earliestId)` and `hasMore` only grows. No client change is needed.
- **Constants** — `src/shared/types.ts` ~L3465–3505: `EVENTS_REPLAY_LIMIT` 800, `EVENTS_REPLAY_MAX_BYTES` 4 MB, `EVENTS_PAGE_MAX_BYTES` 2 MB, `MIN_REPLAY_EVENTS` 20, `EVENTS_WINDOW_MAX` 3000.
- **User rows** — `run_events.stream = 'user'` main-stream rows (`subagent_id IS NULL`) are the user's turns (prompt echo in `startTaskInner`, `sendInput` echoes, claude JSONL `type:"user"` text lines, plus slash-command/local-command echoes and button-generated messages). Migration 039's partial index `idx_run_events_user_history ON run_events(stream, id DESC) WHERE subagent_id IS NULL` serves the lookup, but it carries no run/task column: SQLite walks main-stream `user` rows newest-first across every task, probing `runs` by primary key until one belongs to this task (verified with EXPLAIN QUERY PLAN during review). Cheap in practice because user rows are sparse and every started task has its prompt echo, not because the seek is task-scoped — see the `lastUserEventId` comment in `db.ts`.
- **Fake driver** — `makeFakeAgent` in `src/bun/agents.ts` (~L1140–1720) is an `if / else if` chain of prompt-marker scenarios; the env-var-gated sent-files branch must stay LAST. The fake claude path never sets `claudeSessionId`, so the rebuild route can't be driven e2e — it is covered by the synthetic-JSONL unit fixture in `server-rebuild-byte-budget.test.ts` instead.
- **Test conventions** — db tests set `AGETOR_DATA_DIR` at module top level before importing `db.ts` and clean up with `rmTestDataDir`; route tests use `startServer` + `authedFetch`/`readSseFrames` (see `server-rebuild-byte-budget.test.ts`); e2e specs create tasks over the API with `isolation: "none"` and rely on `startTask`'s prompt echo (see `e2e/tagged-user-messages.spec.ts`). Run e2e with `bun node_modules/@playwright/test/cli.js test <spec>`, one Playwright run at a time.

## 3. Approach & key decisions

- **Anchor = newest main-stream `user` row** (owner: "any main-stream user row"). Resolved server-side by a new `runs.lastUserEventId(taskId, beforeId?)`.
- **All-or-nothing extension under a ceiling** (owner: "Bounded: 3000 events / 16 MB"). If the anchor is older than the default window's `minId`, the span `[anchorId, beforeId)` is counted: when it holds ≤ `EVENTS_REPLAY_ANCHOR_MAX_EVENTS` (3000 — deliberately equal to `EVENTS_WINDOW_MAX`, since the webview trims anything larger on flush) events AND ≤ `EVENTS_REPLAY_ANCHOR_MAX_BYTES` (16 MB) bytes, `minId` becomes `anchorId`; otherwise the default window stands. The span count is bounded by fetching at most `maxEvents + 1` id/len rows (DESC from the newest, `id >= anchorId`), so the check never scans an unbounded history. Partial extension (as far as the ceiling allows) was considered and dropped: the owner chose the fallback, and a partial extension still leaves the user clicking while making the initial load heavier.
- **Pure, shared decision helper** — `resolveAnchoredMinId({ minId, anchorId, spanRowsDesc, maxEvents, maxBytes })` in `db.ts` next to `clampWindowByBytes`: given the DESC `{id, len}` rows of the span (at most `maxEvents + 1` of them), returns `anchorId` when the span fits, else `minId`. The rebuild route reuses it over its in-memory events (id = array index), so both surfaces share one rule and one set of unit tests.
- **Step 2's `LIMIT`** in `eventsForTask` becomes `max(limit, anchor.maxEvents)` when an anchor option is passed — the range `[minId, beforeId)` is already exact, so the LIMIT is only a guard; leaving it at `limit` would truncate the NEWEST rows of an anchored window.
- **Paging is untouched** — each "Load earlier" click keeps its 800 / 2 MB page; the anchor is a first-load concern.
- **No client change** — `hasMore` may legitimately stay `true` after anchoring (e.g. status breadcrumbs older than the first user message); the button still appears for those, which is correct.
- **Test seam** — `FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER = "__agetor_fake_claude_long_reply__"` with an optional `:<count>` suffix (default 900, clamped 1..5000) makes the fake claude driver emit that many `assistant` chunks then `turn complete`. 900 > `EVENTS_REPLAY_LIMIT`, so pre-fix the prompt echo falls outside the replay window.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Constants `EVENTS_REPLAY_ANCHOR_MAX_EVENTS` (= `EVENTS_WINDOW_MAX`, declared after it) and `EVENTS_REPLAY_ANCHOR_MAX_BYTES` (16 MB) with doc comments | `src/shared/types.ts` | — | typecheck green; both exported |
| T2 | `runs.lastUserEventId(taskId, beforeId?)`; pure exported `resolveAnchoredMinId`; `eventsForTask` gains `anchor?: { maxEvents; maxBytes }` (anchor lookup + bounded span fetch + step-2 LIMIT rule); doc comments updated | `src/bun/db.ts` | T1 | with `anchor` and a fitting span the window starts at the anchor; over-ceiling → default window; no `anchor` → byte-identical to today |
| T3 | SSE replay passes `anchor`; rebuild `?limit=` branch anchors the in-memory window via `resolveAnchoredMinId` (last main-stream `user` event index); `hasMore` semantics preserved; page route untouched | `src/bun/server.ts` | T1, T2 | replay `earliestId` ≤ anchor id when the span fits; rebuild `hasMore` true iff events were cut |
| T4 | Fake claude long-reply scenario (`FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER`, `:<count>` suffix), placed before the env-gated sent-files branch, exported | `src/bun/agents.ts` | — | a prompt carrying the marker yields N assistant chunks then `turn complete` |
| T5 | Docs: CLAUDE.md item 16's history-payload sentence gains the anchor rule + ceiling + seam; this plan's §2 notes the outcome | `CLAUDE.md`, `docs/plans/first-load-reaches-last-user-message.md` | T1–T4 | orchestrator edits after wave 1 |

T1–T3 are one agent (one coherent change across three files that must agree on names). T4 is a sibling agent (disjoint file).

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Files |
| --- | --- | --- | --- |
| U1 | unit (db) | `resolveAnchoredMinId` (fits / count over / bytes over / anchor already inside window / no anchor); `lastUserEventId` (main-stream only, `beforeId`, none); `eventsForTask` with `anchor` (extends past both the count cap and the byte cap; step-2 LIMIT keeps the newest rows; over-ceiling falls back; no-anchor call byte-identical) | `src/bun/db-events-anchor.test.ts` (new) |
| U2 | unit (routes) | SSE replay `replay_meta.earliestId` = user event id with 900 assistant events after it, `hasMore` false when the user row is the oldest event; ceiling fallback keeps the 800/4 MB window; rebuild `?limit=` anchors a synthetic JSONL (`type:"user"` line then 900 assistant lines) and reports `hasMore` correctly; `/events/page` unchanged | `src/bun/server-events-anchor.test.ts` (new) |
| E1 | e2e | Create + start a task whose prompt carries the long-reply marker (900 chunks); open the panel; the prompt bubble is attached without clicking "Load earlier"; a control task with the marker at 5000… is NOT needed (ceiling is unit-covered). Second case: after the run settles, reopen (switch away and back) and the bubble is still on first load. | `e2e/load-earlier-anchor.spec.ts` (new) |

E2e applies: the flow is user-visible (open task → see own message) and crosses webview → API → DB. Run recipe: `bun node_modules/@playwright/test/cli.js test e2e/load-earlier-anchor.spec.ts` (fixtures boot a headless backend with the fake drivers; one Playwright run at a time). Unit: `bun test src/bun/db-events-anchor.test.ts src/bun/server-events-anchor.test.ts` plus the existing `db-events-paging`, `db-events-byte-budget`, `server-rebuild-byte-budget` files as regression.

## 6. Execution waves

- **Wave 1 (parallel):** T1+T2+T3 (agent A), T4 (agent B). Barrier: `bun run typecheck`, commit.
- **Wave 1.5 (orchestrator):** T5 docs.
- **Wave 2 (parallel):** U1+U2 (agent C), E1 (agent D). Barrier: commit.
- **Wave 3:** code review (opus) on `git diff 4f2624d...HEAD`; test run (haiku): unit + e2e.
- **Wave 4 (conditional):** fixes, re-run.

## 7. Blast radius & risks

- Callers of `eventsForTask`: SSE replay (anchored), page route (unchanged — no `anchor` passed), tests/tooling with no opts (unchanged path). CLI `agetor logs` reads the same SSE route and so also starts at the last user message — desirable.
- Larger first payload for tasks whose last user message is 800–3000 events back (up to 16 MB instead of 4 MB). Bounded by design; the 61 MB case that motivated the byte cap still falls back to the 4 MB window.
- `hasMore` can remain true after anchoring (older breadcrumbs); harmless.
- Rebuild route: the anchor is computed over mapped events; subagent events are not part of the mapped stream, so "main-stream user" = `stream === "user"` there.
- Rollback: drop the `anchor` option from the two call sites.

## 8. Open questions / assumptions

- Assumption: "last user sent message" = the newest main-stream `user` row regardless of content (owner's pick). A `<local-command-stdout>` echo can therefore be the anchor; the typed command that produced it is at most a couple of events older and is reached with one click.
- Assumption: 16 MB is an acceptable worst case for the first load (4× today's budget). Adjustable via one constant.

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Anchor the SSE replay window | in this run — T2/T3 |
| Anchor the `?limit=` auto-rebuild snapshot | in this run — T3 |
| Anchor the no-`limit` manual rebuild | out of scope — it already returns the complete history |
| Snap each "Load earlier" page to a user-message boundary | out of scope — different UX, not asked; paging stays 800 / 2 MB |
| Partial extension when the span exceeds the ceiling | out of scope — owner chose fallback to today's window |
| Raise the webview's `EVENTS_WINDOW_MAX` | out of scope — ceiling chosen to equal it |
| CLI `agetor logs` first-load parity | in this run by construction (same SSE route) — noted in T5 docs |
| CLAUDE.md / plan docs | in this run — T5 |
| Unit + e2e coverage, fake-driver seam | in this run — T4, U1, U2, E1 |
