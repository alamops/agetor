import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls } from "@xyflow/react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ChevronDown, RotateCcw, Square, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MultiSearchSelect, type MultiSearchSelectItem } from "@/components/ui/multi-search-select";
import { useTheme } from "@/components/theme-provider";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { api, ApiError } from "@/lib/api";
import {
  edgeVisualState,
  latestTransition,
  stepTaskFor,
  stepVisualState,
  toFlowEdges,
  toFlowNodes,
  type StepFlowEdge,
  type StepFlowNode,
} from "@/lib/pipelines";
import { pipelineStepProgress, stepNameById } from "../../../shared/pipeline.ts";
import type {
  Handoff,
  PipelineGraph,
  PipelineRunStatus,
  PipelineStepRecord,
  Task,
} from "../../../shared/types.ts";
import { StepEdge } from "./StepEdge";
import { StepNode } from "./StepNode";

const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { step: StepEdge };

const STATUS_LABEL: Record<PipelineRunStatus, string> = {
  idle: "Not started",
  running: "Running",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_CLASSES: Record<PipelineRunStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-info/10 text-info",
  blocked: "bg-warning/10 text-warning",
  done: "bg-success/10 text-success",
  cancelled: "bg-muted text-muted-foreground",
};

interface PipelineRunViewProps {
  taskId: string;
  onOpenTask: (task: Task) => void;
  onBack: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Full-page, live-animated view of one pipeline TASK's run: the active step
 * pulses, traversed edges paint, and a token travels the edge on each
 * handoff — via `stepVisualState`/`edgeVisualState`/`latestTransition`
 * (`src/mainview/lib/pipelines.ts`). Self-sufficient: fetches its own data
 * (`GET /tasks/:id/pipeline`), refetches on relevant global events (D12)
 * with a 2s poll as the fallback, and lets the caller handle navigation
 * (`onOpenTask` for a step click, `onBack` for the header button). See
 * `docs/plans/pipelines.md` D5/D9/D12.
 */
export function PipelineRunView({ taskId, onOpenTask, onBack }: PipelineRunViewProps) {
  const { resolved } = useTheme();
  const { profiles: liveProfiles } = useAgentProfiles();

  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<Task[]>([]);
  const [pipelineGraph, setPipelineGraph] = useState<PipelineGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showGoal, setShowGoal] = useState(false);
  const [notStartedStepName, setNotStartedStepName] = useState<string | null>(null);

  const fetchingRef = useRef(false);
  const stepIdsRef = useRef<Set<string>>(new Set());

  // Reset on task switch, before the loader effect below re-fetches.
  useEffect(() => {
    setTask(null);
    setSteps([]);
    setLoadError(null);
    setNotStartedStepName(null);
    stepIdsRef.current = new Set();
  }, [taskId]);

  const load = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const result = await api.getPipelineRun(taskId);
      setTask(result.task);
      setSteps(result.steps);
      stepIdsRef.current = new Set(result.steps.map((s) => s.id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load pipeline run.");
    } finally {
      fetchingRef.current = false;
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // D12: sub-poll-latency updates via the global event bus, 2s poll as the
  // documented fallback (skipping a tick while a request is already in
  // flight, per the app's existing poll convention).
  useEffect(() => {
    const unsubscribe = api.subscribeGlobalEvents((e) => {
      if (e.kind === "pipeline" && e.taskId === taskId) {
        void load();
        return;
      }
      if (
        (e.kind === "column" || e.kind === "run-status")
        && (e.taskId === taskId || stepIdsRef.current.has(e.taskId))
      ) {
        void load();
      }
    });
    return unsubscribe;
  }, [taskId, load]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!fetchingRef.current) void load();
    }, 2000);
    return () => clearInterval(id);
  }, [load]);

  const run = task?.pipelineRun ?? null;

  // Before the first Run, `run.snapshot` is null — fall back to the live
  // pipeline's own graph so the canvas still has something to render.
  useEffect(() => {
    if (!run || run.snapshot) {
      setPipelineGraph(null);
      return;
    }
    let cancelled = false;
    api.getPipeline(run.pipelineId)
      .then((p) => {
        if (!cancelled) setPipelineGraph(p.graph);
      })
      .catch(() => { /* the canvas simply stays empty until the first Run */ });
    return () => {
      cancelled = true;
    };
  }, [run?.pipelineId, run?.snapshot]);

  const effectiveGraph = run?.snapshot?.graph ?? pipelineGraph;
  const progress = run ? pipelineStepProgress(run) : null;
  const transition = latestTransition(run);

  const nodes = useMemo<StepFlowNode[]>(() => {
    if (!effectiveGraph) return [];
    return toFlowNodes(effectiveGraph, (step) => {
      const snapshotProfile = step.agentProfileId ? (run?.snapshot?.profiles[step.agentProfileId] ?? null) : null;
      const liveProfile = !snapshotProfile && step.agentProfileId
        ? (liveProfiles.find((p) => p.id === step.agentProfileId) ?? null)
        : null;
      const profile = snapshotProfile ?? liveProfile;
      return {
        profile,
        profileDeleted: step.agentProfileId != null && !profile,
        isStart: effectiveGraph.startStepId === step.id,
        visual: stepVisualState(run, step.id, steps),
        parallelWarning: step.transition === "all",
        readOnly: true,
      };
    });
  }, [effectiveGraph, run, steps, liveProfiles]);

  const edges = useMemo<StepFlowEdge[]>(() => {
    if (!effectiveGraph) return [];
    return toFlowEdges(effectiveGraph).map((e) => {
      const visual = edgeVisualState(run, { id: e.id, from: e.source, to: e.target, label: e.data?.label ?? "" });
      const isTokenEdge = !!transition && transition.fromStepId === e.source && transition.toStepId === e.target;
      return {
        ...e,
        data: {
          ...e.data,
          visual,
          readOnly: true,
          token: isTokenEdge,
          tokenKey: isTokenEdge ? transition!.seq : undefined,
        },
      };
    });
  }, [effectiveGraph, run, transition]);

  const onNodeClick = useCallback(
    (_: unknown, node: StepFlowNode) => {
      const stepTask = stepTaskFor(steps, run, node.id);
      if (stepTask) {
        setNotStartedStepName(null);
        onOpenTask(stepTask);
      } else {
        setNotStartedStepName(node.data.step.name);
      }
    },
    [steps, run, onOpenTask],
  );

  const handleStop = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await api.cancelPipeline(taskId);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to stop the run.");
    } finally {
      setActionBusy(false);
    }
  }, [taskId, load]);

  const handleRetry = useCallback(async (stepTaskId?: string) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await api.retryPipeline(taskId, stepTaskId ? { taskId: stepTaskId } : undefined);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to retry.");
    } finally {
      setActionBusy(false);
    }
  }, [taskId, load]);

  const handleAdvance = useCallback(
    async (fromTaskId: string | null, nextStepIds: string[] | null, handoff?: Partial<Handoff>) => {
      setActionBusy(true);
      setActionError(null);
      try {
        await api.advancePipeline(taskId, { nextStepIds, handoff, fromTaskId: fromTaskId ?? undefined });
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "Failed to advance.");
      } finally {
        setActionBusy(false);
      }
    },
    [taskId, load],
  );

  if (loadError && !task) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-danger">
        <p>{loadError}</p>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back to board
        </Button>
      </div>
    );
  }

  if (!task || !run) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        Loading pipeline run…
      </div>
    );
  }

  const candidates = (effectiveGraph?.steps ?? []).map((s) => ({ value: s.id, label: s.name }));

  return (
    <div data-testid="pipeline-run-view" className="flex h-full min-h-0 w-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" data-testid="pipeline-run-back" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="size-4" aria-hidden />
          Back to board
        </Button>
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Workflow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{run.pipelineName}</span>
        </span>
        <Badge
          variant="secondary"
          data-testid="pipeline-run-status"
          className={`border-transparent font-normal ${STATUS_CLASSES[run.status]}`}
        >
          {STATUS_LABEL[run.status]}
        </Badge>
        {progress && <span className="text-xs text-muted-foreground">{progress.label}</span>}
        <div className="ml-auto flex items-center gap-2">
          {actionError && <span className="text-xs text-danger">{actionError}</span>}
          {run.status === "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pipeline-run-stop"
              disabled={actionBusy}
              onClick={() => void handleStop()}
              className="gap-1.5"
            >
              <Square className="size-3.5" aria-hidden />
              Stop
            </Button>
          )}
          {(run.status === "blocked" || run.status === "cancelled") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pipeline-run-retry"
              disabled={actionBusy}
              onClick={() => void handleRetry()}
              className="gap-1.5"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Retry
            </Button>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodeClick={onNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              fitView
              colorMode={resolved}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
          {notStartedStepName && (
            <div
              data-testid="pipeline-run-node-not-started"
              className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
            >
              "{notStartedStepName}" hasn't started yet.
            </div>
          )}
        </div>

        <div className="w-96 shrink-0 overflow-y-auto border-l border-border bg-card p-3">
          <div className="mb-3">
            <button
              type="button"
              data-testid="pipeline-run-goal-toggle"
              onClick={() => setShowGoal((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/40"
            >
              Goal
              <ChevronDown className={`size-3.5 shrink-0 transition-transform ${showGoal ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {showGoal && (
              <p data-testid="pipeline-run-goal" className="mt-1.5 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs text-foreground">
                {task.prompt}
              </p>
            )}
          </div>

          {run.blocked.length > 0 && (
            <div data-testid="pipeline-run-blocked" className="mb-3 flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {run.blocked.map((entry, i) => {
                  const stepName = entry.stepId && effectiveGraph ? stepNameById(effectiveGraph, entry.stepId) : entry.stepId;
                  const stepTask = entry.taskId ? (steps.find((t) => t.id === entry.taskId) ?? null) : null;
                  return (
                    <motion.div
                      key={`${entry.taskId ?? "run"}-${entry.stepId ?? "none"}-${i}`}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="rounded-md border border-warning/40 bg-warning/10 p-2.5"
                    >
                      <p className="text-xs font-medium text-warning">
                        {stepName ? `${stepName} — ` : ""}
                        {entry.kind}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{entry.message}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {stepTask && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="pipeline-run-open-step"
                            onClick={() => onOpenTask(stepTask)}
                            className="h-7 text-xs"
                          >
                            Open step
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="pipeline-run-retry-entry"
                          disabled={actionBusy}
                          onClick={() => void handleRetry(entry.taskId ?? undefined)}
                          className="h-7 text-xs"
                        >
                          Retry
                        </Button>
                      </div>
                      <AdvanceForm
                        candidates={candidates}
                        busy={actionBusy}
                        onSubmit={(nextStepIds, handoff) => void handleAdvance(entry.taskId, nextStepIds, handoff)}
                      />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">History</p>
            {run.history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No steps have run yet.</p>
            ) : (
              <ul data-testid="pipeline-run-history" className="flex flex-col gap-1.5">
                {[...run.history].reverse().map((record) => (
                  <HistoryRow key={record.seq} record={record} graph={effectiveGraph} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdvanceForm({
  candidates,
  busy,
  onSubmit,
}: {
  candidates: { value: string; label: string }[];
  busy: boolean;
  onSubmit: (nextStepIds: string[] | null, handoff?: Partial<Handoff>) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [finishHere, setFinishHere] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [summary, setSummary] = useState("");

  const items: MultiSearchSelectItem[] = candidates;

  const submit = () => {
    const handoff = purpose.trim() || summary.trim() ? { purpose: purpose.trim(), summary: summary.trim() } : undefined;
    onSubmit(finishHere ? null : selected, handoff);
  };

  return (
    <div data-testid="pipeline-run-advance" className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-background p-2">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch checked={finishHere} onCheckedChange={setFinishHere} data-testid="pipeline-run-advance-finish" />
        Finish here (no next step)
      </label>
      {!finishHere && (
        <MultiSearchSelect
          values={selected}
          onChange={setSelected}
          items={items}
          emptyLabel="Pick next step(s)…"
          placeholder="Search steps…"
        />
      )}
      <Textarea
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        placeholder="Purpose (optional)"
        className="min-h-[44px] text-xs"
      />
      <Textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Summary (optional)"
        className="min-h-[44px] text-xs"
      />
      <Button
        type="button"
        size="sm"
        className="h-7 text-xs"
        disabled={busy || (!finishHere && selected.length === 0)}
        onClick={submit}
      >
        Advance
      </Button>
    </div>
  );
}

function HistoryRow({ record, graph }: { record: PipelineStepRecord; graph: PipelineGraph | null }) {
  const [open, setOpen] = useState(false);
  const stepName = graph ? stepNameById(graph, record.stepId) : record.stepId;
  const duration = record.endedAt != null ? formatDuration(record.endedAt - record.startedAt) : "—";

  return (
    <li data-testid="pipeline-run-history-row" className="rounded-md border border-border p-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left text-xs"
      >
        <span className="min-w-0 truncate">
          #{record.seq} {stepName}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {record.outcome ?? "…"} · {duration}
        </span>
      </button>
      {open && record.handoff && (
        <pre
          data-testid="pipeline-run-history-handoff"
          className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-[10px]"
        >
          {JSON.stringify(record.handoff, null, 2)}
        </pre>
      )}
    </li>
  );
}
