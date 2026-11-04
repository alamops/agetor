-- OpenCode server driver: sessions watched after their task let go of them
-- (docs/architecture/harness-opencode.md, "Server wake"). No alias: nothing
-- has shipped this id.
--
-- A task that is deleted, archived or switched to another harness has no card
-- left for its OpenCode sessions, but the server can still start an execution
-- on one of them (a background subagent that outlived the interrupt finishing).
-- The orchestrator keeps watching such a session for 24 h and interrupts what
-- runs there. The run rows can't name them all: a deleted task's runs are
-- gone, and the watch reads only the last run of each task. Each row names one
-- session, the harness whose server holds it and the task it belonged to, and
-- when it stops being watched. Written by `tombstoneOpencodeSessionsOfTask`
-- (src/bun/orchestrator-opencode-server.ts) through
-- `opencodeWatchTombstones.put`, which prunes expired rows and caps the table
-- in the same transaction; read at every watch refresh, so a tombstone
-- outlives a core restart. No foreign key to `tasks`: the task of a deleted
-- session is gone by design, and a row ages out like any other.
CREATE TABLE opencode_watch_tombstones (
  session_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX opencode_watch_tombstones_expires_idx ON opencode_watch_tombstones(expires_at);
