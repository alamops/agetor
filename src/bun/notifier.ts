/**
 * Resolves and builds argv for AgetorNotifier.app — our own native arm64
 * helper (native/notifier/, built by scripts/build-notifier.ts) that posts a
 * notification whose click opens `agetor://task/<id>` (see deep-link.ts).
 * Electrobun's own `Utils.showNotification` cannot carry a click URL and has
 * no identifier control, so we ship our own signed arm64
 * UNUserNotificationCenter helper. No third-party binary, no Rosetta.
 *
 * Task notifications post under one fixed id per task
 * (`taskNotificationId`), so a newer event replaces the task's entry and
 * shows on top; the helper decides the sound from what is still delivered
 * (see src/shared/os-notification.ts and the helper's header comment for the
 * CLI contract, including the `--remove` and `--list` modes).
 *
 * Pure and side-effect-free at import time so every function is trivially
 * unit-testable without spawning anything.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildTaskDeepLink } from "./deep-link.ts";
import {
  notificationUrgency,
  soundOverUrgencies,
  taskNotificationId,
  type DeliveredUrgency,
  type NotificationKind,
  type NotificationUrgency,
} from "../shared/os-notification.ts";

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
 *   4. The installed Agetor.app's helper (`resolveInstalledAppNotifier`), so a
 *      core running from source or a bare binary, with no bundle of its own,
 *      still posts through the signed helper.
 *
 * Returns `null` if nothing resolves. The deep-link notification is an
 * enhancement, so callers treat `null` (and a non-zero exit — e.g. the user
 * denied notification permission) as "post a plain Utils.showNotification
 * instead" (see task-notifier.ts).
 */
export function resolveNotifier(): string | null {
  const override = process.env.AGETOR_NOTIFIER_BIN;
  if (override) return override;

  for (const candidate of [bundledNotifierExe(), devNotifierExe()]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveInstalledAppNotifier();
}

/**
 * The resolved helper's `.app` bundle path (the parent of Contents/MacOS/…),
 * or null when the helper isn't a real bundle (e.g. an `AGETOR_NOTIFIER_BIN`
 * override pointing at a bare binary, or nothing resolved). Used to register
 * the bundle with LaunchServices so a notification click can relaunch it — we
 * spawn the inner Mach-O directly, which doesn't guarantee LS registration.
 */
export function resolveNotifierApp(): string | null {
  const exe = resolveNotifier();
  if (!exe) return null;
  const suffix = path.join("AgetorNotifier.app", "Contents", "MacOS", "notifier");
  if (!exe.endsWith(suffix)) return null;
  // <app>/Contents/MacOS/notifier -> <app>
  return path.dirname(path.dirname(path.dirname(exe)));
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
  /**
   * Fixed Notification Center request id (`taskNotificationId(taskId)`).
   * Without one the helper posts under a random id (the pre-dedupe
   * behavior) and never reads the delivered list.
   */
  id?: string;
  /** Event kind, stored on the entry so a conditional removal can match it. */
  kind?: NotificationKind;
  /** Stored on the entry so a later post can decide whether it escalates. */
  urgency?: NotificationUrgency;
  /** Delivered urgencies this post plays its sound over (`soundOverUrgencies`). */
  soundOver?: readonly DeliveredUrgency[];
}

/**
 * Builds the argv to pass to the notifier helper AFTER its path. Flag order is
 * fixed (title, message, subtitle, url, silent, id, kind, urgency, then one
 * `--sound-over` per entry) so output is deterministic and easy to assert on
 * in tests; the newer flags come last so the original order is unchanged. The
 * helper requires `--message` (empty allowed). Identity/icon come from the
 * helper's own signed bundle ("Agetor"), so there is no `--sender`.
 */
export function buildNotifierArgs(o: NotifierOptions): string[] {
  const args: string[] = ["--title", o.title, "--message", o.body ?? ""];

  if (o.subtitle) args.push("--subtitle", o.subtitle);
  if (o.url) args.push("--url", o.url);
  if (o.silent === true) args.push("--silent");
  if (o.id) args.push("--id", o.id);
  if (o.kind) args.push("--kind", o.kind);
  if (o.urgency) args.push("--urgency", o.urgency);
  for (const u of o.soundOver ?? []) args.push("--sound-over", u);

  return args;
}

/**
 * The full post argv for a task notification: the task's deep link, its
 * fixed id, the kind (when known), the kind's urgency and the escalation
 * table the helper applies against the delivered entry.
 */
export function buildTaskNotifierPostArgs(n: {
  title: string;
  body?: string;
  subtitle?: string;
  silent?: boolean;
  taskId: string;
  kind?: NotificationKind;
}): string[] {
  const urgency = notificationUrgency(n.kind);
  return buildNotifierArgs({
    title: n.title,
    body: n.body,
    subtitle: n.subtitle,
    silent: n.silent,
    url: buildTaskDeepLink(n.taskId),
    id: taskNotificationId(n.taskId),
    kind: n.kind,
    urgency,
    soundOver: soundOverUrgencies(urgency),
  });
}

/**
 * Argv for the helper's remove mode: drops the entry with `id` plus any
 * old-style entry carrying `url`; with `ifKinds`, only entries whose stored
 * kind is listed. Never asks for notification permission.
 */
export function buildNotifierRemoveArgs(o: {
  id: string;
  url: string;
  ifKinds?: readonly NotificationKind[];
}): string[] {
  const args = ["--remove", "--id", o.id, "--url", o.url];
  for (const k of o.ifKinds ?? []) args.push("--if-kind", k);
  return args;
}

/** Argv for the helper's list mode: prints each delivered `agetor://` url, one per line. */
export function buildNotifierListArgs(): string[] {
  return ["--list"];
}

// Acks. A helper built before the per-task id existed (a stale
// vendor/notifier under `bun run dev`) ignores `--id`, `--remove` and
// `--list`: posts still go out under random ids, and `--remove`/`--list` read
// as a click relaunch that waits ten seconds and exits 0 with no output. The
// helper prints these lines so agetor can tell it apart from a real success.

/** The first stdout line of the helper's `--list` mode. */
export const NOTIFIER_LIST_HEADER = "agetor-notifier list";

/** Whether `--list` stdout starts with {@link NOTIFIER_LIST_HEADER}. */
export function notifierListAcked(stdout: string): boolean {
  return stdout.split("\n", 1)[0]?.trim() === NOTIFIER_LIST_HEADER;
}

/** Whether `--remove` stdout carries the helper's `removed <n>` line. */
export function notifierRemoveAcked(stdout: string): boolean {
  return /^removed \d+$/m.test(stdout);
}

/** Whether a post's stdout confirms it was delivered under `id`. */
export function notifierPostAcked(stdout: string, id: string): boolean {
  return stdout.split("\n").some((line) => line.trim() === `posted ${id}`);
}

/** The helper's path under an Agetor.app bundle. */
const APP_NOTIFIER_SUFFIX = path.join(
  "Contents", "Resources", "app", "bin", "AgetorNotifier.app", "Contents", "MacOS", "notifier",
);

/**
 * The installed Agetor.app's helper, for processes that aren't the app (the
 * CLI, a background core): `AGETOR_NOTIFIER_BIN` wins (returned as-is), else
 * the helper in `/Applications/Agetor.app`, else in `~/Applications/Agetor.app`
 * (the two places the login item may be registered from), else null. Posting
 * through the same signed helper keeps these posts in the app's Notification
 * Center scope, so they share the per-task id with the app's own posts.
 * `home` and `exists` are test seams; the home is read at call time.
 */
export function resolveInstalledAppNotifier(
  opts: { home?: string; exists?: (p: string) => boolean } = {},
): string | null {
  const override = process.env.AGETOR_NOTIFIER_BIN;
  if (override) return override;
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  for (const root of ["/Applications", path.join(home, "Applications")]) {
    const candidate = path.join(root, "Agetor.app", APP_NOTIFIER_SUFFIX);
    if (exists(candidate)) return candidate;
  }
  return null;
}
