// The single spawn wrapper for every process the core launches
// (docs/plans/master-token-agent-read.md, §3 "Spawn wrapper", P2/P3).
//
// Why one wrapper. macOS TCC attributes a child's protected-data prompts to
// its "responsible process" — whoever spawned it, unless the spawn is routed
// through the disclaim helper (disclaim.ts). If only agent processes were
// disclaimed, a program an agent can plant (a repo-configured
// `core.fsmonitor`, a git/ssh config `Match exec`, a binary earlier on PATH)
// would still run with Agetor's TCC identity. So every non-exempt core spawn
// goes through `coreSpawn` / `coreSpawnSync`; the exemptions are marked
// `// spawn-exempt(<category>): <reason>` at the call site and pinned by a
// static test. Call sites must not call `disclaimArgv` themselves — this is
// the only place that wraps, so nothing is wrapped twice.
//
// What the wrapper guarantees:
//   1. The child's env is ALWAYS explicit, built from the live `process.env`
//      (never Bun's startup snapshot) and scrubbed of `SCRUBBED_ENV_KEYS`, so
//      the master API token cannot reach any child, whatever the caller forgot.
//   2. When disclaiming, `argv[0]` is resolved BEFORE the helper runs. The
//      helper does `posix_spawnp` and on failure prints `disclaim: exec … failed`
//      and exits 127 (native/disclaim/disclaim.c); callers instead rely on
//      `Bun.spawn` throwing a synchronous ENOENT for "binary not installed".
//   3. When disclaim is off, unavailable or non-darwin, it is a plain
//      `Bun.spawn` / `spawnSync` with the scrubbed env.

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { disclaimEnabled, resolveDisclaimBin } from "./disclaim.ts";

/** Env vars no child process may inherit. The API token is the core's master
 *  credential; a child (an agent, a probe, a git hook) that could read it
 *  could drive the whole API. */
export const SCRUBBED_ENV_KEYS: readonly string[] = ["AGETOR_API_TOKEN"];

/**
 * Environment for a spawned child: a NEW plain object holding `base` (the live
 * `process.env` by default) overlaid with `extra`, minus `SCRUBBED_ENV_KEYS`.
 * An `undefined` value in `extra` deletes the key. Never mutates `base`.
 *
 * It must be the LIVE `process.env`: `Bun.spawn` without an `env` option hands
 * the child the env snapshot Bun captured at process start, so the PATH that
 * `rehydratePath()` builds at boot never reached children when Agetor was
 * launched from Finder (launchd's minimal `/usr/bin:/bin`). See the same note
 * on tmux-resolution.ts's former `tmuxClientEnv()`.
 */
export function childEnv(
  extra?: Record<string, string | undefined>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
}

/** PATH `Bun.spawn` falls back to when the child env has none (measured: an
 *  empty env still finds `/bin/ls`). Mirrored so resolution agrees with it. */
const BUN_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * Resolve `file` to an absolute path the way `Bun.spawn` would, or `null` when
 * it does not resolve to an executable regular file.
 *
 *  - contains a `/`: absolute as-is, relative against `cwd` (the child's cwd)
 *  - bare name: searched on the CHILD env's PATH (not the core's)
 */
function resolveExecutable(
  file: string,
  env: Record<string, string | undefined>,
  cwd: string | undefined,
): string | null {
  if (file.includes("/")) {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file);
    try {
      if (!statSync(abs).isFile()) return null;
      accessSync(abs, constants.X_OK);
      return abs;
    } catch {
      return null;
    }
  }
  const found = Bun.which(file, { PATH: env.PATH ?? BUN_DEFAULT_PATH, cwd });
  return found || null;
}

/** True when `cwd` (if given) is not an existing directory. With a bad cwd the
 *  helper itself would fail to start instead of the target, which would blame
 *  the wrong path in the error. */
function cwdMissing(cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  try {
    return !statSync(cwd).isDirectory();
  } catch {
    return true;
  }
}

type SpawnOpts = Parameters<typeof Bun.spawn>[1];

/**
 * Spawn `argv` with the scrubbed live env, through the disclaim helper when
 * that is enabled.
 *
 * ENOENT parity: when the target (or the cwd) does not resolve, this does NOT
 * hand the helper a command it would fail on. It falls through to a plain
 * `Bun.spawn` of the original argv, which fails the same way an undisclaimed
 * spawn always did — the genuine error, with Bun's own message / `code:
 * "ENOENT"` / `errno` / `syscall` / `path` — so existing "binary not
 * installed" handling keeps working. The fall-through can only spawn if the
 * target actually appeared between our check and the call, which is the same
 * race any spawn has.
 */
export function coreSpawn(argv: string[], opts: SpawnOpts = {}): ReturnType<typeof Bun.spawn> {
  const env = childEnv(undefined, opts.env ?? process.env);
  const options = { ...opts, env } as NonNullable<SpawnOpts>;
  if (disclaimEnabled() && argv.length > 0 && !cwdMissing(opts.cwd)) {
    const resolved = resolveExecutable(argv[0]!, env, opts.cwd);
    if (resolved) {
      return Bun.spawn([resolveDisclaimBin(), resolved, ...argv.slice(1)], options);
    }
  }
  return Bun.spawn(argv, options);
}

/**
 * Synchronous variant for the few callers that cannot be async (`login-path.ts`,
 * `git-provider.ts`). Same env and disclaim rules as `coreSpawn`; for an
 * unresolvable binary it returns exactly what `spawnSync` returns for ENOENT
 * (it does not throw: `error` is set, `status` is null) because that result
 * comes from `spawnSync` itself.
 */
export function coreSpawnSync(
  file: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const env = childEnv(undefined, (opts.env ?? process.env) as Record<string, string | undefined>);
  const options = { ...opts, env } as SpawnSyncOptions;
  const cwd = opts.cwd === undefined ? undefined : String(opts.cwd);
  if (disclaimEnabled() && !cwdMissing(cwd)) {
    const resolved = resolveExecutable(file, env, cwd);
    if (resolved) {
      return spawnSync(resolveDisclaimBin(), [resolved, ...args], options);
    }
  }
  return spawnSync(file, args, options);
}
