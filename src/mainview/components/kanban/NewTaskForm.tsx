import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AgentModelMap } from "@/lib/api";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { composeLaunchPrompt } from "../../../shared/agent-profile.ts";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { InfoTip } from "@/components/ui/info-tip";
import { Notice } from "@/components/ui/notice";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TASK_TYPE,
  type AgentStatus,
  type Harness,
  type HarnessStack,
  type Isolation,
  type Speed,
  type TaskReference,
  type TaskType,
} from "../../../shared/types.ts";
import { useProjectSelection } from "./ProjectSelection";
import { repositoryFileScopes } from "@/lib/repo-selection";
import { selectionPayload } from "@/lib/worktree-payload";
import { TaskTypePicker } from "./TaskTypePicker";
import { captureDroppedOrPastedItems } from "./ReferencesPicker";
import { PromptComposer, usePromptCapture } from "./PromptComposer";
import { useWorktreeOptions } from "./WorktreeOptions";
import { TaskLaunchPickers, useTaskLaunch } from "./TaskLaunchPickers";
import { WorkspaceSection } from "./WorkspaceSection";
import { LaunchFooter } from "./LaunchFooter";
import { launchGate, submitPicks } from "@/lib/launch-state";
import { useSubmitShortcut } from "@/lib/use-submit-shortcut";
import {
  NEW_TASK_PANEL_COLLAPSED_KEY,
  readCollapsed,
  writeCollapsed,
} from "@/lib/panel-collapse";
import {
  NEW_TASK_PANEL_DEFAULT_WIDTH,
  NEW_TASK_PANEL_MAX_WIDTH,
  NEW_TASK_PANEL_MIN_BOARD_WIDTH,
  NEW_TASK_PANEL_MIN_WIDTH,
  clampNewTaskPanelWidth,
  readNewTaskPanelWidth,
  writeNewTaskPanelWidth,
} from "@/lib/panel-width";

interface Props {
  onSubmit: (
    input: {
      title: string;
      prompt: string;
      /** Harness id — looked up in the harness list to resolve kind/env. */
      agent: string;
      workdir: string;
      isolation: Isolation;
      baseRef?: string;
      /** Branch name for worktree isolation — the value shown in the sidebar's
       *  editable preview field. Omitted when isolation is off. */
      branch?: string;
      mode: string | null;
      model: string | null;
      effort: string | null;
      speed: Speed;
      maxMode: boolean;
      references: TaskReference[];
      taskType: TaskType;
      /** Id of the {@link AgentProfile} this task launches from, or null —
       *  see `AgentProfilePicker` above the harness grid. The server
       *  resolves it and overrides `agent`/`model`/`effort`/`mode`/`speed`/
       *  `maxMode` from the profile; this form already sends the profile's
       *  own values for those fields (see `submit`), so the override is a
       *  no-op in practice but keeps a body-only consumer honest. */
      agentProfileId?: string | null;
      /** Id of the {@link Pipeline} to launch this task as the parent run
       *  of, or omitted for an ordinary task — see `PipelinePicker` above
       *  the Agent picker. Mutually exclusive with `agentProfileId` (never
       *  sent together); the server resolves the first step's harness for
       *  `agent`, which this form already sends (see `submit`). */
      pipelineId?: string;
    },
    options: { start: boolean },
  ) => void;
  agents: AgentStatus[];
  /** Registered harnesses — built-ins plus user aliases. The agent picker
   *  renders one row per harness. */
  harnesses: Harness[];
  /** Harness account stacks, for the account position chip. */
  stacks?: HarnessStack[];
  /** "Manage agents…" footer row in the profile picker's popover — opens
   *  Settings on the Agents section. The profile and pipeline lists themselves
   *  come from the module caches `useTaskLaunch` reads (App mounts them at boot). */
  onOpenSettingsAgents: (profileId?: string) => void;
  /** "Manage pipelines…" footer row in the pipeline picker's popover —
   *  opens the full-page pipelines list. */
  onOpenPipelines: () => void;
  /** Kind-level models discovered from each agent's CLI, refreshed by the
   *  triggers documented on `onRefreshModels` below. Merged with the static
   *  AGENT_OPTIONS list — used as the fallback when `harnessModels` has
   *  nothing for the selected harness (e.g. an older daemon predating the
   *  per-harness route). */
  agentModels: AgentModelMap;
  /** Per-harness model catalog (keyed by harness id, not kind) — the
   *  account-scoped fx picker needs this distinction, since a second `fx-2`
   *  harness sees its own account's catalog rather than the built-in fx
   *  harness's. Preferred over `agentModels` when it has an entry for the
   *  selected harness. */
  harnessModels: Record<string, { id: string; label?: string }[]>;
  /** Force a fresh discovery probe — one harness (pass its id) or every
   *  enabled harness (omit it) — then refetch both `agentModels` and
   *  `harnessModels`. Also fires automatically on the `agent_models_changed`
   *  SSE event, on window focus/visibility, and on a bounded 2s ready-retry
   *  at boot; this prop backs the picker's manual ↻ button for "I just ran
   *  fx login, check now". */
  onRefreshModels: (harnessId?: string) => Promise<void>;
  /** Bumped by the onboarding checklist when it wants to draw attention to
   *  this panel (e.g. the "create your first task" step). On increment
   *  (never on mount, never while `undefined`) the panel expands if
   *  collapsed, the Title field gets focus, and the panel root flashes a
   *  brief highlight ring. */
  focusNonce?: number;
}


/** Width of the collapsed icon rail. */
const RAIL_WIDTH = 44;

export function NewTaskForm({ onSubmit, agents, harnesses, stacks = [], onOpenSettingsAgents, onOpenPipelines, agentModels, harnessModels, onRefreshModels, focusNonce }: Props) {
  // Collapsed = thin icon rail; the board's `flex-1` <main> takes the freed
  // width on its own. Seeded synchronously from localStorage (lazy initial
  // state) so a restart repaints in the state the user left it in — an async
  // read would flash the full-width sidebar first.
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(NEW_TASK_PANEL_COLLAPSED_KEY),
  );
  useEffect(() => {
    writeCollapsed(NEW_TASK_PANEL_COLLAPSED_KEY, collapsed);
  }, [collapsed]);
  // Resizable width (320–560, default 384), read synchronously for the same
  // reason as `collapsed`. `resizing` turns the width transition off while a
  // drag is in flight, so the panel follows the pointer without lag.
  // The width the user chose (stored, dragged or reset to), limited only to the panel's own
  // 320-560 range: a smaller window clamps what is shown, never this, so widening the window
  // again gives the chosen width back, even in a session that started narrow.
  const [storedWidth] = useState(() => readNewTaskPanelWidth(Number.POSITIVE_INFINITY));
  const preferredWidth = useRef(storedWidth);
  const [width, setWidth] = useState(() =>
    clampNewTaskPanelWidth(storedWidth, typeof window === "undefined" ? 1440 : window.innerWidth),
  );
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    // A smaller window re-clamps the panel so the board keeps its room.
    const onResize = () => setWidth(clampNewTaskPanelWidth(preferredWidth.current, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const asideRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // Transient "look here" ring around the panel root, driven by `focusNonce`.
  const [spotlight, setSpotlight] = useState(false);
  const spotlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against firing on mount (initial ref value equals the first prop
  // value, so the first render never counts as an "increment") and against
  // `focusNonce` being permanently `undefined` for callers that don't pass it.
  const prevFocusNonceRef = useRef(focusNonce);
  useEffect(() => {
    const prev = prevFocusNonceRef.current;
    prevFocusNonceRef.current = focusNonce;
    if (focusNonce === undefined || focusNonce === prev) return;
    // Expand exactly like the collapse toggle button does, so the persisted
    // preference and the in-memory state agree — the effect above persists
    // on `[collapsed]` change, so no separate write is needed here.
    setCollapsed(false);
    // Expansion may need a paint before the Title input exists/lays out —
    // defer the focus by a frame (same idiom as RunPanel's post-open focus).
    requestAnimationFrame(() => {
      titleRef.current?.focus();
    });
    if (spotlightTimeoutRef.current) clearTimeout(spotlightTimeoutRef.current);
    setSpotlight(true);
    spotlightTimeoutRef.current = setTimeout(() => setSpotlight(false), 1600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);
  useEffect(() => {
    return () => {
      if (spotlightTimeoutRef.current) clearTimeout(spotlightTimeoutRef.current);
    };
  }, []);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);

  // The launch state — harness / mode / model / effort / speed / max-mode, the
  // agent profile and pipeline "one selection", the remembered per-kind picks and
  // the model catalog — comes from the ONE hook every launch surface shares
  // (`lib/use-task-launch.ts`). The panel feeds it App's live data, so the 15 s
  // harness refresh and the SSE-driven catalog updates keep reaching it.
  const launch = useTaskLaunch(true, {
    withPipelines: true,
    source: { harnesses, agents, stacks, agentModels, harnessModels, refreshModels: onRefreshModels },
  });

  // Combined project selection (single + multi): `repos` is the single source
  // of truth for the selection *and* every per-project base ref, and `workdir`
  // is derived from its first entry. Nothing is selected on a cold start — the
  // OS cwd / home is NOT auto-added as a project. `autoSelect` then promotes
  // the most-recently-added project once the list resolves, so a returning user
  // lands on their previous project without an extra click. After a submit the
  // selection (and every chosen ref) is kept for the next task.
  const { repos, setRepos, workdir, multiRepo } = useProjectSelection({ autoSelect: true });
  // Owns the isolate toggle (forced for 2+) and the branch-name field state —
  // see `WorktreeOptions.tsx`. Declared before the `fileScope` memo below, which
  // reads `wt.effectiveIsolate`.
  const wt = useWorktreeOptions({ workdir, title, taskType, forceIsolate: multiRepo });
  const [references, setReferences] = useState<TaskReference[]>([]);
  const [dragging, setDragging] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // `@` file-reference scope: a live tree when isolation is off (the agent
  // will run directly in `workdir`), or the pinned base ref's tracked files
  // when isolation is on (the worktree doesn't exist yet — see
  // `docs/architecture/at-file-references.md`). Memoized so `useProjectFiles`'s
  // effect (keyed on `scope.dir`/`scope.ref`) doesn't see a new object
  // identity — and therefore doesn't refire — on every unrelated re-render.
  const fileScope = useMemo(() => {
    const dir = workdir.trim();
    if (!dir) return null;
    // A single project's base ref is its own entry's; multi tasks use the
    // per-project `fileScopes` below.
    const ref = repos[0]?.baseRef?.trim() || "HEAD";
    return { dir, ref: wt.effectiveIsolate ? ref : null };
  }, [workdir, repos, wt.effectiveIsolate]);
  // Multi-repository `@` scopes: each selected repo lists at its own path and
  // pinned/HEAD ref; entries are prefixed with the workspace name.
  const fileScopes = useMemo(
    () => (multiRepo ? repositoryFileScopes(repos, wt.effectiveIsolate) : null),
    [multiRepo, repos, wt.effectiveIsolate],
  );
  // Drag/paste-to-attach wiring for the prompt textarea, shared with the
  // aside-wide drop zone below (`onAsideDrop`) — see `PromptComposer.tsx`'s
  // `capture` seam doc for why this needs real `useState` dispatchers.
  const capture = usePromptCapture({ textareaRef: promptRef, setPrompt, setReferences });

  // The label the overage warning and the Run gate name: the harness a launch
  // will ACTUALLY run under (the selected profile's, a pipeline's start step's,
  // else the manual pick).
  const { overageKind, overageLabel } = launch;
  // Gemini's one-shot tmux launch has no deferred-paste fallback for an
  // oversized prompt — surfaced here (and blocking submit) rather than letting
  // it fail at spawn time. Includes the agent-instructions preamble
  // (`composeLaunchPrompt`) so this pre-check sees the same bytes `startTask`
  // will actually send. For a pipeline task the check keys on the START step's
  // bound harness (L-A8); no resolvable start-step profile yet → nothing to check.
  const promptOverage = overageKind === null
    ? null
    : launch.selectedPipeline
      ? promptByteOverage(overageKind, prompt)
      : promptByteOverage(overageKind, composeLaunchPrompt(launch.selectedProfile, prompt));

  // The single Run / backlog rule for every launch surface (S5): Run also needs
  // a launchable harness and a ready pipeline; Add to backlog stays available.
  const gate = launchGate({
    title,
    prompt,
    requireTitle: true,
    reposCount: repos.length,
    worktreeValid: wt.valid,
    overage: promptOverage != null,
    effectiveLaunchable: launch.effectiveLaunchable,
    effectiveHarnessLabel: launch.harnesses.find((h) => h.id === launch.effectiveAgent)?.label ?? launch.effectiveAgent,
    effectiveReason: launch.effectiveStatus?.reason ?? null,
    statusKnown: launch.effectiveStatus !== undefined,
    pipelineSelected: launch.selectedPipeline !== null,
    pipelineReady: launch.pipelineReady,
    pipelineState: launch.pipelineState,
    pipelineProblem: launch.pipelineProblem,
  });

  const submit = ({ start }: { start: boolean }) => {
    if (start ? !gate.canRun : !gate.canBacklog) return;
    const agentFields = submitPicks({
      kind: launch.kind,
      picks: { mode: launch.mode, model: launch.model, effort: launch.effort, speed: launch.speed, maxMode: launch.maxMode },
      profile: launch.selectedProfile,
    });
    onSubmit(
      {
        title: title.trim(),
        prompt: prompt.trim(),
        // The harness id a launch will ACTUALLY run under — a selected profile's
        // or a pipeline's start step's, else the manual pick. The server
        // re-resolves and overrides from the profile/pipeline anyway; sending
        // them here keeps the request body self-consistent.
        agent: launch.effectiveAgent,
        // `selectionPayload` is the single mapping from the combined selection
        // to workdir/isolation/baseRef/branch/repositories: one project keeps
        // the historical single-repository shape, 2+ always sends worktree
        // isolation with one per-project entry. See `worktree-payload.ts`.
        ...selectionPayload({
          repos,
          isolate: wt.effectiveIsolate,
          branchSubmitValue: wt.branchField.submitValue,
        }),
        // model is always an explicit option id. effort is too, except for the
        // Haiku-style "model doesn't accept effort" case which sends null.
        ...agentFields,
        references,
        taskType,
        // Omit entirely when no profile/pipeline is selected — a body that
        // never mentions the key at all is the simplest contract for every
        // consumer of this payload shape (finding F2-1). Mutually exclusive by
        // construction (the hook's one-selection invariant).
        ...(launch.pipelineId ? { pipelineId: launch.pipelineId } : {}),
        ...(launch.agentProfileId ? { agentProfileId: launch.agentProfileId } : {}),
      },
      { start },
    );
    // Remember the picks for next time, per kind (aliases of one kind share the
    // cache). Fire-and-forget; skipped while a profile or pipeline is selected —
    // those aren't the user's manual picks, and there's no "last used profile"
    // or "last used pipeline" preference (plan D12).
    launch.rememberPicks();
    setTitle("");
    setPrompt("");
    setReferences([]);
    capture.clearDropHint();
    wt.resetAfterSubmit();
    // The project selection and its per-project refs stay for the next task.
    launch.setAgentProfileId(null);
    launch.setPipelineId(null);
    // Keep the selection, `model`, `effort`, `mode` set on purpose — the next
    // task should default to the same projects + picks the user just used.
  };

  // Cmd/Ctrl+Enter runs the task from anywhere inside the panel.
  useSubmitShortcut(asideRef, () => submit({ start: true }), gate.canRun);

  const onResizeChange = useCallback((w: number) => {
    setResizing(true);
    setWidth(w);
  }, []);
  const onResizeCommit = useCallback((w: number) => {
    setResizing(false);
    preferredWidth.current = w;
    setWidth(w);
    writeNewTaskPanelWidth(w);
  }, []);
  const onResizeReset = useCallback(() => {
    preferredWidth.current = NEW_TASK_PANEL_DEFAULT_WIDTH;
    // Shown within the window like every other width; the saved one is the plain default.
    setWidth(clampNewTaskPanelWidth(NEW_TASK_PANEL_DEFAULT_WIDTH, window.innerWidth));
    writeNewTaskPanelWidth(NEW_TASK_PANEL_DEFAULT_WIDTH);
  }, []);

  // Sidebar-wide drag/drop — anything dropped on the form (not just the
  // ReferencesPicker) gets added to the references list. The inner picker
  // also accepts drops and calls e.stopPropagation, so we don't double up.
  // While collapsed there is no references list (or prompt caret) on screen to
  // drop into, so the rail is not a drop target: we skip preventDefault, the
  // browser keeps its "no drop" cursor, and the drop falls through instead of
  // silently swallowing the user's file. Expand first, then drop.
  const onAsideDragOver = (e: React.DragEvent) => {
    if (collapsed) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onAsideDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  };
  const onAsideDrop = async (e: React.DragEvent) => {
    if (collapsed) return;
    e.preventDefault();
    setDragging(false);
    capture.clearDropHint();
    const dt = e.dataTransfer;
    const result = await captureDroppedOrPastedItems(dt, { kind: "drop" });
    capture.handleResult(result);
  };

  const panelWidth = collapsed ? RAIL_WIDTH : width;

  return (
    <aside
      ref={asideRef}
      data-testid="new-task-panel"
      onDragOver={onAsideDragOver}
      onDragLeave={onAsideDragLeave}
      onDrop={onAsideDrop}
      style={{ width: panelWidth }}
      className={cn(
        // Width is the only animated property — <main> next door is flex-1,
        // so the board reclaims the space in the same frame with no resize
        // logic on that side. Off while dragging the resize handle.
        "relative flex h-full shrink-0 flex-col border-r border-border/60 bg-card text-card-foreground",
        !resizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        // `!collapsed` is belt-and-braces: onAsideDragOver already refuses to
        // arm `dragging` on the rail, this also drops a stale ring if the
        // panel is collapsed while one is showing.
        dragging && !collapsed && "ring-2 ring-inset ring-primary",
        // Onboarding "look here" highlight — independent of the drag ring
        // above; the two conditions aren't expected to overlap in practice
        // (drag requires the panel already focused/visible by the user).
        spotlight && "ring-2 ring-info",
      )}
    >
      {/* VS Code-style collapse control: straddles the border between the
          sidebar and the board (half of it overhangs into the board's p-4
          gutter, so it never covers a card). z-20 keeps it above the board and
          the resize handle (z-10), and below dialogs/overlays (z-50). top-3
          centers it on the 44px header row ("New task" title). */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand new task panel" : "Collapse new task panel"}
        title={collapsed ? "Expand new task panel" : "Collapse new task panel"}
        className="absolute -right-2.5 top-3 z-20 flex size-5 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
      >
        {collapsed
          ? <ChevronRight className="size-3.5" />
          : <ChevronLeft className="size-3.5" />}
      </button>

      {!collapsed && (
        <ResizeHandle
          testId="new-task-panel-resize"
          label="Resize new task panel"
          value={width}
          min={NEW_TASK_PANEL_MIN_WIDTH}
          max={Math.max(NEW_TASK_PANEL_MIN_WIDTH, Math.min(NEW_TASK_PANEL_MAX_WIDTH, (typeof window === "undefined" ? 1440 : window.innerWidth) - NEW_TASK_PANEL_MIN_BOARD_WIDTH))}
          onChange={onResizeChange}
          onCommit={onResizeCommit}
          onReset={onResizeReset}
        />
      )}

      {/* Clip layer: the contents keep their natural width (rail / form) and get
          cut off by this box while the aside's width animates, instead of
          reflowing every field through 200ms of intermediate widths. It can't
          live on the <aside> itself — that would clip the toggle button's overhang. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {collapsed ? (
          /* Icon rail. Deliberately a plain vertical stack: future quick-action
             icon buttons get appended below the label without touching any of
             the collapse plumbing. The form itself is unmounted rather than
             squeezed — every field's state lives in this component (not its
             children), so nothing the user typed is lost while collapsed. */
          <div className="flex h-full w-11 flex-col items-center gap-2 py-3">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              title="Expand new task panel"
              className="rounded-md px-1 py-2 text-2xs font-semibold tracking-wide text-muted-foreground transition-colors [writing-mode:vertical-rl] hover:text-foreground"
            >
              New task
            </button>
          </div>
        ) : (
          <div className="flex h-full flex-col" style={{ width }}>
            <div className="flex shrink-0 items-center border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <h2 className="text-sm font-semibold">New task</h2>
                <InfoTip
                  label="How these fields fit together"
                  text="A task is a unit of agent work. Type, Title and Prompt say what to do. Project, Branch and Isolate say where — with Isolate on, work happens on a fresh branch in a separate worktree, so your checkout stays clean. Harness, Mode, Model and Effort pick which agent runs it and how much autonomy it gets. Defaults are sensible — a title, a prompt and a project are enough to start."
                />
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
              <TaskTypePicker value={taskType} onChange={setTaskType} />

              <Field controlId="launch-title">
                <FieldLabel>Title</FieldLabel>
                <Input
                  id="launch-title"
                  ref={titleRef}
                  placeholder="Short description"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>

              <PromptComposer
                value={prompt}
                onChange={setPrompt}
                agent={launch.effectiveAgent}
                references={references}
                onReferencesChange={setReferences}
                fileScope={fileScope}
                fileScopes={fileScopes}
                textareaRef={promptRef}
                capture={capture}
                startingFolder={workdir || undefined}
                footer={promptOverage && (
                  <Notice tone="warning">
                    This prompt is {Math.ceil(promptOverage.bytes / 1024)} KB — {overageLabel}'s
                    one-shot launch caps prompts at {Math.floor(promptOverage.limit / 1024)} KB. Pick
                    another harness or trim the prompt.
                  </Notice>
                )}
              />

              {/* One Select Projects control for the whole project/branch
                  section: Projects → per-project Branch rows → Isolate →
                  (More options) Branch name. */}
              <WorkspaceSection surface="panel" state={wt} repos={repos} onReposChange={setRepos} />

              {/* "One selection" (plan D1/D5): a picked pipeline replaces the
                  profile picker AND the manual harness/mode/model/effort block
                  with a summary card; a picked profile replaces the manual
                  block with its own card. */}
              <TaskLaunchPickers
                launch={launch}
                layout="sections"
                surface="panel"
                onManageProfiles={() => onOpenSettingsAgents()}
                onManagePipelines={onOpenPipelines}
              />
            </div>

            <div className="shrink-0 border-t border-border/60 px-4 py-3">
              <LaunchFooter
                primary={{ label: "Run task", onClick: () => submit({ start: true }), disabled: !gate.canRun, testId: "launch-run" }}
                secondary={{ label: "Add to backlog", onClick: () => submit({ start: false }), disabled: !gate.canBacklog, testId: "launch-backlog" }}
                reason={gate.runBlockedReason}
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
