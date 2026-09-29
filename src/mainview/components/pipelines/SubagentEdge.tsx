import { memo } from "react";
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { SubagentFlowEdge, SubagentVisualState } from "@/lib/pipelines";

/**
 * The dashed "delegate" link from a step's bottom handle down to one of its
 * {@link SubagentNode} satellites. Purely decorative in the editor; in the
 * run view its dashes march (the same `animate-pipeline-dash` keyframes a
 * flowing step edge uses) while that persona's subagent is working, and it
 * turns success-coloured once it finished. Never selectable, never
 * deletable — it exists exactly as long as the step lists that persona.
 */
const STROKE_CLASSES: Record<SubagentVisualState, string> = {
  idle: "!stroke-muted-foreground/60",
  working: "!stroke-info animate-pipeline-dash",
  done: "!stroke-success",
};

function SubagentEdgeImpl({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  data,
}: EdgeProps<SubagentFlowEdge>) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const visual = data?.visual ?? "idle";
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={style}
      // A real dasharray is required for the dash-offset keyframes to
      // visibly march — same note as StepEdge.
      strokeDasharray="4 4"
      className={cn(STROKE_CLASSES[visual])}
      data-testid="pipeline-subagent-edge"
      data-visual={visual}
    />
  );
}

export const SubagentEdge = memo(SubagentEdgeImpl);
