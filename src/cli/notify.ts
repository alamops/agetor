import type { GlobalEvent } from "../shared/types.ts";

const BELL = String.fromCharCode(7);

/**
 * The orchestrator stamps an additive `pipelineParentId` onto the task-
 * scoped `GlobalEvent` members (`run-status`, `column`, `interaction`,
 * `files-sent`, `fx-auto-resume`) whenever the event's task is a hidden
 * pipeline step, so a consumer can tell a step's event apart WITHOUT having
 * polled that step's row first (a step that settles before the first poll
 * would otherwise slip through a `hiddenTaskIds` lookup). Read defensively —
 * an older core (or a member that never carries it) yields `null`.
 */
export function eventPipelineParentId(e: GlobalEvent): string | null {
  const v = (e as { pipelineParentId?: unknown }).pipelineParentId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Map a global event to a desktop notification — only for the given task, and
 * only for state changes worth interrupting the user (terminal status + the
 * "needs you" block). Returns null otherwise.
 *
 * `opts.hidden` — true when `taskId` names a pipeline's hidden step task
 * (`pipelineParentId` set, docs/plans/pipelines.md D11) — suppresses the
 * notification even for a step task the caller explicitly resolved (e.g.
 * `agetor logs <stepTaskId> --notify`): the pipeline's parent task's own
 * `column`/pipeline-run transitions already cover the same information at
 * the level a step id, an implementation detail, isn't meaningful outside.
 */
export function notifyFor(
  e: GlobalEvent,
  taskId: string,
  opts?: { hidden?: boolean },
): { title: string; body: string } | null {
  if (opts?.hidden) return null;
  // The event itself says it belongs to a hidden step task — same
  // suppression, no caller lookup needed (see `eventPipelineParentId`).
  if (eventPipelineParentId(e) !== null) return null;
  const short = taskId.slice(0, 8);
  if (e.kind === "run-status" && e.taskId === taskId) {
    if (e.status === "succeeded") return { title: "Agetor — succeeded", body: short };
    if (e.status === "failed") return { title: "Agetor — failed", body: short };
    if (e.status === "orphaned") return { title: "Agetor — orphaned", body: short };
    return null; // cancelled: the user did it
  }
  if (e.kind === "column" && e.taskId === taskId && e.column === "blocked") {
    return {
      title: "Agetor — needs you",
      body: e.reason === "api-error" ? `${short} (API error)` : `${short} is waiting on you`,
    };
  }
  return null;
}

/** Best-effort macOS desktop notification + a terminal bell. Never throws. */
export function osNotify(title: string, body: string): void {
  process.stdout.write(BELL);
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  try {
    Bun.spawn(
      ["osascript", "-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    /* osascript missing / not macOS — the bell still fired */
  }
}
