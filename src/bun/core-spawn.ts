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
//      `Bun.spawn` throwing a synchronous ENOENT for "binary not installed",
//      so an unresolved target (or missing cwd) throws that same error —
//      never an undisclaimed fall-through spawn.
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

/**
 * Why a cwd can't be used, or null when it can (or when its state can't be
 * told from the core — EPERM/EACCES on a TCC-protected folder: the child is
 * still disclaimed and the kernel gives the real answer when it chdirs).
 */
function cwdProblem(cwd: string | undefined): "ENOENT" | null {
  if (cwd === undefined) return null;
  try {
    return statSync(cwd).isDirectory() ? null : "ENOENT";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "ENOENT" : null;
  }
}

type SpawnErrorCode = "ENOENT" | "EACCES";

/** Why `file` would not exec, mirroring Bun's own answer: a name that isn't
 *  found → ENOENT; an existing path that isn't an executable file → EACCES. */
function unresolvedCode(file: string, cwd: string | undefined): SpawnErrorCode {
  if (!file.includes("/")) return "ENOENT";
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file);
  try {
    statSync(abs);
    return "EACCES";
  } catch {
    return "ENOENT";
  }
}

const ERRNO: Record<SpawnErrorCode, number> = { ENOENT: -2, EACCES: -13 };

/**
 * The error a plain `Bun.spawn` / `spawnSync` raises for the same failure, so
 * "binary not installed" handling keeps working: same `code`, `errno`,
 * `syscall` and `path`, and the same message shapes Bun uses.
 */
function spawnError(
  file: string,
  code: SpawnErrorCode,
  cause: "exec" | "cwd",
  mode: "async" | "sync",
): NodeJS.ErrnoException {
  const pathMiss = cause === "exec" && code === "ENOENT" && !file.includes("/");
  const message = pathMiss
    ? `Executable not found in $PATH: "${file}"`
    : `${code}: ${code === "ENOENT" ? "no such file or directory" : "permission denied"}, posix_spawn '${file}'`;
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  err.errno = ERRNO[code];
  // Bun.spawn's PATH miss carries no `syscall`; spawnSync always names itself.
  if (mode === "sync") err.syscall = `spawnSync ${file}`;
  else if (!pathMiss) err.syscall = "posix_spawn";
  err.path = file;
  return err;
}

type SpawnOpts = Parameters<typeof Bun.spawn>[1];

/**
 * Spawn `argv` with the scrubbed live env, through the disclaim helper when
 * that is enabled.
 *
 * While disclaiming, nothing is ever spawned undisclaimed: when the target
 * does not resolve (or the cwd does not exist) this THROWS the error a plain
 * `Bun.spawn` would have thrown — `code` ENOENT/EACCES, `errno`, `syscall`,
 * `path` — instead of handing the helper a command it would fail on (exit
 * 127, blaming the wrong thing) or falling through to an undisclaimed spawn
 * (a binary planted between the check and the call would then run with
 * Agetor's identity).
 */
export function coreSpawn(argv: string[], opts: SpawnOpts = {}): ReturnType<typeof Bun.spawn> {
  const env = childEnv(undefined, opts.env ?? process.env);
  const options = { ...opts, env } as NonNullable<SpawnOpts>;
  if (disclaimEnabled() && argv.length > 0) {
    const file = argv[0]!;
    if (cwdProblem(opts.cwd)) throw spawnError(file, "ENOENT", "cwd", "async");
    const resolved = resolveExecutable(file, env, opts.cwd);
    if (!resolved) throw spawnError(file, unresolvedCode(file, opts.cwd), "exec", "async");
    return Bun.spawn([resolveDisclaimBin(), resolved, ...argv.slice(1)], options);
  }
  return Bun.spawn(argv, options);
}

/**
 * Synchronous variant for the few callers that cannot be async (`login-path.ts`,
 * `git-provider.ts`). Same env and disclaim rules as `coreSpawn`; for a target
 * or cwd that does not resolve it returns what `spawnSync` returns for that
 * failure (it does not throw: `error` is set, `status`/`pid` undefined,
 * `output` null) without spawning anything.
 */
export function coreSpawnSync(
  file: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const env = childEnv(undefined, (opts.env ?? process.env) as Record<string, string | undefined>);
  const options = { ...opts, env } as SpawnSyncOptions;
  const cwd = opts.cwd === undefined ? undefined : String(opts.cwd);
  if (disclaimEnabled()) {
    const failed = (error: NodeJS.ErrnoException): SpawnSyncReturns<string | Buffer> => {
      (error as NodeJS.ErrnoException & { spawnargs?: string[] }).spawnargs = args;
      return {
        pid: undefined as unknown as number,
        output: null as unknown as Array<string | Buffer | null>,
        stdout: null as unknown as string | Buffer,
        stderr: null as unknown as string | Buffer,
        status: undefined as unknown as null,
        signal: null,
        error,
      };
    };
    if (cwdProblem(cwd)) return failed(spawnError(file, "ENOENT", "cwd", "sync"));
    const resolved = resolveExecutable(file, env, cwd);
    if (!resolved) return failed(spawnError(file, unresolvedCode(file, cwd), "exec", "sync"));
    return spawnSync(resolveDisclaimBin(), [resolved, ...args], options);
  }
  return spawnSync(file, args, options);
}
