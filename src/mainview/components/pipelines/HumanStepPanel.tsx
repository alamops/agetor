import { useMemo, useState } from "react";
import { CheckCircle2, GitCompare, RotateCcw, UserCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { HandoffCard } from "@/components/handoff/HandoffCard";
import { HandoffViewContext, stepNameFor, type HandoffViewValue } from "@/components/handoff/handoff-context";
import { MdImageScopeContext, type MdImageScope } from "@/components/kanban/md-components";
import { DiffDialog } from "@/components/kanban/DiffDialog";
import { outgoingSteps, stepNameById } from "../../../shared/pipeline.ts";
import type {
  PipelineGraph,
  PipelineHumanStep,
  PipelineRunState,
  PipelineStepRecord,
  Task,
} from "../../../shared/types.ts";

interface HumanStepPanelProps {
  /** The pipeline parent task. */
  task: Task;
  run: PipelineRunState;
  graph: PipelineGraph;
  /** The pending gate this panel decides. */
  gate: PipelineHumanStep;
  /** Every step task of this run (for transcript links). */
  steps: Task[];
  homeDir: string | null;
  open: boolean;
  onClose: () => void;
  onOpenTask: (task: Task) => void;
  /** Refetch the run after a successful decision. */
  onDecided: () => Promise<void> | void;
}

/**
 * The human gate's control panel — the owner's review of the work so far,
 * including the last handoff into the gate, and exactly two decisions:
 * **Accept** (continue through the gate's outgoing edges; comment optional)
 * and **Return** (re-run the gate's sole incoming source; comment required).
 *
 * A modal over the run view. The component stays mounted while the run view
 * is mounted (the parent always renders it and this component returns `null`
 * when closed), so a half-typed comment/mode/target survives closing and
 * reopening; the parent keys it by the gate's `seq`, so a new gate resets the
 * draft. It never auto-opens on arrival.
 */
export function HumanStepPanel({
  task,
  run,
  graph,
  gate,
  steps,
  homeDir,
  open,
  onClose,
  onOpenTask,
  onDecided,
}: HumanStepPanelProps) {
  const step = graph.steps.find((s) => s.id === gate.stepId) ?? null;
  const archived = task.archivedAt != null;

  const [comment, setComment] = useState("");
  const [mode, setMode] = useState<"fresh" | "resume">("fresh");
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  const outgoing = step ? outgoingSteps(graph, step.id) : [];
  const needsTarget = !!step && step.transition === "choose" && outgoing.length > 1;
  const terminal = outgoing.length === 0;

  const lastArrival = gate.arrivals[gate.arrivals.length - 1] ?? null;
  const lastHandoff = lastArrival?.handoff ?? null;
  const lastRecord: PipelineStepRecord | null = lastArrival
    ? (run.history.find((h) => h.stepId === lastArrival.fromStepId && h.seq === lastArrival.seq) ?? null)
    : null;
  const sourceTask = lastRecord?.taskId ? (steps.find((t) => t.id === lastRecord.taskId) ?? null) : null;
  const resumeAvailable = sourceTask != null && (sourceTask.runId != null || sourceTask.hasOpenableRun);

  const worktreePath = task.worktreePath;
  const workdir = task.workdir;
  const handoffView = useMemo<HandoffViewValue>(
    () => ({
      enabled: true,
      taskId: lastRecord?.taskId ?? undefined,
      parentId: task.id,
      roots: [worktreePath, workdir],
      homeDir,
      stepId: lastArrival?.fromStepId ?? null,
      stepName: lastArrival ? stepNameFor(graph, lastArrival.fromStepId) : null,
      graph,
      run,
      record: lastRecord,
      settledRunIds: new Set<string>(),
    }),
    [lastRecord, lastArrival, task.id, worktreePath, workdir, homeDir, graph, run],
  );
  const mdImageScope = useMemo<MdImageScope>(
    () => ({ taskId: lastRecord?.taskId ?? task.id, roots: [worktreePath, workdir], allowLocal: true }),
    [lastRecord?.taskId, task.id, worktreePath, workdir],
  );

  const priorRounds = run.history.filter((h) => h.stepId === gate.stepId && h.human != null);
  const canReturn = comment.trim().length > 0;

  const decide = async (decision: "accept" | "return") => {
    if (archived || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.reviewPipeline(task.id, {
        stepId: gate.stepId,
        seq: gate.seq,
        decision,
        ...(comment.trim().length > 0 ? { comment } : {}),
        ...(decision === "accept" && target ? { nextStepIds: [target] } : {}),
        ...(decision === "return" ? { mode } : {}),
      });
      setComment("");
      setTarget(null);
      setMode("fresh");
      await onDecided();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to record the review.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="flex max-h-[85vh] w-[min(720px,92vw)] flex-col"
      labelledBy="pipeline-human-panel-title"
    >
      <div data-testid="pipeline-human-panel" data-gate-seq={gate.seq} className="flex min-h-0 flex-col">
        <div className="flex items-start gap-2 border-b border-border px-4 py-3">
          <UserCheck className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="pipeline-human-panel-title" className="truncate text-sm font-semibold">
              Human review — {step?.name ?? gate.stepId}
            </h2>
            <p className="text-xs text-muted-foreground">
              {archived
                ? "This pipeline is archived — unarchive it to decide."
                : "Review the work so far, then accept it or send it back."}
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <section className="mb-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Goal</p>
            <p data-testid="pipeline-human-goal" className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
              {task.prompt}
            </p>
          </section>

          <section className="mb-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">What to check</p>
            <p data-testid="pipeline-human-check" className="whitespace-pre-wrap text-xs">
              {step?.instructions.trim() ? step.instructions : "(no checklist for this gate)"}
            </p>
          </section>

          <section className="mb-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">Last handoff</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="pipeline-human-diff"
                className="h-6 gap-1 text-xs"
                onClick={() => setDiffOpen(true)}
              >
                <GitCompare className="size-3" aria-hidden />
                View changes
              </Button>
            </div>
            {lastArrival ? (
              <p data-testid="pipeline-human-from" className="mb-1 text-xs text-muted-foreground">
                from {stepNameById(graph, lastArrival.fromStepId)}
              </p>
            ) : null}
            {lastHandoff ? (
              <div data-testid="pipeline-human-handoff">
                <HandoffViewContext.Provider value={handoffView}>
                  <MdImageScopeContext.Provider value={mdImageScope}>
                    <HandoffCard handoff={lastHandoff} variant="history" stepId={lastArrival?.fromStepId ?? null} />
                  </MdImageScopeContext.Provider>
                </HandoffViewContext.Provider>
              </div>
            ) : (
              <p data-testid="pipeline-human-handoff-empty" className="text-xs text-muted-foreground">
                No handoff — entered manually.
              </p>
            )}
          </section>

          {priorRounds.length > 0 && (
            <section className="mb-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Prior rounds on this gate</p>
              <ul data-testid="pipeline-human-prior" className="flex flex-col gap-1">
                {[...priorRounds].reverse().map((h) => (
                  <li key={`${h.seq}:${h.outcome}`} className="rounded-md border border-border p-1.5 text-xs">
                    <span className="text-muted-foreground">#{h.seq}</span>{" "}
                    <span className={h.human?.decision === "return" ? "text-info" : "text-success"}>
                      {h.human?.decision}
                    </span>
                    {h.human?.comment ? <span className="text-muted-foreground"> — {h.human.comment}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Run history</p>
            {run.history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No steps have run yet.</p>
            ) : (
              <ul data-testid="pipeline-human-history" className="flex flex-col gap-1">
                {[...run.history].reverse().map((h) => {
                  const stepTask = h.taskId ? (steps.find((t) => t.id === h.taskId) ?? null) : null;
                  return (
                    <li key={`${h.seq}:${h.taskId ?? "human"}`} className="flex items-center gap-2 text-xs">
                      <span className="w-8 shrink-0 text-muted-foreground">#{h.seq}</span>
                      <span className="min-w-0 flex-1 truncate">{stepNameById(graph, h.stepId)}</span>
                      <span className="shrink-0 text-muted-foreground">{h.outcome ?? "…"}</span>
                      {stepTask && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-xs"
                          onClick={() => onOpenTask(stepTask)}
                        >
                          Transcript
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="border-t border-border px-4 py-3">
          {error && (
            <p data-testid="pipeline-human-error" className="mb-2 text-xs text-danger">
              {error}
            </p>
          )}
          <Textarea
            data-testid="pipeline-human-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Comment — required to return, optional to accept"
            className="min-h-[70px] text-xs"
            disabled={archived}
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Return mode</span>
              <Button
                type="button"
                variant={mode === "fresh" ? "secondary" : "outline"}
                size="sm"
                data-testid="pipeline-human-mode-fresh"
                className="h-6 text-xs"
                disabled={archived || busy}
                onClick={() => setMode("fresh")}
              >
                Fresh
              </Button>
              <Button
                type="button"
                variant={mode === "resume" ? "secondary" : "outline"}
                size="sm"
                data-testid="pipeline-human-mode-resume"
                className="h-6 text-xs"
                disabled={archived || busy || !resumeAvailable}
                title={resumeAvailable ? "Continue the previous step's session" : "The previous step can't be resumed — use Fresh"}
                onClick={() => setMode("resume")}
              >
                Resume
              </Button>
            </div>
          </div>

          {needsTarget && (
            <div data-testid="pipeline-human-targets" className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Next step</span>
              {outgoing.map((o) => (
                <Button
                  key={o.step.id}
                  type="button"
                  variant={target === o.step.id ? "secondary" : "outline"}
                  size="sm"
                  data-testid="pipeline-human-target"
                  className="h-6 text-xs"
                  disabled={archived || busy}
                  onClick={() => setTarget(o.step.id)}
                >
                  {o.step.name}
                </Button>
              ))}
            </div>
          )}
          {!needsTarget && !terminal && outgoing.length > 1 && (
            <p data-testid="pipeline-human-targets-all" className="mt-2 text-xs text-muted-foreground">
              Accept runs all next steps: {outgoing.map((o) => o.step.name).join(", ")}
            </p>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pipeline-human-return"
              disabled={archived || busy || !canReturn}
              title={canReturn ? "Send back to the previous step" : "Write a comment to return"}
              onClick={() => void decide("return")}
              className="gap-1.5"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Return
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="pipeline-human-accept"
              disabled={archived || busy || (needsTarget && target === null)}
              onClick={() => void decide("accept")}
              className="gap-1.5"
            >
              <CheckCircle2 className="size-3.5" aria-hidden />
              {terminal ? "Accept & finish" : "Accept"}
            </Button>
          </div>
        </div>
      </div>

      <DiffDialog open={diffOpen} task={task} onClose={() => setDiffOpen(false)} />
    </Dialog>
  );
}
