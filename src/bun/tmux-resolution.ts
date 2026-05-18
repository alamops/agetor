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
