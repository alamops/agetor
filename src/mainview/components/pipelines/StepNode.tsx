import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Merge, Play, Plus, RefreshCw, Split } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepVisualState } from "@/lib/pipelines";
import type { PipelineStep } from "../../../shared/types.ts";
import { AgentProfileCard } from "../kanban/AgentProfileCard";
import { usePipelineCanvasContext } from "./pipeline-canvas-context";

/** Node `data` shape for the pipelines canvas's custom `"step"` node type —
 *  everything {@link StepNode} needs to render one step, EXCEPT the agent
 *  profile lookup and the start-step flag, which come from
 *  {@link usePipelineCanvasContext} instead of `data` on purpose (review
 *  M11 — see `pipeline-canvas-context.tsx`'s doc comment for why). An
 *  intersection with `Record<string, unknown>` (not `interface … extends
 *  Record<…>`, which TS rejects for a mapped type) so it satisfies React
 *  Flow's `Node<NodeData extends Record<string, unknown>>` constraint. */
export type StepNodeData = Record<string, unknown> & {
  step: PipelineStep;
  visual?: StepVisualState;
  /** Read-only (run view): hides the "+" append affordance. */
  readOnly?: boolean;
  /** Run view only: the step's currently active execution has already
   *  received the runner's automatic "no valid handoff yet" reminder turn
   *  and hasn't settled since — see `stepReminded` in `@/lib/pipelines`.
   *  Renders a small glyph while `visual === "active"`. */
  reminded?: boolean;
  /** Appends a new step connected to this one's output — omit (or pair
   *  with `readOnly: true`) to hide the "+" button entirely. */
  onAppend?: (stepId: string) => void;
};

export type StepFlowNodeType = Node<StepNodeData, "step">;

const VISUAL_CLASSES: Record<StepVisualState, string> = {
  idle: "border-border",
  // The pulse is an OUTLINE animation (`pipeline-pulse` in
  // tailwind.config.js), so it coexists with the `ring-primary` selection
  // ring below — both used to be box-shadows, and the keyframe clobbered
  // the ring. No static `ring-info` here: the animated outline IS the halo.
  active: "border-info outline outline-2 outline-info animate-pipeline-pulse",
  done: "border-success",
  blocked: "border-warning",
  failed: "border-danger",
  cancelled: "border-muted-foreground",
};

function StepNodeImpl({ data, selected }: NodeProps<StepFlowNodeType>) {
  const { step, visual = "idle", readOnly, reminded, onAppend } = data;
  const { startStepId, resolveProfile } = usePipelineCanvasContext();
  const { profile, profileDeleted } = resolveProfile(step.agentProfileId ?? null);
  const isStart = startStepId === step.id;
  const parallelWarning = step.transition === "all";

  return (
    <div
      data-testid="pipeline-step-node"
      data-step-id={step.id}
      data-visual={visual}
      className={cn(
        "relative w-[240px] rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-colors",
        VISUAL_CLASSES[visual],
        selected && "ring-2 ring-primary",
      )}
    >
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        className="!size-2.5 !border-2 !border-background !bg-info"
      />

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={step.name}>
          {step.name}
        </span>
        {isStart && (
          <span
            title="Start step"
            data-testid="pipeline-step-start-badge"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info"
          >
            <Play className="size-2.5" aria-hidden />
            Start
          </span>
        )}
        {step.transition === "all" && (
          <Split className="size-3.5 shrink-0 text-muted-foreground" aria-label="Fans out to all next steps" />
        )}
        {step.join === "all" && (
          <Merge className="size-3.5 shrink-0 text-muted-foreground" aria-label="Waits for every incoming step" />
        )}
        {visual === "active" && reminded && (
          <span
            data-testid="pipeline-step-reminded"
            title="Reminder sent — waiting for the handoff"
            className="inline-flex shrink-0 items-center text-warning"
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </span>
        )}
      </div>

      <div className="mt-1.5 min-w-0">
        {profile ? (
          <AgentProfileCard profile={profile} variant="chip" deleted={profileDeleted} className="max-w-full" />
        ) : profileDeleted ? (
          <span data-testid="pipeline-step-profile-deleted" className="text-xs text-danger">
            Deleted agent
          </span>
        ) : (
          <span className="text-xs text-warning">No agent</span>
        )}
      </div>

      {parallelWarning && (
        <p className="mt-1.5 text-[10px] leading-tight text-warning">
          Shares the worktree with parallel siblings
        </p>
      )}

      <Handle
        type="source"
        id="out"
        position={Position.Right}
        className="!-right-1.5 !size-2.5 !border-2 !border-background !bg-info"
      />
      {/* Anchor for the dashed "delegate" edges down to this step's
          subagent satellites (SubagentNode/SubagentEdge). Never a
          drag-to-connect source — pipeline edges only ever leave via
          `out` — and invisible when the step lists no personas, so the
          card's silhouette is unchanged for the common case. */}
      <Handle
        type="source"
        id="delegate"
        position={Position.Bottom}
        isConnectable={false}
        className={cn(
          "!size-1.5 !border-0 !bg-muted-foreground/60",
          step.subagents.profileIds.length === 0 && "!opacity-0",
        )}
      />

      {!readOnly && onAppend && (
        <button
          type="button"
          data-testid="pipeline-step-append"
          title="Add a connected step"
          onClick={() => onAppend(step.id)}
          className="absolute -right-9 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

export const StepNode = memo(StepNodeImpl);
