import type { Task } from "../../shared/types.ts";
import { importedSessionOf } from "../../shared/imported-session.ts";

/**
 * The facts every task action surface derives from one task: the card's
 * visible buttons (`cardActions`, `TaskCardActions`) and the right-click / `⋯`
 * menu (`buildTaskContextMenu`). Both used to compute these separately and
 * "mirror" each other by comment, which is how a button could exist on the
 * card with no menu entry behind it. They share this function now, so the two
 * cannot drift apart. `task-card-actions.test.ts` also proves the menu offers
 * everything the card used to show as an extra button.
 */
export interface TaskActionFlags {
  /** `archivedAt` is set: the card is dimmed, immutable, and offers Open. */
  archived: boolean;
  /** The agent process is live: running, or blocked awaiting the user. */
  active: boolean;
  /** At least one pending interaction, or codex flipped the task to `blocked`. */
  awaiting: boolean;
  /** `pendingInteractionCount`, for the "Answer (N)" label. */
  pendingCount: number;
  /** There is something worth reading: a run, or a pipeline with history. */
  openable: boolean;
  /** A pipeline parent parked in Review on a pending human gate. */
  gatePending: boolean;
  /** Stop is honoured: a live process, or a pipeline run that is `running`
   *  (or parked on a gate, which Stop dismisses). */
  stoppable: boolean;
  isPipelineParent: boolean;
  /** A hidden pipeline step task; its parent owns its lifecycle. */
  isStepTask: boolean;
  /** Imported from a session started outside agetor. */
  imported: boolean;
  /** Review column, no pending gate, and not an unfinished pipeline. */
  canMarkDone: boolean;
}

export function taskActionFlags(task: Task): TaskActionFlags {
  const archived = task.archivedAt != null;
  const active = task.column === "running" || task.column === "blocked";
  const pendingCount = task.pendingInteractionCount;
  const awaiting = pendingCount > 0 || task.column === "blocked";
  // A pipeline PARENT never gets its own `runId`/`hasOpenableRun` — only its
  // step tasks do — so `hasOpenableRun` alone would forever gate the button
  // on "Run" even once the pipeline has actually executed. Once any step
  // execution has landed in `pipelineRun.history`, there is something worth
  // opening the run view for; Retry/Restart live there, not on the card
  // (M15, docs/plans/pipelines.md review).
  const hasOpenablePipelineRun = !!task.pipelineRun
    && (task.pipelineRun.history.length > 0 || (task.pipelineRun.humanSteps ?? []).length > 0);
  const openable = task.hasOpenableRun || hasOpenablePipelineRun;
  const isPipelineParent = task.pipelineId != null;
  const isStepTask = task.pipelineParentId != null;
  // A pending human gate parks the card in Review and needs a decision.
  const gatePending = isPipelineParent && (task.pipelineRun?.humanSteps ?? []).length > 0;
  // Stop is only honoured server-side for a pipeline PARENT while its run is
  // genuinely `running` (`POST /tasks/:id/pipeline/cancel` 409s otherwise —
  // e.g. a `blocked` run with nothing live), so it gates on
  // `pipelineRun.status`, not the column (L-A1). A pending gate is stoppable
  // too: Stop dismisses it and moves the card to Ready.
  const stoppable = isPipelineParent
    ? task.pipelineRun?.status === "running" || gatePending
    : active;
  const canMarkDone = task.column === "review"
    && !archived
    && !gatePending
    && !(isPipelineParent && task.pipelineRun?.status !== "done");
  return {
    archived,
    active,
    awaiting,
    pendingCount,
    openable,
    gatePending,
    stoppable,
    isPipelineParent,
    isStepTask,
    imported: importedSessionOf(task) != null,
    canMarkDone,
  };
}

/** A button the card shows itself. Everything else lives in the `⋯` menu. */
export type CardAction = "review-gate" | "open" | "answer" | "stop" | "run" | "mark-done";

/**
 * The card's visible buttons, in display order; `⋯` is always present and not
 * listed. First match wins, mirroring the precedence Answer > Stop > Open >
 * Run, with a pipeline gate and an archived card in front:
 *
 * | state                                 | visible        |
 * | ------------------------------------- | -------------- |
 * | archived                              | Open           |
 * | pipeline gate pending                 | Review · Open  |
 * | awaiting (interaction / blocked)      | Answer / Review|
 * | stoppable                             | Stop           |
 * | openable or imported                  | Open           |
 * | otherwise                             | Run            |
 *
 * plus Done in the Review column (no pending gate, not an unfinished pipeline).
 */
export function cardActions(task: Task): CardAction[] {
  const f = taskActionFlags(task);
  if (f.archived) return ["open"];
  const out: CardAction[] = [];
  if (f.gatePending) out.push("review-gate", "open");
  else if (f.awaiting) out.push("answer");
  else if (f.stoppable) out.push("stop");
  else if (f.openable || f.imported) out.push("open");
  else out.push("run");
  if (f.canMarkDone) out.push("mark-done");
  return out;
}
