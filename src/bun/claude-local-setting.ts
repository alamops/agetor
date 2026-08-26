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

/** Strip claude's parenthesized qualifiers (`(1M context)`, `(default)`, …)
 *  from a `/model` display name and collapse the resulting whitespace, e.g.
 *  turning `"Opus 5 (1M context) (default) and saved …"` into `"Opus 5 and
 *  saved …"`. Shared by `claudeModelIdFromDisplayName` (label matching) and
 *  `parseClaudeLocalSetting` (computing the `unrepresentable` outcome's `raw`
 *  text) so both strip qualifiers identically. */
function stripModelQualifiers(name: string): string {
  return name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Resolve a `/model` display name — as it appears in claude's own
 * `Set model to <name> …` / `Kept model as <name>` stdout — to an agetor
 * model id. Qualifiers claude appends inline (`(1M context)`, `(default)`, …)
 * are stripped first (`stripModelQualifiers`); then the LONGEST
 * `AGENT_OPTIONS["claude-code"].models[].label` that the (case-insensitive)
 * remaining text STARTS WITH wins.
 *
 * This is a prefix match, not exact equality, because the text after the
 * model name varies by how `/model` was invoked and isn't fully pinned down:
 * `and saved as your default for new sessions` for the default (`d`) path,
 * but the picker's session-only (`s`) key omits that suffix in favor of
 * something like `for this session` — the exact wording was never confirmed
 * against a live session. Matching on `startsWith` makes the trailing
 * wording irrelevant to whether the model itself is recognized.
 *
 * The match additionally requires a WORD BOUNDARY right after the label
 * (finding #4, docs/plans/model-effort-local-command-turns.md §10 re-review):
 * `lower === l || lower.startsWith(l + " ")`, never a bare `lower.startsWith(l)`.
 * Without that, a longer real model name that happens to start with a
 * shorter label's characters would mismatch — `"Opus 5.1 …"` would resolve to
 * `opus-5` (the `"Opus 5"` label is a character-prefix of `"Opus 5.1"`, just
 * not a WORD-boundary one), and `"Haiku 4.5.1"` would resolve to `haiku-4.5`.
 * Requiring the label be either the whole (trimmed) string or followed by a
 * space keeps `"Opus 5 and saved …"` matching (space boundary) while making
 * `"Opus 5.1 …"` correctly fall through to `unrepresentable` — agetor's
 * curated list has no `Opus 5.1` entry, so silently rounding it down to
 * `Opus 5` would store the wrong model id.
 *
 * A raw `claude-…` id at the start of the text passes through verbatim — just
 * the leading token, not anything trailing it. This deliberately differs from
 * the label path: an id is already a valid CLI arg (house style: an unknown
 * id passes through verbatim because it's still usable as-is), whereas a
 * display name is NOT an id — an unrecognized one has no verbatim escape
 * hatch and must resolve via the label table or come back `null` (surfaced by
 * `parseClaudeLocalSetting` as `{ kind: "unrepresentable" }`, never silently
 * stored). Returns null when nothing matches.
 */
export function claudeModelIdFromDisplayName(name: string): string | null {
  const stripped = stripModelQualifiers(name);
  if (!stripped) return null;
  const claudeIdToken = /^(claude-\S+)/.exec(stripped);
  if (claudeIdToken) return claudeIdToken[1]!;
  const lower = stripped.toLowerCase();
  let matched: { id: string; label: string } | null = null;
  for (const opt of AGENT_OPTIONS["claude-code"].models) {
    const l = opt.label.toLowerCase();
    // Word-boundary match (finding #4, §10 re-review) — see this function's
    // doc for why a bare `startsWith` over-matches a longer real name that
    // merely shares a shorter label's leading characters.
    if (lower === l || lower.startsWith(l + " ")) {
      if (!matched || opt.label.length > matched.label.length) matched = opt;
    }
  }
  return matched ? matched.id : null;
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

/**
 * A `/model` outcome that resolved to an agetor model id — either claude
 * just SET it, or claude reports it KEPT this id (see
 * `parseClaudeLocalSetting`'s `Kept model as` handling).
 *
 * `kept` distinguishes the two, and the caller must not ignore it. A `Set
 * model to <X>` outcome (`kept` absent/false) is an unconditional real
 * change. A `Kept model as <X>` outcome (`kept: true`) is NOT a change at
 * all — it's claude restating the model the live session is already on, and
 * it is emitted by two very different events that this parse cannot tell
 * apart from the text alone:
 *
 *   1. the user DECLINED the `Switch model?` confirm that agetor's own
 *      dropdown mirror provoked — the row was written optimistically before
 *      the mirror ran, so it needs correcting back;
 *   2. the user opened a bare `/model` themselves and pressed Esc — claude
 *      restates the session's model, which says nothing whatsoever about the
 *      model the user deliberately chose in the dropdown for the NEXT run.
 *
 * Only `LocalSettingInfo.viaMirror` separates them, and only the caller has
 * it — `applyClaudeLocalSetting` is where that decision lives. Case (2)
 * silently overwriting a deliberate next-run pick is the live bug this flag
 * exists to prevent.
 */
export interface ClaudeLocalModelOutcome {
  kind: "model";
  id: string;
  /** Present (and `true`) only for a `Kept model as <X>` outcome — see this
   *  interface's doc. Absent for `Set model to <X>`. */
  kept?: true;
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
 *   1. `Kept model as <name>` resolves the same way a `Set model to` outcome
 *      does (same display-name lookup, and its `unrepresentable` `raw` is
 *      qualifier-stripped identically — finding #11e, docs/plans/
 *      model-effort-local-command-turns.md §10 re-review), but is tagged
 *      `kept: true` because it is NOT a change: claude is restating the
 *      model the session is already on. Whether that restatement should be
 *      written to the task row depends on WHO provoked it, which is
 *      `LocalSettingInfo.viaMirror`'s job, not this parse's — see
 *      `ClaudeLocalModelOutcome`'s doc and `applyClaudeLocalSetting`. This
 *      function deliberately does not read `viaMirror`: it stays a pure
 *      "what did claude report" mapping, and the policy lives in one place.
 *   2. Otherwise, the first line MUST match `Set model to <name>` — read
 *      from the FIRST LINE only (claude sometimes appends further lines,
 *      e.g. a note or caveat, and since `.` doesn't match `\n`, matching
 *      against the full multi-line stdout would silently fail to capture
 *      anything). No match (`Cancelled`, an error, empty stdout) → `null`,
 *      even when `args` carries a perfectly valid raw `claude-*` id —
 *      `args` is never consulted before a real "Set model to" outcome is
 *      confirmed, otherwise a declined confirm could still write the value
 *      that was merely typed.
 *   3. Only once a real "Set model to" outcome is confirmed: an `args` that
 *      matches a `CLAUDE_MODEL_FLAG` value exactly (the dropdown mirror's
 *      own `/model <flag>`, or a user typing the raw flag) resolves
 *      directly via `claudeModelIdFromArg` — this is the one case `args` is
 *      a MORE reliable resolver than the display name, since it round-trips
 *      losslessly, whereas an alias like `sonnet`/`opus`/`default` can't be
 *      inverted from the arg alone.
 *   4. Otherwise (no arg, or an alias the arg-based lookup can't invert)
 *      fall back to `claudeModelIdFromDisplayName` on the full first-line
 *      remainder after "Set model to " — see that function's doc for the
 *      prefix-match rationale (the trailing clause's wording varies by
 *      invocation and isn't fully known).
 *   A display name/id that resolves via neither `AGENT_OPTIONS` nor the
 *   `claude-…` passthrough is `{ kind: "unrepresentable" }`, not null — the
 *   value is real, agetor just can't store it. Its `raw` text has the one
 *   CONFIRMED trailing clause (`and saved …`) trimmed off; an unconfirmed
 *   (session-only) suffix is left in place rather than guessed at.
 *
 * Effort resolution: only `Set effort level to <id>` is a real change —
 * `Cancelled`, a future `Kept effort level as …`, or any other line bails to
 * `null`. Given that match, the id is read from `match[1]` and lowercased
 * (claude's own id is already lowercase, but a caller-supplied `args` used
 * for the support check elsewhere might not be — irrelevant here since
 * `args` is never read in this branch: `(\w+)` cannot capture an empty
 * string, so once the regex matches there is nothing left for an `args`
 * fallback to contribute). An id outside `CLAUDE_EFFORT_IDS` (`ultracode`)
 * is `{ kind: "unrepresentable" }`.
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
      // `raw` is qualifier-stripped (finding #11e, §10 re-review) — matches
      // the `Set model to` branch below so the breadcrumb is consistent
      // regardless of which outcome produced it.
      //
      // `kept: true` is what tells the orchestrator this is a RESTATEMENT,
      // not a change — the `unrepresentable` branch needs no such flag: it
      // never writes the row either way, so "kept" vs "set" doesn't change
      // its behaviour.
      return id
        ? { kind: "model", id, kept: true }
        : { kind: "unrepresentable", setting: "model", raw: stripModelQualifiers(name) };
    }

    const setMatch = /^Set model to (.+)$/.exec(firstLine);
    if (!setMatch) return null;
    const remainder = setMatch[1]!;

    if (args) {
      const id = claudeModelIdFromArg(args);
      if (id) return { kind: "model", id };
    }

    const id = claudeModelIdFromDisplayName(remainder);
    if (id) return { kind: "model", id };

    const raw = stripModelQualifiers(remainder).replace(/\s+and saved\b[\s\S]*$/, "");
    return { kind: "unrepresentable", setting: "model", raw };
  }

  // setting === "effort" — no `args` fallback (see doc above): once
  // `Set effort level to (\w+)` matches, `match[1]` is always non-empty.
  const match = /^Set effort level to (\w+)/.exec(stdout);
  if (!match) return null;
  const candidate = match[1]!.toLowerCase();
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

/**
 * Status-breadcrumb text for a `Kept model as <kept>` outcome that
 * `applyClaudeLocalSetting` deliberately did NOT sync — the user opened a
 * bare `/model` themselves and dismissed it, so claude restated the live
 * session's model while the task row holds a different, deliberately-chosen
 * model for the next run (typically one the installed picker can't select at
 * all, which is exactly why it was left as a next-run choice).
 *
 * Both values are agetor model ids, so the two halves of the sentence are
 * directly comparable. `effective` is the model the NEXT run will actually
 * use — i.e. the row's own id, or the claude-code default when the row was
 * never pinned — not a raw `null`. The caller only emits this when the two
 * genuinely differ; a restatement that AGREES with the row is silent (there
 * is no drift to explain, and a breadcrumb on every `/model` + Esc would be
 * pure noise).
 */
export function describeKeptModelNotSynced(kept: string, effective: string): string {
  return `claude kept ${kept} for this session — the task's model ${effective} still applies on the next run`;
}
