import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, useNodesState, useEdgesState } from "@xyflow/react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ChevronDown, RotateCcw, Square, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { MultiSearchSelect, type MultiSearchSelectItem } from "@/components/ui/multi-search-select";
import { useTheme } from "@/components/theme-provider";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { api, ApiError } from "@/lib/api";
import { subscribePipelineGlobalEvents } from "@/lib/pipeline-events";
import {
  edgeVisualState,
  latestTransition,
  reconcileFlowItems,
  responseKindLabel,
  satellitesSignature,
  stepReminded,
  stepTaskFor,
  stepVisualState,
  subagentEdgeKey,
  subagentNodeKey,
  subagentSatellites,
  toFlowEdges,
  toFlowNodes,
  toSubagentFlowEdges,
  toSubagentFlowNodes,
  type EdgeVisualState,
  type ResponseKindTone,
  type StepFlowEdge,
  type StepFlowNode,
  type StepVisualState,
  type SubagentFlowEdge,
  type SubagentFlowNode,
  type SubagentSatellite,
} from "@/lib/pipelines";
import { pipelineStepProgress, stepNameById } from "../../../shared/pipeline.ts";
import type {
  Handoff,
  PipelineBlockKind,
  PipelineGraph,
  PipelineRunState,
  PipelineRunStatus,
  PipelineStepRecord,
  Subagent,
  Task,
} from "../../../shared/types.ts";
import { PipelineCanvasContext, type PipelineCanvasContextValue, type StepProfileResolution } from "./pipeline-canvas-context";
import { StepEdge } from "./StepEdge";
import { StepNode } from "./StepNode";
import { SubagentDetailsDialog } from "./SubagentDetailsDialog";
import { SubagentEdge } from "./SubagentEdge";
import { SubagentNode } from "./SubagentNode";

const NODE_TYPES = { step: StepNode, subagent: SubagentNode };
const EDGE_TYPES = { step: StepEdge, subagent: SubagentEdge };

/** State-held step nodes/edges plus the DERIVED subagent satellites. */
type CanvasNode = StepFlowNode | SubagentFlowNode;
type CanvasEdge = StepFlowEdge | SubagentFlowEdge;

/** Content signature of an observed-subagents map — what the satellite
 *  derivation keys on, so a poll that changed nothing keeps every
 *  satellite's identity. */
function liveSubagentsSignature(map: Map<string, Subagent[]>): string {
  const parts: string[] = [];
  for (const [taskId, list] of map) parts.push(`${taskId}=${list.map((s) => `${s.id}:${s.status}`).join(",")}`);
  return parts.sort().join("|");
}

/** How many `GET /tasks/:id/subagents` requests one poll tick may have in
 *  flight at once. WKWebView caps HTTP/1.1 connections per host at ~6 and
 *  two are permanently spent on SSE channels (`/app/events` plus the open
 *  task's `/tasks/:id/events`), so a fan-out with N active steps must not
 *  fire N parallel listings every 2s — that starved the stream itself. */
const SUBAGENT_LIST_CONCURRENCY = 2;

/** `Promise.all` with at most `limit` `fn` calls in flight; results keep
 *  input order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Keyboard activation of a focused React Flow node: Enter/Space on the
 *  focused `.react-flow__node` (React Flow gives every node `tabIndex=0`
 *  and a `data-id`) inside `container` yields that node's id, else `null`.
 *  Text-entry targets and an open modal/popover layer never qualify. */
function keyboardActivatedNodeId(e: KeyboardEvent, container: HTMLElement | null): string | null {
  if (e.key !== "Enter" && e.key !== " ") return null;
  if (e.defaultPrevented) return null;
  if (document.querySelector('[role="dialog"][aria-modal="true"], [data-popover-open]')) return null;
  if (!(e.target instanceof HTMLElement)) return null;
  if (e.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return null;
  const nodeEl = e.target.closest(".react-flow__node[data-id]");
  if (!nodeEl || !container?.contains(nodeEl)) return null;
  return nodeEl.getAttribute("data-id");
}

/** A run that will never launch another step on its own — nothing left to
 *  observe live once its still-listed executions have been re-read. */
function isTerminalRunStatus(status: PipelineRunStatus): boolean {
  return status === "done" || status === "cancelled";
}

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

/** Background/foreground pair for a {@link responseKindLabel}/reminder chip,
 *  keyed by `ResponseKindTone` — mirrors `STATUS_CLASSES` above. */
const TONE_CLASSES: Record<ResponseKindTone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  muted: "bg-muted text-muted-foreground",
};

/** Statuses from which a run can be restarted from its start step,
 *  discarding the prior history — mirrors the server's own gate. */
const RESTARTABLE_STATUSES: PipelineRunStatus[] = ["done", "cancelled", "blocked"];

/** Block kinds Retry can re-attempt — everything except a missing/invalid
 *  handoff, which Retry can't fix (re-running the same step reproduces the
 *  same non-handoff, or the same malformed one) — those need Advance. */
const RETRY_BLOCK_KINDS: PipelineBlockKind[] = [
  "step-failed",
  "step-blocked",
  "step-cap",
  "profile-missing",
  "join-incomplete",
];
/** Block kinds Advance can resolve by manually picking (or skipping) the
 *  next step(s) — a missing/invalid handoff, an incomplete join the user
 *  wants to force past, a step reported as blocked, or (for a task-level
 *  block, `taskId != null`) a step that was stopped — Advance lets the
 *  user skip past it instead of only retrying the same step. */
const ADVANCE_BLOCK_KINDS: PipelineBlockKind[] = [
  "handoff-missing",
  "handoff-invalid",
  "join-incomplete",
  "step-blocked",
  "step-failed",
];

interface PipelineRunViewProps {
  taskId: string;
  /** Open a step task's panel — optionally landing on one of its helpers'
   *  transcript tabs (a satellite's "Open transcript"). */
  onOpenTask: (task: Task, opts?: { subagentId?: string }) => void;
  onBack: () => void;
  /** Offered as "Edit in Settings" from a satellite's details. */
  onOpenSettingsAgents?: () => void;
}

function formatClockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Any execution's step task is actively running, or blocked with a
 *  genuinely pending interaction — used to decide whether Stop should be
 *  offered. A `blocked` column with nothing pending (e.g. it already got
 *  answered and is between ticks) has nothing left to stop. Distinct from
 *  `run.status === "running"`: a run can be mid-block on one branch while
 *  another branch is still actively executing. */
function hasLiveExecution(steps: Task[], run: { active: { taskId: string }[] } | null): boolean {
  if (!run) return false;
  return run.active.some((entry) => {
    const stepTask = steps.find((t) => t.id === entry.taskId);
    if (!stepTask) return false;
    if (stepTask.column === "running") return true;
    return stepTask.column === "blocked" && stepTask.pendingInteractionCount > 0;
  });
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
 *
 * Nodes/edges live in `useNodesState`/`useEdgesState` (review M11) and are
 * only rebuilt wholesale from a `PipelineGraph` when the graph's own
 * CONTENT changes (`graphSignature`, a structural key — not the graph
 * object's reference, which is a fresh JSON-fetched object on every poll
 * even when nothing changed). Per-poll visual updates (`stepVisualState`/
 * `edgeVisualState`/token) are merged into the existing arrays by id, only
 * replacing a node/edge's `data` when its computed visual actually changed
 * — never a full `toFlowNodes`/`toFlowEdges` rebuild on every poll.
 *
 * **Regression fixed here (React Flow `<StoreUpdater>` "Maximum update
 * depth exceeded")**: `latestTransition(run)` returns a brand-new object
 * literal on every call. It used to be computed directly in the render
 * body (`const transition = latestTransition(run)`), so EVERY re-render —
 * including the ones the per-poll edges-merge effect's own `setEdges` call
 * caused — hands that effect's `[run, transition, setEdges]` dependency
 * array a new `transition` reference, even when `run` itself hasn't
 * changed. React sees a changed dependency, re-runs the effect, calls
 * `setEdges` again, re-renders, computes a new `transition` again — an
 * unbounded synchronous loop the instant a run has ≥1 edge to animate a
 * token across (a run with no edges never has a non-null `transition`, so
 * the reference churn was invisible — matching the symptom that only
 * edge-bearing pipelines crashed). The fix has three parts: (1) `transition`
 * is now derived from a primitive, content-stable signature so it's only a
 * new reference when the underlying data actually changes, not every
 * render; (2) both merge effects are keyed on primitive signatures
 * (`nodeVisualSignature`/`edgeVisualSignature`/`transitionKey`) instead of
 * the `run`/`steps`/`transition` object references, which are fresh
 * objects on every poll/task-refetch even when nothing they carry changed;
 * (3) the merge updaters are identity-stable — they return the SAME
 * `ns`/`es` array reference untouched when no node/edge's computed visual
 * actually changed, so React's `Object.is` bail-out on `setState` skips the
 * re-render (and therefore `<StoreUpdater>`'s own `setEdges`/`setNodes`
 * sync) entirely when a poll turns up nothing new to paint.
 */
export function PipelineRunView({ taskId, onOpenTask, onBack, onOpenSettingsAgents }: PipelineRunViewProps) {
  const { resolved } = useTheme();
  const { profiles: liveProfiles } = useAgentProfiles();
  const confirm = useConfirm();

  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<Task[]>([]);
  const [pipelineGraph, setPipelineGraph] = useState<PipelineGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showGoal, setShowGoal] = useState(false);
  const [notStartedStepName, setNotStartedStepName] = useState<string | null>(null);
  // The satellite whose details dialog is open (by node id — re-resolved
  // against the freshly-derived satellites every render, so the dialog
  // tracks working → done live while it's up).
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null);
  // Subagents observed on each step task (`GET /tasks/:id/subagents`), keyed
  // by step TASK id. Refreshed for every currently-active execution on each
  // poll; entries for executions that have since settled are kept as last
  // observed, so a finished step's satellites keep reading "finished"
  // rather than snapping back to idle — and pruned of any task that's no
  // longer one of this run's step tasks (a Restart replaces every step
  // row). There is deliberately NO per-`taskId` reset effect in this view:
  // `App.tsx` mounts it under a `pipeline-run-${taskId}` key, so switching
  // pipeline tasks always remounts it with fresh state — a reset effect
  // here would be dead code that only ever ran once, on mount.
  const [liveSubagents, setLiveSubagents] = useState<Map<string, Subagent[]>>(() => new Map());
  // Latest-value mirror for `load` (declared below, before this state's
  // consumers) — assigned every render, like the other refs in this view.
  const liveSubagentsRef = useRef(liveSubagents);
  liveSubagentsRef.current = liveSubagents;

  const fetchingRef = useRef(false);
  // Set when a refetch is requested (an event, or the 2s poll) WHILE a
  // fetch is already in flight — rather than dropping it, `load` runs
  // exactly one trailing refetch once the in-flight one settles, so a
  // burst of events during a slow request never loses the freshest state
  // (review M17).
  const dirtyRef = useRef(false);
  const stepIdsRef = useRef<Set<string>>(new Set());
  // `false` once this view has unmounted: an in-flight `load` then skips
  // every setState and — more importantly — never fires its trailing
  // refetch, so leaving the run view mid-request can't start a burst of
  // requests against a view nobody is looking at.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // `load` reads the task id through a ref rather than closing over the
  // prop: its trailing refetch (`finally` below) re-invokes whatever `load`
  // closure the FIRST call captured, and a ref keeps that honest even if
  // the prop ever changed under a mounted instance.
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  const [nodes, setNodes] = useNodesState<StepFlowNode>([]);
  const [edges, setEdges] = useEdgesState<StepFlowEdge>([]);

  const load = useCallback(async () => {
    if (fetchingRef.current) {
      dirtyRef.current = true;
      return;
    }
    fetchingRef.current = true;
    dirtyRef.current = false;
    try {
      const result = await api.getPipelineRun(taskIdRef.current);
      if (!aliveRef.current) return;
      setTask(result.task);
      setSteps(result.steps);
      const stepIds = new Set(result.steps.map((s) => s.id));
      stepIdsRef.current = stepIds;
      setLoadError(null);
      // Live subagents ride the per-task SSE, not the global bus, so the run
      // view refreshes them here, on the same cadence as everything else —
      // for executions still active (a handful at most), PLUS any task
      // whose last-observed list still shows a running subagent: a step's
      // helper settles moments before the step itself hands off, and once
      // the step leaves `run.active` nothing else would ever re-read it, so
      // its satellite would stay "working" forever. Once the run is
      // TERMINAL (done/cancelled), only a task whose last-observed list
      // still shows a running helper is re-read — never the whole
      // `run.active` list, which a cancelled run keeps populated forever
      // (so Retry can re-attempt those executions) and which would
      // otherwise be re-listed every 2s for as long as the view is open. A
      // failed listing keeps that task's last-known list.
      const pipelineRun = result.task.pipelineRun ?? null;
      const terminal = pipelineRun ? isTerminalRunStatus(pipelineRun.status) : true;
      const activeTaskIds = new Set(pipelineRun?.active.map((a) => a.taskId) ?? []);
      const toRefresh = new Set<string>();
      for (const [id, list] of liveSubagentsRef.current) {
        if (!stepIds.has(id)) continue;
        if (list.some((sub) => sub.status === "running")) toRefresh.add(id);
      }
      if (!terminal) for (const id of activeTaskIds) toRefresh.add(id);
      const lists = toRefresh.size > 0
        ? await mapWithConcurrency([...toRefresh], SUBAGENT_LIST_CONCURRENCY, (id) =>
            api.listSubagents(id).then((l) => [id, l] as const).catch(() => null),
          )
        : [];
      if (!aliveRef.current) return;
      setLiveSubagents((prev) => {
        const next = new Map<string, Subagent[]>();
        // Prune: drop anything that isn't one of this run's step tasks any more.
        for (const [id, list] of prev) if (stepIds.has(id)) next.set(id, list);
        for (const entry of lists) if (entry) next.set(entry[0], entry[1]);
        return liveSubagentsSignature(next) === liveSubagentsSignature(prev) ? prev : next;
      });
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(err instanceof ApiError ? err.message : "Failed to load pipeline run.");
    } finally {
      fetchingRef.current = false;
      if (aliveRef.current && dirtyRef.current) {
        dirtyRef.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // D12: sub-poll-latency updates via the global event bus, 2s poll as the
  // documented fallback (skipping a tick while a request is already in
  // flight, per the app's existing poll convention). The events arrive
  // through `subscribePipelineGlobalEvents` — `App.tsx`'s ONE `/events`
  // EventSource forwards every `pipeline`/`column`/`run-status` event into
  // that module bus — rather than this view opening a second permanent
  // EventSource of its own: WKWebView's ~6-connections-per-host budget
  // already carries two SSE channels, and a third starved the rest.
  useEffect(() => {
    const unsubscribe = subscribePipelineGlobalEvents((e) => {
      if (e.kind === "pipeline") {
        if (e.taskId === taskId) void load();
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
  // Primitive facts about the run the effects below key on — `run` itself
  // is a fresh object from every poll's JSON even when nothing changed.
  const runPipelineId = run?.pipelineId ?? null;
  const snapshotCapturedAt = run?.snapshot?.capturedAt ?? null;
  const hasRun = run != null;

  // Before the first Run, `run.snapshot` is null — fall back to the live
  // pipeline's own graph so the canvas still has something to render.
  // Keyed on whether a snapshot EXISTS (`capturedAt`, frozen once a run
  // starts) rather than the snapshot object, which churns every poll.
  useEffect(() => {
    if (!hasRun || snapshotCapturedAt != null || !runPipelineId) {
      setPipelineGraph(null);
      return;
    }
    let cancelled = false;
    api.getPipeline(runPipelineId)
      .then((p) => {
        if (!cancelled) setPipelineGraph(p.graph);
      })
      .catch(() => { /* the canvas simply stays empty until the first Run */ });
    return () => {
      cancelled = true;
    };
  }, [hasRun, runPipelineId, snapshotCapturedAt]);

  const effectiveGraph = run?.snapshot?.graph ?? pipelineGraph;
  const progress = run ? pipelineStepProgress(run) : null;

  // Latest refs for values the effects below read but must NOT depend on
  // directly (their object identity churns every poll/render even when
  // nothing they carry changed — see the class doc comment above for why
  // that broke React Flow). Assigning unconditionally on every render
  // (rather than in their own effect) means the ref is always current by
  // the time an effect actually runs, mirroring `effectiveGraphRef` below.
  const runRef = useRef<PipelineRunState | null>(null);
  runRef.current = run;
  const stepsRef = useRef<Task[]>([]);
  stepsRef.current = steps;

  // A stable CONTENT key for `effectiveGraph` — `run.snapshot.graph` is a
  // fresh object from every poll's JSON response even when its content is
  // byte-identical (the snapshot is frozen once a run starts), so keying
  // the rebuild effect on the object reference would rebuild every node on
  // every 2s poll. Content, not identity, decides when a rebuild is due.
  // `run.snapshot.capturedAt` alone is enough once a run has started — the
  // snapshot is frozen at that instant and never mutated in place — so the
  // common (post-first-run) case needs no stringify at all; only the
  // pre-first-run fallback (the live, editable pipeline graph) still needs
  // a cheap structural fingerprint instead of a full JSON.stringify of the
  // whole graph on every 2s poll.
  const graphSignature = useMemo(() => {
    if (!effectiveGraph) return null;
    if (snapshotCapturedAt != null) return `snap:${snapshotCapturedAt}`;
    return `live:${effectiveGraph.steps.map((s) => s.id).join(",")}:${effectiveGraph.edges.map((e) => e.id).join(",")}`;
  }, [effectiveGraph, snapshotCapturedAt]);
  const effectiveGraphRef = useRef<PipelineGraph | null>(null);
  effectiveGraphRef.current = effectiveGraph;

  // ---- Full rebuild: only on a genuine graph-content change. ----
  useEffect(() => {
    const g = effectiveGraphRef.current;
    if (!g) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(toFlowNodes(g));
    setEdges(toFlowEdges(g).map((e) => ({ ...e, data: { ...e.data, readOnly: true } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (graphSignature), not the graph object's identity.
  }, [graphSignature, setNodes, setEdges]);

  // Primitive, content-derived signatures the two per-poll merge effects
  // below key on INSTEAD OF the `run`/`steps`/`transition` object
  // references (which are brand-new objects on every poll/task-refetch
  // even when nothing in them changed — see the class doc comment). A
  // string/number dependency only "changes" (by `Object.is`) when its
  // VALUE differs, so an unrelated refetch that changes nothing these
  // signatures read never re-triggers the merge.
  const nodeVisualSignature = useMemo(() => {
    if (!run) return "";
    const active = run.active.map((a) => `${a.stepId}:${a.taskId}`).join(",");
    const blocked = run.blocked.map((b) => `${b.stepId ?? ""}:${b.taskId ?? ""}`).join(",");
    const history = run.history.map((h) => `${h.stepId}:${h.outcome ?? ""}:${h.reminder ? h.reminder.at : ""}`).join(",");
    const columns = steps.map((t) => `${t.id}:${t.column}`).join(",");
    return `${active}|${blocked}|${history}|${columns}`;
  }, [run, steps]);

  const edgeVisualSignature = useMemo(() => {
    if (!run) return "";
    const active = run.active.map((a) => a.stepId).join(",");
    const history = run.history.map((h) => `${h.stepId}:${h.nextStepIds.join("+")}`).join(",");
    return `${active}|${history}`;
  }, [run]);

  const transition = useMemo(() => latestTransition(run), [run]);
  const transitionRef = useRef<ReturnType<typeof latestTransition>>(null);
  transitionRef.current = transition;
  const transitionKey = transition ? `${transition.fromStepId}>${transition.toStepIds.join("+")}#${transition.seq}` : "";

  // ---- Per-poll merge: replace a node's `data.visual` only when it
  // actually changed, so most nodes keep their exact object identity —
  // and, whenever NO node's visual changed, hand `setNodes` back the exact
  // same array reference so React's `Object.is` bail-out skips the
  // re-render entirely instead of feeding React Flow a perpetually-new
  // (but content-identical) `nodes` array. ----
  useEffect(() => {
    const r = runRef.current;
    const s = stepsRef.current;
    setNodes((ns) => {
      let changed = false;
      const next = ns.map((n) => {
        const visual: StepVisualState = stepVisualState(r, n.id, s);
        const reminded = stepReminded(r, n.id);
        if (n.data.visual === visual && n.data.reminded === reminded) return n;
        changed = true;
        return { ...n, data: { ...n.data, visual, reminded } };
      });
      return changed ? next : ns;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (nodeVisualSignature), not run/steps object identity; runRef/stepsRef carry the current values.
  }, [nodeVisualSignature, setNodes]);

  useEffect(() => {
    const r = runRef.current;
    const t = transitionRef.current;
    setEdges((es) => {
      let changed = false;
      const next = es.map((e) => {
        const visual: EdgeVisualState = edgeVisualState(r, { id: e.id, from: e.source, to: e.target, label: e.data?.label ?? "" });
        // Every edge the latest transition took gets a token — a fan-out
        // launches several targets off one record, not just the first.
        const isTokenEdge = !!t && t.fromStepId === e.source && t.toStepIds.includes(e.target);
        const tokenKey = isTokenEdge ? t!.seq : undefined;
        if (e.data?.visual === visual && e.data?.token === isTokenEdge && e.data?.tokenKey === tokenKey) return e;
        changed = true;
        return { ...e, data: { ...e.data, visual, token: isTokenEdge, tokenKey } };
      });
      return changed ? next : es;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (edgeVisualSignature/transitionKey), not run/transition object identity; runRef/transitionRef carry the current values.
  }, [edgeVisualSignature, transitionKey, setEdges]);

  // Reads the frozen snapshot through `runRef` and is keyed on
  // `snapshotCapturedAt` — the snapshot is captured exactly once at run
  // start and never mutated, so `capturedAt` IS its identity; depending on
  // `run.snapshot` (a fresh object every poll) would hand every `StepNode`
  // a new `resolveProfile` on every tick for no reason.
  const resolveProfile = useCallback(
    (agentProfileId: string | null): StepProfileResolution => {
      if (!agentProfileId) return { profile: null, profileDeleted: false };
      const snapshotProfile = runRef.current?.snapshot?.profiles[agentProfileId] ?? null;
      if (snapshotProfile) return { profile: snapshotProfile, profileDeleted: false };
      const liveProfile = liveProfiles.find((p) => p.id === agentProfileId) ?? null;
      return { profile: liveProfile, profileDeleted: !liveProfile };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshotCapturedAt stands in for runRef.current.snapshot (frozen per run, read via the ref).
    [snapshotCapturedAt, liveProfiles],
  );

  const canvasContextValue = useMemo<PipelineCanvasContextValue>(
    () => ({ startStepId: effectiveGraph?.startStepId ?? null, resolveProfile }),
    [effectiveGraph?.startStepId, resolveProfile],
  );

  // ---- Subagent satellites (see PipelineEditor's twin block): one node
  // per persona each step may delegate to, plus a transient one per
  // running subagent that matched no persona. `visual` comes from the
  // subagents observed on the step's CURRENT task (`subagentSatellites`):
  // working / done / idle. Derived, identity-reconciled, never in state. ----
  const liveSubagentsKey = useMemo(() => liveSubagentsSignature(liveSubagents), [liveSubagents]);
  const satellites = useMemo<SubagentSatellite[]>(() => {
    const g = effectiveGraphRef.current;
    if (!g) return [];
    const r = runRef.current;
    const s = stepsRef.current;
    const live = liveSubagentsRef.current;
    return g.steps.flatMap((step) => {
      const stepTask = stepTaskFor(s, r, step.id);
      const observed = stepTask ? (live.get(stepTask.id) ?? []) : [];
      return subagentSatellites(step, observed, (id) => resolveProfile(id).profile?.name ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content signatures (graph, node visuals, observed subagents), not the churning run/steps/graph objects; the refs carry current values.
  }, [graphSignature, nodeVisualSignature, liveSubagentsKey, resolveProfile]);
  const satelliteNodeMemory = useRef(new Map<string, { key: string; item: SubagentFlowNode }>());
  const satelliteEdgeMemory = useRef(new Map<string, { key: string; item: SubagentFlowEdge }>());
  const satellitesKey = satellitesSignature(satellites);
  const subagentNodes = useMemo(
    () => reconcileFlowItems(satelliteNodeMemory.current, toSubagentFlowNodes(satellites, () => ({ readOnly: true })), subagentNodeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (satellitesKey).
    [satellitesKey],
  );
  const subagentEdges = useMemo(
    () => reconcileFlowItems(satelliteEdgeMemory.current, toSubagentFlowEdges(satellites), subagentEdgeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (satellitesKey).
    [satellitesKey],
  );
  // Satellites are derived during render from the frozen graph, but the
  // step nodes they hang from only land in `nodes` state once the graph
  // effect above has run — so on the first frame after a run loads (and
  // again after `setNodes([])` on a vanished graph) a satellite can
  // precede its parent. React Flow drops such a child with a "Parent node
  // … not found" console warning for that frame; gate satellites (and
  // their edges) on the parent step actually being present instead.
  const canvasNodes = useMemo<CanvasNode[]>(() => {
    const stepIds = new Set(nodes.map((n) => n.id));
    return [...nodes, ...subagentNodes.filter((n) => n.parentId != null && stepIds.has(n.parentId))];
  }, [nodes, subagentNodes]);
  const canvasEdges = useMemo<CanvasEdge[]>(() => {
    const stepIds = new Set(nodes.map((n) => n.id));
    return [...edges, ...subagentEdges.filter((e) => stepIds.has(e.source))];
  }, [nodes, edges, subagentEdges]);
  const canvasNodesRef = useRef<CanvasNode[]>([]);
  canvasNodesRef.current = canvasNodes;

  // What activating a canvas node does — shared by a click and by
  // Enter/Space on a focused node (see the keyboard effect below): a
  // satellite opens its own details (persona, status, the helpers spawned
  // for it, each openable on its transcript tab); a step node opens the
  // step task's panel, or the "hasn't started yet" note when it has none.
  const activateNode = useCallback(
    (node: CanvasNode) => {
      if (node.type === "subagent") {
        setNotStartedStepName(null);
        setDetailsNodeId(node.id);
        return;
      }
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
  const onNodeClick = useCallback((_: unknown, node: CanvasNode) => activateNode(node), [activateNode]);

  // Enter/Space on a focused node (React Flow makes every node tabbable)
  // activates it exactly like a click — the library's own Enter/Space only
  // toggles its internal selection, which this read-only canvas has
  // switched off (`elementsSelectable={false}`), so without this a
  // keyboard user could reach a node but never open it.
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const nodeId = keyboardActivatedNodeId(e, canvasRef.current);
      if (!nodeId) return;
      const node = canvasNodesRef.current.find((n) => n.id === nodeId);
      if (!node) return;
      e.preventDefault(); // Space would otherwise scroll the pane.
      activateNode(node);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activateNode]);

  const detailsSatellite = useMemo(
    () => (detailsNodeId ? (satellites.find((sat) => sat.nodeId === detailsNodeId) ?? null) : null),
    [detailsNodeId, satellites],
  );
  const detailsStep = detailsSatellite ? (effectiveGraph?.steps.find((st) => st.id === detailsSatellite.stepId) ?? null) : null;
  const detailsStepTask = detailsSatellite ? stepTaskFor(steps, run, detailsSatellite.stepId) : null;
  const detailsProfile = detailsSatellite?.profileId ? resolveProfile(detailsSatellite.profileId) : { profile: null, profileDeleted: false };

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

  const handleRestart = useCallback(async () => {
    const ok = await confirm({
      title: "Restart this pipeline?",
      description: "This starts a fresh run from the start step. Previous run history will be cleared.",
      confirmLabel: "Restart",
      variant: "destructive",
    });
    if (!ok) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.restartPipeline(taskId);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to restart the run.");
    } finally {
      setActionBusy(false);
    }
  }, [taskId, load, confirm]);

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
  const showStop = hasLiveExecution(steps, run);
  const showRestart = RESTARTABLE_STATUSES.includes(run.status);
  // An active execution whose step task already finished (board column
  // `review`) but the pipeline hasn't advanced past it — e.g. `transition:
  // "choose"` with no agent-emitted handoff yet resolved. Distinct from
  // `run.blocked`: nothing failed, it's just waiting on a manual decision.
  // Excludes any execution that ALSO has a `run.blocked` entry (by
  // `taskId`) — that execution already renders its own Advance form in the
  // blocked section above, so listing it here too would show two Advance
  // forms for the same execution (Minor 8).
  const reviewActive = run.active.flatMap((active) => {
    const stepTask = steps.find((t) => t.id === active.taskId);
    if (!stepTask || stepTask.column !== "review") return [];
    const alreadyBlocked = run.blocked.some((b) => b.taskId != null && b.taskId === active.taskId);
    if (alreadyBlocked) return [];
    return [{ active, task: stepTask }];
  });

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
          {showStop && (
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
          {showRestart && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pipeline-run-restart"
              disabled={actionBusy}
              onClick={() => void handleRestart()}
              className="gap-1.5"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Restart
            </Button>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div ref={canvasRef} className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            <PipelineCanvasContext.Provider value={canvasContextValue}>
              <ReactFlow<CanvasNode, CanvasEdge>
                nodes={canvasNodes}
                edges={canvasEdges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodeClick={onNodeClick}
                nodesDraggable={false}
                nodesConnectable={false}
                // Read-only canvas with no `onNodesChange`: React Flow's
                // selection would be a dead affordance (a `select` change
                // it can never apply, plus a stray selection ring). Clicks
                // still reach `onNodeClick` — selection isn't a
                // prerequisite for it.
                elementsSelectable={false}
                fitView
                colorMode={resolved}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </PipelineCanvasContext.Provider>
          </ReactFlowProvider>
          <SubagentDetailsDialog
            open={detailsSatellite != null}
            onClose={() => setDetailsNodeId(null)}
            satellite={detailsSatellite}
            stepName={detailsStep?.name ?? ""}
            cap={detailsStep?.subagents.cap ?? null}
            profile={detailsProfile.profile}
            profileDeleted={detailsProfile.profileDeleted}
            onOpenTranscript={
              detailsStepTask
                ? (subagentId) => {
                    setDetailsNodeId(null);
                    onOpenTask(detailsStepTask, { subagentId });
                  }
                : undefined
            }
            onOpenStep={
              detailsStepTask
                ? () => {
                    setDetailsNodeId(null);
                    onOpenTask(detailsStepTask);
                  }
                : undefined
            }
            onOpenSettingsAgents={onOpenSettingsAgents}
          />
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
                {run.blocked.map((entry, index) => {
                  const stepName = entry.stepId && effectiveGraph ? stepNameById(effectiveGraph, entry.stepId) : entry.stepId;
                  const stepTask = entry.taskId ? (steps.find((t) => t.id === entry.taskId) ?? null) : null;
                  return (
                    <motion.div
                      // Index-prefixed: two run-level blocks of the same
                      // kind (e.g. two `step-failed` holds while the parent
                      // was archived) share every other field.
                      key={`${index}:${entry.kind}:${entry.stepId ?? entry.taskId ?? "run"}`}
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
                        {RETRY_BLOCK_KINDS.includes(entry.kind) && (
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
                        )}
                      </div>
                      {ADVANCE_BLOCK_KINDS.includes(entry.kind) &&
                        (entry.kind !== "step-failed" || entry.taskId != null) && (
                        <AdvanceForm
                          candidates={candidates}
                          busy={actionBusy}
                          onSubmit={(nextStepIds, handoff) => void handleAdvance(entry.taskId, nextStepIds, handoff)}
                        />
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {reviewActive.length > 0 && (
            <div data-testid="pipeline-run-review" className="mb-3 flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Awaiting review</p>
              <AnimatePresence initial={false}>
                {reviewActive.map(({ active, task: stepTask }) => {
                  const stepName = effectiveGraph ? stepNameById(effectiveGraph, active.stepId) : active.stepId;
                  return (
                    <motion.div
                      key={`active-review:${active.taskId}`}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="rounded-md border border-info/40 bg-info/10 p-2.5"
                    >
                      <p className="text-xs font-medium text-info">{stepName} — finished, awaiting next step</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
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
                      </div>
                      <AdvanceForm
                        candidates={candidates}
                        busy={actionBusy}
                        onSubmit={(nextStepIds, handoff) => void handleAdvance(active.taskId, nextStepIds, handoff)}
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
  const kindInfo = responseKindLabel(record.responseKind);

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
      {(kindInfo || record.reminder) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {kindInfo && (
            <span
              data-testid="pipeline-run-response-kind"
              data-kind={record.responseKind}
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASSES[kindInfo.tone]}`}
            >
              {kindInfo.text}
            </span>
          )}
          {record.reminder && (
            <span
              data-testid="pipeline-run-reminder"
              title={record.reminder.detail}
              data-delivered={record.reminder.delivered !== false}
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                record.reminder.delivered === false ? TONE_CLASSES.danger : TONE_CLASSES.warning
              }`}
            >
              {record.reminder.delivered === false ? "Reminder failed" : "Reminder sent"} ·{" "}
              {formatClockTime(record.reminder.at)}
            </span>
          )}
        </div>
      )}
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
