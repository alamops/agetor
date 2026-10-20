import type { Task } from "../../shared/types.ts";

/**
 * Pipeline parents whose "Pipeline needs you" alert is owed: a step's
 * retargeted "Waiting on you" toast held the parent's one toast slot while
 * the run was (or became) blocked, so the block alert was suppressed or
 * displaced. Answering that question dismisses the waiting toast and the
 * server removes the waiting OS entry; if another step still blocks the run,
 * App.tsx raises the owed alert then, so the block is not left with only the
 * card glow. Pure bookkeeping — App.tsx checks the tracker and the toast slot
 * and shows the toast.
 *
 * Each owed parent remembers the steps whose questions were answered since:
 * the runner records a question left pending at a step's settle as a
 * `step-blocked` block on that step, and that block lasts until the step runs
 * again. Such a block is not a reason to alert, so it is ignored until the
 * step is seen running (`noteStepRunning`).
 *
 * A block naming a step that is running again is ignored too, whatever its
 * kind: the runner clears every block naming a step once that step runs, but
 * it does so asynchronously (under the parent's pipeline lock), so the
 * parent's row can still carry the stale block after the step's own
 * `running` column event has landed.
 */
export class OwedPipelineAlerts {
  private readonly owed = new Map<string, Set<string>>();

  owe(parentId: string): void {
    if (!this.owed.has(parentId)) this.owed.set(parentId, new Set());
  }

  isOwed(parentId: string): boolean {
    return this.owed.has(parentId);
  }

  /** The user answered `stepTaskId`'s last question. */
  noteAnswered(parentId: string, stepTaskId: string): void {
    this.owed.get(parentId)?.add(stepTaskId);
  }

  /** `stepTaskId` runs again, so its blocks count from here on. */
  noteStepRunning(parentId: string, stepTaskId: string): void {
    this.owed.get(parentId)?.delete(stepTaskId);
  }

  /** The alert was shown, or the run no longer needs it. */
  forget(parentId: string): void {
    this.owed.delete(parentId);
  }

  parentIds(): string[] {
    return [...this.owed.keys()];
  }

  /**
   * What to do with `parentId`'s owed alert given the parent's current row:
   * `raise` while its run is blocked on something other than an answered
   * question or a step that runs again, `wait` while those are the only
   * blocks (or nothing is owed), `drop` once the alert is moot — the run left
   * `blocked`, or the parent was archived or deleted. `isStepRunning` reports
   * whether a step task's row currently sits in the `running` column.
   */
  decide(
    parentId: string,
    parent: Pick<Task, "archivedAt" | "pipelineRun"> | undefined,
    isStepRunning: (taskId: string) => boolean,
  ): "raise" | "wait" | "drop" {
    const answered = this.owed.get(parentId);
    if (!answered) return "wait";
    const run = parent?.pipelineRun;
    if (!parent || parent.archivedAt != null || !run || run.status !== "blocked") return "drop";
    const blocked = run.blocked.some((b) => {
      if (b.taskId === null) return true;
      if (b.kind === "step-blocked" && answered.has(b.taskId)) return false;
      return !isStepRunning(b.taskId);
    });
    return blocked ? "raise" : "wait";
  }
}
