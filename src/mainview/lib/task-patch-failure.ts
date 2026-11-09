/**
 * How a failed RunPanel task PATCH reads. Pure so the "which failures toast"
 * rule is unit-testable without a DOM.
 *
 * Most RunPanel PATCHes (mode, model, effort, speed, max mode) are optimistic
 * dropdown changes: a failure stays quiet and the parent's 2 s task poll
 * reverts the dropdown on its own. An account switch (`agent`) is different:
 * the server can refuse it for a reason the user must see (a same-stack move
 * while the task is running or held, a destination whose config root failed
 * the path gate, a move that could not copy the session), and a silent
 * revert looks like the click did nothing (review N8). So an `agent` patch
 * surfaces the server's own error message.
 */
import { ApiTransitError } from "./net-retry.ts";

export interface TaskPatchFailureToast {
  title: string;
  description: string;
}

/** The toast for a failed task PATCH, or null when the failure stays quiet. */
export function taskPatchFailureToast(
  patch: { agent?: unknown },
  error: unknown,
): TaskPatchFailureToast | null {
  if (typeof patch.agent !== "string") return null;
  if (error instanceof ApiTransitError) {
    // The PATCH is not retried after a transit failure, so it MAY have
    // landed; the next task poll shows which account the task is on.
    return {
      title: "Couldn't confirm the account switch",
      description: "The connection dropped before agetor answered — the switch may have gone through.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    title: "Couldn't switch account",
    description: message.trim() === "" ? "agetor refused the switch." : message,
  };
}
