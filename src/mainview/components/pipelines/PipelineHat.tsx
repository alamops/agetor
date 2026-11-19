import { AlertTriangle, Play, UserCheck, Workflow, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { pipelineStepProgress, stepNameById } from "../../../shared/pipeline.ts";
import type { PipelineRunState, PipelineRunStatus } from "../../../shared/types.ts";

const TONE: Record<PipelineRunStatus, string> = {
  idle: "border-border bg-muted text-muted-foreground",
  running: "border-info/25 bg-info/10 text-info",
  review: "border-info/25 bg-info/10 text-info",
  blocked: "border-warning/30 bg-warning/10 text-warning",
  done: "border-success/25 bg-success/10 text-success",
  cancelled: "border-border bg-muted text-muted-foreground",
};

/**
 * Board-card header for a pipeline task, a full-width band tinted by the run's
 * status. It replaces the old `PipelineBadge` pill, which sat in a
 * `justify-between` row beside the other badges and pushed them out of the
 * card.
 *
 * Label rule (one implementation, `pipelineStepProgress`): the right side is
 * `n/total` over DISTINCT steps, or `✓ Done` for a finished run; a run that
 * looped never reads `13/10`. The line under it names what the run is on: the
 * active step (`+N` for a fan-out), the pending gate, or `Blocked: <step>`.
 * The pipeline name wraps and the count never truncates, so nothing here has a
 * fixed width. The tooltip adds the execution counts (`13 step runs · 3
 * re-runs`).
 */
export function PipelineHat({ run }: { run: PipelineRunState }) {
  const progress = pipelineStepProgress(run);
  const line = stepLine(run, progress);
  // No snapshot yet (before the first Run): `0/0` says nothing, so the count
  // is left out of the band and the tooltip.
  const showCount = progress.total > 0 || progress.done;
  const tooltip = [run.pipelineName, [showCount ? progress.countLabel : "", progress.runsLabel].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join(" — ");
  return (
    <div
      data-testid="task-card-pipeline"
      data-status={run.status}
      title={tooltip}
      className={cn(
        "flex flex-col gap-1 rounded-tl-[4px_7px] rounded-tr-[7px] border-b px-3 py-2",
        TONE[run.status],
      )}
    >
      <div className="flex items-start gap-1.5">
        <Workflow className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span data-must-not-truncate className="min-w-0 flex-1 text-xs font-semibold leading-[18px] [overflow-wrap:anywhere]">
          {run.pipelineName}
        </span>
        {showCount && (
          <span data-must-not-truncate className="shrink-0 text-xs font-semibold leading-[18px] tabular-nums">
            {progress.countLabel}
          </span>
        )}
      </div>
      {line && (
        <div className="flex items-start gap-1.5 text-[11px] font-medium leading-4">
          <line.Icon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
        </div>
      )}
    </div>
  );
}

function stepLine(
  run: PipelineRunState,
  progress: ReturnType<typeof pipelineStepProgress>,
): { Icon: LucideIcon; text: string } | null {
  if (run.status === "done" || run.status === "cancelled" || run.status === "idle") return null;
  const cur = progress.current;
  if (run.status === "blocked") {
    // Name the step the block is on; fall back to what is live, then to the bare word.
    const blockedStepId = run.blocked.find((b) => b.stepId)?.stepId;
    const name = blockedStepId
      ? (run.snapshot ? stepNameById(run.snapshot.graph, blockedStepId) : blockedStepId)
      : cur?.name;
    return { Icon: AlertTriangle, text: name ? `Blocked: ${name}` : "Blocked" };
  }
  if (!cur) return null;
  if (cur.kind === "gate") {
    return { Icon: UserCheck, text: `Waiting for your review: ${cur.name}${cur.more > 0 ? ` +${cur.more}` : ""}` };
  }
  return { Icon: Play, text: `${cur.name}${cur.more > 0 ? ` +${cur.more}` : ""}` };
}
