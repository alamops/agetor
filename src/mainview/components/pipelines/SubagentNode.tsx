import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SUBAGENT_NODE_WIDTH, type SubagentFlowNode, type SubagentVisualState } from "@/lib/pipelines";
import { usePipelineCanvasContext } from "./pipeline-canvas-context";

/**
 * The pipelines canvas's `"subagent"` node: one small satellite per persona
 * a step may delegate to (`step.subagents.profileIds`), hanging beneath the
 * step it belongs to (a React Flow child via `parentId`, so it follows the
 * step when dragged) and linked to it by a {@link SubagentEdge}. In the
 * editor it's static configuration; in the run view `data.visual` animates
 * it while a live subagent attributed to that persona is working and marks
 * it once that subagent finished (`subagentSatellites` in
 * `@/lib/pipelines`). A `kind: "live"` satellite is a running subagent the
 * run view observed that matched NO configured persona — rendered with the
 * subagent's own description as its label, only while it runs.
 *
 * The persona's name/harness come from {@link usePipelineCanvasContext}'s
 * `resolveProfile`, not node `data`, for the same reason `StepNode`'s do:
 * a profiles refetch must never change a node object's identity.
 */
const VISUAL_CLASSES: Record<SubagentVisualState, string> = {
  idle: "border-dashed border-border text-muted-foreground",
  // Outline-based pulse (see StepNode's `active` class / tailwind.config.js)
  // so it never fights a box-shadow ring.
  working: "border-info outline outline-2 outline-info text-foreground animate-pipeline-pulse",
  done: "border-success text-foreground",
};

function SubagentNodeImpl({ data }: NodeProps<SubagentFlowNode>) {
  const { stepId, kind, profileId, subagentId, label, visual = "idle", instanceCount = 0 } = data;
  const { resolveProfile } = usePipelineCanvasContext();
  const { profile, profileDeleted } = kind === "profile" ? resolveProfile(profileId ?? null) : { profile: null, profileDeleted: false };
  const name = kind === "live" ? (label ?? "Subagent") : (profile?.name ?? (profileDeleted ? "Deleted agent" : "Unknown agent"));
  // A frozen snapshot carries `harnessLabel`; a live `AgentProfile` only
  // its harness id — either reads fine as the small secondary line.
  const sub = kind === "live"
    ? "live subagent"
    : profile
      ? ("harnessLabel" in profile ? profile.harnessLabel : profile.harness)
      : null;
  const title =
    visual === "working"
      ? `${name} — working now`
      : visual === "done"
        ? `${name} — finished`
        : `${name} — this step may delegate to it`;

  return (
    <div
      data-testid="pipeline-subagent-node"
      data-step-id={stepId}
      data-kind={kind}
      data-profile-id={profileId ?? undefined}
      data-subagent-id={subagentId ?? undefined}
      data-visual={visual}
      data-instance-count={instanceCount}
      title={title}
      style={{ width: SUBAGENT_NODE_WIDTH }}
      className={cn(
        "relative flex items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 text-xs shadow-sm transition-colors",
        VISUAL_CLASSES[visual],
        profileDeleted && "border-danger text-danger",
      )}
    >
      <Handle
        type="target"
        id="in"
        position={Position.Top}
        isConnectable={false}
        className="!size-1.5 !border-0 !bg-muted-foreground/60"
      />
      <span className="flex size-4 shrink-0 items-center justify-center">
        {visual === "working" ? (
          <Loader2 className="size-3.5 animate-spin text-info" aria-label="Working" />
        ) : visual === "done" ? (
          <Check className="size-3.5 text-success" aria-label="Finished" />
        ) : (
          <Bot className="size-3.5" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-tight">{name}</span>
        {sub && <span className="block truncate text-[10px] leading-tight text-muted-foreground">{sub}</span>}
      </span>
      {instanceCount > 1 && (
        <span
          data-testid="pipeline-subagent-count"
          className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
          title={`${instanceCount} helpers spawned for this persona`}
        >
          ×{instanceCount}
        </span>
      )}
    </div>
  );
}

export const SubagentNode = memo(SubagentNodeImpl);
