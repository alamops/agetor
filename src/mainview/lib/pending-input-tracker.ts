/**
 * Tracks which interaction ids are awaiting an answer, keyed by task, so the
 * app-level notification hook fires "Waiting on you" exactly ONCE per task (not
 * once per stacked prompt) and clears it only when the LAST prompt resolves.
 *
 * Pure and DOM-free on purpose: the toast/notification side effects live in the
 * caller (App.tsx), and this bookkeeping is unit-tested in isolation.
 */
export class PendingInputTracker {
  private byTask = new Map<string, Set<string>>();

  /**
   * Record a newly-pending prompt. Returns `true` when it is the FIRST live
   * prompt for the task — the caller's signal to raise the alert. A repeat of
   * an id already tracked never re-signals.
   */
  add(taskId: string, interactionId: string): boolean {
    let set = this.byTask.get(taskId);
    if (!set) {
      set = new Set();
      this.byTask.set(taskId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(interactionId);
    return wasEmpty;
  }

  /**
   * Drop a resolved prompt. Returns `true` when the task now has NO live
   * prompts left — the caller's signal to clear the alert. Unknown task/id
   * pairs are a no-op returning `false`.
   */
  remove(taskId: string, interactionId: string): boolean {
    const set = this.byTask.get(taskId);
    if (!set) return false;
    set.delete(interactionId);
    if (set.size === 0) {
      this.byTask.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * Forget all tracking for a task — used when its run reaches a terminal state
   * without every prompt emitting a resolved event (e.g. the agent process
   * exits with a modal still on the pane). Without this, a stale id would sit
   * in the set and suppress the FIRST-prompt alert for the task's next run.
   */
  clearTask(taskId: string): void {
    this.byTask.delete(taskId);
  }
}
