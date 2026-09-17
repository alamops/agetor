// Resolver + gating for the "disclaim" helper (native/disclaim/disclaim.c,
// built by scripts/build-disclaim.ts into vendor/disclaim/disclaim). See
// docs/plans/stop-agetor-tcc-appdata-spam.md for the full design: macOS's
// TCC attributes a spawned child's data-access prompts to whichever
// ancestor is the "responsible process" — by default, whoever spawned it.
// Agetor spawns tmux, which hosts claude/codex/cursor/gemini, so every one
// of those descendants inherits Agetor's responsibility, and a prompt like
// "Agetor would like to access data from other apps" never persists a grant
// (the responsible identity, Agetor, differs from the accessing binary).
// Running a child through `disclaim <cmd> [args...]` marks it responsible
// for itself instead, so any resulting prompt names the real accessor and
// its grant persists normally. This module only resolves the helper's path
// and decides whether to use it — the actual spawn-site wiring (tmux
// server start, fx's Bun.spawn) is a separate task.

import { existsSync } from "node:fs";
import path from "node:path";
import { preferences } from "./db.ts";

/** Preference key gating whether spawned agents get disclaimed. Exported so
 *  the Settings UI (a separate task) references the same string rather than
 *  duplicating the literal. */
export const DISCLAIM_PREF_KEY = "disclaimSpawnedAgents";

/**
 * Where the bundled disclaim helper lives at runtime. Two locations:
 *   - packaged: <bun>/../Resources/app/bin/disclaim (inside the .app)
 *   - dev:     <repo>/vendor/disclaim/disclaim
 * The first match wins; if neither exists we still return the packaged path
 * so callers get a deterministic, debuggable error ("ENOENT <expected path>")
 * instead of a generic "command not found". Mirrors
 * src/bun/tmux-resolution.ts:bundledTmuxPath().
 */
export function bundledDisclaimPath(): string {
  const packaged = path.join(
    path.dirname(process.execPath),
    "..",
    "Resources",
    "app",
    "bin",
    "disclaim",
  );
  if (existsSync(packaged)) return packaged;
  const dev = path.join(process.cwd(), "vendor", "disclaim", "disclaim");
  if (existsSync(dev)) return dev;
  return packaged;
}

/**
 * Single source of truth for the disclaim binary path. Precedence:
 *   1. AGETOR_DISCLAIM_BIN env override (tests + power users).
 *   2. The bundled helper (packaged path, else dev fallback).
 */
export function resolveDisclaimBin(): string {
  return process.env.AGETOR_DISCLAIM_BIN || bundledDisclaimPath();
}

/** True when the resolved disclaim binary is actually present on disk. */
export function disclaimAvailable(): boolean {
  const override = process.env.AGETOR_DISCLAIM_BIN;
  if (override) return existsSync(override);
  // Don't auto-discover the built helper under `bun test`: a test run must not
  // spawn `disclaim` as a side effect (Gatekeeper cold-exec timing flakes, a
  // stray disclaimed tmux server). Tests that exercise the wrap opt in via the
  // AGETOR_DISCLAIM_BIN override (the branch above), mirroring tmux-resolution's
  // NODE_ENV socket handling. Production/dev discovery is unaffected.
  if (process.env.NODE_ENV === "test") return false;
  return existsSync(bundledDisclaimPath());
}

/**
 * Pure decision function — kept separate from disclaimEnabled() so the truth
 * table is unit-testable without touching process.platform / preferences /
 * the filesystem.
 */
export function computeDisclaimEnabled(opts: {
  platform: NodeJS.Platform;
  prefDisabled: boolean;
  available: boolean;
}): boolean {
  return opts.platform === "darwin" && !opts.prefDisabled && opts.available;
}

/**
 * Whether spawned agents should be run through the disclaim helper right
 * now. Default ON — only the literal preference value "false" disables it
 * (fail-open: an unset/corrupt preference, a non-darwin host, or a missing
 * helper binary all resolve safely without throwing).
 */
export function disclaimEnabled(): boolean {
  return computeDisclaimEnabled({
    platform: process.platform,
    prefDisabled: preferences.get(DISCLAIM_PREF_KEY) === "false",
    available: disclaimAvailable(),
  });
}

/**
 * Wrap a command argv with the disclaim helper when enabled, else return it
 * unchanged. Spread the result directly into Bun.spawn / a tmux command
 * builder in place of the raw argv.
 */
export function disclaimArgv(argv: string[]): string[] {
  if (!disclaimEnabled()) return argv;
  return [resolveDisclaimBin(), ...argv];
}
