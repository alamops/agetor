import { approvePlan, setEditedContent } from "../../task-plans.ts";
import { defineOp } from "./define.ts";

// Read-check-write units of the HTTP routes (`src/bun/server.ts`) that were
// atomic while the routes ran synchronous queries on the main thread, and
// would race a concurrent write across the await between their read and their
// write now that every query is a hop to the database worker.

export const serverOps = {
  /** Plan approve's undo: put a task's mode back to `mode`, but only while it
   *  is still the `auto` the approve request wrote, so a concurrent edit of
   *  the mode wins. Returns whether the mode was put back. */
  "server.revertModeIfAuto": defineOp({
    tx: true,
    run: ({ modules }, taskId: string, mode: string | null): boolean => {
      if (modules.tasks.get(taskId)?.mode !== "auto") return false;
      modules.tasks.update(taskId, { mode });
      return true;
    },
  }),

  /** `PATCH /tasks/:id/plans/:planId`: set (or clear, with `null`) a pending
   *  plan's draft edit, reading and writing `plans` in one transaction so a
   *  plan detected meanwhile (`orchestrator.applyPlanChange`) is never
   *  overwritten with a stale array. `"missing"` when the task is gone,
   *  `"not-pending"` when the plan is unknown or no longer pending. */
  "server.setPlanEditedContent": defineOp({
    tx: true,
    run: ({ modules }, taskId: string, planId: string, editedContent: string | null): "ok" | "missing" | "not-pending" => {
      const task = modules.tasks.get(taskId);
      if (!task) return "missing";
      const next = setEditedContent(task.plans, planId, editedContent);
      if (!next) return "not-pending";
      modules.tasks.update(taskId, { plans: next });
      return "ok";
    },
  }),
  /** `POST /tasks/:id/plans/:planId/approve`, the persist step after the
   *  approval message was delivered: re-read `plans` and flip only the target
   *  plan to approved, in one transaction, so a plan detected, edited or
   *  reverted during the (slow) send is never overwritten by a stale array.
   *  `approvedEdited` comes from the caller's snapshot, the version whose text
   *  was actually sent. Returns the updated task, `"missing"` when it is gone,
   *  `"not-pending"` when the plan is no longer pending (or no longer exists). */
  "server.approvePlan": defineOp({
    tx: true,
    run: (
      { modules },
      taskId: string,
      planId: string,
      opts: { now: number; filePath: string | null; approvedEdited: boolean },
    ) => {
      const task = modules.tasks.get(taskId);
      if (!task) return "missing" as const;
      const result = approvePlan(task.plans, planId, { now: opts.now, filePath: opts.filePath });
      if (!result) return "not-pending" as const;
      const plans = result.plans.map((p) => (p.id === planId ? { ...p, approvedEdited: opts.approvedEdited } : p));
      return modules.tasks.update(taskId, { plans }) ?? ("missing" as const);
    },
  }),
};
