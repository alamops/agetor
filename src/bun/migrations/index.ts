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
import m020 from "./020_task_type.sql" with { type: "text" };
import m021 from "./021_codex_session_id.sql" with { type: "text" };
import m022 from "./022_subagents.sql" with { type: "text" };
import m023 from "./023_run_origin.sql" with { type: "text" };
import m024 from "./024_reseed_harness_builtins.sql" with { type: "text" };
import m025 from "./025_task_backlog.sql" with { type: "text" };
// Appends after main's 022–025 (this branch originally used 024, renumbered on
// merge to avoid the clash with 024_reseed_harness_builtins).
import m026 from "./026_project_branch_config.sql" with { type: "text" };
import m027 from "./027_subagent_tool_use_id.sql" with { type: "text" };
import m028 from "./028_branch_source.sql" with { type: "text" };
// This branch originally used 028 for task_draft; renumbered to 029 on merge
// to avoid the clash with main's 028_branch_source (same as 026 above).
import m029 from "./029_task_draft.sql" with { type: "text" };
import m030 from "./030_runs_task_id_index.sql" with { type: "text" };
// This branch originally used 030 for task_pr_url; renumbered to 031 on merge
// to avoid the clash with main's 030_runs_task_id_index (same as 026/029 above).
import m031 from "./031_task_pr_url.sql" with { type: "text" };
// The cursor branch originally used 024/025; renumbered to 032/033 on merge to
// avoid the clash with 024_reseed_harness_builtins/025_task_backlog (same as
// 026/029/031 above).
import m032 from "./032_cursor_harness.sql" with { type: "text" };
import m033 from "./033_cursor_session_id.sql" with { type: "text" };

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
  { id: "020_task_type", sql: m020 },
  { id: "021_codex_session_id", sql: m021 },
  { id: "022_subagents", sql: m022 },
  { id: "023_run_origin", sql: m023 },
  { id: "024_reseed_harness_builtins", sql: m024 },
  { id: "025_task_backlog", sql: m025 },
  { id: "026_project_branch_config", sql: m026 },
  { id: "027_subagent_tool_use_id", sql: m027 },
  { id: "028_branch_source", sql: m028 },
  { id: "029_task_draft", sql: m029 },
  { id: "030_runs_task_id_index", sql: m030 },
  { id: "031_task_pr_url", sql: m031 },
  { id: "032_cursor_harness", sql: m032 },
  { id: "033_cursor_session_id", sql: m033 },
];
