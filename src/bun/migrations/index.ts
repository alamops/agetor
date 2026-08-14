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
import m034 from "./034_task_fast.sql" with { type: "text" };
import m035 from "./035_task_max_mode.sql" with { type: "text" };
// The gemini branch originally used 032/033/034; renumbered to 036/037/038 on
// merge to avoid the clash with the cursor branch's 032-035 above (same
// renumber-with-alias pattern).
import m036 from "./036_gemini_session_id.sql" with { type: "text" };
import m037 from "./037_harness_kind_gemini.sql" with { type: "text" };
import m038 from "./038_reseed_harness_builtins_2.sql" with { type: "text" };
// This branch used 035 then 036 for run_events_user_history across two
// main-merges (max-mode took 035, gemini took 036); renumbered to 039 with
// both prior ids as aliases (same renumber-with-alias pattern).
import m039 from "./039_run_events_user_history.sql" with { type: "text" };
import m040 from "./040_saved_prompts.sql" with { type: "text" };
import m041 from "./041_task_plans.sql" with { type: "text" };
import m042 from "./042_subagents_running_idx.sql" with { type: "text" };
import m043 from "./043_harness_usage.sql" with { type: "text" };
import m044 from "./044_todo_progress.sql" with { type: "text" };

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
  { id: "026_project_branch_config", sql: m026, aliases: ["024_project_branch_config"] },
  { id: "027_subagent_tool_use_id", sql: m027 },
  { id: "028_branch_source", sql: m028 },
  { id: "029_task_draft", sql: m029, aliases: ["028_task_draft"] },
  { id: "030_runs_task_id_index", sql: m030 },
  { id: "031_task_pr_url", sql: m031, aliases: ["030_task_pr_url"] },
  { id: "032_cursor_harness", sql: m032, aliases: ["024_cursor_harness"] },
  { id: "033_cursor_session_id", sql: m033, aliases: ["025_cursor_session_id"] },
  { id: "034_task_fast", sql: m034 },
  { id: "035_task_max_mode", sql: m035 },
  { id: "036_gemini_session_id", sql: m036, aliases: ["032_gemini_session_id"] },
  { id: "037_harness_kind_gemini", sql: m037, aliases: ["033_harness_kind_gemini"] },
  { id: "038_reseed_harness_builtins_2", sql: m038, aliases: ["034_reseed_harness_builtins_2"] },
  { id: "039_run_events_user_history", sql: m039, aliases: ["035_run_events_user_history", "036_run_events_user_history"] },
  { id: "040_saved_prompts", sql: m040 },
  { id: "041_task_plans", sql: m041 },
  { id: "042_subagents_running_idx", sql: m042 },
  { id: "043_harness_usage", sql: m043, aliases: ["042_harness_usage"] },
  { id: "044_todo_progress", sql: m044 },
];
