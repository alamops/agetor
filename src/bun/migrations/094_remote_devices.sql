-- Companion device registry (docs/specs/remote-readiness-spec.md "Device registry").
--
-- A row is only TRUSTED when `sig` verifies against the key helper's registry key and the helper has not revoked the id
-- (src/bun/remote/registry.ts); the table is a cache of signed entries, never an authority. An agent running as the user can
-- write this table, which is accepted: an unsigned or replayed row is ignored and audited, and deleting a row only revokes.
--
-- `sig` covers the canonical JSON of {id, name, platform, session_pub, approve_pub, push_pub, level, enrolled_at}: the level
-- is chosen in the native pairing window and nothing here can raise it. `status`, `app_version`, `last_seen_at` and the push
-- columns are conveniences outside the signature. Additive: an older build ignores the table.
CREATE TABLE IF NOT EXISTS remote_devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version   TEXT NOT NULL DEFAULT '',
  session_pub   BLOB NOT NULL,
  approve_pub   BLOB NOT NULL,
  push_pub      BLOB NOT NULL,
  link_secret   BLOB NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('observe', 'respond', 'operate', 'configure')),
  status        TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  enrolled_at   INTEGER NOT NULL,
  last_seen_at  INTEGER,
  push_ref      TEXT,
  push_send_key BLOB,
  push_dead     INTEGER NOT NULL DEFAULT 0 CHECK (push_dead IN (0, 1)),
  sig           BLOB NOT NULL
);
