/**
 * Pure helper for resolving an `open_task` app event (a clicked native
 * notification deep-link, `agetor://task/<id>`) against a task list. Kept
 * free of React/App imports so it's directly unit-testable — the webview
 * has no DOM test harness.
 */
export function findTaskById<T extends { id: string }>(tasks: readonly T[], taskId: string): T | null {
  return tasks.find((t) => t.id === taskId) ?? null;
}
