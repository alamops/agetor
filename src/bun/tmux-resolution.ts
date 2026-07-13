import { existsSync } from "node:fs";
import path from "node:path";
import { preferences } from "./db.ts";

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
 * Which tmux server socket to talk to, or `null` for tmux's own default
 * socket (`/tmp/tmux-<uid>/default`) — i.e. today's byte-identical behavior.
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
 *   3. Otherwise `null` — production default socket, unchanged.
 */
export function tmuxSocketName(): string | null {
  const override = process.env.AGETOR_TMUX_SOCKET;
  if (override) return override === "default" ? null : override;
  if (process.env.NODE_ENV === "test") return "agetor-test";
  return null;
}

/** `["-L", <socket>]` for `tmuxSocketName()`, or `[]` to use tmux's default
 *  socket. Spread directly after the tmux binary in every spawn site — see
 *  `tmuxSocketName()` for why this must be threaded through unconditionally. */
export function tmuxSocketArgs(): string[] {
  const name = tmuxSocketName();
  return name ? ["-L", name] : [];
}
