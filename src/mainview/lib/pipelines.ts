/**
 * Webview-side helpers for {@link Pipeline}s: a module-cached list hook
 * mirroring `useAgentProfiles` (`src/mainview/lib/agent-profiles.ts`), plus
 * pure functions that turn a {@link PipelineRunState} into per-node/per-edge
 * visual states for the canvas editor and the run view, and React Flow
 * node/edge conversion + dagre auto-layout. Kept free of any component
 * imports so `pipelines.test.ts` can exercise every pure function with no
 * DOM. See `docs/plans/pipelines.md` §3 (D6/D12) for the design this
 * supports.
 */
import { useCallback, useEffect, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { api } from "./api";
import type {
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineRunState,
  PipelineStep,
  PipelineStepRecord,
  Task,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// usePipelines — module-cached list, modelled on useAgentProfiles.
// ---------------------------------------------------------------------------

let cache: Pipeline[] | null = null;
let inFlight: Promise<Pipeline[]> | null = null;
let lastError: string | null = null;
let loaded = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

async function fetchPipelines(): Promise<void> {
  const promise = api.listPipelines();
  inFlight = promise;
  try {
    const pipelines = await promise;
    cache = pipelines;
    lastError = null;
    loaded = true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    if (inFlight === promise) inFlight = null;
    notify();
  }
}

/**
 * Module-cached `Pipeline[]` list — same cache/refresh semantics as
 * `useAgentProfiles`: the first mount (across the whole app) triggers the
 * fetch, every later mount reads the already-resolved cache instantly, and
 * `refresh()` refetches and re-renders every subscribed component. A failed
 * fetch leaves the previous `cache` in place (stale-but-known) and only
 * sets `error`; `loaded` stays `true` once any fetch has ever succeeded.
 *
 * `opts.enabled: false` (default `true`) skips fetching entirely and always
 * reports an empty, non-loading, error-free, not-`loaded` result.
 */
export function usePipelines(opts?: { enabled?: boolean }): {
  pipelines: Pipeline[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const enabled = opts?.enabled ?? true;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const listener = () => bump((n) => n + 1);
    subscribers.add(listener);
    if (cache === null && inFlight === null) void fetchPipelines();
    return () => {
      subscribers.delete(listener);
    };
  }, [enabled]);

  const refresh = useCallback(() => fetchPipelines(), []);

  if (!enabled) {
    return { pipelines: [], loading: false, loaded: false, error: null, refresh };
  }
  return {
    pipelines: cache ?? [],
    loading: cache === null && lastError === null,
    loaded,
    error: lastError,
    refresh,
  };
}

/**
 * Module-level refetch, callable from outside a `usePipelines()` consumer
 * (e.g. `App.tsx` after creating a pipeline task, to pick up the bound
 * pipeline's freshly-bumped `taskCount`) — identical to the `refresh()`
 * returned by the hook, just reachable without mounting one.
 */
export function refreshPipelines(): Promise<void> {
  return fetchPipelines();
}

// ---------------------------------------------------------------------------
// Visual state derivation
// ---------------------------------------------------------------------------

/** Per-step-node rendering state, derived from a live {@link PipelineRunState}
 *  (or `null`/`undefined` before the first Run) — see {@link stepVisualState}. */
export type StepVisualState = "idle" | "active" | "done" | "blocked" | "failed" | "cancelled";

/** Per-edge rendering state — see {@link edgeVisualState}. */
export type EdgeVisualState = "idle" | "traversed" | "flowing";

/**
 * Resolve a single step's visual state for the canvas/run view. A step
 * currently in `run.active` is `"active"`, unless either a `run.blocked`
 * entry names it (by `stepId` or by the active execution's `taskId`) or its
 * own step task's board `column` reads `"blocked"`, in which case it's
 * `"blocked"`. Otherwise the most recent `run.history` record for this step
 * decides: `succeeded`/`advanced-manually` → `"done"`, `failed` →
 * `"failed"`, `cancelled` → `"cancelled"`; no history at all (or an
 * unresolved/`null` outcome) → `"idle"`. `run` may be `null`/`undefined`
 * (no run has started yet), which always yields `"idle"`.
 */
export function stepVisualState(
  run: PipelineRunState | null | undefined,
  stepId: string,
  steps: Task[],
): StepVisualState {
  if (!run) return "idle";

  const activeEntry = run.active.find((a) => a.stepId === stepId);
  if (activeEntry) {
    const blockedForStep = run.blocked.some(
      (b) => b.stepId === stepId || (b.taskId != null && b.taskId === activeEntry.taskId),
    );
    const stepTask = steps.find((t) => t.id === activeEntry.taskId);
    if (blockedForStep || stepTask?.column === "blocked") return "blocked";
    return "active";
  }

  let latest: PipelineStepRecord | null = null;
  for (const record of run.history) {
    if (record.stepId === stepId) latest = record;
  }
  if (!latest) return "idle";

  switch (latest.outcome) {
    case "succeeded":
    case "advanced-manually":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

/**
 * Resolve an edge's visual state. `"traversed"` when ANY history record from
 * `edge.from` recorded `edge.to` in its `nextStepIds` (covers a cycle that
 * took this edge on an earlier generation, even if the most recent one took
 * a different branch). `"flowing"` — a stronger state, painted as the
 * animated "in flight" edge — additionally requires that the *latest*
 * history record from `edge.from` named `edge.to` AND `edge.to` is
 * currently active (i.e. this is the transition that's actively in
 * progress right now, not a stale earlier one). Otherwise `"idle"`.
 */
export function edgeVisualState(run: PipelineRunState | null | undefined, edge: PipelineEdge): EdgeVisualState {
  if (!run) return "idle";

  let latestFromRecord: PipelineStepRecord | null = null;
  let traversed = false;
  for (const record of run.history) {
    if (record.stepId !== edge.from) continue;
    if (record.nextStepIds.includes(edge.to)) traversed = true;
    latestFromRecord = record;
  }
  if (!traversed) return "idle";

  const flowing = !!latestFromRecord?.nextStepIds.includes(edge.to)
    && run.active.some((a) => a.stepId === edge.to);
  return flowing ? "flowing" : "traversed";
}

/**
 * The most recent handoff transition recorded in `run.history` — the run
 * view animates a token along this edge, keyed by `seq` so a later
 * transition (even a repeat of the same edge on a cycle) replays the
 * animation. `null` before any transition has happened (empty history, or
 * every record so far was terminal/failed with no `nextStepIds`).
 */
export function latestTransition(
  run: PipelineRunState | null | undefined,
): { fromStepId: string; toStepId: string; seq: number } | null {
  if (!run) return null;
  for (let i = run.history.length - 1; i >= 0; i -= 1) {
    const record = run.history[i]!;
    if (record.nextStepIds.length > 0) {
      return { fromStepId: record.stepId, toStepId: record.nextStepIds[0]!, seq: record.seq };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// React Flow conversion
// ---------------------------------------------------------------------------

/** Node data shape shared by every {@link toFlowNodes} caller: the source
 *  {@link PipelineStep} plus whatever per-consumer extras (profile,
 *  visual state, …) the caller's `extra` callback attaches. */
export type StepFlowNodeData = Record<string, unknown> & { step: PipelineStep };
export type StepFlowNode = Node<StepFlowNodeData, "step">;

/** Edge data shape shared by every {@link toFlowEdges} caller. */
export type StepFlowEdgeData = Record<string, unknown> & { label?: string };
export type StepFlowEdge = Edge<StepFlowEdgeData, "step">;

/**
 * Convert a {@link PipelineGraph}'s steps into React Flow nodes: `id` = step
 * id, `type: "step"`, `position` = the step's own canvas position, `data` =
 * `{ step, ...extra?.(step) }`. `extra` lets a caller attach per-render
 * fields (resolved profile, visual state, callbacks, …) without this pure
 * module knowing anything about them.
 */
export function toFlowNodes(
  graph: PipelineGraph,
  extra?: (step: PipelineStep) => Record<string, unknown>,
): StepFlowNode[] {
  return graph.steps.map((step) => ({
    id: step.id,
    type: "step",
    position: { x: step.position.x, y: step.position.y },
    data: { step, ...(extra ? extra(step) : {}) },
  }));
}

/**
 * Convert a {@link PipelineGraph}'s edges into React Flow edges: `id` = edge
 * id, `type: "step"`, `source`/`target` = `from`/`to`, fixed
 * `sourceHandle: "out"` / `targetHandle: "in"` (matching {@link StepNode}'s
 * two handles), `data: { label }`.
 */
export function toFlowEdges(graph: PipelineGraph): StepFlowEdge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    type: "step",
    source: edge.from,
    target: edge.to,
    sourceHandle: "out",
    targetHandle: "in",
    data: { label: edge.label },
  }));
}

/**
 * Inverse of {@link toFlowNodes}/{@link toFlowEdges} — rebuilds a
 * {@link PipelineGraph} from the editor's live React Flow node/edge arrays
 * (after drags, connects, deletes). Each node's `data.step` is spread and
 * its `position` overwritten from the node's live canvas position; each
 * edge's `label` is read back from `data.label` (defaulting to `""`).
 */
export function graphFromFlow(nodes: StepFlowNode[], edges: StepFlowEdge[], startStepId: string | null): PipelineGraph {
  const steps: PipelineStep[] = nodes.map((n) => ({
    ...n.data.step,
    position: { x: n.position.x, y: n.position.y },
  }));
  const graphEdges: PipelineEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.source,
    to: e.target,
    label: typeof e.data?.label === "string" ? e.data.label : "",
  }));
  return { steps, edges: graphEdges, startStepId };
}

// ---------------------------------------------------------------------------
// Auto-layout (dagre, left-to-right)
// ---------------------------------------------------------------------------

const LAYOUT_NODE_WIDTH = 240;
const LAYOUT_NODE_HEIGHT = 96;

/**
 * Re-position every step in `graph` via dagre's left-to-right layered
 * layout (the editor's "Auto-arrange" button). Edges referencing a step not
 * present in `graph.steps` are ignored (defensive — `validatePipelineGraph`
 * should already guarantee this never happens for a saved pipeline, but an
 * in-progress editor draft can transiently be inconsistent). Returns a new
 * `PipelineGraph` with the same steps/edges/startStepId, only `position`
 * fields changed.
 */
export function autoLayout(graph: PipelineGraph): PipelineGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  const stepIds = new Set(graph.steps.map((s) => s.id));
  for (const step of graph.steps) {
    g.setNode(step.id, { width: LAYOUT_NODE_WIDTH, height: LAYOUT_NODE_HEIGHT });
  }
  for (const edge of graph.edges) {
    if (stepIds.has(edge.from) && stepIds.has(edge.to)) g.setEdge(edge.from, edge.to);
  }

  dagre.layout(g);

  const steps = graph.steps.map((step) => {
    const pos = g.node(step.id) as { x: number; y: number } | undefined;
    if (!pos) return step;
    return { ...step, position: { x: pos.x - LAYOUT_NODE_WIDTH / 2, y: pos.y - LAYOUT_NODE_HEIGHT / 2 } };
  });

  return { ...graph, steps };
}

// ---------------------------------------------------------------------------
// Misc run-view helpers
// ---------------------------------------------------------------------------

/**
 * The task of the LATEST execution of `stepId` within `run` — a currently
 * active execution wins over history (so clicking a step mid-run opens the
 * in-progress task, not a stale earlier one on a cycle); otherwise the most
 * recent `run.history` record for that step. `null` when the step hasn't
 * executed at all yet, `run` is unset, or the resolved task id isn't in
 * `steps` (a step task the caller hasn't fetched).
 */
export function stepTaskFor(steps: Task[], run: PipelineRunState | null | undefined, stepId: string): Task | null {
  if (!run) return null;

  for (let i = run.active.length - 1; i >= 0; i -= 1) {
    const entry = run.active[i]!;
    if (entry.stepId === stepId) {
      return steps.find((t) => t.id === entry.taskId) ?? null;
    }
  }

  let latestTaskId: string | null = null;
  for (const record of run.history) {
    if (record.stepId === stepId) latestTaskId = record.taskId;
  }
  return latestTaskId ? (steps.find((t) => t.id === latestTaskId) ?? null) : null;
}

/**
 * One-line summary of a run's blocked state for a badge/banner: the first
 * blocked entry's message, with a `"(+N more)"` suffix when several
 * executions are blocked at once. `null` when nothing is blocked (or `run`
 * is unset).
 */
export function blockedSummary(run: PipelineRunState | null | undefined): string | null {
  if (!run || run.blocked.length === 0) return null;
  const [first, ...rest] = run.blocked;
  const suffix = rest.length > 0 ? ` (+${rest.length} more)` : "";
  return `${first!.message}${suffix}`;
}

// ---------------------------------------------------------------------------
// Handoff-reminder display (the runner's one-automatic-reminder-turn flow)
// ---------------------------------------------------------------------------

/** Semantic tone for a {@link responseKindLabel} result — maps to the same
 *  `--success`/`--warning`/`--danger` status tokens (plus a neutral
 *  `"muted"`) every other badge in the app uses. */
export type ResponseKindTone = "success" | "warning" | "danger" | "muted";

const RESPONSE_KIND_DISPLAY: Record<
  NonNullable<PipelineStepRecord["responseKind"]>,
  { text: string; tone: ResponseKindTone }
> = {
  handoff: { text: "Handed off", tone: "success" },
  "handoff-blocked": { text: "Reported blocked", tone: "warning" },
  "handoff-missing": { text: "No handoff", tone: "warning" },
  "handoff-invalid": { text: "Invalid handoff", tone: "warning" },
  "user-ask": { text: "Asked you", tone: "warning" },
  error: { text: "Error", tone: "danger" },
  cancelled: { text: "Cancelled", tone: "muted" },
};

/**
 * Display text + semantic tone for a step execution's
 * `PipelineStepRecord.responseKind` — backs the run view's history-row chip.
 * `null`/`undefined` (an older run recorded before `responseKind` existed,
 * or a still-in-flight record) yields `null`, telling the caller to render
 * no chip at all rather than a placeholder.
 */
export function responseKindLabel(
  kind: PipelineStepRecord["responseKind"] | null | undefined,
): { text: string; tone: ResponseKindTone } | null {
  if (!kind) return null;
  return RESPONSE_KIND_DISPLAY[kind] ?? null;
}

/**
 * True exactly while the CURRENTLY ACTIVE execution of `stepId` has already
 * received the runner's one automatic "no valid handoff yet" reminder turn
 * (its `run.history` record — pushed at launch, before the execution
 * settles — carries a non-null `reminder`) and hasn't settled yet. `false`
 * once that execution ends (a later, unreminded record supersedes it, or
 * the step is no longer in `run.active` at all) or if it was never
 * reminded. Matches the record by BOTH `stepId` and the active entry's
 * `taskId` so a step that's cycled (several `run.history` records share a
 * `stepId`) always reads the in-progress execution's own record, not an
 * earlier generation's.
 */
export function stepReminded(run: PipelineRunState | null | undefined, stepId: string): boolean {
  if (!run) return false;
  const activeEntry = run.active.find((a) => a.stepId === stepId);
  if (!activeEntry) return false;

  let latest: PipelineStepRecord | null = null;
  for (const record of run.history) {
    if (record.stepId === stepId && record.taskId === activeEntry.taskId) latest = record;
  }
  return !!latest?.reminder;
}
