import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
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
  toFlowEdges,
  toFlowNodes,
  type StepFlowEdge,
  type StepFlowNode,
  type StepVisualState,
} from "@/lib/pipelines";
import { newStep, validatePipelineGraph } from "../../../shared/pipeline.ts";
import { PIPELINE_LIMITS } from "../../../shared/types.ts";
import type { Harness, Pipeline, PipelineEdge, PipelineGraph, PipelineInput, PipelineStep } from "../../../shared/types.ts";
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

function blankGraph(): { graph: PipelineGraph; step: PipelineStep } {
  const step = newStep({ position: { x: 0, y: 0 } });
  return { graph: { steps: [step], edges: [], startStepId: step.id }, step };
}

/**
 * The full-page, n8n-style canvas editor for a {@link Pipeline}: draggable
 * step nodes, drag-to-connect (or "Connect to…"-select) edges, a per-step
 * side panel, Auto-arrange (dagre), Fit view, keyboard delete, and an
 * unsaved-changes guard on Back. See `docs/plans/pipelines.md` D5/D6/D13.
 */
export function PipelineEditor(props: PipelineEditorProps) {
  return (
    <ReactFlowProvider>
      <PipelineEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function PipelineEditorInner({ pipelineId, onBack, onSaved }: PipelineEditorProps) {
  const confirm = useConfirm();
  const { resolved } = useTheme();
  const { fitView } = useReactFlow();
  const { profiles, refresh: refreshProfiles } = useAgentProfiles();

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

  // Computed at most once (never on a later render) so the draft's single
  // step and `selectedStepId` always agree on the same generated id — two
  // independent `blankGraph()` calls would each mint their own uuid.
  const initialDraftRef = useRef<{ graph: PipelineGraph; step: PipelineStep } | null>(null);
  if (initialDraftRef.current === null) initialDraftRef.current = blankGraph();
  const initialDraft = initialDraftRef.current;

  const [loading, setLoading] = useState(pipelineId != null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [maxSteps, setMaxSteps] = useState<number>(PIPELINE_LIMITS.maxStepsDefault);
  const [graph, setGraph] = useState<PipelineGraph>(initialDraft.graph);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(initialDraft.step.id);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const initialSnapshotRef = useRef<string>(snapshotOf("", "", PIPELINE_LIMITS.maxStepsDefault, initialDraft.graph));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!pipelineId) {
        const { graph: g, step } = blankGraph();
        if (cancelled) return;
        setName("");
        setDescription("");
        setMaxSteps(PIPELINE_LIMITS.maxStepsDefault);
        setGraph(g);
        setSelectedStepId(step.id);
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
        setGraph(pipeline.graph);
        setSelectedStepId(pipeline.graph.steps[0]?.id ?? null);
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
  }, [pipelineId]);

  // Escape deselects the current step (closes the panel) — but yields to any
  // open popover inside the panel (AgentProfilePicker's search box, the
  // subagent multi-select, …) per the app's `data-popover-open` convention,
  // so a picker's own Escape-to-close isn't shadowed by this full-page
  // view's Escape handler.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[data-popover-open]")) return;
      setSelectedStepId(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const appendStep = useCallback((fromId: string) => {
    const id = crypto.randomUUID();
    setGraph((g) => {
      if (g.steps.length >= PIPELINE_LIMITS.steps) return g;
      const fromStep = g.steps.find((s) => s.id === fromId);
      const base = fromStep?.position ?? { x: 0, y: 0 };
      const step = newStep({ id, position: { x: base.x + 300, y: base.y }, name: uniqueStepName(g.steps) });
      const edge: PipelineEdge = { id: crypto.randomUUID(), from: fromId, to: step.id, label: "" };
      return { ...g, steps: [...g.steps, step], edges: [...g.edges, edge] };
    });
    setSelectedStepId(id);
  }, []);

  const addStep = useCallback(() => {
    const id = crypto.randomUUID();
    setGraph((g) => {
      if (g.steps.length >= PIPELINE_LIMITS.steps) return g;
      const maxX = g.steps.reduce((m, s) => Math.max(m, s.position.x), -300);
      const step = newStep({ id, position: { x: maxX + 300, y: 0 }, name: uniqueStepName(g.steps) });
      return { steps: [...g.steps, step], edges: g.edges, startStepId: g.startStepId ?? step.id };
    });
    setSelectedStepId(id);
  }, []);

  const updateStep = useCallback((updated: PipelineStep) => {
    setGraph((g) => ({ ...g, steps: g.steps.map((s) => (s.id === updated.id ? updated : s)) }));
  }, []);

  const deleteStep = useCallback((stepId: string) => {
    setGraph((g) => {
      const steps = g.steps.filter((s) => s.id !== stepId);
      const edges = g.edges.filter((e) => e.from !== stepId && e.to !== stepId);
      const startStepId = g.startStepId === stepId ? (steps[0]?.id ?? null) : g.startStepId;
      return { steps, edges, startStepId };
    });
    setSelectedStepId((id) => (id === stepId ? null : id));
  }, []);

  const setStart = useCallback((stepId: string) => {
    setGraph((g) => ({ ...g, startStepId: stepId }));
  }, []);

  const addEdgeToGraph = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return;
    setGraph((g) => {
      if (g.edges.some((e) => e.from === from && e.to === to)) return g;
      if (g.edges.length >= PIPELINE_LIMITS.edges) return g;
      const edge: PipelineEdge = { id: crypto.randomUUID(), from, to, label: "" };
      return { ...g, edges: [...g.edges, edge] };
    });
  }, []);

  const removeEdge = useCallback((edgeId: string) => {
    setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }));
  }, []);

  const onEdgeLabel = useCallback((edgeId: string, label: string) => {
    setGraph((g) => ({ ...g, edges: g.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)) }));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target) addEdgeToGraph(connection.source, connection.target);
  }, [addEdgeToGraph]);

  const onNodesDelete = useCallback((deleted: StepFlowNode[]) => {
    const ids = new Set(deleted.map((n) => n.id));
    setGraph((g) => {
      const steps = g.steps.filter((s) => !ids.has(s.id));
      const edges = g.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
      const startStepId = g.startStepId && ids.has(g.startStepId) ? (steps[0]?.id ?? null) : g.startStepId;
      return { steps, edges, startStepId };
    });
    setSelectedStepId((id) => (id && ids.has(id) ? null : id));
  }, []);

  const onEdgesDelete = useCallback((deleted: StepFlowEdge[]) => {
    const ids = new Set(deleted.map((e) => e.id));
    setGraph((g) => ({ ...g, edges: g.edges.filter((e) => !ids.has(e.id)) }));
  }, []);

  // React Flow's controlled-component contract: apply library-side changes
  // (drag positions, dimension measurement) via the library's own reducer,
  // then fold resulting positions back into `graph` — the single source of
  // truth every other handler above also reads/writes. Removal is handled
  // by `onNodesDelete`/`onEdgesDelete`, not here.
  const onNodesChange = useCallback((changes: NodeChange<StepFlowNode>[]) => {
    setGraph((g) => {
      const current = toFlowNodes(g);
      const next = applyNodeChanges(changes, current);
      const positionById = new Map(next.map((n) => [n.id, n.position]));
      let changed = false;
      const steps = g.steps.map((s) => {
        const pos = positionById.get(s.id);
        if (pos && (pos.x !== s.position.x || pos.y !== s.position.y)) {
          changed = true;
          return { ...s, position: pos };
        }
        return s;
      });
      return changed ? { ...g, steps } : g;
    });
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<StepFlowEdge>[]) => {
    // Edge geometry/label is re-derived from `graph` every render and edge
    // selection isn't persisted state; this keeps React Flow's controlled
    // contract honest without a second source of truth. Actual removal is
    // `onEdgesDelete`.
    applyEdgeChanges(changes, toFlowEdges(graph));
  }, [graph]);

  const nodes = useMemo<StepFlowNode[]>(
    () =>
      toFlowNodes(graph, (step) => ({
        profile: step.agentProfileId ? (profileById.get(step.agentProfileId) ?? null) : null,
        profileDeleted: step.agentProfileId != null && !profileById.has(step.agentProfileId),
        isStart: graph.startStepId === step.id,
        visual: "idle" as StepVisualState,
        parallelWarning: step.transition === "all",
        onAppend: appendStep,
      })).map((n) => ({ ...n, selected: n.id === selectedStepId })),
    [graph, profileById, selectedStepId, appendStep],
  );

  const edges = useMemo<StepFlowEdge[]>(
    () => toFlowEdges(graph).map((e) => ({ ...e, data: { ...e.data, onDelete: removeEdge } })),
    [graph, removeEdge],
  );

  const selectedStep = useMemo(
    () => (selectedStepId ? (graph.steps.find((s) => s.id === selectedStepId) ?? null) : null),
    [graph, selectedStepId],
  );

  const liveValidation = useMemo(() => validatePipelineGraph(graph), [graph]);
  const isDirty = snapshotOf(name, description, maxSteps, graph) !== initialSnapshotRef.current;

  const handleAutoArrange = useCallback(() => {
    setGraph((g) => autoLayout(g));
  }, []);

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
    const validated = validatePipelineGraph(graph);
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
  }, [name, description, maxSteps, graph, pipelineId, onSaved]);

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
          {graph.steps.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <p className="rounded-md border border-dashed border-border bg-card/80 px-4 py-2 text-sm text-muted-foreground">
                Add a step to get started.
              </p>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
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
                graph={graph}
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
