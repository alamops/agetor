import { memo, useEffect, useRef, useState } from "react";
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
  selected,
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
  // Whether the token circle should actually be painted. `<animateMotion>`
  // translates its target element ON TOP OF that element's own `cx`/`cy` —
  // it does not reset it to the path's start — so seeding `cx`/`cy` at the
  // edge's source point (the previous approach) double-offsets the circle
  // once the motion begins, parking it near source+target instead of on
  // the edge. The fix is to keep `cx`/`cy` at the origin (0, 0) — where
  // `<animateMotion>` expects its target to start from — and drive
  // visibility with plain React state instead of leaning on SMIL's
  // `begin="<id>.begin"` syncbase (unreliable across engines for a
  // programmatically-triggered `beginElement()`, per the SMIL spec note
  // that event-value timing is sensitive to how the referenced timed
  // element was started). `beginElement()` runs synchronously — the SMIL
  // timeline is already ticking from the path's start point before the
  // `setTokenVisible(true)` update below is even scheduled — so the
  // circle's very first painted frame is already correctly positioned by
  // the animation, never a static frame at (0, 0).
  const [tokenVisible, setTokenVisible] = useState(false);

  // The token's `<animateMotion>` runs with `begin="indefinite"` (never
  // auto-starts) and is replayed imperatively via `beginElement()` whenever
  // `data.tokenKey` changes — including a repeat transition over the SAME
  // edge (a cycle), which a `key`-based remount can't reliably replay for a
  // SMIL animation embedded in an SVG that itself never unmounts.
  useEffect(() => {
    if (data?.token) {
      animateRef.current?.beginElement();
      setTokenVisible(true);
    } else {
      setTokenVisible(false);
    }
  }, [data?.tokenKey, data?.token]);

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
        // The visual-state strokes are `!important` (they have to beat React
        // Flow's own `.react-flow__edge-path` rule), which also beat the
        // library's selected-edge stroke — so a clicked edge in the editor
        // looked exactly like an unselected one. Paint selection ourselves,
        // last, so it wins.
        className={cn(STROKE_CLASSES[visual], selected && "!stroke-primary")}
        data-testid="pipeline-step-edge"
        data-visual={visual}
        data-selected={selected ? "true" : undefined}
      />
      {data?.token && (
        // `cx`/`cy` stay at the origin — `<animateMotion>` offsets FROM
        // there, so this is the coordinate space the `path` above is
        // already drawn in (starting at `sourceX`/`sourceY`). `opacity` is
        // gated on `tokenVisible`, flipped only once `beginElement()` has
        // already started the timeline (see the effect above), so this
        // element is never painted sitting statically at (0,0).
        <circle
          cx={0}
          cy={0}
          r={5}
          opacity={tokenVisible ? 1 : 0}
          className="fill-info"
          data-testid="pipeline-step-edge-token"
        >
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
            // `nopan nodrag`: React Flow's opt-out classes — a press on the
            // pill (its × button, or just the label) must not start a pane
            // pan / a node drag underneath it.
            className="nopan nodrag pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm"
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
