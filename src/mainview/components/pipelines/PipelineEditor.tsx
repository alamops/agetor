import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, LayoutGrid, Maximize2, Plus, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useTheme } from "@/components/theme-provider";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { api, ApiError } from "@/lib/api";
import {
  autoLayout,
  graphFromFlow,
  reconcileFlowItems,
  satellitesSignature,
  subagentEdgeKey,
  subagentNodeKey,
  subagentSatellites,
  toFlowEdges,
  toFlowNodes,
  toSubagentFlowEdges,
  toSubagentFlowNodes,
  type StepFlowEdge,
  type StepFlowNode,
  type SubagentFlowEdge,
  type SubagentFlowNode,
  type SubagentSatellite,
} from "@/lib/pipelines";
import { newStep, validatePipelineGraph } from "../../../shared/pipeline.ts";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type { Harness, Pipeline, PipelineEdge, PipelineGraph, PipelineInput, PipelineStep } from "../../../shared/types.ts";
import { PipelineCanvasContext, type PipelineCanvasContextValue, type StepProfileResolution } from "./pipeline-canvas-context";
import { StepEdge } from "./StepEdge";
import { StepNode } from "./StepNode";
import { StepPanel } from "./StepPanel";
import { SubagentDetailsDialog } from "./SubagentDetailsDialog";
import { SubagentEdge } from "./SubagentEdge";
import { SubagentNode } from "./SubagentNode";

const NODE_TYPES = { step: StepNode, subagent: SubagentNode };
const EDGE_TYPES = { step: StepEdge, subagent: SubagentEdge };

/** Everything the canvas renders: the state-held step nodes/edges plus the
 *  DERIVED subagent satellites (never stored in `useNodesState` — see the
 *  satellites block in `PipelineEditorInner`). */
type CanvasNode = StepFlowNode | SubagentFlowNode;
type CanvasEdge = StepFlowEdge | SubagentFlowEdge;

interface PipelineEditorProps {
  /** Existing pipeline to load, or `null` to start a blank draft. */
  pipelineId: string | null;
  onBack: () => void;
  onSaved: (pipeline: Pipeline) => void;
  /** Fires whenever the unsaved-changes flag flips (including the initial
   *  `false` once a draft/pipeline finishes loading) — lets a host that can
   *  navigate away some other way (e.g. a tab switch) reuse the same
   *  discard-guard the in-editor Back button already applies. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Offered as "Edit in Settings" from a satellite's details dialog. */
  onOpenSettingsAgents?: () => void;
}

/** `maxSteps` is the RAW text of the Max-steps input (see `maxStepsInput` in
 *  the editor) so a half-typed value counts as dirty exactly like any other
 *  keystroke — the number it parses to is only decided at save time. */
function snapshotOf(name: string, description: string, maxSteps: string, graph: PipelineGraph): string {
  return JSON.stringify({ name, description, maxSteps, graph });
}

/** The Max-steps input's text → the integer the server accepts, or `null`
 *  when it isn't one (empty, non-numeric, fractional, or out of
 *  `1..PIPELINE_LIMITS.maxStepsMax`). Save is disabled on `null`. */
function parseMaxSteps(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > PIPELINE_LIMITS.maxStepsMax) return null;
  return n;
}

/** Text-entry elements a Delete/Backspace/Enter/Space keystroke belongs to
 *  (their own editing), never to the canvas — mirrors React Flow's own
 *  `isInputDOMNode` guard for the keys we handle ourselves. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') != null;
}

/** A modal dialog or popover is up — every canvas keyboard shortcut yields
 *  to it (the same layer selector the app's Escape coordination uses, see
 *  the `data-popover-open` convention in CLAUDE.md item 11). */
function keyboardLayerOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [data-popover-open]') != null;
}

function uniqueStepName(existing: PipelineStep[]): string {
  const used = new Set(existing.map((s) => s.name.trim().toLowerCase()));
  if (!used.has("new step")) return "New step";
  let n = 2;
  while (used.has(`new step ${n}`)) n += 1;
  return `New step ${n}`;
}

/** Single-edge counterpart of `toFlowEdges` — used whenever the editor adds
 *  exactly one new edge, so it doesn't have to round-trip the whole edge
 *  array through `toFlowEdges` just to get one item's shape. `onDelete` is
 *  baked in at creation time since it's a STABLE callback (see the M11 note
 *  on `appendStep` below) — it never needs to be refreshed later. */
function edgeToFlow(edge: PipelineEdge, onDelete: (edgeId: string) => void): StepFlowEdge {
  return {
    id: edge.id,
    type: "step",
    source: edge.from,
    target: edge.to,
    sourceHandle: "out",
    targetHandle: "in",
    data: { label: edge.label, onDelete },
  };
}

function blankGraph(): { graph: PipelineGraph; step: PipelineStep } {
  const step = newStep({ position: { x: 0, y: 0 } });
  return { graph: { steps: [step], edges: [], startStepId: step.id }, step };
}

/**
 * The full-page, n8n-style canvas editor for a {@link Pipeline}: draggable
 * step nodes, drag-to-connect (or "Connect to…"-select) edges, a per-step
 * side panel, Auto-arrange (dagre), Fit view, keyboard delete, and an
 * unsaved-changes guard on Back. See `docs/plans/pipelines.md` D5/D6/D13.
 *
 * Node/edge state lives in React Flow's own controlled arrays
 * (`useNodesState`/`useEdgesState`) rather than being rebuilt from a
 * `PipelineGraph` on every render — review finding M11. A `PipelineGraph`
 * is only derived FROM that state (via `graphFromFlow`, memoized) for
 * validation/save/the step panel, and nodes are only rebuilt wholesale from
 * a `PipelineGraph` on load, auto-arrange, or the initial add of a step —
 * never on a keystroke or an unrelated `agent-profiles` refetch. Per-step
 * data updates (rename, profile change, transition/join) mutate just the
 * affected node's `data` via `setNodes(ns => ns.map(...))`, which preserves
 * every OTHER node's object identity (and therefore React Flow's internal
 * `measured` state for it) — the fix for the "trying to drag a node that is
 * not initialized" warning / a sibling node stuck `visibility: hidden`
 * pinned by `e2e/pipelines-editor.spec.ts`'s "New agent… inline creation on
 * one step does not leave a sibling step node stuck unclickable" test. The
 * agent profile lookup and the start-step flag are read by `StepNode` from
 * `PipelineCanvasContext` instead of node `data` for the same reason: a
 * `profiles` refetch (or a "Set as start" click) changes a context value's
 * identity, which only re-renders the `StepNode` components — it never
 * touches the node objects React Flow itself tracks.
 */
export function PipelineEditor(props: PipelineEditorProps) {
  return (
    <ReactFlowProvider>
      <PipelineEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function PipelineEditorInner({ pipelineId, onBack, onSaved, onDirtyChange, onOpenSettingsAgents }: PipelineEditorProps) {
  const confirm = useConfirm();
  const { resolved } = useTheme();
  const { fitView } = useReactFlow();
  const { profiles, loaded: profilesLoaded, refresh: refreshProfiles } = useAgentProfiles();

  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.listHarnesses()
      .then((payload) => {
        if (!cancelled) setHarnesses(payload.harnesses);
      })
      .catch(() => { /* the picker degrades to unresolved harness labels */ });
    return () => {
      cancelled = true;
    };
  }, []);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // The Max-steps field is kept as the RAW input text and only coerced to a
  // number on blur (formatting) and at save time (`parseMaxSteps`) — an
  // eager `Number(...)`-in-`onChange` made the field impossible to clear or
  // retype (every keystroke snapped it back to a clamped integer) and hid
  // out-of-range values behind a silent clamp instead of disabling Save.
  const [maxStepsInput, setMaxStepsInput] = useState<string>(String(PIPELINE_LIMITS.maxStepsDefault));
  const [startStepId, setStartStepId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  // Satellite whose persona details dialog is open (by node id).
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const initialSnapshotRef = useRef<string>(
    snapshotOf("", "", String(PIPELINE_LIMITS.maxStepsDefault), { steps: [], edges: [], startStepId: null }),
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<StepFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StepFlowEdge>([]);

  // Mirrors of the latest committed nodes/edges for callbacks that get
  // baked permanently into node/edge `data` at creation time (`onAppend`,
  // an edge's `onDelete`) and therefore must stay referentially STABLE —
  // they read current state through these refs instead of depending on
  // `nodes`/`edges` directly, which would force them to be recreated (and
  // every node/edge's embedded copy along with them) on every change.
  const nodesRef = useRef<StepFlowNode[]>([]);
  const edgesRef = useRef<StepFlowEdge[]>([]);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  // Same latest-value mirror for the document keyboard handler below, which
  // must stay subscribed once rather than re-bind on every selection change.
  const selectedStepIdRef = useRef<string | null>(null);
  selectedStepIdRef.current = selectedStepId;
  // The canvas container — the keyboard handler only treats a focused
  // `.react-flow__node` as ours when it lives inside it.
  const canvasRef = useRef<HTMLDivElement>(null);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const resolveProfile = useCallback(
    (agentProfileId: string | null): StepProfileResolution => {
      if (!agentProfileId) return { profile: null, profileDeleted: false };
      const profile = profileById.get(agentProfileId) ?? null;
      // Only report "deleted" once profiles have loaded at least once — a
      // still-in-flight or perpetually-failed first fetch must never flash
      // every bound step as "Deleted agent".
      return { profile, profileDeleted: profilesLoaded ? !profile : false };
    },
    [profileById, profilesLoaded],
  );

  const canvasContextValue = useMemo<PipelineCanvasContextValue>(
    () => ({ startStepId, resolveProfile }),
    [startStepId, resolveProfile],
  );

  // ---- Edge mutations (defined first: appendStep/addEdgeToGraph below
  // embed `removeEdge` into a newly-created edge's `data.onDelete`). ----

  const removeEdge = useCallback(
    (edgeId: string) => {
      setEdges((es) => es.filter((e) => e.id !== edgeId));
    },
    [setEdges],
  );

  const onEdgeLabel = useCallback(
    (edgeId: string, label: string) => {
      setEdges((es) => es.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, label } } : e)));
    },
    [setEdges],
  );

  const addEdgeToGraph = useCallback(
    (from: string, to: string) => {
      if (!from || !to || from === to) return;
      if (edgesRef.current.some((e) => e.source === from && e.target === to)) return;
      if (edgesRef.current.length >= PIPELINE_LIMITS.edges) return;
      const edge: PipelineEdge = { id: crypto.randomUUID(), from, to, label: "" };
      setEdges((es) => [...es, edgeToFlow(edge, removeEdge)]);
    },
    [setEdges, removeEdge],
  );

  // ---- Node mutations. `appendStep`/`addStep` bake `onAppend: appendStep`
  // into every node's `data` — `appendStep` itself has an empty-ish,
  // STABLE dependency list (only `setNodes`/`setEdges`/`removeEdge`, none
  // of which ever change identity), so it never needs to be refreshed on
  // existing nodes once set. ----

  const appendStep = useCallback(
    (fromId: string) => {
      if (nodesRef.current.length >= PIPELINE_LIMITS.steps) return;
      const id = crypto.randomUUID();
      const fromNode = nodesRef.current.find((n) => n.id === fromId);
      const base = fromNode?.position ?? { x: 0, y: 0 };
      const step = newStep({
        id,
        position: { x: base.x + 300, y: base.y },
        name: uniqueStepName(nodesRef.current.map((n) => n.data.step)),
      });
      setNodes((ns) => [...ns, { id, type: "step", position: step.position, data: { step, onAppend: appendStep } }]);
      if (edgesRef.current.length < PIPELINE_LIMITS.edges) {
        const edge: PipelineEdge = { id: crypto.randomUUID(), from: fromId, to: id, label: "" };
        setEdges((es) => [...es, edgeToFlow(edge, removeEdge)]);
      }
      setSelectedStepId(id);
    },
    [setNodes, setEdges, removeEdge],
  );

  const addStep = useCallback(() => {
    if (nodesRef.current.length >= PIPELINE_LIMITS.steps) return;
    const id = crypto.randomUUID();
    const maxX = nodesRef.current.reduce((m, n) => Math.max(m, n.position.x), -300);
    const step = newStep({
      id,
      position: { x: maxX + 300, y: 0 },
      name: uniqueStepName(nodesRef.current.map((n) => n.data.step)),
    });
    setNodes((ns) => [...ns, { id, type: "step", position: step.position, data: { step, onAppend: appendStep } }]);
    setStartStepId((s) => s ?? id);
    setSelectedStepId(id);
  }, [setNodes, appendStep]);

  const updateStep = useCallback(
    (updated: PipelineStep) => {
      setNodes((ns) => ns.map((n) => (n.id === updated.id ? { ...n, data: { ...n.data, step: updated } } : n)));
    },
    [setNodes],
  );

  const deleteStep = useCallback(
    (stepId: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== stepId));
      setEdges((es) => es.filter((e) => e.source !== stepId && e.target !== stepId));
      setStartStepId((s) => (s === stepId ? (nodesRef.current.find((n) => n.id !== stepId)?.id ?? null) : s));
      setSelectedStepId((id) => (id === stepId ? null : id));
    },
    [setNodes, setEdges],
  );

  const setStart = useCallback((stepId: string) => {
    setStartStepId(stepId);
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) addEdgeToGraph(connection.source, connection.target);
    },
    [addEdgeToGraph],
  );

  // What a click (or Enter/Space on a focused node — see the keyboard
  // handler below) on a canvas node does: a satellite selects the step it
  // hangs from AND opens the persona's details; a step node selects itself.
  // Keyed by node id so the keyboard path, which only has the focused DOM
  // node's `data-id`, shares this exact logic with `onNodeClick`.
  const activateNodeById = useCallback((nodeId: string) => {
    const satellite = satellitesRef.current.get(nodeId);
    if (satellite) {
      setSelectedStepId(satellite.stepId);
      setDetailsNodeId(nodeId);
      return;
    }
    if (nodesRef.current.some((n) => n.id === nodeId)) setSelectedStepId(nodeId);
  }, []);

  // ---- Canvas keyboard shortcuts (one document listener, bound once):
  //
  //  * Escape deselects the current step (closes the panel).
  //  * Delete/Backspace removes the selected step and any selected edges —
  //    handled HERE rather than via React Flow's `deleteKeyCode` (passed as
  //    `null` below) because the library's global key handler only guards
  //    text inputs: with the "Delete step" confirm, a satellite's details
  //    dialog, the "New agent…" dialog or any popover open, a Backspace
  //    aimed at that layer silently deleted the selected step underneath.
  //  * Enter/Space on a focused node activates it exactly like a click
  //    (React Flow's own Enter/Space only touches its internal selection
  //    store, which this editor doesn't read — `selectedStepId` is the
  //    source of truth).
  //
  // Every branch yields to an open modal dialog or popover
  // (`keyboardLayerOpen` — AgentProfilePicker's search box, the subagent
  // multi-select, the confirm dialog, …) per the app's
  // `data-popover-open`/`role="dialog"` conventions, so a layer's own
  // Escape-to-close / Backspace-in-its-input is never shadowed by this
  // full-page view, and to a text-entry target (`isTextEntryTarget`) so
  // typing in the step panel never reaches the canvas.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (keyboardLayerOpen()) return;
        setSelectedStepId(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (keyboardLayerOpen() || isTextEntryTarget(e.target)) return;
        const stepId = selectedStepIdRef.current;
        const hasSelectedEdge = edgesRef.current.some((edge) => edge.selected);
        if (!stepId && !hasSelectedEdge) return;
        e.preventDefault();
        if (hasSelectedEdge) setEdges((es) => es.filter((edge) => !edge.selected));
        if (stepId) deleteStep(stepId);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (keyboardLayerOpen() || isTextEntryTarget(e.target)) return;
        if (!(e.target instanceof HTMLElement)) return;
        const nodeEl = e.target.closest(".react-flow__node[data-id]");
        if (!nodeEl || !canvasRef.current?.contains(nodeEl)) return;
        const nodeId = nodeEl.getAttribute("data-id");
        if (!nodeId) return;
        e.preventDefault(); // Space would otherwise scroll the pane.
        activateNodeById(nodeId);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleteStep, setEdges, activateNodeById]);

  // ---- Load: the ONE place nodes/edges are rebuilt wholesale from a
  // `PipelineGraph` on a task/pipeline switch (plus auto-arrange below). ----

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!pipelineId) {
        const { graph: g, step } = blankGraph();
        if (cancelled) return;
        setName("");
        setDescription("");
        setMaxStepsInput(String(PIPELINE_LIMITS.maxStepsDefault));
        setNodes(toFlowNodes(g, () => ({ onAppend: appendStep })));
        setEdges(toFlowEdges(g).map((e) => ({ ...e, data: { ...e.data, onDelete: removeEdge } })));
        setStartStepId(g.startStepId);
        setSelectedStepId(step.id);
        // Seed the debounced graph immediately for a wholesale rebuild —
        // otherwise `liveValidation` would read against the STALE pre-load
        // debounced value for up to 150ms right after this fresh,
        // intentionally-clean draft loads. (`isDirty` is unaffected by this
        // debounce — it's derived straight from `derivedGraph`.)
        setDebouncedGraph(g);
        initialSnapshotRef.current = snapshotOf("", "", String(PIPELINE_LIMITS.maxStepsDefault), g);
        setLoading(false);
        setLoadError(null);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const pipeline = await api.getPipeline(pipelineId);
        if (cancelled) return;
        setName(pipeline.name);
        setDescription(pipeline.description);
        setMaxStepsInput(String(pipeline.maxSteps));
        setNodes(toFlowNodes(pipeline.graph, () => ({ onAppend: appendStep })));
        setEdges(toFlowEdges(pipeline.graph).map((e) => ({ ...e, data: { ...e.data, onDelete: removeEdge } })));
        setStartStepId(pipeline.graph.startStepId);
        setSelectedStepId(pipeline.graph.steps[0]?.id ?? null);
        // Same immediate-seed rationale as the blank-draft branch above.
        setDebouncedGraph(pipeline.graph);
        initialSnapshotRef.current = snapshotOf(
          pipeline.name,
          pipeline.description,
          String(pipeline.maxSteps),
          pipeline.graph,
        );
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Failed to load pipeline.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- appendStep/removeEdge are referentially stable.
  }, [pipelineId, setNodes, setEdges]);

  // Selection is applied as an overlay over the raw node array rather than
  // stored on it, so selecting a step never touches `data` (only `selected`,
  // for at most the two nodes whose selection flag actually flips).
  const nodesWithSelection = useMemo(
    () => nodes.map((n) => (n.selected === (n.id === selectedStepId) ? n : { ...n, selected: n.id === selectedStepId })),
    [nodes, selectedStepId],
  );

  // ---- Subagent satellites: one small node per persona a step may
  // delegate to, hanging beneath it (`SubagentNode`, `parentId` = the
  // step, so it follows drags) and linked by a dashed `SubagentEdge`.
  // DERIVED from the step nodes' `data.step.subagents`, never stored in
  // `nodes`/`edges` state — so `graphFromFlow`, save, delete-cascade and
  // the step panel keep seeing exactly the step graph, and the satellites
  // can't drift from what the panel's picker says. Recomputed from `nodes`
  // itself (a fresh array on every drag frame — the flatMap is trivial;
  // NOT from `nodesRef`, which an effect only catches up AFTER the render
  // that changed the config, so a load-from-REST would derive against the
  // previous, empty node list and render no satellites at all) and then
  // identity-reconciled (`reconcileFlowItems`, keyed on the satellites'
  // content signature) so an unchanged satellite keeps its node object
  // across renders — React Flow re-measures a node whose object identity
  // changes. ----
  const profileNameById = useCallback((id: string) => profileById.get(id)?.name ?? null, [profileById]);
  const satellites = useMemo<SubagentSatellite[]>(
    () => nodes.flatMap((n) => subagentSatellites(n.data.step, [], profileNameById)),
    [nodes, profileNameById],
  );
  const satelliteNodeMemory = useRef(new Map<string, { key: string; item: SubagentFlowNode }>());
  const satelliteEdgeMemory = useRef(new Map<string, { key: string; item: SubagentFlowEdge }>());
  const satellitesKey = satellitesSignature(satellites);
  const subagentNodes = useMemo(
    () => reconcileFlowItems(satelliteNodeMemory.current, toSubagentFlowNodes(satellites), subagentNodeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (satellitesKey), not the satellites array identity.
    [satellitesKey],
  );
  const subagentEdges = useMemo(
    () => reconcileFlowItems(satelliteEdgeMemory.current, toSubagentFlowEdges(satellites), subagentEdgeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same content key as subagentNodes.
    [satellitesKey],
  );
  // React Flow requires a parent to precede its children — satellites go
  // last, after every step node.
  const canvasNodes = useMemo<CanvasNode[]>(() => [...nodesWithSelection, ...subagentNodes], [nodesWithSelection, subagentNodes]);
  const canvasEdges = useMemo<CanvasEdge[]>(() => [...edges, ...subagentEdges], [edges, subagentEdges]);
  const detailsSatellite = useMemo(
    () => (detailsNodeId ? (satellites.find((sat) => sat.nodeId === detailsNodeId) ?? null) : null),
    [detailsNodeId, satellites],
  );
  const detailsStep = detailsSatellite ? (nodes.find((n) => n.id === detailsSatellite.stepId)?.data.step ?? null) : null;
  const detailsStepName = detailsStep?.name ?? "";

  // Latest-value mirrors of the derived satellites, keyed by node id — the
  // change filters and the keyboard handler read them through refs so they
  // stay bound once (no re-subscribe per satellite change). Assigned every
  // render, so they're current by the time any event handler runs.
  const satellitesRef = useRef<Map<string, SubagentSatellite>>(new Map());
  satellitesRef.current = new Map(satellites.map((sat) => [sat.nodeId, sat]));
  const subagentEdgeIdsRef = useRef<Set<string>>(new Set());
  subagentEdgeIdsRef.current = new Set(subagentEdges.map((e) => e.id));

  // Satellites are never in state, so their own change events (dimension
  // measurements, mostly) have nothing to apply to — forward only the
  // changes for STEP nodes/edges to the hooks' reducers. A satellite is
  // recognised by membership in the derived satellite id set, not by a
  // string prefix on its id (a step id is a uuid, but nothing structurally
  // stops one from starting with `sub:` and being misfiled).
  const onCanvasNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const stepChanges = changes.filter((c) => !("id" in c) || !satellitesRef.current.has(c.id));
      if (stepChanges.length > 0) onNodesChange(stepChanges as NodeChange<StepFlowNode>[]);
    },
    [onNodesChange],
  );
  const onCanvasEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      const stepChanges = changes.filter((c) => !("id" in c) || !subagentEdgeIdsRef.current.has(c.id));
      if (stepChanges.length > 0) onEdgesChange(stepChanges as EdgeChange<StepFlowEdge>[]);
    },
    [onEdgesChange],
  );

  const derivedGraph = useMemo(() => graphFromFlow(nodes, edges, startStepId), [nodes, edges, startStepId]);

  const selectedStep = useMemo(
    () => (selectedStepId ? (derivedGraph.steps.find((s) => s.id === selectedStepId) ?? null) : null),
    [derivedGraph, selectedStepId],
  );

  // `derivedGraph` recomputes on every node-position change — including
  // every pointermove frame of a drag — so recomputing `validatePipelineGraph`
  // (a full graph walk) directly from it on every render was doing that work
  // at drag-frame rate for no UI benefit (the validation banner doesn't need
  // sub-frame freshness). That one is derived from a `debouncedGraph` that
  // only catches up 150ms after node/edge changes go quiet. `handleSave`
  // deliberately does NOT use this debounced value — it re-validates
  // `derivedGraph` itself synchronously at submit time, so Save always acts
  // on the truly-latest graph even if a debounce cycle hasn't settled yet.
  //
  // `isDirty` used to be derived from `debouncedGraph` too, which meant Back
  // (and `App.tsx`'s `navigate` unsaved-changes guard, fed via
  // `onDirtyChange`) could see a stale "clean" state for up to 150ms after
  // an edit — a quick edit-then-Back could slip through with no confirm.
  // It's computed straight from `derivedGraph` instead, so it (and
  // `onDirtyChange`) update in the same render as the edit; only
  // `liveValidation`'s banner keeps the debounce.
  const [debouncedGraph, setDebouncedGraph] = useState<PipelineGraph>(derivedGraph);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedGraph(derivedGraph), 150);
    return () => clearTimeout(t);
  }, [derivedGraph]);

  const liveValidation = useMemo(() => validatePipelineGraph(debouncedGraph), [debouncedGraph]);
  const liveSnapshot = useMemo(
    () => snapshotOf(name, description, maxStepsInput, derivedGraph),
    [name, description, maxStepsInput, derivedGraph],
  );
  const isDirty = liveSnapshot !== initialSnapshotRef.current;
  const maxSteps = parseMaxSteps(maxStepsInput);
  const maxStepsError = maxSteps == null ? `Max steps must be a whole number between 1 and ${PIPELINE_LIMITS.maxStepsMax}.` : null;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleAutoArrange = useCallback(() => {
    // Feed dagre each card's REAL measured height (React Flow's
    // `node.measured`) so a card taller than the layout estimate can't be
    // laid over the rank beneath it; an unmeasured node falls back to the
    // constant estimate inside `autoLayout`.
    const measuredById = new Map(
      nodesRef.current.map((n) => [
        n.id,
        n.measured?.width != null && n.measured?.height != null
          ? { width: n.measured.width, height: n.measured.height }
          : null,
      ]),
    );
    const laidOut = autoLayout(derivedGraph, { measured: (id) => measuredById.get(id) ?? null });
    setNodes(toFlowNodes(laidOut, () => ({ onAppend: appendStep })));
    // A deliberate, one-shot repositioning — not a drag frame — so there's
    // no reason to make the validation banner wait out the debounce for it.
    // (`isDirty` already updates immediately via `derivedGraph`.)
    setDebouncedGraph(laidOut);
  }, [derivedGraph, appendStep, setNodes]);

  const handleFitView = useCallback(() => {
    void fitView({ duration: 300 });
  }, [fitView]);

  const handleBack = useCallback(async () => {
    if (isDirty) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        description: "You have unsaved changes to this pipeline — leaving now will discard them.",
        confirmLabel: "Discard changes",
        variant: "destructive",
      });
      if (!ok) return;
    }
    onBack();
  }, [isDirty, confirm, onBack]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidationError("Pipeline name is required.");
      return;
    }
    if (trimmedName.length > PIPELINE_LIMITS.name) {
      setValidationError(`Pipeline name must be ${PIPELINE_LIMITS.name} characters or fewer.`);
      return;
    }
    if (maxSteps == null) {
      setValidationError(maxStepsError);
      return;
    }
    const validated = validatePipelineGraph(derivedGraph);
    if (!validated.ok) {
      setValidationError(validated.error);
      return;
    }
    setValidationError(null);
    setSaving(true);
    try {
      const trimmedDescription = description.trim();
      const input: PipelineInput = {
        name: trimmedName,
        description: trimmedDescription,
        graph: validated.graph,
        maxSteps,
      };
      const saved = pipelineId ? await api.updatePipeline(pipelineId, input) : await api.createPipeline(input);
      // The clean baseline is the NORMALIZED payload (trimmed name /
      // description, the validator's normalized graph, the coerced max
      // steps) — so reset the live state to those same values, otherwise
      // the editor would read as dirty again the instant it re-rendered
      // (" Foo " vs "Foo", or a step name the validator trimmed) even
      // though nothing the user did after Save changed anything.
      setName(trimmedName);
      setDescription(trimmedDescription);
      setMaxStepsInput(String(maxSteps));
      setNodes(toFlowNodes(validated.graph, () => ({ onAppend: appendStep })));
      setEdges(toFlowEdges(validated.graph).map((e) => ({ ...e, data: { ...e.data, onDelete: removeEdge } })));
      setStartStepId(validated.graph.startStepId);
      setDebouncedGraph(validated.graph);
      initialSnapshotRef.current = snapshotOf(trimmedName, trimmedDescription, String(maxSteps), validated.graph);
      onSaved(saved);
    } catch (err) {
      setValidationError(err instanceof ApiError ? err.message : "Failed to save pipeline.");
    } finally {
      setSaving(false);
    }
  }, [name, description, maxSteps, maxStepsError, derivedGraph, pipelineId, onSaved, appendStep, removeEdge, setNodes, setEdges]);

  const displayedError = validationError ?? (!liveValidation.ok ? liveValidation.error : null) ?? maxStepsError;

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        Loading pipeline…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-danger">
        <p>{loadError}</p>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back to pipelines
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="pipeline-editor" className="flex h-full min-h-0 w-full flex-col">
      <div
        data-testid="pipeline-editor-toolbar"
        className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2.5"
      >
        <Button type="button" variant="ghost" size="sm" data-testid="pipeline-back" onClick={handleBack} className="gap-1.5">
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Button>
        <Input
          data-testid="pipeline-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pipeline name"
          maxLength={PIPELINE_LIMITS.name}
          className="h-8 w-48"
        />
        <Input
          data-testid="pipeline-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          maxLength={PIPELINE_LIMITS.description}
          className="h-8 min-w-[160px] flex-1"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Max steps
          <Input
            type="number"
            min={1}
            max={PIPELINE_LIMITS.maxStepsMax}
            step={1}
            data-testid="pipeline-max-steps"
            value={maxStepsInput}
            aria-invalid={maxSteps == null || undefined}
            onChange={(e) => setMaxStepsInput(e.target.value)}
            // Coerce on blur: a finite number is re-rendered as its integer
            // form ("3.7" → "3", " 5 " → "5"); anything else is left as
            // typed so the disabled Save + the error text explain why.
            onBlur={() => {
              const n = Number(maxStepsInput.trim());
              if (maxStepsInput.trim() !== "" && Number.isFinite(n)) setMaxStepsInput(String(Math.floor(n)));
            }}
            className="h-8 w-20"
          />
        </label>
        <Button type="button" variant="outline" size="sm" data-testid="pipeline-add-step" onClick={addStep} className="gap-1.5">
          <Plus className="size-4" aria-hidden />
          Add step
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pipeline-auto-arrange"
          onClick={handleAutoArrange}
          className="gap-1.5"
        >
          <LayoutGrid className="size-4" aria-hidden />
          Auto-arrange
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="pipeline-fit-view" onClick={handleFitView} className="gap-1.5">
          <Maximize2 className="size-4" aria-hidden />
          Fit view
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {displayedError && (
            <span data-testid="pipeline-validation-error" className="max-w-xs truncate text-xs text-danger" title={displayedError}>
              {displayedError}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            data-testid="pipeline-save"
            disabled={saving || !liveValidation.ok || !name.trim() || maxSteps == null}
            onClick={handleSave}
            className="gap-1.5"
          >
            <Save className="size-4" aria-hidden />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div ref={canvasRef} data-testid="pipeline-canvas" className="relative min-w-0 flex-1">
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <p className="rounded-md border border-dashed border-border bg-card/80 px-4 py-2 text-sm text-muted-foreground">
                Add a step to get started.
              </p>
            </div>
          )}
          <PipelineCanvasContext.Provider value={canvasContextValue}>
            <ReactFlow<CanvasNode, CanvasEdge>
              nodes={canvasNodes}
              edges={canvasEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onCanvasNodesChange}
              onEdgesChange={onCanvasEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => activateNodeById(node.id)}
              onPaneClick={() => setSelectedStepId(null)}
              // Delete/Backspace are handled by this editor's own document
              // listener (modal/popover- and text-entry-guarded) — see the
              // keyboard-shortcuts effect above for why the library's
              // handler was the wrong layer.
              deleteKeyCode={null}
              fitView
              colorMode={resolved}
              proOptions={{ hideAttribution: true }}
              snapToGrid
              snapGrid={[16, 16]}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <MiniMap pannable zoomable />
              <Controls showInteractive={false} />
            </ReactFlow>
          </PipelineCanvasContext.Provider>
        </div>

        <SubagentDetailsDialog
          open={detailsSatellite != null}
          onClose={() => setDetailsNodeId(null)}
          satellite={detailsSatellite}
          stepName={detailsStepName}
          cap={detailsStep?.subagents.cap ?? null}
          profile={detailsSatellite?.profileId ? (profileById.get(detailsSatellite.profileId) ?? null) : null}
          profileDeleted={detailsSatellite?.profileId ? profilesLoaded && !profileById.has(detailsSatellite.profileId) : false}
          onOpenSettingsAgents={onOpenSettingsAgents}
        />

        <AnimatePresence>
          {selectedStep && (
            // ONE aside, keyed once: only opening/closing the panel slides
            // it; switching between two steps swaps the content in place.
            // Keyed per step id, a switch used to run the outgoing panel's
            // exit and the incoming one's enter concurrently — two 320px
            // panels docked side by side for the 180ms overlap, shoving the
            // canvas over and back. `StepPanel` itself is still keyed per
            // step so its own local state (the "New agent…" dialog flag)
            // never carries over from one step to the next.
            <motion.aside
              key="pipeline-step-panel"
              initial={{ x: 320, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 320, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="w-80 shrink-0 border-l border-border bg-card"
            >
              <StepPanel
                key={selectedStep.id}
                step={selectedStep}
                graph={derivedGraph}
                profiles={profiles}
                harnesses={harnesses}
                onChange={updateStep}
                onConnect={(toId) => addEdgeToGraph(selectedStep.id, toId)}
                onEdgeLabel={onEdgeLabel}
                onRemoveEdge={removeEdge}
                onSetStart={() => setStart(selectedStep.id)}
                onDelete={() => deleteStep(selectedStep.id)}
                onProfilesChanged={refreshProfiles}
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
