-- Codex is parked as "coming soon" until the harness is brought back online.
-- Flip the built-in codex row off so it ships disabled on every DB.
--
-- HISTORICAL NOTE (2026-06): the UI lock + server create/enable rejects that
-- originally accompanied this migration have since been REMOVED — codex is now
-- re-enabled as opt-in. It still ships disabled (this UPDATE is unchanged), but
-- the user can toggle it on in Settings and create codex aliases. There is
-- deliberately NO follow-up "force-enable" migration: opt-in means the row
-- stays off until the user flips it. Do not edit the SQL below (already
-- applied); this note only corrects the now-stale comment above it.
UPDATE harnesses SET enabled = 0, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE kind = 'codex';
