import { existsSync } from "node:fs";
import path from "node:path";
import { dataDir, preferences } from "./db.ts";
import { childEnv, coreSpawn } from "./core-spawn.ts";

export const TMUX_SOURCE_KEY = "tmux_source";
export type TmuxSource = "system" | "bundled";

/**
 * Where the bundled tmux lives at runtime. Two locations:
 *   - packaged: <bun>/../Resources/app/bin/tmux (inside the .app)
 *   - dev:     <repo>/vendor/tmux/arm64/tmux
 * The first match wins; if neither exists we still return the packaged path
 * so callers get a deterministic, debuggable error ("ENOENT <expected path>")
 * instead of a generic "tmux: command not found".
 */
export function bundledTmuxPath(): string {
  const packaged = path.join(
    path.dirname(process.execPath),
    "..",
    "Resources",
    "app",
    "bin",
    "tmux",
  );
  if (existsSync(packaged)) return packaged;
  const dev = path.join(process.cwd(), "vendor", "tmux", "arm64", "tmux");
  if (existsSync(dev)) return dev;
  return packaged;
}

// Cache the resolved source between writes. Without this, every call to
// resolveTmuxBin() — which fires from inside `tmux(...)` in claude-tmux.ts
// for has-session checks, paste-buffer + send-keys, status probes — does a
// synchronous SQLite read. Preferences only change when setTmuxSource()
// runs, so the cache invalidates from a single point.
let cachedSource: TmuxSource | null = null;

export function getTmuxSource(): TmuxSource {
  if (cachedSource !== null) return cachedSource;
  cachedSource = preferences.get(TMUX_SOURCE_KEY) === "bundled" ? "bundled" : "system";
  return cachedSource;
}

export function setTmuxSource(source: TmuxSource): void {
  preferences.set(TMUX_SOURCE_KEY, source);
  cachedSource = source;
}

/**
 * Single source of truth for the tmux binary path. Precedence:
 *   1. AGETOR_TMUX_BIN env override (tests + power users) — never bypassed.
 *   2. `tmux_source = "bundled"` preference → the in-bundle binary.
 *   3. System PATH lookup — resolved to an absolute path so `Bun.spawn`
 *      doesn't re-do the lookup against its stale cached PATH (see the
 *      `Bun.which` gotcha in agent-status.ts).
 *
 * Returns the literal "tmux" only when nothing on PATH matches — the caller
 * spawn will then surface the same "Executable not found in $PATH" error
 * the user would have seen, but from a deterministic codepath.
 */
export function resolveTmuxBin(): string {
  const override = process.env.AGETOR_TMUX_BIN;
  if (override) return override;
  if (getTmuxSource() === "bundled") return bundledTmuxPath();
  return Bun.which("tmux", { PATH: process.env.PATH }) ?? "tmux";
}

/** True when the bundled binary is actually present on disk. */
export function bundledTmuxAvailable(): boolean {
  return existsSync(bundledTmuxPath());
}

/**
 * macOS's system terminfo database. Present on every supported macOS and the
 * second — fallback — entry of the runtime `TERMINFO_DIRS` built below, so a
 * `TERM` the vendored five-entry DB doesn't carry (a custom Terminal profile)
 * still resolves.
 */
export const SYSTEM_TERMINFO_DIR = "/usr/share/terminfo";

/**
 * Pure: the `TERMINFO_DIRS` value for the tmux binary at `binPath` — its
 * sibling `terminfo/` directory first (the vendored DB; see
 * `scripts/terminfo/README.md`), then `systemDir`. Only directories that
 * actually exist are included, and `null` means "nothing to override" so the
 * caller leaves the env alone.
 *
 * Why this exists: the bundled tmux links a vendored `libncursesw` whose
 * COMPILED-IN default terminfo path is the build machine's Homebrew Cellar
 * directory. The bundle ships no DB of its own, so a tty client (`tmux
 * attach` from Terminal.app) printed `can't find terminfo database` and
 * exited — issue #298's "Open in Terminal" dead end. A headless client (no
 * tty) never resolves terminfo, which is why only the attach path broke.
 *
 * Pure (no spawning, no `resolveTmuxBin`) so the search-path construction is
 * unit-testable and so the open-tmux route can inline the value into its
 * shell command (where the env must live, not on osascript).
 */
export function terminfoDirsFor(binPath: string, systemDir = SYSTEM_TERMINFO_DIR): string | null {
  const dirs = [path.join(path.dirname(binPath), "terminfo"), systemDir].filter((d) => existsSync(d));
  return dirs.length ? dirs.join(":") : null;
}

/** True when `bin` resolves to the same file as `bundledTmuxPath()` (packaged
 *  or dev). Paths are resolved first so `…/bin/../bin/tmux` and an
 *  `AGETOR_TMUX_BIN` pointing at the bundle both count. */
export function isBundledTmuxBin(bin: string): boolean {
  return path.resolve(bin) === path.resolve(bundledTmuxPath());
}

/**
 * Env for a tmux CLIENT spawn: `childEnv()` semantics (the live environment,
 * master API token scrubbed) plus a `TERMINFO_DIRS` override —
 * but ONLY when the resolved binary is the bundled one. System tmux keeps its
 * own lookup untouched.
 *
 * The computed dirs are PREPENDED to any existing `TERMINFO_DIRS`, which is
 * never replaced, so a user's own setting stays further down the search path.
 * (`TERMINFO`, a single directory, still wins over `TERMINFO_DIRS` by ncurses
 * semantics — a deliberate user override we don't stomp on.)
 *
 * Deliberately NOT named `tmuxClientEnv`: that helper was removed in favour of
 * `childEnv` and `core-spawn-allowlist.test.ts` pins its absence. This is a
 * thin bundled-tmux-only wrapper over `childEnv`, not a resurrection.
 */
export function tmuxEnv(
  bin: string = resolveTmuxBin(),
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env = childEnv(extra);
  if (!isBundledTmuxBin(bin)) return env;
  const dirs = terminfoDirsFor(bin);
  if (!dirs) return env;
  env.TERMINFO_DIRS = env.TERMINFO_DIRS ? `${dirs}:${env.TERMINFO_DIRS}` : dirs;
  return env;
}

/**
 * Derive a stable per-instance tmux socket name from the data dir — pure so
 * it's unit-testable without touching env/preferences. `~/.agetor` ->
 * `"agetor"`, `~/.agetor-dev` -> `"agetor-dev"`: strip leading dot(s) off
 * the basename, replace any char outside `[A-Za-z0-9_-]` with `-`, and fall
 * back to `"agetor"` if that leaves nothing.
 */
export function deriveTmuxSocketName(dataDirPath: string): string {
  const base = path.basename(dataDirPath).replace(/^\.+/, "");
  // Strip a leading dash after sanitizing too: a socket name beginning with
  // `-` would be parsed by tmux as an option (`tmux -L -weird …` fails), which
  // a data dir like `/x/-weird` or `/x/.-y` (→ `-y`) would otherwise produce.
  const sanitized = base.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "");
  return sanitized || "agetor";
}

/**
 * Which tmux server socket to talk to, or `null` for tmux's own default
 * socket (`/tmp/tmux-<uid>/default`).
 *
 * This exists because of a real incident: `bun test` (including a zombie
 * agent dogfooding agetor on itself) ran on the user's shared default tmux
 * socket, and a test that deletes `AGETOR_TMUX_BIN` to exercise the raw-PATH
 * fallback ended up issuing `new-session`/`kill-session` churn against the
 * *production* server — which died mid-run and took every live agent
 * session on it down with it. Socket isolation makes the whole test suite
 * structurally unable to reach the production socket, regardless of which
 * test forgets to scope itself.
 *
 * The production branch (below) ALSO gets its own dedicated socket, derived
 * from the data dir, rather than tmux's shared default socket — two reasons:
 * (1) it means agetor always *owns* (and, per `ensureDisclaimedServer()`
 * below, starts) its own tmux server rather than sometimes attaching to a
 * server some other process on the machine already started undisclaimed,
 * which is what makes the disclaim-at-server-start trick reliably cover
 * every session agetor hosts; (2) it isolates agetor's sessions from the
 * user's own terminal tmux usage on the same machine. One-time upgrade
 * cost: sessions still running on the OLD shared default socket at upgrade
 * time become unreachable from the new socket — handled non-destructively
 * by the existing `orphaned` -> `ready` boot reconciliation path (they're
 * just dead sessions from the new socket's point of view, same as a crash).
 *
 * Precedence, read at CALL time (no module-level caching) so tests can
 * flip `AGETOR_TMUX_SOCKET`/`NODE_ENV` between cases without a restart:
 *   1. `AGETOR_TMUX_SOCKET` env override — explicit test/power-user escape
 *      hatch. The literal value `"default"` means "force tmux's own default
 *      socket even under test", so a test that genuinely needs the real
 *      socket (or a developer debugging against it) isn't stuck.
 *   2. `NODE_ENV === "test"` (bun test sets this) → `"agetor-test"` — the
 *      safety net. Catches every test file, including ones that never
 *      import this module directly, as long as they route through the
 *      `tmux()` runner in claude-tmux.ts.
 *   3. Otherwise, a per-instance socket derived from `dataDir` (e.g.
 *      `"agetor"` for the packaged app, `"agetor-dev"` under `bun run dev`).
 */
export function tmuxSocketName(): string | null {
  const override = process.env.AGETOR_TMUX_SOCKET;
  if (override) return override === "default" ? null : override;
  if (process.env.NODE_ENV === "test") return "agetor-test";
  return deriveTmuxSocketName(dataDir);
}

/** `["-L", <socket>]` for `tmuxSocketName()`, or `[]` to use tmux's default
 *  socket. Spread directly after the tmux binary in every spawn site — see
 *  `tmuxSocketName()` for why this must be threaded through unconditionally. */
export function tmuxSocketArgs(): string[] {
  const name = tmuxSocketName();
  return name ? ["-L", name] : [];
}

/**
 * Build the argv for a disclaimed `tmux start-server` on agetor's own
 * socket — pure so it's unit-testable without spawning anything. `tmuxBin`
 * is the caller-resolved tmux binary (`resolveTmuxBin()`). The argv is the
 * plain tmux command: the disclaim wrapping happens inside `coreSpawn`
 * (core-spawn.ts), the only place that calls `disclaimArgv`, so wrapping it
 * here too would exec the helper twice (P3).
 */
export function buildEnsureServerArgv(tmuxBin: string): string[] {
  return [tmuxBin, ...tmuxSocketArgs(), "start-server"];
}

/** Whether this process already cleared a stale `AGETOR_API_TOKEN` from the
 *  tmux server's global environment (see `ensureDisclaimedServer`). */
let staleServerTokenCleared = false;

/** Test seam: forget that the one-time `set-environment -g -u` ran. */
export function __resetTmuxServerEnvClearedForTest(): void {
  staleServerTokenCleared = false;
}

/**
 * Best-effort: start agetor's dedicated tmux server through the disclaim
 * helper, so the server daemon — and every session it goes on to host —
 * inherits self-responsibility instead of Agetor's. `start-server` is
 * idempotent (a no-op against an already-live server), so this is safe to
 * call defensively before every new session, not just once at boot.
 *
 * Must run before ANY other tmux command touches this socket: a plain
 * `has-session`/`new-session` issued first would auto-start the server
 * un-disclaimed, and there's no way to re-disclaim a server after the fact
 * (`start-server` on an already-running server is a no-op, not a restart).
 * Never throws — a disclaim/tmux hiccup here must not block a run; worst
 * case is the pre-fix TCC-spam behavior, not a broken spawn.
 */
export async function ensureDisclaimedServer(): Promise<void> {
  try {
    const bin = resolveTmuxBin();
    const argv = buildEnsureServerArgv(bin);
    // Ignore stdio rather than pipe: `start-server` emits nothing and this is
    // best-effort, so there's no output to capture and a drain-free pipe is
    // pointless. `disclaim`'s exec-replace preserves these fd choices.
    // `tmuxEnv(bin)`: a panes-inherit-env concern for a bundled client (see
    // `tmuxEnv`) — the started server and its panes get the real terminfo
    // search path, which is harmless for the agent CLIs inside them.
    const proc = coreSpawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: tmuxEnv(bin),
    });
    await proc.exited;
    if (!staleServerTokenCleared) {
      staleServerTokenCleared = true;
      // A server started by an older build inherited the core's env, which
      // carried AGETOR_API_TOKEN into the server's GLOBAL environment, and
      // tmux hands that to every new session's panes. `set-environment -g -u`
      // drops it (a no-op when absent). Once per process: the server is
      // long-lived, so repeating it before every new session would only add
      // an exec per launch. Best effort like the rest of this function.
      const clear = coreSpawn(
        [bin, ...tmuxSocketArgs(), "set-environment", "-g", "-u", "AGETOR_API_TOKEN"],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: tmuxEnv(bin) },
      );
      await clear.exited;
    }
  } catch {
    // Best-effort — swallow. See doc comment above.
  }
}

/**
 * Launch `tmux new-session` for a driver's detached hosting session. Async
 * (`Bun.spawn` + `await proc.exited`) so this fork+exec never blocks the
 * event loop that also serves the HTTP API — this used to be
 * `node:child_process`'s `spawnSync`, which stalled every concurrent request
 * for the duration of tmux's fork+exec (see
 * docs/plans/fix-task-details-load-delay.md). No timeout, mirroring
 * claude-tmux.ts's `tmux()` helper — an owner decision to keep behavior
 * unchanged beyond removing the block. Never throws; a spawn failure (e.g.
 * tmux not on PATH) folds into `stderr` the same way a non-zero exit does,
 * so callers only need one failure branch.
 *
 * Shared by codex-tmux.ts, cursor-tmux.ts, and gemini-tmux.ts — the
 * one-shot-per-turn drivers that each host a turn in a detached tmux
 * session. Hoisted here per docs/plans/tmux-sessions-killed-unexpectedly.md
 * ("every tmux invocation flows through the single choke point... no
 * parallel spawn logic") so the three drivers can't drift.
 */
export async function spawnTmuxNewSession(
  tmux: string,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  await ensureDisclaimedServer();
  try {
    const proc = coreSpawn([tmux, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: tmuxEnv(tmux),
    }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const status = await proc.exited;
    return { status, stderr: stderr.trim() };
  } catch (e) {
    return { status: null, stderr: (e as Error).message };
  }
}
