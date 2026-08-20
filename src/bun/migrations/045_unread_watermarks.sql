-- Watermark pair backing the kanban board's unread-messages indicator.
-- `last_assistant_event_id` is bumped by the orchestrator's chunk handler
-- (`makeChunkHandler` -> `tasks.noteAssistantEvent`, src/bun/orchestrator.ts)
-- to the `run_events.id` of every top-level (non-subagent) assistant event —
-- a monotonic-only write, so a stale/out-of-order chunk can never move it
-- backwards. `last_seen_event_id` is bumped by `tasks.markSeen` (called from
-- `POST /tasks/:id/seen`) whenever the user opens or closes the task's run
-- panel. Both are read together by `toTask` to compute the ephemeral
-- `Task.unread` boolean (`last_assistant_event_id > (last_seen_event_id ??
-- 0)`) — never stored directly. NULL on every existing row until touched, so
-- an upgraded DB starts with every task read (no board-wide unread flash),
-- and a brand-new task starts the same way. `run_events.id` is globally
-- monotonic (AUTOINCREMENT, see 001_init.sql), which is what makes a simple
-- watermark comparison race-free instead of needing a set/clear boolean.
ALTER TABLE tasks ADD COLUMN last_assistant_event_id INTEGER;
ALTER TABLE tasks ADD COLUMN last_seen_event_id INTEGER;
