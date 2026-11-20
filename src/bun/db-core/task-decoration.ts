import type { Task } from "../../shared/types.ts";
import type { TaskDecorationDeps } from "./tasks.ts";

// The pure arithmetic behind a Task's two main-thread badge counts
// (`pendingInteractionCount`, `openTerminalCount`). `tasks.list()` uses
// `foldPipelineStepCounts` when it runs on the connection that owns the
// registries; `db-async.ts` uses all three to overlay the same numbers onto a
// Task read by the worker (which reports zero), so both paths give identical
// results.

/** D11: a pipeline parent task never has interactions registered against its own
 *  (hidden, agent-less) id: every interaction happens on the currently-active
 *  hidden step task. Fold each step's pending count into its parent's, in one
 *  O(n) pass, so the parent card's "waiting on you" glow is honest without every
 *  consumer (board, CLI, TUI) having to know about the parent/step split.
 *  Mutates and returns `pending`. */
export function foldPipelineStepCounts(
  pending: Map<string, number>,
  rows: Iterable<{ id: string; pipelineParentId?: string | null }>,
): Map<string, number> {
  for (const r of rows) {
    if (!r.pipelineParentId) continue;
    const stepCount = pending.get(r.id);
    if (!stepCount) continue;
    pending.set(r.pipelineParentId, (pending.get(r.pipelineParentId) ?? 0) + stepCount);
  }
  return pending;
}

/** `tasks.list()` shape: grouped counts with the pipeline fold applied. */
export function decorateTaskList(tasks: readonly Task[], decor: TaskDecorationDeps): Task[] {
  const pending = foldPipelineStepCounts(decor.pendingCountsByTask(), tasks);
  const terminals = decor.terminalCountsByTask();
  return tasks.map((t) => ({
    ...t,
    pendingInteractionCount: pending.get(t.id) ?? 0,
    openTerminalCount: terminals.get(t.id) ?? 0,
  }));
}

/** A single-task read (`insert`, `update`, `markSeen`, …): the task's own counts. */
export function decorateTask(task: Task, decor: TaskDecorationDeps): Task {
  return {
    ...task,
    pendingInteractionCount: decor.countPendingForTask(task.id),
    openTerminalCount: decor.countTerminals(task.id),
  };
}

/** `tasks.get()` shape: a pipeline parent (`pipelineId` set) adds its hidden
 *  steps' pending counts (M17), so it agrees with the board's list poll. */
export function decorateTaskWithSteps(task: Task, steps: readonly Task[], decor: TaskDecorationDeps): Task {
  const own = decorateTask(task, decor);
  if (!task.pipelineId) return own;
  let stepPending = 0;
  for (const step of steps) stepPending += decor.countPendingForTask(step.id);
  return stepPending > 0 ? { ...own, pendingInteractionCount: own.pendingInteractionCount + stepPending } : own;
}
