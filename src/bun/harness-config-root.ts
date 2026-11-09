/**
 * The single resolver for where a Claude Code or Codex account keeps its
 * config, sessions and login (docs/architecture/harness-stacks.md). Every
 * reader of an account's files (the stack mirror and transcript transfer,
 * login evidence, capability discovery in `commands.ts`, the usage tracker)
 * goes through these functions, so they can never disagree with each other or
 * with the spawn.
 *
 * They mirror `harnessEnv` (agents.ts) exactly. A spawn's environment is
 * Agetor's own process env, overlaid by the home-derived vars, overlaid by the
 * harness's `env` map:
 *
 *  - claude-code: `CLAUDE_CONFIG_DIR` = the env map's own value, else the
 *    harness `home`, else the process-level value the account inherits. With
 *    none of those, claude reads `<HOME>/.claude`, where HOME is the env map's
 *    `HOME` if it sets one, else the real home. `.claude.json` lives directly
 *    in the config dir when one is set, else in `<HOME>`.
 *  - codex: `CODEX_HOME` = the env map's own value, else `<home>/.codex`, else
 *    the process-level value, else `<HOME>/.codex` with HOME resolved as above.
 *
 * A blank (empty or whitespace-only) value counts as unset everywhere:
 * `harnessEnv` drops a blank `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HOME` from the
 * env map for the same reason, so a blank never steers a spawn either.
 *
 * Kept free of `db.ts` (and of agents.ts, which imports it) so the usage
 * tracker and its tests can import it without opening a database.
 */
import { homedir } from "node:os";
import path from "node:path";

/** The sub-fields of a harness that determine its on-disk config root. `env`
 *  is optional so a caller may pass a `{ home }`-only fixture. */
export interface HarnessRootSource {
  home: string | null;
  env?: Record<string, string> | null;
}

/** Env keys that pick a config root; a blank value for one is ignored. */
export const ROOT_ENV_KEYS: readonly string[] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME"];

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function processValue(key: string): string | null {
  const value = process.env[key];
  return nonBlank(value) ? value : null;
}

/** The HOME a spawned CLI sees: the env map's own `HOME`, else the real one. */
function spawnHome(harness: HarnessRootSource): string {
  const fromEnv = harness.env?.HOME;
  return nonBlank(fromEnv) ? fromEnv : homedir();
}

/**
 * The exact `CLAUDE_CONFIG_DIR` value a spawned claude receives, or null when
 * none is set (claude then uses `<HOME>/.claude`). This is the string Claude
 * Code hashes into its macOS keychain service name, so it is returned as
 * given: no `~` expansion, no resolve, no trailing-slash trimming.
 */
export function claudeConfigDirEnvFor(harness: HarnessRootSource): string | null {
  const fromEnv = harness.env?.CLAUDE_CONFIG_DIR;
  if (nonBlank(fromEnv)) return fromEnv;
  if (nonBlank(harness.home)) return harness.home;
  return processValue("CLAUDE_CONFIG_DIR");
}

/**
 * The Claude config root this harness pins, or null when the account uses the
 * same root as Agetor's own environment (a process-level `CLAUDE_CONFIG_DIR`
 * or `~/.claude`). An env-map `HOME` with no config dir anywhere pins
 * `<HOME>/.claude`.
 */
export function claudeConfigDirOverrideFor(harness: HarnessRootSource): string | null {
  const fromEnv = harness.env?.CLAUDE_CONFIG_DIR;
  if (nonBlank(fromEnv)) return fromEnv;
  if (nonBlank(harness.home)) return harness.home;
  if (processValue("CLAUDE_CONFIG_DIR")) return null;
  const envHome = harness.env?.HOME;
  return nonBlank(envHome) ? path.join(envHome, ".claude") : null;
}

/** The Claude config root a spawned claude reads (`CLAUDE_CONFIG_DIR`
 *  equivalent): sessions, settings, plugins, `.credentials.json`. */
export function claudeConfigDirFor(harness: HarnessRootSource): string {
  return claudeConfigDirEnvFor(harness) ?? path.join(spawnHome(harness), ".claude");
}

/** The directory holding Claude's `.claude.json` blob: the config dir when
 *  one is set (claude reads `CLAUDE_CONFIG_DIR || homedir()`), else the HOME
 *  the spawn sees, NOT `~/.claude`. */
export function claudeJsonDirFor(harness: HarnessRootSource): string {
  return claudeConfigDirEnvFor(harness) ?? spawnHome(harness);
}

/**
 * The Codex state root this harness pins (`CODEX_HOME`), or null when the
 * account uses the same root as Agetor's own environment (a process-level
 * `CODEX_HOME` or `~/.codex`). An env-map `HOME` with no `CODEX_HOME`
 * anywhere pins `<HOME>/.codex`.
 */
export function codexHomeOverrideFor(harness: HarnessRootSource): string | null {
  const fromEnv = harness.env?.CODEX_HOME;
  if (nonBlank(fromEnv)) return fromEnv;
  if (nonBlank(harness.home)) return path.join(harness.home, ".codex");
  if (processValue("CODEX_HOME")) return null;
  const envHome = harness.env?.HOME;
  return nonBlank(envHome) ? path.join(envHome, ".codex") : null;
}

/** The Codex state root a spawned codex reads (`CODEX_HOME`): login, config,
 *  sessions, MCP servers. */
export function codexHomeFor(harness: HarnessRootSource): string {
  return codexHomeOverrideFor(harness)
    ?? processValue("CODEX_HOME")
    ?? path.join(homedir(), ".codex");
}
