import { createContext, useContext } from "react";
import type { AgentProfile, AgentProfileSnapshot } from "../../../shared/types.ts";

/** What {@link StepNode} needs to render one step's agent chip, resolved by
 *  whichever canvas (editor or run view) currently owns the lookup. */
export interface StepProfileResolution {
  profile: AgentProfileSnapshot | AgentProfile | null;
  /** The step names a profile id that no longer resolves. */
  profileDeleted: boolean;
}

export interface PipelineCanvasContextValue {
  /** The graph's current start step id, or `null` before one is set. */
  startStepId: string | null;
  resolveProfile: (agentProfileId: string | null) => StepProfileResolution;
}

const DEFAULT_CONTEXT_VALUE: PipelineCanvasContextValue = {
  startStepId: null,
  resolveProfile: () => ({ profile: null, profileDeleted: false }),
};

/**
 * Carries per-canvas lookups (start step, agent-profile resolution) to every
 * {@link StepNode} WITHOUT them being part of a node's own `data` — the
 * whole point (review M11): a profiles refetch, or a `startStepId` change,
 * would otherwise force every node's `data` object to a new identity on the
 * SAME render, and React Flow interprets that as a reason to re-measure
 * every node (root cause of the "trying to drag a node that is not
 * initialized" warning / a sibling node getting stuck `visibility: hidden`
 * — pinned by `e2e/pipelines-editor.spec.ts`'s "New agent… inline creation
 * on one step does not leave a sibling step node stuck unclickable" test).
 * A context value's identity is free to change every render; only the
 * consuming `StepNode` components re-render, and React Flow never sees it.
 */
export const PipelineCanvasContext = createContext<PipelineCanvasContextValue>(DEFAULT_CONTEXT_VALUE);

export function usePipelineCanvasContext(): PipelineCanvasContextValue {
  return useContext(PipelineCanvasContext);
}
