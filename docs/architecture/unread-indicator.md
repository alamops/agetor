# Unread indicator

> Moved from `CLAUDE.md`, where this was orchestration-flow item 8. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

**Unread indicator** (colored bullet on the board card for assistant messages the user hasn't read): migration 045 adds a watermark pair on `tasks` — `last_assistant_event_id` (bumped by `tasks.noteAssistantEvent` from `makeChunkHandler` when a top-level `assistant` event is appended; subagent lines structurally never reach that handler, they append via `claude-subagents.ts`) and `last_seen_event_id` (bumped only by `tasks.markSeen` via the dedicated `POST /tasks/:id/seen` route — allowed on archived tasks, and **not** in the PATCH allow-list).
`Task.unread` is derived in `toTask` (`lastAssistant > lastSeen`, NULLs read as caught-up so migrated DBs start all-read); `run_events.id` being globally monotonic is what makes the comparison race-free.
`runs.appendEvent` returns the inserted event id — `null` on the `(run_id, line_uuid)` dedup path, so reattach replay can never re-flag a task.
Two deliberate omissions are load-bearing: the generic `tasks.update` SET clause skips both watermark columns (unrelated task edits can't clobber read state), and neither `markSeen` nor `noteAssistantEvent` bumps `updated_at` (a bump would change the row's JSON on every 2s poll and defeat `reconcileById`'s identity preservation, re-rendering the board while a task merely streams).
UI: `TaskCard` renders a static `bg-info` corner dot (`title="New messages"`) when `task.unread && !isOpen`; `App.tsx` marks seen on panel open *and* close and optimistically merges only the returned `unread` field into `tasks` state (never the whole Task snapshot — that would revert concurrent optimistic patches).
