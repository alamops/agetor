/**
 * The single resolver for where a Claude Code or Codex account keeps its
 * config, sessions and login (docs/architecture/harness-stacks.md). Every
 * reader of an account's files (the stack mirror and transcript transfer,
 * login evidence, capability discovery in `commands.ts`, the usage tracker,
 * the session tailer and scans) goes through these functions, so they can
 * never disagree with each other or with the spawn.
 *
 * The precedence itself is the pure `src/shared/harness-config-root.ts`
 * (shared with the webview); this module feeds it Agetor's own process values
 * (`os.homedir()`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), which every spawn
 * inherits. Two kinds of answer, never to be mixed:
 *
 *  - `claudeConfigDirOverrideFor` / `codexHomeOverrideFor`: the value the
 *    spawn PINS (env map, else `home`), or null. Only the spawn path feeds
 *    this to claude/codex. An env-map `HOME` alone pins nothing: claude hashes
 *    `CLAUDE_CONFIG_DIR` into its macOS keychain service name, so pinning
 *    `<HOME>/.claude` would log that account out (review R-M1).
 *  - `claudeConfigDirFor` / `claudeJsonDirFor` / `codexHomeFor`: where the
 *    spawned CLI actually reads and writes, never null. Every file READER
 *    (JSONL paths, tailers, session scans, liveness probes, mirror, usage)
 *    uses these.
 *
 * Kept free of `db.ts` (and of agents.ts, which imports it) so the usage
 * tracker and its tests can import it without opening a database.
 */
import { homedir } from "node:os";
import {
  ROOT_ENV_KEYS,
  resolveClaudeRoot,
  resolveCodexRoot,
  type ClaudeRootResolution,
  type CodexRootResolution,
  type HarnessRootSource,
  type ProcessRootValues,
} from "../shared/harness-config-root.ts";

export { ROOT_ENV_KEYS, type HarnessRootSource };

/** The process values every spawn inherits, read live (tests change them). */
export function processRootValues(): ProcessRootValues {
  return {
    homeDir: homedir(),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
  };
}

/** The full Claude resolution (which rule won, the pin, the read roots). */
export function claudeRootFor(harness: HarnessRootSource): ClaudeRootResolution {
  return resolveClaudeRoot(harness, processRootValues());
}

/** The full Codex resolution. */
export function codexRootFor(harness: HarnessRootSource): CodexRootResolution {
  return resolveCodexRoot(harness, processRootValues());
}

/**
 * The exact `CLAUDE_CONFIG_DIR` value a spawned claude receives (the
 * harness's pin, else the inherited process value), or null when it gets none
 * (claude then uses `<HOME>/.claude`). This is the string Claude Code hashes
 * into its macOS keychain service name, so it is returned as given: no `~`
 * expansion, no resolve, no trailing-slash trimming.
 */
export function claudeConfigDirEnvFor(harness: HarnessRootSource): string | null {
  return claudeRootFor(harness).configDirEnv;
}

/**
 * The `CLAUDE_CONFIG_DIR` this harness pins on its spawn: the env map's own
 * value, else `home`, else null. Null means the spawn pins nothing and
 * claude-tmux's `pinClaudeConfigDir` hands claude this process's value or
 * unsets it. Only the spawn path uses this; file readers use
 * `claudeConfigDirFor`.
 */
export function claudeConfigDirOverrideFor(harness: HarnessRootSource): string | null {
  return claudeRootFor(harness).pin;
}

/** The Claude config root a spawned claude reads (`CLAUDE_CONFIG_DIR`
 *  equivalent): sessions, settings, plugins, `.credentials.json`. */
export function claudeConfigDirFor(harness: HarnessRootSource): string {
  return claudeRootFor(harness).configDir;
}

/** The directory holding Claude's `.claude.json` blob: the config dir when
 *  claude receives one (it reads `CLAUDE_CONFIG_DIR || homedir()`), else the
 *  HOME the spawn sees, NOT `~/.claude`. */
export function claudeJsonDirFor(harness: HarnessRootSource): string {
  return claudeRootFor(harness).claudeJsonDir;
}

/** The HOME a spawned claude/codex sees: the env map's `HOME`, else the real
 *  one. */
export function spawnHomeFor(harness: HarnessRootSource): string {
  return claudeRootFor(harness).spawnHome;
}

/**
 * The `CODEX_HOME` this harness pins on its spawn (`harnessEnv`): the env
 * map's own value, else `<home>/.codex`, else null. Null means codex inherits
 * the process `CODEX_HOME` or falls back to `<HOME>/.codex` by itself, which
 * `codexHomeFor` describes.
 */
export function codexHomeOverrideFor(harness: HarnessRootSource): string | null {
  return codexRootFor(harness).pin;
}

/** The Codex state root a spawned codex reads (`CODEX_HOME`): login, config,
 *  sessions, MCP servers. */
export function codexHomeFor(harness: HarnessRootSource): string {
  return codexRootFor(harness).codexHome;
}
