/**
 * Resolves and builds argv for `terminal-notifier`, a macOS CLI that can
 * post a notification whose click runs `open <url>` — the mechanism agetor
 * uses to deep-link a notification click back into a task via
 * `agetor://task/<id>` (see deep-link.ts). Electrobun's own
 * `Utils.showNotification` cannot carry a click URL, so this is the
 * deep-link-capable path.
 *
 * Pure and side-effect-free at import time so both functions are trivially
 * unit-testable without spawning anything.
 *
 * We deliberately do NOT bundle terminal-notifier: the only prebuilt release
 * (v2.0.0) is x86_64-only, and agetor is arm64-only with a hard no-Rosetta
 * rule (Apple is sunsetting Rosetta). So the binary is resolved from the
 * user's PATH — an arm64 build, e.g. `brew install terminal-notifier`. When
 * it's absent (or a resolved binary fails to launch), callers fall back to a
 * plain, non-deep-linking notification, so the feature degrades cleanly
 * rather than depending on a translated x86_64 binary.
 */

/**
 * Single source of truth for the terminal-notifier binary path. Precedence:
 *   1. AGETOR_TERMINAL_NOTIFIER_BIN env override (tests + power users) —
 *      returned as-is, never bypassed, matching AGETOR_TMUX_BIN's contract.
 *   2. System PATH lookup via Bun.which (expects an arm64 build).
 *
 * Returns `null` if nothing resolves. terminal-notifier is an optional
 * enhancement (deep-linkable notifications), so callers treat `null` as
 * "post a plain notification instead" rather than attempt a spawn that will
 * fail. A resolved binary that turns out to be the wrong arch / otherwise
 * unlaunchable is handled at the call site by falling back on a non-zero
 * exit (see showTaskNotification in index.ts).
 */
export function resolveNotifier(): string | null {
  const override = process.env.AGETOR_TERMINAL_NOTIFIER_BIN;
  if (override) return override;

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
