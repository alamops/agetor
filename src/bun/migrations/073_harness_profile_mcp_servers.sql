-- Per-harness switch for fx's profile MCP servers (`Harness.profileMcpServers`):
-- when on, the fx driver sends `_meta.fx.profileMcpServers: true` on
-- `session/new` / `session/resume` / `session/load`, so a session also loads
-- the MCP servers configured in the user's fx profile. Meaningful for fx-kind
-- rows only; every other kind ignores it. Existing and new rows default to on
-- (owner decision D4); Settings, `PATCH /harnesses/:id` and
-- `agetor harness edit --no-profile-mcp` turn it off.
ALTER TABLE harnesses ADD COLUMN profile_mcp_servers INTEGER NOT NULL DEFAULT 1;
