/**
 * Resolves and builds argv for `terminal-notifier`, a macOS CLI that can
 * post a notification whose click runs `open <url>` — the mechanism agetor
 * uses to deep-link a notification click back into a task via
 * `agetor://task/<id>` (see deep-link.ts). Electrobun's own
 * `Utils.showNotification` cannot carry a click URL, so this is the
 * deep-link-capable path.
 *
 * Pure and side-effect-free at import time (mirrors tmux-resolution.ts's
 * conventions for binary resolution) so both functions are trivially
 * unit-testable without spawning anything.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where a bundled terminal-notifier could live inside the packaged .app,
 * mirroring tmux-resolution.ts's bundledTmuxPath(): binaries are copied to
 * `Contents/Resources/app/bin` at build time.
 *
 * terminal-notifier normally ships as a `.app` bundle, so its real
 * executable is nested at
 *   bin/terminal-notifier.app/Contents/MacOS/terminal-notifier
 * We also accept a plain `bin/terminal-notifier` file in case a future
 * packaging step flattens or symlinks it — both candidates are checked and
 * whichever exists on disk wins (bundle path first).
 */
function bundledNotifierCandidates(): string[] {
  const bin = path.join(path.dirname(process.execPath), "..", "Resources", "app", "bin");
  return [
    path.join(bin, "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier"),
    path.join(bin, "terminal-notifier"),
  ];
}

/**
 * Single source of truth for the terminal-notifier binary path. Precedence:
 *   1. AGETOR_TERMINAL_NOTIFIER_BIN env override (tests + power users) —
 *      returned as-is, never bypassed, matching AGETOR_TMUX_BIN's contract.
 *   2. The bundled binary inside the packaged app, checking both the
 *      `.app` bundle shape and a plain-file fallback.
 *   3. System PATH lookup via Bun.which.
 *
 * Returns `null` if nothing resolves — unlike resolveTmuxBin, tmux is a hard
 * prereq for agetor so it falls back to the literal string "tmux" for a
 * deterministic spawn error; terminal-notifier is an optional enhancement
 * (deep-linkable notifications), so callers should treat `null` as "skip
 * notifying" rather than attempt a spawn that will fail.
 */
export function resolveNotifier(): string | null {
  const override = process.env.AGETOR_TERMINAL_NOTIFIER_BIN;
  if (override) return override;

  for (const candidate of bundledNotifierCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  return Bun.which("terminal-notifier", { PATH: process.env.PATH }) ?? null;
}

export interface NotifierOptions {
  title: string;
  body?: string;
  subtitle?: string;
  /**
   * terminal-notifier is silent by default and only plays a sound when
   * `-sound <name>` is passed. We mirror that default: only an *explicit*
   * `silent === false` opts into a sound; `undefined` or `true` stays
   * silent. See buildNotifierArgs for the exact mapping.
   */
  silent?: boolean;
  /** Deep-link URL to open on click, e.g. buildTaskDeepLink(taskId). */
  url?: string;
  /** Bundle id to post under (icon/identity), e.g. "sh.alamops.agetor". */
  sender?: string;
}

/**
 * Builds the argv to pass to terminal-notifier AFTER the binary path.
 * Flag order is fixed (title, message, subtitle, open, sender, sound) so
 * output is deterministic and easy to assert on in tests.
 */
export function buildNotifierArgs(o: NotifierOptions): string[] {
  // -message is required by terminal-notifier even with no body.
  const args: string[] = ["-title", o.title, "-message", o.body ?? ""];

  if (o.subtitle) args.push("-subtitle", o.subtitle);
  if (o.url) args.push("-open", o.url);
  if (o.sender) args.push("-sender", o.sender);

  // Sound mapping: terminal-notifier plays no sound unless told to. Only an
  // explicit `silent: false` requests the default sound; `silent: true` and
  // the unset/undefined default both stay silent.
  if (o.silent === false) args.push("-sound", "default");

  return args;
}
