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
import { memberReasonText } from "../../shared/harness-stack.ts";
import type { SwitchAccountRefusal } from "../../shared/types.ts";
import { ApiError } from "./api.ts";
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

/**
 * The toast for a failed "Switch to next account" (`POST
 * /tasks/:id/switch-account`). A 409 refusal carries a `SwitchAccountRefusal`
 * body: when it lists per-member reasons they read one after another
 * ("No other account can take this task: Work: cooling until 15:00; …").
 * Labels and reasons are data and rendered as text by the toast.
 */
export function switchAccountFailureToast(error: unknown): TaskPatchFailureToast {
  if (error instanceof ApiTransitError) {
    return {
      title: "Couldn't confirm the account switch",
      description: "The connection dropped before agetor answered — the switch may have gone through.",
    };
  }
  const body = error instanceof ApiError ? (error.body as Partial<SwitchAccountRefusal> | null) : null;
  // The per-member heading fits only the no-usable-member refusal (or an older
  // core that sent no code); any other code reads as the core's own sentence.
  const memberRefusal = body?.code === "no-usable-member" || body?.code === undefined;
  const reasons = memberRefusal && Array.isArray(body?.reasons) ? body.reasons : [];
  if (reasons.length > 0) {
    return {
      title: "Couldn't switch account",
      description: `No other account can take this task: ${reasons.map(memberReasonText).join("; ")}`,
    };
  }
  const message = typeof body?.error === "string" && body.error.trim() !== ""
    ? body.error
    : error instanceof Error ? error.message : String(error);
  return {
    title: "Couldn't switch account",
    description: message.trim() === "" ? "agetor refused the switch." : message,
  };
}
