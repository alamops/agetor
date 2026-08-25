import { AGENT_OPTIONS } from "../shared/types.ts";
import { claudeModelIdFromArg } from "./agents.ts";

/**
 * Pure parsing helpers for claude's own `/model` / `/effort` local-command
 * outcomes (see `docs/plans/model-effort-local-command-turns.md` §10). No
 * db/tmux imports on purpose — this module is unit-testable in isolation
 * and shared by the orchestrator's `applyClaudeLocalSetting`.
 */

/** Strip ANSI SGR escapes (e.g. the `ESC[1m … ESC[22m` bold wrapping claude
 *  puts around the model name in `<local-command-stdout>`). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Resolve a `/model` display name — as it appears in claude's own
 * `Set model to <name> …` stdout — to an agetor model id. Handles the
 * qualifiers claude appends inline (`(1M context)`, `(default)`, …) by
 * stripping every parenthesized segment before matching, case-insensitively,
 * against `AGENT_OPTIONS["claude-code"].models[].label`. A raw `claude-…` id
 * (shouldn't normally reach this path, but harmless if it does) passes
 * through verbatim. Returns null when nothing matches.
 */
export function claudeModelIdFromDisplayName(name: string): string | null {
  const stripped = name
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  if (/^claude-/.test(stripped)) return stripped;
  const lower = stripped.toLowerCase();
  for (const opt of AGENT_OPTIONS["claude-code"].models) {
    if (opt.label.toLowerCase() === lower) return opt.id;
  }
  return null;
}

/**
 * claude ids the `/effort` slash command accepts. Mirrors
 * `MODEL_EFFORT_SUPPORT["claude-code"]`/`EFFORT_OPTIONS` — `minimal` and
 * `none` are Cursor/Codex-only ids that claude's CLI never emits.
 */
const CLAUDE_EFFORT_IDS = new Set(["max", "xhigh", "high", "medium", "low"]);

/**
 * Structural twin of the driver's `LocalSettingInfo` (claude-tmux.ts). Kept
 * local rather than imported so this module stays free of the tmux driver
 * import — TypeScript's structural typing means the driver's real type
 * satisfies this one at every call site.
 */
export interface LocalSettingInfo {
  setting: "model" | "effort";
  args: string;
  stdout: string;
}

/**
 * Parse a claude `<local-command-stdout>` outcome for `/model` or `/effort`
 * into the setting it actually landed on, or null when nothing changed
 * (`Kept model as …`, bare `/effort` + Esc's `Cancelled`) or the outcome
 * can't be resolved to a known id.
 *
 * Model resolution order: an arg that matches a `CLAUDE_MODEL_FLAG` value
 * exactly (the dropdown mirror's own `/model <flag>`, or a user typing the
 * raw flag) resolves directly via `claudeModelIdFromArg`; otherwise (no arg,
 * or an alias like `sonnet`/`opus`/`default` the arg-based lookup can't
 * invert) fall back to the ANSI-stripped stdout's `Set model to <name> …`
 * display name.
 *
 * Effort resolution: prefer a non-empty arg verbatim, else parse
 * `Set effort level to <id>` from stdout; either way the id must be one of
 * claude's supported levels.
 */
export function parseClaudeLocalSetting(
  info: LocalSettingInfo,
): { model: string } | { effort: string } | null {
  const stdout = stripAnsi(info.stdout).trim();
  const args = info.args.trim();

  if (info.setting === "model") {
    if (/^Kept model as\b/.test(stdout)) return null;
    if (args) {
      const id = claudeModelIdFromArg(args);
      if (id) return { model: id };
    }
    const match = /^Set model to (.+?)(?: and saved\b|$)/.exec(stdout);
    const displayName = match?.[1];
    if (!displayName) return null;
    const id = claudeModelIdFromDisplayName(displayName);
    return id ? { model: id } : null;
  }

  // setting === "effort"
  if (/^Cancelled\b/.test(stdout)) return null;
  let candidate: string | null = null;
  if (args) {
    candidate = args;
  } else {
    const match = /^Set effort level to (\w+)/.exec(stdout);
    candidate = match?.[1] ?? null;
  }
  return candidate && CLAUDE_EFFORT_IDS.has(candidate) ? { effort: candidate } : null;
}

/**
 * Status-breadcrumb text for a setting sync landed via
 * `applyClaudeLocalSetting` — surfaced on the task's most recent run so the
 * user sees why `task.model`/`task.effort` moved without them touching the
 * dropdown.
 */
export function describeLocalSettingSync(next: { model: string } | { effort: string }): string {
  return "model" in next
    ? `model synced from claude: ${next.model}`
    : `effort synced from claude: ${next.effort}`;
}
