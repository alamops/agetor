/**
 * Server-side "the reason went away" triggers for a task's OS notification
 * (D6b): a question answered from any client (webview, CLI, terminal, the
 * scraper noticing the modal closed) and a task leaving `blocked`. Both ride
 * the global event bus, so they fire wherever the change came from. The
 * desktop app installs the hook (index.ts); a headless core installs it through
 * `installHeadlessNotifications()` when its own notifications are on.
 *
 * The removals are conditional on the entry's stored kind, so an answer never
 * wipes a newer "Task succeeded" entry, and an answer only removes the entry
 * once no other question is still pending for the task (for a pipeline
 * parent, across its steps).
 *
 * No side effects at module load.
 */

import { tasks } from "./db.ts";
import { countPendingForTask } from "./interactions.ts";
import { subscribeGlobal } from "./orchestrator.ts";
import type { GlobalEvent } from "../shared/types.ts";
import {
  ANSWERED_REMOVAL_KINDS,
  UNBLOCKED_REMOVAL_KINDS,
  type TaskNotificationRemoval,
} from "../shared/os-notification.ts";

/**
 * The task that owns the OS notification for `taskId`: a hidden pipeline
 * step's events are retargeted to its parent (D16), so a step maps to its
 * parent. Anything else — including an unknown id — maps to itself.
 */
export function notificationTargetTaskId(taskId: string): string {
  try {
    return tasks.get(taskId)?.pipelineParentId ?? taskId;
  } catch {
    return taskId;
  }
}

/** Pending questions for a task; for a pipeline parent, its own plus every step's. */
export function pendingInteractionsFor(taskId: string): number {
  let n = countPendingForTask(taskId);
  try {
    if (tasks.get(taskId)?.pipelineId) {
      for (const step of tasks.stepsForParent(taskId)) n += countPendingForTask(step.id);
    }
  } catch {
    // A db hiccup must not turn into a removal: report "still pending".
    return Math.max(n, 1);
  }
  return n;
}

/**
 * The removal a global event implies, or null.
 *
 * - `interaction` resolved → the asking task's (or its pipeline parent's)
 *   `waiting` entry, once nothing else is pending for it. `fanoutResolved`
 *   runs after the resolved card left its map, so the count already
 *   excludes it.
 * - `column` leaving `blocked` → the reason-family kinds. A hidden step's
 *   own column change never removes the parent's entry; the parent's own
 *   column events cover it.
 */
export function removalForEvent(
  ev: GlobalEvent,
  deps: { pendingFor?: (taskId: string) => number } = {},
): TaskNotificationRemoval | null {
  if (ev.kind === "interaction" && ev.state === "resolved") {
    const target = ev.pipelineParentId ?? ev.taskId;
    const pendingFor = deps.pendingFor ?? pendingInteractionsFor;
    if (pendingFor(target) > 0) return null;
    return { taskId: target, ifKinds: ANSWERED_REMOVAL_KINDS };
  }
  if (ev.kind === "column" && ev.prev === "blocked" && ev.column !== "blocked" && !ev.pipelineParentId) {
    return { taskId: ev.taskId, ifKinds: UNBLOCKED_REMOVAL_KINDS };
  }
  return null;
}

/** Subscribes the removal triggers to the global bus; returns the unsubscribe. */
export function installNotificationRemovalHooks(
  remove: (r: TaskNotificationRemoval) => void,
): () => void {
  return subscribeGlobal((ev) => {
    try {
      const removal = removalForEvent(ev);
      if (removal) remove(removal);
    } catch (err) {
      console.error("[agetor] notification removal hook failed:", err);
    }
  });
}
