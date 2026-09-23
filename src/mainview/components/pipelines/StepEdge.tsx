import { memo, useEffect, useRef } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EdgeVisualState } from "@/lib/pipelines";

/** Edge `data` shape for the pipelines canvas's custom `"step"` edge type. */
export type StepEdgeData = Record<string, unknown> & {
  label?: string;
  visual?: EdgeVisualState;
  /** Paint an animated token traveling this edge (the run view's "a
   *  handoff just happened" cue). */
  token?: boolean;
  /** Re-keys the token's `<animateMotion>` so a repeat transition over the
   *  SAME edge (a cycle) replays the animation instead of the browser
   *  treating it as an unchanged element. */
  tokenKey?: string | number;
  /** Editor only: clicking the label pill's × removes this edge. */
  onDelete?: (edgeId: string) => void;
  /** Run view: hides the delete affordance even when `onDelete` is set. */
  readOnly?: boolean;
};

export type StepFlowEdgeType = Edge<StepEdgeData, "step">;

const STROKE_CLASSES: Record<EdgeVisualState, string> = {
  idle: "!stroke-muted-foreground",
  traversed: "!stroke-success",
  flowing: "!stroke-info animate-pipeline-dash",
};

function StepEdgeImpl({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<StepFlowEdgeType>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const visual = data?.visual ?? "idle";
  const showLabelPill = !!(data?.label || (data?.onDelete && !data?.readOnly));
  const animateRef = useRef<SVGAnimateMotionElement>(null);

  // The token's `<animateMotion>` runs with `begin="indefinite"` (never
  // auto-starts) and is replayed imperatively via `beginElement()` whenever
  // `data.tokenKey` changes — including a repeat transition over the SAME
  // edge (a cycle), which a `key`-based remount can't reliably replay for a
  // SMIL animation embedded in an SVG that itself never unmounts.
  useEffect(() => {
    if (data?.token) animateRef.current?.beginElement();
  }, [data?.tokenKey]);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        // A real `stroke-dasharray` attribute is required for the
        // `animate-pipeline-dash` keyframes (which only animate
        // `stroke-dashoffset`) to visibly "march" — see M13.
        strokeDasharray={visual === "flowing" ? "6 6" : undefined}
        className={cn(STROKE_CLASSES[visual])}
        data-testid="pipeline-step-edge"
        data-visual={visual}
      />
      {data?.token && (
        // `cx`/`cy` seed the circle at the edge's own source point so it
        // never flashes at the SVG origin (0,0) for the one frame before
        // `beginElement()` (fired from the effect above) hands it off to
        // `<animateMotion>`.
        <circle cx={sourceX} cy={sourceY} r={5} className="fill-info" data-testid="pipeline-step-edge-token">
          <animateMotion ref={animateRef} begin="indefinite" dur="1.2s" repeatCount="1" fill="freeze" path={edgePath} />
        </circle>
      )}
      {showLabelPill && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm"
          >
            {data?.label && <span className="max-w-24 truncate">{data.label}</span>}
            {data?.onDelete && !data?.readOnly && (
              <button
                type="button"
                data-testid="pipeline-step-edge-delete"
                title="Remove connection"
                onClick={() => data.onDelete?.(id)}
                className="rounded-full p-0.5 hover:bg-accent hover:text-foreground"
              >
                <X className="size-2.5" aria-hidden />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const StepEdge = memo(StepEdgeImpl);
