/**
 * The focused-window rule (D7) for a task's Notification Center entry, shared by the core's notification policy
 * (src/bun/notification-policy.ts) and the webview's toast-slot tests. Moved verbatim from
 * src/mainview/lib/toast-slots.ts when the decision moved into the core (grill D5). Pure; no imports.
 */

/** What the notification policy does with one event's OS notification. */
export type OsNotifyAction = "post" | "clear" | "keep";

/**
 * The focused-window (D7) rule for a task's Notification Center entry, plus
 * the one exception the plan carves out of it: an event that FORCES its post
 * while the window is focused (a proactive "Files sent") still posts, and
 * that entry must outlive the task's next focused event, which would
 * otherwise remove it a few seconds later (usually the same turn's own
 * "succeeded"). Pure — `notification-policy.ts` performs the action.
 *
 * A task keeps that protection until it is opened, archived or deleted
 * (`forget`, via `dismissTaskToast`) or until a later unfocused post replaces
 * the entry. Window focus with the task open (D6d) still clears it: the user
 * is then looking at the task.
 */
export class FocusedForcedPosts {
  private readonly tasks = new Set<string>();

  decide(taskId: string, s: { isFocused: boolean; force: boolean }): OsNotifyAction {
    if (s.isFocused && !s.force) return this.tasks.has(taskId) ? "keep" : "clear";
    if (s.isFocused) this.tasks.add(taskId);
    else this.tasks.delete(taskId);
    return "post";
  }

  forget(taskId: string): void {
    this.tasks.delete(taskId);
  }
}
