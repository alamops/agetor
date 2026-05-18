-- Dedup key on run_events so we can re-read claude's JSONL on reattach (after
-- agetor restarts and finds the tmux session still alive) without producing
-- duplicate rows. The value is the JSONL line's `uuid` (claude assigns one per
-- event), captured at append time and used as an idempotency token. NULL for
-- non-JSONL events (status, stderr, user echoes from sendInput) — those only
-- ever land once during live tailing so they don't need a key.
ALTER TABLE run_events ADD COLUMN line_uuid TEXT;
CREATE UNIQUE INDEX run_events_run_line_uuid
  ON run_events(run_id, line_uuid) WHERE line_uuid IS NOT NULL;
