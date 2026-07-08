import type { Task, Run } from "../shared/types.ts";

/**
 * The webview's task control precedence, mirrored so the CLI runs/continues
 * tasks by the same rules as the dashboard's Run button (see
 * src/mainview/components/kanban/TaskCard.tsx + RunPanel.tsx):
 *
 *   - active (running | blocked)        → "stop"  (the button is Stop, not Run)
 *   - hasOpenableRun (succeeded/orphan) → "open"  (continue by *sending* a
 *                                                   message — the app resumes
 *                                                   the session, it never starts
 *                                                   a fresh run from here)
 *   - otherwise (never-run, or only failed/cancelled) → "run" (POST /start)
 */
export type RunControl = "run" | "stop" | "open";

export function runControl(task: Task): RunControl {
  if (task.column === "running" || task.column === "blocked") return "stop";
  if (task.hasOpenableRun) return "open";
  return "run";
}

/**
 * The webview's resumable-run resolution (RunPanel.tsx): the live run if there
 * is one, otherwise — for a finished task — the most recent run so the backend
 * can spawn `claude --resume <sessionId>`. `runs` must be newest-first, as
 * returned by GET /tasks/:id/runs. Returns null when there is nothing to
 * send to (e.g. a never-started task).
 */
export function resumableRunId(task: Task, runs: Run[]): string | null {
  return task.runId ?? (runs.length > 0 ? runs[0]!.id : null);
}
