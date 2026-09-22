// Shared by both processes — must stay free of runtime imports from either
// side (same rule at-refs.ts / prompt-limits.ts document). Pure `major.minor
// .patch` parsing and comparison for a CLI's `--version` output, plus the
// one user-facing error string built from it.
//
// Why this exists (see docs/plans/add-gpt-6-sol-and-luna.md §3 D4): codex's
// `chatgpt.com/backend-api/codex/models` catalog gate is keyed on the
// installed CLI's `client_version`, and an old CLI answers a plain HTTP 400
// that *blames the ChatGPT account* rather than naming the real cause — so
// agetor can't trust that 400 text as a diagnosis, and by the time a spawn
// would surface it the run row and worktree already exist. The fix is a
// pre-flight: compare the probed CLI version against a per-model minimum
// (`MODEL_MIN_CLI_VERSION` in `types.ts`) before ever starting a run.
//
// The contract is deliberately FAIL-OPEN: `cliVersionSatisfies` returns
// `null` — never `false` — whenever either side fails to parse (a stub test
// binary answering `--version` with nothing recognizable, a probe that
// legitimately can't run, a future CLI whose banner format changes). Callers
// must treat `null` as "unknown, do not block" — the goal is to catch a
// *known-too-old* CLI before spawn, never to require every environment to
// report a parseable version just to run at all. `/bin/echo`-based test
// overrides and other stub binaries are exactly the case this keeps
// unblocked.

/** A parsed `major.minor.patch` CLI version. */
export interface CliVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

/**
 * Extracts the first `\d+\.\d+\.\d+` run from a `--version`-style probe
 * line — tolerant of surrounding text ("codex-cli 0.155.1", "gemini 0.54.0
 * (abc)"), a leading "v" ("v1.2.3"), and a bare version with nothing else
 * ("0.147.0"). A pre-release/build suffix after the third number is ignored
 * ("0.155.1-beta.2" → 0.155.1 — only the leading three numeric groups are
 * captured). Returns `null` for `null`/`undefined`/empty input or a line
 * with no such run (e.g. "--version", "codex", "1.2").
 */
export function parseCliVersion(raw: string | null | undefined): CliVersion | null {
  if (!raw) return null;
  const match = VERSION_RE.exec(raw);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Numeric major/minor/patch comparison. Negative when `a` < `b`, zero when
 * equal, positive when `a` > `b` — the standard comparator contract.
 */
export function compareCliVersions(a: CliVersion, b: CliVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Whether the CLI version reported by `raw` is at least `min`. Returns
 * `true`/`false` when both sides parse, and `null` — fail-open — when
 * either doesn't. See the module doc comment above: callers must treat
 * `null` as "unknown, do not block."
 */
export function cliVersionSatisfies(raw: string | null | undefined, min: string): boolean | null {
  const installed = parseCliVersion(raw);
  const floor = parseCliVersion(min);
  if (!installed || !floor) return null;
  return compareCliVersions(installed, floor) >= 0;
}

/** Input to `formatMinCliVersionError`. */
export interface MinCliVersionErrorInput {
  /** Human-facing harness name, e.g. "Codex". */
  harnessLabel: string;
  /** The raw probe line the harness reported, e.g. "codex-cli 0.147.0". */
  installedRaw: string;
  /** Human-facing model name, e.g. "GPT-6 Sol". */
  modelLabel: string;
  /** `AgentKind` id, used verbatim in "<kind> CLI", e.g. "codex". */
  kind: string;
  /** Minimum required version, e.g. "0.155.0". */
  floor: string;
  /** Upgrade command to suggest, or `null` to omit that sentence. */
  installHint: string | null;
}

/**
 * Builds the single user-facing error string for a version-gated model
 * launch blocked by `cliVersionSatisfies` returning `false`. `installedRaw`
 * is rendered as its parsed "major.minor.patch" when it parses, else
 * verbatim (defensive — this path is only reached when it already parsed,
 * but the fallback keeps the function safe to call standalone).
 */
export function formatMinCliVersionError(input: MinCliVersionErrorInput): string {
  const parsedInstalled = parseCliVersion(input.installedRaw);
  const installedVersion = parsedInstalled
    ? `${parsedInstalled.major}.${parsedInstalled.minor}.${parsedInstalled.patch}`
    : input.installedRaw;
  let message =
    `${input.harnessLabel} ${installedVersion} can't run ${input.modelLabel} — ` +
    `it needs ${input.kind} CLI ≥ ${input.floor}.`;
  if (input.installHint) {
    message += ` Upgrade with: ${input.installHint}`;
  }
  return message;
}
