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
  Subagent,
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
 * view animates a token along EVERY edge it took (`fromStepId` → each of
 * `toStepIds`, deduplicated: a `transition: "all"` fan-out launches several
 * targets off one record, and each of those edges gets its own token),
 * keyed by `seq` so a later transition (even a repeat of the same edge on a
 * cycle) replays the animation. `null` before any transition has happened
 * (empty history, or every record so far was terminal/failed with no
 * `nextStepIds`).
 */
export function latestTransition(
  run: PipelineRunState | null | undefined,
): { fromStepId: string; toStepIds: string[]; seq: number } | null {
  if (!run) return null;
  for (let i = run.history.length - 1; i >= 0; i -= 1) {
    const record = run.history[i]!;
    if (record.nextStepIds.length > 0) {
      return { fromStepId: record.stepId, toStepIds: [...new Set(record.nextStepIds)], seq: record.seq };
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

/** The step card's fixed width (`StepNode`'s `w-[240px]`). */
export const LAYOUT_NODE_WIDTH = 240;
/**
 * Height dagre reserves for a step card whose real height isn't known yet
 * (a fresh draft / a REST-built graph the canvas hasn't measured). Sized to
 * the TALLEST `StepNode` variant, measured from its Tailwind classes: 2px
 * border + 24px `p-3` + 20px title row (`text-sm`) + 6px `mt-1.5` + 22px
 * profile chip (`Badge`: `text-xs` 16px + `py-0.5` 4px + 2px border) + 6px
 * `mt-1.5` + 13px `transition: "all"` warning line (`text-[10px]
 * leading-tight`) = 93px, plus headroom for sub-pixel line boxes. A
 * measured height (React Flow's `node.measured.height`, passed via
 * {@link autoLayout}'s `measured` option) always wins over this constant.
 */
export const LAYOUT_NODE_HEIGHT = 100;

/** Layout footprint of one step INCLUDING the row(s) of subagent satellite
 *  nodes hanging beneath it (see {@link subagentSatellitePosition}) — what
 *  dagre must reserve so a step's satellites never overlap a neighbouring
 *  rank or a sibling in the same rank. A step with no subagents keeps the
 *  bare {@link LAYOUT_NODE_WIDTH}×{@link LAYOUT_NODE_HEIGHT}. */
export function stepLayoutFootprint(
  step: PipelineStep,
  card: { width: number; height: number } = { width: LAYOUT_NODE_WIDTH, height: LAYOUT_NODE_HEIGHT },
): { width: number; height: number } {
  const count = step.subagents.profileIds.length;
  if (count === 0) return { width: card.width, height: card.height };
  const perRow = Math.min(count, SUBAGENT_NODES_PER_ROW);
  const rows = Math.ceil(count / SUBAGENT_NODES_PER_ROW);
  const rowWidth = perRow * SUBAGENT_NODE_WIDTH + (perRow - 1) * SUBAGENT_NODE_GAP;
  return {
    width: Math.max(card.width, rowWidth),
    height: card.height + SUBAGENT_ROW_TOP + rows * (SUBAGENT_NODE_HEIGHT + SUBAGENT_NODE_GAP),
  };
}

export interface AutoLayoutOptions {
  /** The card's REAL on-canvas size for a step (React Flow's
   *  `node.measured`), when the canvas has already measured it — wins over
   *  the {@link LAYOUT_NODE_WIDTH}×{@link LAYOUT_NODE_HEIGHT} estimate, so a
   *  card taller than the estimate (a long profile name that wrapped, a
   *  future extra row) can't overlap the rank below it. Return `null` for a
   *  step the canvas hasn't measured yet. */
  measured?: (stepId: string) => { width: number; height: number } | null;
}

/**
 * Re-position every step in `graph` via dagre's left-to-right layered
 * layout (the editor's "Auto-arrange" button). Edges referencing a step not
 * present in `graph.steps` are ignored (defensive — `validatePipelineGraph`
 * should already guarantee this never happens for a saved pipeline, but an
 * in-progress editor draft can transiently be inconsistent). Returns a new
 * `PipelineGraph` with the same steps/edges/startStepId, only `position`
 * fields changed.
 */
export function autoLayout(graph: PipelineGraph, opts: AutoLayoutOptions = {}): PipelineGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  const cardFor = (step: PipelineStep): { width: number; height: number } => {
    const m = opts.measured?.(step.id) ?? null;
    if (m && Number.isFinite(m.width) && Number.isFinite(m.height) && m.width > 0 && m.height > 0) {
      return { width: Math.max(LAYOUT_NODE_WIDTH, m.width), height: Math.max(LAYOUT_NODE_HEIGHT, m.height) };
    }
    return { width: LAYOUT_NODE_WIDTH, height: LAYOUT_NODE_HEIGHT };
  };

  const stepIds = new Set(graph.steps.map((s) => s.id));
  for (const step of graph.steps) {
    g.setNode(step.id, stepLayoutFootprint(step, cardFor(step)));
  }
  for (const edge of graph.edges) {
    if (stepIds.has(edge.from) && stepIds.has(edge.to)) g.setEdge(edge.from, edge.to);
  }

  dagre.layout(g);

  const steps = graph.steps.map((step) => {
    const pos = g.node(step.id) as { x: number; y: number } | undefined;
    if (!pos) return step;
    // dagre centres each node on (x, y) within the footprint it was given;
    // the step card itself sits at the footprint's top-left, with any
    // satellites hanging below it.
    const footprint = stepLayoutFootprint(step, cardFor(step));
    return { ...step, position: { x: pos.x - footprint.width / 2, y: pos.y - footprint.height / 2 } };
  });

  return { ...graph, steps };
}

// ---------------------------------------------------------------------------
// Subagent satellites — one small node per profile a step may delegate to,
// hanging beneath the step and linked to it by a dashed "delegate" edge.
// Pure derivations shared by the editor (static: what the step is
// configured with) and the run view (live: which persona is at work).
// ---------------------------------------------------------------------------

export const SUBAGENT_NODE_WIDTH = 150;
export const SUBAGENT_NODE_HEIGHT = 40;
export const SUBAGENT_NODE_GAP = 8;
/** Satellites wrap into rows of this many beneath their step. */
export const SUBAGENT_NODES_PER_ROW = 3;
/** Vertical gap between the bottom of the step card and the first row. */
export const SUBAGENT_ROW_TOP = 32;

/** `idle` — configured on the step, nothing observed for it; `working` — a
 *  live subagent attributed to this persona is running right now; `done` —
 *  one ran and finished during the step's current execution. */
export type SubagentVisualState = "idle" | "working" | "done";

/** Node `data` for the canvas's `"subagent"` node type. `kind: "profile"`
 *  is a persona the step is configured to delegate to (always rendered,
 *  editor and run view alike); `kind: "live"` is a running subagent the run
 *  view observed on the step's task that matched NO configured persona —
 *  rendered transiently, labelled from the subagent's own description. */
export type SubagentNodeData = Record<string, unknown> & {
  stepId: string;
  kind: "profile" | "live";
  /** `kind: "profile"` only — the agent profile id. */
  profileId?: string;
  /** `kind: "live"` only — the observed subagent's id and display label. */
  subagentId?: string;
  label?: string;
  visual?: SubagentVisualState;
  /** Helpers observed for this persona in the current execution (0 in the
   *  editor) — rendered as an `×N` badge past one. */
  instanceCount?: number;
  readOnly?: boolean;
};
export type SubagentFlowNode = Node<SubagentNodeData, "subagent">;
export type SubagentFlowEdgeData = Record<string, unknown> & { visual?: SubagentVisualState };
export type SubagentFlowEdge = Edge<SubagentFlowEdgeData, "subagent">;

export function subagentNodeId(stepId: string, profileId: string): string {
  return `sub:${stepId}:${profileId}`;
}
export function liveSubagentNodeId(stepId: string, subagentId: string): string {
  return `live:${stepId}:${subagentId}`;
}
export function subagentEdgeId(nodeId: string): string {
  return `edge:${nodeId}`;
}

/**
 * Position of the `index`-th of `count` satellites, RELATIVE to its step
 * node's top-left (React Flow `parentId` semantics — the satellite then
 * follows the step when it's dragged): rows of {@link SUBAGENT_NODES_PER_ROW},
 * each row centred under the 240px step card, starting
 * {@link SUBAGENT_ROW_TOP} below the card's bottom edge.
 */
export function subagentSatellitePosition(index: number, count: number): { x: number; y: number } {
  const row = Math.floor(index / SUBAGENT_NODES_PER_ROW);
  const col = index % SUBAGENT_NODES_PER_ROW;
  const rowStart = row * SUBAGENT_NODES_PER_ROW;
  const inRow = Math.min(SUBAGENT_NODES_PER_ROW, count - rowStart);
  const rowWidth = inRow * SUBAGENT_NODE_WIDTH + (inRow - 1) * SUBAGENT_NODE_GAP;
  const x = (LAYOUT_NODE_WIDTH - rowWidth) / 2 + col * (SUBAGENT_NODE_WIDTH + SUBAGENT_NODE_GAP);
  const y = LAYOUT_NODE_HEIGHT + SUBAGENT_ROW_TOP + row * (SUBAGENT_NODE_HEIGHT + SUBAGENT_NODE_GAP);
  return { x, y };
}

/** One satellite to render, as {@link subagentSatellites} derives them. */
export interface SubagentSatellite {
  nodeId: string;
  stepId: string;
  kind: "profile" | "live";
  profileId: string | null;
  subagentId: string | null;
  /** Display label for a `live` satellite (a `profile` one renders its
   *  profile chip instead). */
  label: string | null;
  visual: SubagentVisualState;
  /** The observed helpers behind this satellite: every subagent attributed
   *  to the persona (running first, in spawn order) for a `profile`
   *  satellite, or the single helper itself for a `live` one. What the
   *  details dialog lists and links to transcripts; `[]` in the editor. */
  instances: Subagent[];
}

/**
 * Claude Code's own built-in `agentType` ids (lowercased). A persona whose
 * name collides with one of these can never be attributed by `agentType`
 * equality — every ordinary `Agent` call carries one of these types, so a
 * persona named "Explore" would otherwise claim every generic explorer the
 * step spawned. Such a persona is still attributable by `description`.
 */
const BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  "general-purpose",
  "explore",
  "plan",
  "bash",
  "fork",
  "claude",
  "claude-code-guide",
  "statusline-setup",
  "output-style-setup",
]);

/** Shortest persona name {@link matchSubagentToProfile} will consider — a
 *  one-character name ("A", "Q") would prefix-match far too much. */
export const MATCH_PROFILE_NAME_MIN_LEN = 2;

/** `true` when `text` starts with `name` (both already lowercased) and the
 *  name ends on a word boundary: end of text, whitespace, or punctuation
 *  (`:`, `-`, `—`, `,`, `(`, `/`, …) — anything that isn't a letter/digit.
 *  So "QA: run tests" matches the persona "QA", but "QAnon investigation"
 *  does not, and "Reviewer Pro: …" matches both "Reviewer" and "Reviewer
 *  Pro" (the caller then picks the longer). */
function startsWithOnWordBoundary(text: string, name: string): boolean {
  if (!text.startsWith(name)) return false;
  const next = text.charAt(name.length);
  return next === "" || !/[\p{L}\p{N}]/u.test(next);
}

/**
 * Attribute an observed subagent to one of the step's configured personas,
 * or `null`. Matching is by name, case-insensitively, and deliberately
 * anchored rather than a substring search (a persona named "Test" must not
 * claim every helper whose description merely mentions tests): the
 * subagent's `description` (what the spawning `Agent` tool call said it was
 * for — the step prompt asks the agent to START it with the persona's name)
 * must begin with the profile name on a word boundary, or — only for a
 * persona whose name isn't itself one of Claude Code's built-in agent types
 * ({@link BUILTIN_AGENT_TYPES}) — its registered `agentType` must EQUAL the
 * name. Names shorter than {@link MATCH_PROFILE_NAME_MIN_LEN} never match.
 * When several profiles match, the longest name wins so "Reviewer Pro"
 * beats "Reviewer".
 */
export function matchSubagentToProfile(
  subagent: Pick<Subagent, "description" | "agentType">,
  profiles: readonly { id: string; name: string }[],
): string | null {
  const description = typeof subagent.description === "string" ? subagent.description.trim().toLowerCase() : "";
  const agentType = typeof subagent.agentType === "string" ? subagent.agentType.trim().toLowerCase() : "";
  if (description.length === 0 && agentType.length === 0) return null;
  let best: { id: string; len: number } | null = null;
  for (const p of profiles) {
    const needle = p.name.trim().toLowerCase();
    if (needle.length < MATCH_PROFILE_NAME_MIN_LEN) continue;
    const byDescription = description.length > 0 && startsWithOnWordBoundary(description, needle);
    const byAgentType = agentType.length > 0 && !BUILTIN_AGENT_TYPES.has(needle) && agentType === needle;
    if (!byDescription && !byAgentType) continue;
    if (!best || needle.length > best.len) best = { id: p.id, len: needle.length };
  }
  return best?.id ?? null;
}

/**
 * The satellites for one step: every configured persona (in
 * `step.subagents.profileIds` order, `idle` unless a live subagent was
 * attributed to it — `working` while that subagent runs, `done` once it
 * finished), followed by one transient `live` satellite per RUNNING
 * subagent that matched no persona. Finished unmatched subagents are not
 * shown (nothing to attribute them to). `liveSubagents` is whatever the
 * run view observed on the step's current task — pass `[]` for the editor.
 */
export function subagentSatellites(
  step: PipelineStep,
  liveSubagents: readonly Subagent[],
  profileName: (profileId: string) => string | null,
): SubagentSatellite[] {
  const profiles = step.subagents.profileIds
    .map((id) => ({ id, name: profileName(id) ?? "" }))
    .filter((p) => p.name.length > 0);
  const byProfile = new Map<string, SubagentVisualState>();
  const instancesByProfile = new Map<string, Subagent[]>();
  const unmatchedRunning: Subagent[] = [];
  for (const sub of liveSubagents) {
    const matched = matchSubagentToProfile(sub, profiles);
    if (!matched) {
      if (sub.status === "running") unmatchedRunning.push(sub);
      continue;
    }
    const list = instancesByProfile.get(matched) ?? [];
    list.push(sub);
    instancesByProfile.set(matched, list);
    const prev = byProfile.get(matched) ?? "idle";
    // A running attribution always wins over an earlier finished one.
    if (sub.status === "running") byProfile.set(matched, "working");
    else if (prev !== "working") byProfile.set(matched, "done");
  }
  const out: SubagentSatellite[] = step.subagents.profileIds.map((profileId) => {
    const instances = instancesByProfile.get(profileId) ?? [];
    return {
      nodeId: subagentNodeId(step.id, profileId),
      stepId: step.id,
      kind: "profile",
      profileId,
      subagentId: null,
      label: null,
      visual: byProfile.get(profileId) ?? "idle",
      // Running helpers first, each group in spawn order.
      instances: [...instances.filter((i) => i.status === "running"), ...instances.filter((i) => i.status !== "running")],
    };
  });
  for (const sub of unmatchedRunning) {
    out.push({
      nodeId: liveSubagentNodeId(step.id, sub.id),
      stepId: step.id,
      kind: "live",
      profileId: null,
      subagentId: sub.id,
      label: (sub.description ?? sub.agentType ?? "Subagent").trim() || "Subagent",
      visual: "working",
      instances: [sub],
    });
  }
  return out;
}

/**
 * React Flow nodes for a step's satellites. Each is a CHILD of its step
 * (`parentId`, position relative to the step's top-left via
 * {@link subagentSatellitePosition}) so it follows drags for free; never
 * draggable/selectable/connectable on its own. Callers must append these
 * AFTER the step nodes in the array React Flow receives — it requires a
 * parent to precede its children.
 */
export function toSubagentFlowNodes(
  satellites: readonly SubagentSatellite[],
  extra?: (satellite: SubagentSatellite) => Record<string, unknown>,
): SubagentFlowNode[] {
  // Positions are per STEP (index within that step's own satellites, out
  // of that step's count) — the input may interleave several steps.
  const countByStep = new Map<string, number>();
  for (const sat of satellites) countByStep.set(sat.stepId, (countByStep.get(sat.stepId) ?? 0) + 1);
  const seenByStep = new Map<string, number>();
  return satellites.map((sat) => {
    const index = seenByStep.get(sat.stepId) ?? 0;
    seenByStep.set(sat.stepId, index + 1);
    return {
    id: sat.nodeId,
    type: "subagent",
    parentId: sat.stepId,
    position: subagentSatellitePosition(index, countByStep.get(sat.stepId) ?? 1),
    draggable: false,
    selectable: false,
    connectable: false,
    data: {
      stepId: sat.stepId,
      kind: sat.kind,
      ...(sat.profileId ? { profileId: sat.profileId } : {}),
      ...(sat.subagentId ? { subagentId: sat.subagentId } : {}),
      ...(sat.label ? { label: sat.label } : {}),
      visual: sat.visual,
      instanceCount: sat.instances.length,
      ...(extra ? extra(sat) : {}),
    },
    };
  });
}

/**
 * Identity-preserving merge for a DERIVED (not state-held) React Flow
 * node/edge list: returns each fresh item, except that an item whose
 * `keyOf` content key is unchanged since the previous call is replaced by
 * the previous object, so React Flow sees the same object identity and
 * never re-measures it (see `pipeline-canvas-context.tsx` for why identity
 * churn is harmful). `memory` is the caller-owned map that carries state
 * between calls; it's rewritten in place to hold exactly the current items.
 */
export function reconcileFlowItems<T extends { id: string }>(
  memory: Map<string, { key: string; item: T }>,
  fresh: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const next = new Map<string, { key: string; item: T }>();
  const out = fresh.map((f) => {
    const key = keyOf(f);
    const prev = memory.get(f.id);
    const item = prev && prev.key === key ? prev.item : f;
    next.set(f.id, { key, item });
    return item;
  });
  memory.clear();
  for (const [id, entry] of next) memory.set(id, entry);
  return out;
}

/** Content key for {@link reconcileFlowItems} over satellite nodes. */
export function subagentNodeKey(node: SubagentFlowNode): string {
  return `${node.id}|${node.parentId ?? ""}|${node.position.x},${node.position.y}|${JSON.stringify(node.data)}`;
}
/** Content key for {@link reconcileFlowItems} over satellite edges. */
export function subagentEdgeKey(edge: SubagentFlowEdge): string {
  return `${edge.id}|${edge.source}|${edge.target}|${edge.data?.visual ?? ""}`;
}

/** The dashed "delegate" edge from a step's bottom handle to each of its
 *  satellites; `data.visual` mirrors the satellite's own state so the edge
 *  can march while its persona works. */
export function toSubagentFlowEdges(satellites: readonly SubagentSatellite[]): SubagentFlowEdge[] {
  return satellites.map((sat) => ({
    id: subagentEdgeId(sat.nodeId),
    type: "subagent",
    source: sat.stepId,
    target: sat.nodeId,
    sourceHandle: "delegate",
    targetHandle: "in",
    selectable: false,
    focusable: false,
    data: { visual: sat.visual },
  }));
}

/** A primitive, content-derived key for a satellite list — what a memoised
 *  node/edge derivation keys on, so a re-render or a poll that changes
 *  nothing observable keeps every satellite node's object identity (React
 *  Flow re-measures a node whose object changes; see
 *  `pipeline-canvas-context.tsx`). */
export function satellitesSignature(satellites: readonly SubagentSatellite[]): string {
  return satellites
    .map((s) => `${s.nodeId}:${s.visual}:${s.label ?? ""}:${s.instances.map((i) => `${i.id}=${i.status}`).join(",")}`)
    .join("|");
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
