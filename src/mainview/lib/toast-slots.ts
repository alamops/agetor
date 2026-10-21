import { UNBLOCKED_REMOVAL_KINDS, type NotificationKind } from "../../shared/os-notification.ts";

/**
 * Every kind that can occupy a task's in-app toast slot: the OS-notification
 * kinds plus the three toast-only event kinds (they never post an OS entry).
 */
export type TaskToastKind =
  | NotificationKind
  | "send-failed"
  | "fx-auto-resume-fired"
  | "fx-auto-resume-exhausted";

export interface TaskToastEntry {
  /** The sonner toast id. */
  id: string | number;
  kind: TaskToastKind;
}

const REASON_KINDS: ReadonlySet<TaskToastKind> = new Set<TaskToastKind>(UNBLOCKED_REMOVAL_KINDS);

/**
 * The one-toast-per-task bookkeeping behind `toasts.ts` (D12/D13): a task owns
 * at most one live event toast, keyed by task id. Pure — no sonner, no api —
 * so the slot rules are unit-testable on their own.
 *
 * "Reason" kinds are the ones a task leaving `blocked` makes stale
 * (`UNBLOCKED_REMOVAL_KINDS`); the others (success, failed, files sent, …)
 * stay until the user dismisses them or a newer event replaces them.
 */
export class TaskToastSlots {
  private readonly entries = new Map<string, TaskToastEntry>();

  /** Put `id` in `taskId`'s slot and return the entry it displaced, if any. */
  set(taskId: string, id: string | number, kind: TaskToastKind): TaskToastEntry | undefined {
    const prior = this.entries.get(taskId);
    this.entries.set(taskId, { id, kind });
    return prior;
  }

  get(taskId: string): TaskToastEntry | undefined {
    return this.entries.get(taskId);
  }

  /** Clear the slot only while `id` is still its current toast. A displaced
   *  toast's late `onDismiss` therefore can't free its successor's slot. */
  release(taskId: string, id: string | number): void {
    if (this.entries.get(taskId)?.id === id) this.entries.delete(taskId);
  }

  /** Remove and return the slot's entry. With `onlyReason`, a non-reason kind
   *  is left in place and `undefined` is returned. */
  take(taskId: string, opts?: { onlyReason?: boolean }): TaskToastEntry | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;
    if (opts?.onlyReason && !REASON_KINDS.has(entry.kind)) return undefined;
    this.entries.delete(taskId);
    return entry;
  }

  /** Whether the slot holds a reason-family toast. */
  isReason(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    return entry !== undefined && REASON_KINDS.has(entry.kind);
  }
}

/** What `maybeNotifyOS` does with one event's OS notification. */
export type OsNotifyAction = "post" | "clear" | "keep";

/**
 * The focused-window (D7) rule for a task's Notification Center entry, plus
 * the one exception the plan carves out of it: an event that FORCES its post
 * while the window is focused (a proactive "Files sent") still posts, and
 * that entry must outlive the task's next focused event, which would
 * otherwise remove it a few seconds later (usually the same turn's own
 * "succeeded"). Pure — `toasts.ts` performs the action.
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
