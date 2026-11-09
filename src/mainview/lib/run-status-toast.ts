/**
 * Which toast a top-level task's `run-status` event raises. Pure so the
 * harness-stack suppression is unit-testable (review S27).
 */
import type { GlobalEvent } from "../../shared/types.ts";

type RunStatusEvent = Extract<GlobalEvent, { kind: "run-status" }>;

/**
 * - `succeeded` → the success toast.
 * - `failed` / `orphaned` → the failure toast, EXCEPT when the settle is half
 *   of a harness-stack failover: `harness-swap` records the old run failed
 *   while the task keeps running on the next account, and `harness-exhausted`
 *   is owned by the blocked-column toast. Neither may read as "Task failed".
 * - `cancelled` → nothing (the user issued the cancel).
 */
export function runStatusToastKind(
  ev: Pick<RunStatusEvent, "status" | "reason">,
): "success" | "error" | null {
  if (ev.status === "succeeded") return "success";
  if (ev.status === "failed" || ev.status === "orphaned") {
    if (ev.reason === "harness-swap" || ev.reason === "harness-exhausted") return null;
    return "error";
  }
  return null;
}
