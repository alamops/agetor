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
  toFlowEdges,
  toFlowNodes,
  type StepFlowEdge,
  type StepFlowNode,
} from "@/lib/pipelines";
import { newStep, validatePipelineGraph } from "../../../shared/pipeline.ts";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type { Harness, Pipeline, PipelineEdge, PipelineGraph, PipelineInput, PipelineStep } from "../../../shared/types.ts";
import { PipelineCanvasContext, type PipelineCanvasContextValue, type StepProfileResolution } from "./pipeline-canvas-context";
import { StepEdge } from "./StepEdge";
import { StepNode } from "./StepNode";
import { StepPanel } from "./StepPanel";

const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { step: StepEdge };

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
}

function snapshotOf(name: string, description: string, maxSteps: number, graph: PipelineGraph): string {
  return JSON.stringify({ name, description, maxSteps, graph });
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
 * documented in `e2e/pipelines-editor.spec.ts`'s `test.fixme`. The agent
 * profile lookup and the start-step flag are read by `StepNode` from
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

function PipelineEditorInner({ pipelineId, onBack, onSaved, onDirtyChange }: PipelineEditorProps) {
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
  const [maxSteps, setMaxSteps] = useState<number>(PIPELINE_LIMITS.maxStepsDefault);
  const [startStepId, setStartStepId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const initialSnapshotRef = useRef<string>(
    snapshotOf("", "", PIPELINE_LIMITS.maxStepsDefault, { steps: [], edges: [], startStepId: null }),
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

  // Escape deselects the current step (closes the panel) — but yields to
  // any open modal dialog or popover (AgentProfilePicker's search box, the
  // subagent multi-select, the "New agent…" dialog, …) per the app's
  // `data-popover-open`/`role="dialog"` conventions, so a picker's or
  // dialog's own Escape-to-close isn't shadowed by this full-page view's
  // Escape handler.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-popover-open]')) return;
      setSelectedStepId(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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

  // React Flow's own removal (Delete key / programmatic) is already applied
  // to `nodes` by the hook's built-in `onNodesChange`; this only handles
  // the graph-level cascade — connected edges, `startStepId`, selection.
  const onNodesDelete = useCallback(
    (deleted: StepFlowNode[]) => {
      const ids = new Set(deleted.map((n) => n.id));
      setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
      setStartStepId((s) => (s && ids.has(s) ? (nodesRef.current.find((n) => !ids.has(n.id))?.id ?? null) : s));
      setSelectedStepId((id) => (id && ids.has(id) ? null : id));
    },
    [setEdges],
  );

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
        setMaxSteps(PIPELINE_LIMITS.maxStepsDefault);
        setNodes(toFlowNodes(g, () => ({ onAppend: appendStep })));
        setEdges(toFlowEdges(g).map((e) => ({ ...e, data: { ...e.data, onDelete: removeEdge } })));
        setStartStepId(g.startStepId);
        setSelectedStepId(step.id);
        // Seed the debounced graph immediately for a wholesale rebuild —
        // otherwise `isDirty`/`liveValidation` would read against the STALE
        // pre-load debounced value for up to 150ms and could flash "dirty"
        // right after this fresh, intentionally-clean draft loads.
        setDebouncedGraph(g);
        initialSnapshotRef.current = snapshotOf("", "", PIPELINE_LIMITS.maxStepsDefault, g);
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
        setMaxSteps(pipeline.maxSteps);
        setNodes(toFlowNodes(pipeline.graph, () => ({ onAppend: appendStep })));
        setEdges(toFlowEdges(pipeline.graph).map((e) => ({ ...e, data: { ...e.data, onDelete: removeEdge } })));
        setStartStepId(pipeline.graph.startStepId);
        setSelectedStepId(pipeline.graph.steps[0]?.id ?? null);
        // Same immediate-seed rationale as the blank-draft branch above.
        setDebouncedGraph(pipeline.graph);
        initialSnapshotRef.current = snapshotOf(pipeline.name, pipeline.description, pipeline.maxSteps, pipeline.graph);
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

  const derivedGraph = useMemo(() => graphFromFlow(nodes, edges, startStepId), [nodes, edges, startStepId]);

  const selectedStep = useMemo(
    () => (selectedStepId ? (derivedGraph.steps.find((s) => s.id === selectedStepId) ?? null) : null),
    [derivedGraph, selectedStepId],
  );

  // `derivedGraph` recomputes on every node-position change — including
  // every pointermove frame of a drag — so recomputing `validatePipelineGraph`
  // (a full graph walk) and `snapshotOf` (a full JSON.stringify) directly
  // from it on every render was doing that work at drag-frame rate for no
  // UI benefit (neither the validation banner nor the dirty flag needs
  // sub-frame freshness). Both are instead derived from a `debouncedGraph`
  // that only catches up 150ms after node/edge changes go quiet. `handleSave`
  // deliberately does NOT use this debounced value — it re-validates
  // `derivedGraph` itself synchronously at submit time, so Save always acts
  // on the truly-latest graph even if a debounce cycle hasn't settled yet.
  const [debouncedGraph, setDebouncedGraph] = useState<PipelineGraph>(derivedGraph);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedGraph(derivedGraph), 150);
    return () => clearTimeout(t);
  }, [derivedGraph]);

  const liveValidation = useMemo(() => validatePipelineGraph(debouncedGraph), [debouncedGraph]);
  const debouncedSnapshot = useMemo(
    () => snapshotOf(name, description, maxSteps, debouncedGraph),
    [name, description, maxSteps, debouncedGraph],
  );
  const isDirty = debouncedSnapshot !== initialSnapshotRef.current;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleAutoArrange = useCallback(() => {
    const laidOut = autoLayout(derivedGraph);
    setNodes(toFlowNodes(laidOut, () => ({ onAppend: appendStep })));
    // A deliberate, one-shot repositioning — not a drag frame — so there's
    // no reason to make the validation banner / dirty flag wait out the
    // debounce for it.
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
    if (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > PIPELINE_LIMITS.maxStepsMax) {
      setValidationError(`Max steps must be between 1 and ${PIPELINE_LIMITS.maxStepsMax}.`);
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
      const input: PipelineInput = {
        name: trimmedName,
        description: description.trim(),
        graph: validated.graph,
        maxSteps,
      };
      const saved = pipelineId ? await api.updatePipeline(pipelineId, input) : await api.createPipeline(input);
      initialSnapshotRef.current = snapshotOf(trimmedName, description.trim(), maxSteps, validated.graph);
      onSaved(saved);
    } catch (err) {
      setValidationError(err instanceof ApiError ? err.message : "Failed to save pipeline.");
    } finally {
      setSaving(false);
    }
  }, [name, description, maxSteps, derivedGraph, pipelineId, onSaved]);

  const displayedError = validationError ?? (!liveValidation.ok ? liveValidation.error : null);

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
            data-testid="pipeline-max-steps"
            value={maxSteps}
            onChange={(e) => setMaxSteps(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
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
            disabled={saving || !liveValidation.ok || !name.trim()}
            onClick={handleSave}
            className="gap-1.5"
          >
            <Save className="size-4" aria-hidden />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div data-testid="pipeline-canvas" className="relative min-w-0 flex-1">
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <p className="rounded-md border border-dashed border-border bg-card/80 px-4 py-2 text-sm text-muted-foreground">
                Add a step to get started.
              </p>
            </div>
          )}
          <PipelineCanvasContext.Provider value={canvasContextValue}>
            <ReactFlow
              nodes={nodesWithSelection}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodesDelete={onNodesDelete}
              onNodeClick={(_, node) => setSelectedStepId(node.id)}
              onPaneClick={() => setSelectedStepId(null)}
              deleteKeyCode={["Backspace", "Delete"]}
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

        <AnimatePresence>
          {selectedStep && (
            <motion.aside
              key={`pipeline-step-panel-${selectedStep.id}`}
              initial={{ x: 320, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 320, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="w-80 shrink-0 border-l border-border bg-card"
            >
              <StepPanel
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
