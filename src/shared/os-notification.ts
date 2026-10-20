/**
 * The OS-notification policy shared by the webview, the Bun core and the CLI:
 * which event kinds exist, how loud each one is, and the fixed per-task
 * Notification Center id. Pure and import-free (src/shared rule) so all three
 * processes and their tests can use it. Decisions D1–D5 and D10 live in
 * docs/plans/duplicated-macos-notifications-grill.md.
 *
 * - D1/D14: a task owns at most one Notification Center entry, posted under
 *   `taskNotificationId(taskId)`. Re-posting the same id from a new helper
 *   process replaces the delivered entry and moves it to the top.
 * - D2–D5: the sound plays when the task has no delivered entry, or when a
 *   `needs-you` event replaces a `quiet` one. Every other replacement is a
 *   silent banner. "Unopened" means "still delivered", which only the helper
 *   can see, so Bun hands it the escalation table (`soundOverUrgencies`) and
 *   the helper reads the delivered entry's stored urgency.
 * - D10: entries posted by older versions carry a random id and no urgency.
 *   They read as `unknown`, which escalates like `quiet`.
 */

/** Every event kind that can post an OS notification for a task. */
export const NOTIFICATION_KINDS = [
  "waiting",
  "blocked",
  "api-error",
  "session-ended",
  "unknown-command",
  "failed",
  "succeeded",
  "files-sent",
  "pipeline-finished",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** How loud a kind is (D4). */
export type NotificationUrgency = "needs-you" | "quiet";

/** A delivered entry's urgency; `unknown` = an entry stored without one (old-style, D10). */
export type DeliveredUrgency = NotificationUrgency | "unknown";

/**
 * Remove a task's entry. With `ifKinds`, only an entry whose stored kind is
 * listed is removed (an old-style entry has no kind, so it never matches).
 */
export interface TaskNotificationRemoval {
  taskId: string;
  ifKinds?: readonly NotificationKind[];
}

const KIND_SET: ReadonlySet<string> = new Set(NOTIFICATION_KINDS);

export function isNotificationKind(v: unknown): v is NotificationKind {
  return typeof v === "string" && KIND_SET.has(v);
}

const NEEDS_YOU_KINDS: ReadonlySet<NotificationKind> = new Set([
  "waiting",
  "blocked",
  "api-error",
  "session-ended",
  "unknown-command",
  "failed",
]);

/** D4: kinds that need the user are `needs-you`; the rest (and no kind) are `quiet`. */
export function notificationUrgency(kind: NotificationKind | undefined): NotificationUrgency {
  return kind !== undefined && NEEDS_YOU_KINDS.has(kind) ? "needs-you" : "quiet";
}

const SOUND_OVER: Record<NotificationUrgency, readonly DeliveredUrgency[]> = {
  "needs-you": ["quiet", "unknown"],
  quiet: [],
};

/**
 * The delivered urgencies a new post of urgency `u` plays its sound over (D3):
 * `needs-you` escalates a `quiet` (or `unknown`) entry, nothing escalates a
 * `needs-you` entry, and a `quiet` post never escalates.
 */
export function soundOverUrgencies(u: NotificationUrgency): readonly DeliveredUrgency[] {
  return SOUND_OVER[u];
}

/** The fixed Notification Center request id for a task (D1). */
export function taskNotificationId(taskId: string): string {
  return `agetor.task.${taskId}`;
}

/** Kinds an answered question removes (D6b): only the question's own entry. */
export const ANSWERED_REMOVAL_KINDS: readonly NotificationKind[] = ["waiting"];

/**
 * Kinds a task leaving `blocked` removes (D6b) — the "reason" family. Mirrors
 * the in-app `dismissPending` on `prev === "blocked"`.
 */
export const UNBLOCKED_REMOVAL_KINDS: readonly NotificationKind[] = [
  "waiting",
  "blocked",
  "api-error",
  "session-ended",
  "unknown-command",
];
