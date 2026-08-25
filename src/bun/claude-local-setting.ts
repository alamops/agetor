import { AGENT_OPTIONS } from "../shared/types.ts";
import { claudeModelIdFromArg } from "./agents.ts";
import type { LocalSettingInfo } from "./claude-tmux.ts";

/**
 * Pure parsing helpers for claude's own `/model` / `/effort` local-command
 * outcomes (see `docs/plans/model-effort-local-command-turns.md` §10). No
 * db/tmux runtime imports on purpose — this module is unit-testable in
 * isolation and shared by the orchestrator's `applyClaudeLocalSetting`. The
 * `LocalSettingInfo` import above is `import type`-only: it's erased at
 * compile time, so it doesn't pull the tmux driver (or anything it imports)
 * into this module's runtime graph — just its shape.
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
 * `none` are Cursor/Codex-only ids that claude's CLI never emits. `ultracode`
 * is deliberately NOT here: it's a real slider position claude offers (see
 * the spike in the plan doc) that agetor simply has no representation for —
 * see `kind: "unrepresentable"` below, which is how that case is surfaced
 * rather than silently dropped.
 */
const CLAUDE_EFFORT_IDS = new Set(["max", "xhigh", "high", "medium", "low"]);

/** A `/model` outcome that resolved to an agetor model id — either claude
 *  just set it, or claude reports it KEPT this id after a declined confirm
 *  (see `parseClaudeLocalSetting`'s `Kept model as` handling). */
export interface ClaudeLocalModelOutcome {
  kind: "model";
  id: string;
}

/** A `/effort` outcome that resolved to an agetor-tracked effort id. */
export interface ClaudeLocalEffortOutcome {
  kind: "effort";
  id: string;
}

/**
 * A `/model` or `/effort` outcome claude reported that agetor has no
 * representation for — an id/display-name outside agetor's curated model
 * list (`Opus 6`, a future release not yet added to `AGENT_OPTIONS`), or an
 * effort level agetor doesn't track (claude's own `ultracode` slider
 * position). `raw` is the exact text claude reported (display name, or
 * lowercased effort id) so the caller can surface it verbatim rather than
 * silently dropping the value the live session actually landed on.
 */
export interface ClaudeLocalUnrepresentableOutcome {
  kind: "unrepresentable";
  setting: "model" | "effort";
  raw: string;
}

/** `parseClaudeLocalSetting`'s return type: the setting claude actually
 *  landed on (`model` / `effort`), a value agetor can't store
 *  (`unrepresentable`), or `null` for a genuinely no-change outcome
 *  (`Cancelled`, a bare Esc, an unparsable line). */
export type ClaudeLocalSettingOutcome =
  | ClaudeLocalModelOutcome
  | ClaudeLocalEffortOutcome
  | ClaudeLocalUnrepresentableOutcome
  | null;

/**
 * Parse a claude `<local-command-stdout>` outcome for `/model` or `/effort`
 * into what it actually landed on. Both branches are **outcome-first**:
 * `info.args` reflects what the user (or the dropdown mirror) TYPED, not
 * necessarily what claude landed on — a mid-conversation `/effort low`
 * answered "No, go back" on the "Change effort level?" confirm must not
 * write `low` just because that's what was typed. So `stdout` — claude's own
 * report of the outcome — is checked first in both branches; `args` is only
 * ever a secondary resolver for a shape stdout can't fully disambiguate
 * (model aliases like `sonnet`/`opus`/`default` — see below), never a
 * substitute for a stdout that doesn't confirm a real change.
 *
 * Model resolution order:
 *   1. `Kept model as <name>` is a REAL outcome, not a no-op — it's what
 *      claude reports when the user declines the "Switch model?" confirm.
 *      This matters when e.g. the Task Details dropdown already wrote a new
 *      model onto the task row before the user declined in the session: the
 *      row needs correcting back to what the session actually kept. Synced
 *      exactly like a `Set model to` outcome (same display-name lookup).
 *   2. An arg that matches a `CLAUDE_MODEL_FLAG` value exactly (the dropdown
 *      mirror's own `/model <flag>`, or a user typing the raw flag) resolves
 *      directly via `claudeModelIdFromArg`.
 *   3. Otherwise (no arg, or an alias like `sonnet`/`opus`/`default` the
 *      arg-based lookup can't invert) fall back to the ANSI-stripped
 *      stdout's `Set model to <name> …` display name — read from the FIRST
 *      LINE only: claude sometimes appends further lines (a note, a
 *      caveat) after that line, and since `.` doesn't match `\n`, matching
 *      the regex against the full multi-line stdout silently fails to
 *      capture anything.
 *   A display name/id that resolves via neither `AGENT_OPTIONS` nor the
 *   `claude-…` passthrough is `{ kind: "unrepresentable" }`, not null — the
 *   value is real, agetor just can't store it.
 *
 * Effort resolution: only `Set effort level to <id>` is a real change —
 * `Cancelled`, a future `Kept effort level as …`, or any other line bails to
 * null. Given that prefix, the id is parsed from stdout first (lowercased
 * before the support check, since claude's `Set effort level to` id is
 * already lowercase but a caller-supplied `args` might not be — e.g.
 * `{ args: "HIGH", stdout: "Set effort level to high" }` must resolve to
 * `high`); `args` is consulted only if the stdout capture itself came back
 * empty. An id outside `CLAUDE_EFFORT_IDS` (`ultracode`) is
 * `{ kind: "unrepresentable" }`.
 */
export function parseClaudeLocalSetting(info: LocalSettingInfo): ClaudeLocalSettingOutcome {
  const stdout = stripAnsi(info.stdout).trim();
  const args = info.args.trim();
  const firstLine = stdout.split("\n")[0] ?? "";

  if (info.setting === "model") {
    const keptMatch = /^Kept model as (.+)$/.exec(firstLine);
    if (keptMatch) {
      const name = keptMatch[1]!.trim();
      const id = claudeModelIdFromDisplayName(name);
      return id ? { kind: "model", id } : { kind: "unrepresentable", setting: "model", raw: name };
    }
    if (args) {
      const id = claudeModelIdFromArg(args);
      if (id) return { kind: "model", id };
    }
    const match = /^Set model to (.+?)(?: and saved\b|$)/.exec(firstLine);
    const displayName = match?.[1];
    if (!displayName) return null;
    const id = claudeModelIdFromDisplayName(displayName);
    return id ? { kind: "model", id } : { kind: "unrepresentable", setting: "model", raw: displayName };
  }

  // setting === "effort"
  const match = /^Set effort level to (\w+)/.exec(stdout);
  if (!match) return null;
  const candidate = ((match[1] ?? "") || args).toLowerCase();
  if (!candidate) return null;
  return CLAUDE_EFFORT_IDS.has(candidate)
    ? { kind: "effort", id: candidate }
    : { kind: "unrepresentable", setting: "effort", raw: candidate };
}

/**
 * Status-breadcrumb text for a setting sync landed via
 * `applyClaudeLocalSetting` — surfaced on the task's most recent run so the
 * user sees why `task.model`/`task.effort` moved without them touching the
 * dropdown.
 */
export function describeLocalSettingSync(
  next: ClaudeLocalModelOutcome | ClaudeLocalEffortOutcome,
): string {
  return next.kind === "model"
    ? `model synced from claude: ${next.id}`
    : `effort synced from claude: ${next.id}`;
}

/**
 * Status-breadcrumb text for a value claude landed on that agetor has no
 * representation for. `applyClaudeLocalSetting` never writes this value to
 * the task row — the breadcrumb is the only trace of it, so the user isn't
 * left wondering why the dropdown didn't move to match what the session is
 * actually running. `current` is the task's existing value for that
 * setting (already unchanged by this outcome), formatted as-is or "unset".
 */
export function describeUnrepresentableLocalSetting(
  outcome: ClaudeLocalUnrepresentableOutcome,
  current: string | null,
): string {
  return `claude is now on "${outcome.raw}", which agetor can't store — task ${outcome.setting} left as ${current ?? "unset"}`;
}
