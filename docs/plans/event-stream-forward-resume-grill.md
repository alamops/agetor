# Grill — event-stream forward resume (`afterId` / `Last-Event-ID`) + `snapshot_required`

| Field | Value |
| --- | --- |
| Date | 2026-10-29 |
| Source | `docs/plans/event-stream-forward-resume-investigation.md` (its §4 *must ask* list and §3 assumptions); Agetor Companion Blueprint §03 row *Event streams*, §07 *Protocol*, §12 item 3.1 (`https://claude.ai/artifact/25cyTFUnoiRksPpD9CiiPy#readiness`) |
| Mode | interactive, answered by the owner (agetor pipeline step "Grilling", three AskUserQuestion passes) |
| Flags | none |

## Settled by evidence (not asked)

These would have been questions; the code or the investigation already answers them.

| # | Finding | Evidence |
| --- | --- | --- |
| E1 | The route's subscribe-then-replay "buffer" is **always empty** in practice. `ReadableStream.start()` runs synchronously, `runs.eventsForTask` is synchronous bun:sqlite, and every `emit` happens on the same main thread, so no event can land between `subscribe()` and the drain. No server-side dedup between the window and the buffer is needed; the existing buffer can stay as a harmless guard. | `src/bun/server.ts:8183-8238` |
| E2 | No schema change and no new index. The forward query plans as `SEARCH runs USING INDEX idx_runs_task` + `SEARCH run_events USING INDEX idx_run_events_run (run_id=? AND id>?)`, which passes the plan guard; worst case (`afterId = 0`, 75k-event task) is 16 ms warm. | investigation §2, spike `plan.ts` |
| E3 | Exactly **four** task-stream status/stderr sends are unsaved (everything else goes through `appendEvent`/`appendRunStatusLine` first), and nothing in `src/` parses their text: the `started — …` breadcrumb (`orchestrator.ts:2186`), `background agents still running (N) — holding in running` (`:3147`), `exit:N` / `cancelled (exit:N)` (`:3165`), and the spawn-rejection `cancelled` / stderr `String(err)` (`:3204`). | `grep` of every `emit({` with a status/stderr stream in `orchestrator.ts`; readers grep found none |
| E4 | `run_events.id` is a sound cursor: AUTOINCREMENT, never reused; a live task's rows are append-only; retention rewrites `data` in place without changing `id`; the only delete is task-level (cascade), which is the existing 404. | investigation §1.2 |
| E5 | Live frames can carry their id today: every save-then-send site already holds the `appendEvent` return value and drops it. | investigation §1.3 |

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Scope / clients | Which clients does this change wire? | **Server + db + shared, plus all three desktop clients**: webview `RunPanel` (resume on reconnect, reset on snapshot), `agetor logs` (no reprint on reconnect), and the TUI `useCoalescedStream`. | owner |
| D2 | Threshold | Where does `snapshot_required` trigger? | **The replay window: 800 events / 4 MB** (`EVENTS_REPLAY_LIMIT` / `EVENTS_REPLAY_MAX_BYTES`). No new constant. All-or-nothing: the gap is sent only if it is ≤ 800 rows **and** ≤ 4 MB, else snapshot. | owner |
| D3 | Snapshot delivery (SSE) | Signal then continue, or signal then close? | **Signal, then continue inline on the same connection**: the server sends the fresh window a no-cursor connect would get (default replay, honouring `?anchor`), and the client drops its local events and reloads from it. No extra round trip or connection. | owner |
| D4 | Live-only events | How does resume handle events that are never saved? | **Save all four unsaved status/stderr lines (E3)** so they become ordinary rows (replayed, resumable, shown on reopen, in `agetor logs` and history, for every run from now on). Clients also **refetch side state on reconnect** (pending interactions; kick the runs/subagents polls). `interaction`, `interaction_resolved` and `subagent` lifecycle stay live-only. | owner (pass 1 picked "Also save the status lines"; pass 2 picked "All four") |
| D5 | Cursor transport | `?afterId=` only, or also SSE `id:` + `Last-Event-ID`? | **Both.** The server writes standard SSE `id:` lines and accepts a `Last-Event-ID` request header as well as `?afterId=`. Requires `last-event-id` in CORS allow-headers (`server.ts:468-481`; it is not CORS-safelisted) and the shared parser (`src/shared/sse-parse.ts`) to stop ignoring `id:`. | owner |
| D6 | Precedence / client mechanism | What do desktop clients send on reconnect, and which wins if both arrive? | **Desktop clients track the last `id:` received and send `Last-Event-ID` on every reconnect to the same fixed URL** (EventSource semantics; `openEventStream` and `streamSse` keep their fixed URL). `?afterId=` is for an explicit first resume from a stored cursor (the future phone). **If a request carries both, `Last-Event-ID` wins**, since it is always the most recent. | owner |
| D7 | `replay_meta` shape | How is a resumed or snapshot connection described? | **Additive optional fields on the single first `replay_meta` frame** (`TaskEventsReplayMeta`): `resumedAfter: <id>` on a resume (`earliestId: null`, `hasMore: false`, both ignored by new clients so the RunPanel's MIN/OR merge never re-shows "Load earlier"); `snapshotRequired: true` on a snapshot (`earliestId`/`hasMore` describe the fresh window and **replace** the client's values). No new named frame. Old clients ignore unknown fields; a new client talking to an older core sees neither field and knows it wasn't resumed. | owner |
| D8 | `GET /runs/:id/events` | Leave, add `afterId`, or delete? | **Leave it as is.** Out of scope; recorded as a known leftover (see Completeness). | owner |
| D9 | Snapshot UX | What does the user see on `snapshot_required`? | **A notice everywhere.** RunPanel: drops its events, reloads the fresh window ("Load earlier" works from there), and shows a **muted, unsaved inline line**: "Reconnected after a long gap — showing the latest messages". `agetor logs`: one dim line ("… gap too large — skipped older events, showing the latest"), then the fresh window minus ids it already printed. TUI: resets its buffer and shows a dim notice line (see Assumptions A1). | owner |
| D10 | Acceptance | What test bar? | **Unit + integration + one Playwright e2e.** Unit/integration: db forward query (registered in `db-run-events-plans.test.ts`), the route (resume, snapshot, `id:` lines, header-over-query precedence, malformed/stale cursors, the newly saved status lines), the parser's `id:` handling, `openEventStream`, `streamSse`, `agetor logs`, the TUI hook. E2E: one spec that drops the task stream mid-turn and asserts no duplicate rows, missed events appear, a card opened during the drop shows up, and a gap over 800 triggers the reset with its notice. The drop uses an **env-gated, test-only route that closes open task streams** (same pattern as `AGETOR_TEST_BLOCK_ROUTE`); the gap uses `FAKE_CLAUDE_LONG_REPLY_PROMPT_MARKER`. | owner |
| D11 | Live frame `ts` | Do live frames carry the stored ts? | **Yes.** `appendEvent` returns `{id, ts}` (the inserted row's own values); each saved row's live frame carries the stored id and ts, so live and replayed copies match byte for byte and the ts-keyed dedupers (`event-dedup.ts`, TUI `eventKey`) stop showing duplicates. Every caller of the old `number | null` return (unread watermark in `makeChunkHandler`, imports, subagent sinks) moves together. | owner (default #1) |
| D12 | Dedup-hit sends | What happens when `appendEvent` reports the row already exists (`null`)? | **Skip the live send.** Any connected client already saw it or gets it from replay. | owner (default #2) |
| D13 | Scope boundary | Global events, mobile payloads, phone protocol? | **Task stream only.** 3.3 (global-event sequence numbers + ring buffer) and 3.4 (mobile `maxBytes`) stay separate tickets. No phone/remote protocol code now, but the resume decision lives in a **pure, DB-free helper + one db method** (like `clampWindowByBytes` / `resolveAnchoredMinId`) so the future remote router (item 2.3) reuses it without SSE. | owner (default #3) |
| D14 | Cursor semantics | Per what, and how is the gap counted? | **One cursor per task subscription**; the gap counts **all** of the task's rows after the cursor, subagent rows included (they share the task's id space). Counted in rows, never as an id difference (ids interleave across tasks). | owner (default #4) |
| D15 | Bad cursors | Stale, foreign or malformed cursors? | A cursor **greater than `sqlite_sequence.seq` for `run_events`** (another or a wiped database, e.g. after `bun run wipe:dev`) → `snapshot_required`. A **non-integer or negative** cursor → **ignored**, plain fresh connect; never a 400, because `openEventStream` retries a 400 forever (it stops only on 401/403/404). | owner (default #5) |
| D16 | Client-side guard | Do clients filter by id too? | **Yes.** Every client drops any frame whose id ≤ its cursor. This protects against an older core that ignores the cursor and replays a full window. | owner (default #6) |
| D17 | Desktop cursor lifetime | Persist desktop cursors? | **No.** Desktop clients resume only across reconnects of one live subscription. Opening or switching a task, or relaunching, still does a fresh connect. | owner (default #7) |
| D18 | Reconnect side state | What does the RunPanel refetch? | On every reconnect (each `replay_meta`), reload pending interactions (`api.listPendingInteractions`) and kick the runs/subagents polls. Subagent lifecycle stays live-only; the 2 s poll covers it. This fixes today's missed/stale card after a drop. | owner (default #8) |
| D19 | Ordering invariant | What must stay true for the cursor to be safe? | A saved row's live send stays **synchronous, right after its insert**, so send order equals id order. Documented in code and covered by a test; any future batching or queued emit must keep it. | owner (default #9) |
| D20 | Which frames get `id:` | Where do `id:` lines appear? | On **saved rows only**, both replayed and live. Never on `ping`, `replay_meta`, `interaction`, `interaction_resolved` or `subagent` frames, and **never an empty `id:`** (per the SSE spec, that resets the client's last event id). CORS allow-headers gains `last-event-id`. | owner (default #10) |
| D21 | Backfill + docs | Older runs, documentation? | **No backfill** of the newly saved status lines for existing runs. Docs updated in this change: the stale `RunEvent.id` comment (`src/shared/types.ts:5331-5336`), the `TaskEventsReplayMeta` doc, the `sse-parse.ts` module comment (`id` no longer ignored), the `event-dedup.ts` header, the `StreamEvent.dbId` doc in `RunPanel.tsx`, the route comment blocks in `server.ts`, `CLAUDE.md` item 16 and the RunPanel "Things that will trip you up" note. | owner (default #11) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Forward query in `db.ts` + pure resume/snapshot decision helper | in this change | D2, D13, D14 |
| `/tasks/:id/events`: `?afterId=`, `Last-Event-ID`, `id:` lines, `snapshot_required` inline, `replay_meta` fields | in this change | D3, D5–D7, D20 |
| CORS allow-headers `last-event-id` | in this change | D5 |
| Shared SSE parser `id:` support; `openEventStream` / `streamSse` track last id and send `Last-Event-ID` | in this change | D5, D6 |
| Every save-then-send site emits the stored `{id, ts}`: the ~25 `orchestrator.ts` sites, `appendRunStatusLine`, `makeChunkHandler`, the copilot sink, `claude-subagents.ts` (monitor, background shells, transcripts), `opencode-subagents.ts`, `claude-session-import.ts`, `opencode-session-import.ts` | in this change | D11; a site left emitting without an id would be unfinished (that frame would never advance a cursor) |
| `appendEvent` return-shape change and all its callers | in this change | D11 |
| Skip the live send on a dedup hit | in this change | D12 |
| Save the four unsaved status/stderr lines (E3) | in this change | D4 |
| RunPanel: resume, reset path on snapshot (drop events, deduper, client ids; replace earliest/hasMore), notice line, refetch interactions + kick polls on reconnect | in this change | D1, D7, D9, D18 |
| `agetor logs`: no reprint (id ≤ cursor filter), resume, dim snapshot notice | in this change | D1, D9, D16 |
| TUI `useCoalescedStream`: resume, reset + notice on snapshot | in this change | D1, D9 |
| Tests listed in D10, including the env-gated test-only stream-drop route | in this change | D10 |
| Existing tests that pin current replay contents or `appendEvent`'s return (they will see the new status rows and ids) | in this change | consequence of D4/D11; the planner must sweep `db-events-*.test.ts`, `server-events-anchor.test.ts`, `task-events.test.ts`, orchestrator tests, e2e specs that count events |
| Doc updates listed in D21 | in this change | D21 |
| `GET /runs/:id/events` (unbounded, unused) and `api.subscribeRun` | out of scope | owner chose "leave it" (D8): a different, unused stream; noted for the Companion remote-surface review |
| Global-event sequence numbers + ring buffer (blueprint 3.3) | out of scope | separate blueprint ticket (D13) |
| Mobile `maxBytes` replay option (blueprint 3.4) | out of scope | separate blueprint ticket (D13) |
| Phone/remote protocol (`task.subscribe`, `{s, c, e}` envelope, `remote-protocol.ts`) | out of scope | Track 2/3 remote work; this change only makes the decision reusable (D13) |
| Backfill of status lines for existing runs | out of scope | owner (D21): the `started` note can't be reconstructed, and older history is a fresh-open view anyway |
| Persisting `interaction` / `subagent` lifecycle events | out of scope | owner kept them live-only with refetch/poll recovery (D4, D18) |

## Assumptions still open

- **A1 — TUI notice.** D9 "Notice everywhere" is read as: the TUI also shows a dim notice line on reset (the option text listed only the RunPanel addition on top of a TUI reset). *If wrong:* the TUI resets silently; a one-line change.
- **A2 — JSONL-rebuilt splice on reset.** The RunPanel's "rebuild from session JSONL" snapshot (`rebuilt-mask.ts`) works on client-assigned ids. A snapshot reset drops local events, so it is assumed to also drop any rebuilt splice and let the existing rebuild trigger run again on its own terms. The cursor is the highest **server** id received on the stream, tracked separately from what is displayed (neither the window trim nor the rebuild moves it). *If wrong:* the planner must define how a rebuilt view survives a reset.
- **A3 — No feature flag.** The change is additive (new optional query/header, new optional meta fields, new optional `id`), so it ships without a flag. Mixed versions are covered by D7 (meta detection) and D16 (client id filter). *If wrong:* add a preference gate on the server.
- **A4 — Adding `id` to live frames breaks no test.** The investigation found no test that pins its absence, but this is unverified until the suite runs. *If wrong:* tests that `toEqual` an emitted frame gain the field.
- **A5 — Saved status lines don't disturb derived state.** They are `status`/`stderr` rows: they don't move the unread watermark (assistant only), the first-load anchor (`user` only), the pipeline handoff parse (assistant text) or retention (tool_result only). They will appear in RunPanel message search, which is fine. *If wrong:* the planner must filter them where a count or anchor reads `status` rows.
- **A6 — Snapshot window for the TUI.** The inline snapshot honours the client's own `?anchor` (the TUI keeps sending `anchor=0`), so the TUI's fresh window stays small. Per D3.
