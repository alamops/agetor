/**
 * The cross-task "needs you" inbox (`GET /interactions/pending`, docs/specs/remote-readiness-spec.md "Sync, streams and the
 * inbox"): every pending card across tasks, with a pipeline step's card folded into its parent, plus every pipeline gate
 * waiting for a human. Types only, so the core builds it and the CLI, TUI and phone read it from one definition.
 */
import type { PipelineHumanStep } from "./types.ts";

/** A pending interaction (ask, tmux or fx/OpenCode permission card) plus the board card it belongs to. */
export type InboxCard<Card extends { taskId: string }> = Card & {
  /** The task shown on the board: the step's pipeline parent for a hidden step, else the card's own task. */
  parentTaskId: string;
};

/** A pipeline gate (`type: "human"` step) waiting for the owner's decision. */
export interface InboxGate {
  /** The pipeline parent task (the board card). */
  taskId: string;
  taskTitle: string;
  stepId: string;
  /** The run-wide sequence the decision is recorded under. */
  seq: number;
  startedAt: number;
  /** The handoffs the gate was entered with, as `PipelineHumanStep.arrivals`. */
  arrivals: PipelineHumanStep["arrivals"];
}

export interface PendingInbox<Card extends { taskId: string }> {
  cards: Array<InboxCard<Card>>;
  gates: InboxGate[];
}
