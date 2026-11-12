-- Where each backup account's mirror last read its primary from
-- (docs/architecture/harness-stacks.md, "Mirror provenance, backups, preview
-- and Restore": "The primary's and the backup's folders are pinned").
--
-- A primary account with no config folder of its own resolves through the
-- core's process environment (CLAUDE_CONFIG_DIR / CODEX_HOME, else the home
-- default). A core started with a different environment then reads another,
-- existing folder, and every file or key missing there would read as deleted
-- on the primary. One row per backup records the primary's id, the folder(s)
-- it resolved to and a fingerprint of its own root settings (`home` and the
-- root env keys). When the same primary, with the same settings, resolves to a
-- different folder while the recorded one still exists, the mirror skips that
-- backup's whole run (nothing copied, merged or removed), warns, and keeps the
-- recorded folder.
--
-- No foreign key (085): `harnesses.delete` and account cleanup remove the row.
CREATE TABLE harness_mirror_sources (
  harness_id TEXT PRIMARY KEY,
  primary_id TEXT NOT NULL,
  primary_root TEXT NOT NULL,
  primary_config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
