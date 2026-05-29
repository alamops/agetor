// Each new migration: create NNN_name.sql, then add a line below.
// The file order here is the apply order — never reorder, never edit applied migrations.
import m001 from "./001_init.sql" with { type: "text" };
import m002 from "./002_worktree.sql" with { type: "text" };
import m003 from "./003_base_ref.sql" with { type: "text" };
import m004 from "./004_mode_model.sql" with { type: "text" };
import m005 from "./005_projects.sql" with { type: "text" };
import m006 from "./006_attachments.sql" with { type: "text" };
import m007 from "./007_effort.sql" with { type: "text" };
import m008 from "./008_tmux_session.sql" with { type: "text" };
import m009 from "./009_claude_session_id.sql" with { type: "text" };
import m010 from "./010_approval_rules.sql" with { type: "text" };
import m011 from "./011_preferences.sql" with { type: "text" };
import m012 from "./012_task_references.sql" with { type: "text" };
import m013 from "./013_harnesses.sql" with { type: "text" };
import m014 from "./014_harness_enabled.sql" with { type: "text" };
import m015 from "./015_default_model_effort.sql" with { type: "text" };
import m016 from "./016_disable_codex.sql" with { type: "text" };
import m017 from "./017_drop_approval_rules.sql" with { type: "text" };
import m018 from "./018_run_events_dedup.sql" with { type: "text" };
import m019 from "./019_archived_at.sql" with { type: "text" };

import type { Migration } from "../migrate.ts";

export const migrations: Migration[] = [
  { id: "001_init", sql: m001 },
  { id: "002_worktree", sql: m002 },
  { id: "003_base_ref", sql: m003 },
  { id: "004_mode_model", sql: m004 },
  { id: "005_projects", sql: m005 },
  { id: "006_attachments", sql: m006 },
  { id: "007_effort", sql: m007 },
  { id: "008_tmux_session", sql: m008 },
  { id: "009_claude_session_id", sql: m009 },
  { id: "010_approval_rules", sql: m010 },
  { id: "011_preferences", sql: m011 },
  { id: "012_task_references", sql: m012 },
  { id: "013_harnesses", sql: m013 },
  { id: "014_harness_enabled", sql: m014 },
  { id: "015_default_model_effort", sql: m015 },
  { id: "016_disable_codex", sql: m016 },
  { id: "017_drop_approval_rules", sql: m017 },
  { id: "018_run_events_dedup", sql: m018 },
  { id: "019_archived_at", sql: m019 },
];
