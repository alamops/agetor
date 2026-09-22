import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Merge, Play, Plus, Split } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepVisualState } from "@/lib/pipelines";
import type { AgentProfile, AgentProfileSnapshot, PipelineStep } from "../../../shared/types.ts";
import { AgentProfileCard } from "../kanban/AgentProfileCard";

/** Node `data` shape for the pipelines canvas's custom `"step"` node type —
 *  everything {@link StepNode} needs to render one step, resolved by the
 *  caller (editor or run view) from the live/frozen graph plus whatever
 *  agent-profile/visual-state lookups it has on hand. An intersection with
 *  `Record<string, unknown>` (not `interface … extends Record<…>`, which
 *  TS rejects for a mapped type) so it satisfies React Flow's
 *  `Node<NodeData extends Record<string, unknown>>` constraint. */
export type StepNodeData = Record<string, unknown> & {
  step: PipelineStep;
  /** The step's bound agent profile — live `AgentProfile` in the editor,
   *  frozen `AgentProfileSnapshot` in a started run's read-only view — or
   *  `null` when the step has no profile bound yet. */
  profile: AgentProfileSnapshot | AgentProfile | null;
  /** The step names a profile id that no longer resolves (editor: deleted
   *  from Settings; run view: not in the frozen snapshot). */
  profileDeleted: boolean;
  isStart: boolean;
  visual?: StepVisualState;
  /** `transition: "all"` fan-out — the shared-worktree caution note. */
  parallelWarning?: boolean;
  /** Read-only (run view): hides the "+" append affordance. */
  readOnly?: boolean;
  /** Appends a new step connected to this one's output — omit (or pair
   *  with `readOnly: true`) to hide the "+" button entirely. */
  onAppend?: (stepId: string) => void;
};

export type StepFlowNodeType = Node<StepNodeData, "step">;

const VISUAL_CLASSES: Record<StepVisualState, string> = {
  idle: "border-border",
  active: "border-info ring-2 ring-info animate-pipeline-pulse",
  done: "border-success",
  blocked: "border-warning",
  failed: "border-danger",
  cancelled: "border-muted-foreground",
};

function StepNodeImpl({ data, selected }: NodeProps<StepFlowNodeType>) {
  const { step, profile, profileDeleted, isStart, visual = "idle", parallelWarning, readOnly, onAppend } = data;

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
      </div>

      <div className="mt-1.5 min-w-0">
        {profile ? (
          <AgentProfileCard profile={profile} variant="chip" deleted={profileDeleted} className="max-w-full" />
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
        className="!size-2.5 !border-2 !border-background !bg-info"
      />

      {!readOnly && onAppend && (
        <button
          type="button"
          data-testid="pipeline-step-append"
          title="Add a connected step"
          onClick={() => onAppend(step.id)}
          className="absolute -right-3 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

export const StepNode = memo(StepNodeImpl);
