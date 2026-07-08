/**
 * Resolves and builds argv for AgetorNotifier.app — our own native arm64
 * helper (native/notifier/, built by scripts/build-notifier.ts) that posts a
 * notification whose click opens `agetor://task/<id>` (see deep-link.ts).
 * Electrobun's own `Utils.showNotification` cannot carry a click URL, and
 * terminal-notifier's only prebuilt release is x86_64-only — so we ship our
 * own signed arm64 UNUserNotificationCenter helper. No third-party binary, no
 * Rosetta.
 *
 * Pure and side-effect-free at import time so both functions are trivially
 * unit-testable without spawning anything.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The helper's executable path inside the packaged .app, mirroring
 * tmux-resolution.ts's bundled-path shape: binaries are copied under
 * `Contents/Resources/app/bin` at build time (electrobun.config.ts build.copy
 * maps `vendor/notifier` there, giving `bin/AgetorNotifier.app`).
 */
function bundledNotifierExe(): string {
  const bin = path.join(path.dirname(process.execPath), "..", "Resources", "app", "bin");
  return path.join(bin, "AgetorNotifier.app", "Contents", "MacOS", "notifier");
}

/**
 * The locally-built helper, used when running from source (`bun run dev`)
 * rather than the packaged .app. Resolved relative to this module's location
 * inside the repo (src/bun/ -> repo root -> vendor/notifier/...).
 */
function devNotifierExe(): string {
  return path.join(
    import.meta.dir, "..", "..",
    "vendor", "notifier", "AgetorNotifier.app", "Contents", "MacOS", "notifier",
  );
}

/**
 * Single source of truth for the notifier helper path. Precedence:
 *   1. AGETOR_NOTIFIER_BIN env override (tests + power users) — returned
 *      as-is, matching AGETOR_TMUX_BIN's contract.
 *   2. The helper bundled inside the packaged app.
 *   3. The locally-built helper under vendor/ (dev runs from source).
 *
 * Returns `null` if nothing resolves. The deep-link notification is an
 * enhancement, so callers treat `null` (and a non-zero exit — e.g. the user
 * denied notification permission) as "post a plain Utils.showNotification
 * instead" (see showTaskNotification in index.ts).
 */
export function resolveNotifier(): string | null {
  const override = process.env.AGETOR_NOTIFIER_BIN;
  if (override) return override;

  for (const candidate of [bundledNotifierExe(), devNotifierExe()]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface NotifierOptions {
  title: string;
  body?: string;
  subtitle?: string;
  /**
   * The helper plays the default sound unless muted. Only an explicit
   * `silent === true` passes `--silent`; `false`/`undefined` let the sound
   * play (the normal case — the /notifications route sends a real boolean).
   */
  silent?: boolean;
  /** Deep-link URL to open on click, e.g. buildTaskDeepLink(taskId). */
  url?: string;
}

/**
 * Builds the argv to pass to the notifier helper AFTER its path. Flag order is
 * fixed (title, message, subtitle, url, silent) so output is deterministic and
 * easy to assert on in tests. The helper requires `--message` (empty allowed).
 * Identity/icon come from the helper's own signed bundle ("Agetor"), so there
 * is no `--sender`.
 */
export function buildNotifierArgs(o: NotifierOptions): string[] {
  const args: string[] = ["--title", o.title, "--message", o.body ?? ""];

  if (o.subtitle) args.push("--subtitle", o.subtitle);
  if (o.url) args.push("--url", o.url);
  if (o.silent === true) args.push("--silent");

  return args;
}
