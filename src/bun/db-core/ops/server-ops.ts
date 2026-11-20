import { setEditedContent } from "../../task-plans.ts";
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
};
