-- Codex is parked as "coming soon" until the harness is brought back online.
-- Flip the built-in codex row off; the UI also locks the toggle so it can't
-- be re-enabled and rejects new codex aliases at the create endpoint. Users
-- who had explicitly enabled it before this migration are no exception —
-- the rollout is intentional and re-enable will happen via a follow-up
-- migration once the harness is ready.
UPDATE harnesses SET enabled = 0, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE kind = 'codex';
