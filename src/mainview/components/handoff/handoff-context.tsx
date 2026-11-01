/**
 * What the formatted handoff surfaces need to know about where they render
 * (`docs/plans/formatted-handoff.md` K6). Provided by RunPanel around the
 * transcript of a pipeline STEP task (and per history row by the run view),
 * read by the card, the modal, the artifact chips and the handoff-file chip
 * instead of threading a dozen props through `RunEventList`'s memoized
 * blocks. React context crosses `createPortal`, so the portaled modal sees
 * it too.
 *
 * With no provider the frozen {@link DISABLED_HANDOFF_VIEW} applies
 * (`enabled: false`), and every consumer renders exactly today's markup — a
 * non-step task, a subagent tab and a delta-streaming harness never change.
 */
import { createContext, useContext } from "react";
import type { PipelineGraph, PipelineRunState, PipelineStepRecord } from "../../../shared/types.ts";

export interface HandoffViewValue {
  /** Cards render at all (`handoffCardsEnabled`: a step task's main stream
   *  on a message-level harness). */
  enabled: boolean;
  /** The task whose cwd a relative path resolves against server-side
   *  (`api.openPath`/`api.revealPath`) — the step task, or the history
   *  row's step task in the run view. */
  taskId: string | undefined;
  /** The pipeline parent task's id — the directory the runner writes
   *  handoff files into (`pipeline-runs/<parentId>/`, D18). */
  parentId: string | null;
  /** Roots a relative artifact resolves against, in order:
   *  `[worktreePath, workdir]` (D6). */
  roots: readonly (string | null | undefined)[];
  /** The user's home directory, for `~/` artifacts (A7). */
  homeDir: string | null;
  /** The step this task executes, in the frozen graph — the source of a
   *  transcript handoff's `next` (K9). */
  stepId: string | null;
  /** That step's display name, for the modal's context block. */
  stepName: string | null;
  /** The run's frozen graph (`run.snapshot.graph`), or `null` until loaded
   *  — then `next` shows verbatim (D14). */
  graph: PipelineGraph | null;
  /** The parent's full run state, for the D18 handoff-file lookup. */
  run: PipelineRunState | null;
  /** This step task's history record, for the usage rule (D21). */
  record: PipelineStepRecord | null;
  /** Run ids of this task that have settled (A8). */
  settledRunIds: ReadonlySet<string>;
}

/** The value a surface sees with no provider: cards off, nothing known. */
export const DISABLED_HANDOFF_VIEW: HandoffViewValue = Object.freeze({
  enabled: false,
  taskId: undefined,
  parentId: null,
  roots: Object.freeze([]) as readonly (string | null | undefined)[],
  homeDir: null,
  stepId: null,
  stepName: null,
  graph: null,
  run: null,
  record: null,
  settledRunIds: new Set<string>() as ReadonlySet<string>,
});

export const HandoffViewContext = createContext<HandoffViewValue>(DISABLED_HANDOFF_VIEW);

export function useHandoffView(): HandoffViewValue {
  return useContext(HandoffViewContext);
}

/** The display name of step `stepId` in `graph`, else `null`. */
export function stepNameFor(graph: PipelineGraph | null, stepId: string | null): string | null {
  if (graph === null || stepId === null) return null;
  return graph.steps.find((s) => s.id === stepId)?.name ?? null;
}
