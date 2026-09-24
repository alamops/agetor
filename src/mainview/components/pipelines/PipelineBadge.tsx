import { Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { pipelineStepProgress } from "../../../shared/pipeline.ts";
import type { PipelineRunState, PipelineRunStatus } from "../../../shared/types.ts";

const STATUS_CLASSES: Record<PipelineRunStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-info/10 text-info",
  blocked: "bg-warning/10 text-warning",
  done: "bg-success/10 text-success",
  cancelled: "bg-muted text-muted-foreground",
};

interface PipelineBadgeProps {
  run: PipelineRunState;
  className?: string;
}

/**
 * Board-card badge for a pipeline task: the pipeline name plus step
 * progress (`"<completed>/<total> · <active step name>"`), colored by the
 * run's overall status. See `pipelineStepProgress` (`src/shared/
 * pipeline.ts`) for the label format.
 */
export function PipelineBadge({ run, className }: PipelineBadgeProps) {
  const progress = pipelineStepProgress(run);
  return (
    <Badge
      variant="secondary"
      data-testid="task-card-pipeline"
      data-status={run.status}
      title={`${run.pipelineName} — ${progress.label}`}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 border-transparent font-normal", STATUS_CLASSES[run.status], className)}
    >
      <Workflow className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{run.pipelineName}</span>
      <span className="shrink-0 opacity-80">{progress.label}</span>
    </Badge>
  );
}
