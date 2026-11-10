/**
 * The precedence that decides where a Claude Code or Codex account keeps its
 * config, sessions and login (docs/architecture/harness-stacks.md). Pure: it
 * takes the harness's `{ home, env }` plus the process values the spawn
 * inherits as parameters, so the Bun resolver (`src/bun/harness-config-root.ts`)
 * and the webview can share one implementation.
 *
 * It describes the spawn exactly. A spawn's environment is Agetor's own
 * process env, overlaid by the home-derived vars `harnessEnv` (agents.ts)
 * pins, overlaid by the harness's `env` map; claude-tmux's
 * `pinClaudeConfigDir` then pins this process's `CLAUDE_CONFIG_DIR` (or unsets
 * it) when the harness pins none, so the long-lived tmux server's env never
 * leaks in.
 *
 *  - claude-code: the spawn pins `CLAUDE_CONFIG_DIR` = the env map's own value,
 *    else the harness `home` (`pin`). Without a pin it carries the process
 *    value, else none. With none, claude reads `<HOME>/.claude`, where HOME is
 *    the env map's `HOME` if it sets one, else the real home. `.claude.json`
 *    lives directly in the config dir when `CLAUDE_CONFIG_DIR` is set, else in
 *    `<HOME>`. An env-map `HOME` alone never pins `CLAUDE_CONFIG_DIR`: that
 *    value is hashed into the macOS keychain service name, so pinning it would
 *    log the account out (review R-M1).
 *  - codex: the spawn pins `CODEX_HOME` = the env map's own value, else
 *    `<home>/.codex` (`pin`). Without a pin codex reads the inherited process
 *    `CODEX_HOME`, else `<HOME>/.codex` with HOME resolved as above.
 *
 * A blank (empty or whitespace-only) value counts as unset everywhere:
 * `harnessEnv` drops a blank `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HOME` from the
 * env map, and `pinClaudeConfigDir` unsets a blank process value, so a blank
 * never steers a spawn either.
 *
 * No runtime imports from either process (CLAUDE.md, src/shared).
 */

/** The sub-fields of a harness that determine its on-disk config root. `env`
 *  is optional so a caller may pass a `{ home }`-only fixture. */
export interface HarnessRootSource {
  home: string | null;
  env?: Record<string, string> | null;
}

/** The process-level values a spawn inherits. `homeDir` is the real home the
 *  CLI falls back to when the env map sets no `HOME`. */
export interface ProcessRootValues {
  homeDir: string;
  claudeConfigDir?: string | null;
  codexHome?: string | null;
}

/** Env keys that pick a config root; a blank value for one is ignored. */
export const ROOT_ENV_KEYS: readonly string[] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME"];

/** True for a string with at least one non-whitespace character. */
export function nonBlankRootValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * POSIX `path.join(base, segment)` without importing `node:path` (the
 * webview cannot): joins with `/` and normalizes `.`/`..` segments and
 * repeated slashes exactly as Node's posix normalize does.
 */
export function joinRootPath(base: string, segment: string): string {
  const joined = base === "" ? segment : segment === "" ? base : `${base}/${segment}`;
  if (joined === "") return ".";
  const absolute = joined.startsWith("/");
  const trailing = joined.endsWith("/");
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  let result = out.join("/");
  if (absolute) result = `/${result}`;
  else if (result === "") result = ".";
  if (trailing && result !== "/" && result !== ".") result = `${result}/`;
  else if (trailing && result === ".") result = "./";
  return result;
}

/** Which rule decided an account's root. */
export type HarnessRootSourceKind = "env-map" | "home" | "process" | "env-home" | "default";

export interface ClaudeRootResolution {
  source: HarnessRootSourceKind;
  /** The `CLAUDE_CONFIG_DIR` the harness itself pins (env map, else `home`),
   *  as given, or null. This is the value the spawn hands claude. */
  pin: string | null;
  /** The `CLAUDE_CONFIG_DIR` the spawned claude actually receives (the pin,
   *  else the process value), as given, or null when it gets none. */
  configDirEnv: string | null;
  /** The HOME the spawned claude sees. */
  spawnHome: string;
  /** Where claude reads/writes sessions, settings, plugins and
   *  `.credentials.json`. Never null. */
  configDir: string;
  /** The directory holding the `.claude.json` claude reads. */
  claudeJsonDir: string;
}

export function resolveClaudeRoot(harness: HarnessRootSource, proc: ProcessRootValues): ClaudeRootResolution {
  const envHome = harness.env?.HOME;
  const spawnHome = nonBlankRootValue(envHome) ? envHome : proc.homeDir;
  const fromEnv = harness.env?.CLAUDE_CONFIG_DIR;
  let source: HarnessRootSourceKind;
  let pin: string | null = null;
  let configDirEnv: string | null = null;
  if (nonBlankRootValue(fromEnv)) {
    source = "env-map";
    pin = configDirEnv = fromEnv;
  } else if (nonBlankRootValue(harness.home)) {
    source = "home";
    pin = configDirEnv = harness.home;
  } else if (nonBlankRootValue(proc.claudeConfigDir)) {
    source = "process";
    configDirEnv = proc.claudeConfigDir;
  } else {
    source = nonBlankRootValue(envHome) ? "env-home" : "default";
  }
  return {
    source,
    pin,
    configDirEnv,
    spawnHome,
    configDir: configDirEnv ?? joinRootPath(spawnHome, ".claude"),
    claudeJsonDir: configDirEnv ?? spawnHome,
  };
}

export interface CodexRootResolution {
  source: HarnessRootSourceKind;
  /** The `CODEX_HOME` the harness itself pins (env map, else
   *  `<home>/.codex`), or null. */
  pin: string | null;
  /** Where codex reads/writes login, config, sessions and MCP servers. */
  codexHome: string;
}

export function resolveCodexRoot(harness: HarnessRootSource, proc: ProcessRootValues): CodexRootResolution {
  const fromEnv = harness.env?.CODEX_HOME;
  if (nonBlankRootValue(fromEnv)) return { source: "env-map", pin: fromEnv, codexHome: fromEnv };
  if (nonBlankRootValue(harness.home)) {
    const pin = joinRootPath(harness.home, ".codex");
    return { source: "home", pin, codexHome: pin };
  }
  if (nonBlankRootValue(proc.codexHome)) return { source: "process", pin: null, codexHome: proc.codexHome };
  const envHome = harness.env?.HOME;
  if (nonBlankRootValue(envHome)) return { source: "env-home", pin: null, codexHome: joinRootPath(envHome, ".codex") };
  return { source: "default", pin: null, codexHome: joinRootPath(proc.homeDir, ".codex") };
}
