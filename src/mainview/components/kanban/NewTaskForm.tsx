import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Code2,
  RefreshCw,
} from "lucide-react";
import { api, type AgentModelMap } from "@/lib/api";
import { discoveredEffortsFor, mergeModelOptions } from "../../../shared/model-options.ts";
import { promptByteOverage } from "../../../shared/prompt-limits.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchSelect } from "@/components/ui/search-select";
import { InfoTip } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  CODE_PLAN_MODE,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TASK_TYPE,
  cursorModelIdCoveredByCatalog,
  cursorModelSupportsFast,
  cursorModelSupportsMaxMode,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentStatus,
  type Harness,
  type Isolation,
  type TaskReference,
  type TaskType,
} from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";
import { HarnessAuthHint } from "./HarnessAuthHint";
import { ProjectPicker } from "./ProjectPicker";
import { TaskTypePicker } from "./TaskTypePicker";
import { captureDroppedOrPastedItems } from "./ReferencesPicker";
import { PromptComposer, usePromptCapture } from "./PromptComposer";
import { useWorktreeOptions, WorktreeOptions } from "./WorktreeOptions";
import {
  NEW_TASK_PANEL_COLLAPSED_KEY,
  readCollapsed,
  writeCollapsed,
} from "@/lib/panel-collapse";

const initialMode = (kind: AgentKind) => AGENT_OPTIONS[kind].modes[0]?.id ?? "auto";

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
      fast: boolean;
      maxMode: boolean;
      references: TaskReference[];
      taskType: TaskType;
    },
    options: { start: boolean },
  ) => void;
  agents: AgentStatus[];
  /** Registered harnesses — built-ins plus user aliases. The agent picker
   *  renders one button per harness. */
  harnesses: Harness[];
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

export function NewTaskForm({ onSubmit, agents, harnesses, agentModels, harnessModels, onRefreshModels, focusNonce }: Props) {
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
  // Soft-deleted harnesses are excluded from the picker and the default-
  // fallback logic. The full `harnesses` list is still used for
  // `selectedHarness` lookup so the resolved kind stays correct even for a
  // currently-selected-but-disabled harness (edge case during a refresh).
  const availableHarnesses = useMemo(
    () => harnesses.filter((h) => h.enabled),
    [harnesses],
  );
  // Selected harness id (free-form string). Defaults to the built-in
  // claude-code; replaced on first preferences load by `defaultHarness`.
  const [agent, setAgent] = useState<string>("claude-code");
  const selectedHarness = useMemo(
    () => harnesses.find((h) => h.id === agent) ?? null,
    [harnesses, agent],
  );
  // Resolve kind for the form's mode/model/effort logic. Falls back to
  // claude-code (back-compat) when the harness list hasn't loaded yet or
  // the selected id was deleted out-of-band.
  const kind: AgentKind = selectedHarness?.kind ?? "claude-code";
  // workdir starts empty — the OS cwd / home is NOT auto-added as a project.
  // After the user picks (or adds) one and submits a task, we retain the value
  // so the next task pre-fills with the same project ("previous task's project
  // is the default for the next"). On a cold start with prior tasks, the
  // ProjectPicker will auto-select the most-recently-used project from the
  // persisted list.
  const [workdir, setWorkdir] = useState("");
  // Owns the isolate toggle, base-ref, and branch-name field state/derivations
  // — see `WorktreeOptions.tsx`. Declared here (before the mode/model state)
  // since `wt.baseRef` is read further down by `<PromptComposer branch={…}>`.
  const wt = useWorktreeOptions({ workdir, title, taskType });
  const [mode, setMode] = useState<string>(initialMode("claude-code"));
  const [model, setModel] = useState<string>(DEFAULT_MODEL["claude-code"]);
  // `null` is reserved for the Haiku-style "model doesn't accept effort" case.
  // Every other state is a real effort id from EFFORT_OPTIONS.
  const [effort, setEffort] = useState<string | null>(DEFAULT_EFFORT["claude-code"]);
  const [fast, setFast] = useState(false);
  const [maxMode, setMaxMode] = useState(false);
  // Spins the Model label's ↻ button while a manual `onRefreshModels` probe
  // is in flight for the currently-selected harness.
  const [refreshingModels, setRefreshingModels] = useState(false);
  // Auto-select the default harness once it (and the harness list) loads.
  // We only force-switch when the *current* selection isn't valid for the
  // loaded list — so a user mid-edit doesn't get their pick stolen. The
  // `seededDefaultRef` guard means we read `preferences.defaultHarness`
  // at most once per mount; the parent's 15s harness-refresh re-runs the
  // effect, but it short-circuits on the harness-membership check from
  // then on.
  const seededDefaultRef = useRef(false);
  useEffect(() => {
    if (availableHarnesses.length === 0) return;
    if (availableHarnesses.some((h) => h.id === agent)) return;
    if (seededDefaultRef.current) {
      // We've already seeded once; the selected alias was just deleted or
      // disabled. Fall back to the first available harness without
      // re-fetching prefs.
      setAgent(availableHarnesses[0]!.id);
      return;
    }
    seededDefaultRef.current = true;
    void api.listPreferences().then((prefs) => {
      const want = prefs.defaultHarness;
      if (want && availableHarnesses.some((h) => h.id === want)) {
        setAgent(want);
      } else {
        setAgent(availableHarnesses[0]!.id);
      }
    }).catch(() => {
      setAgent(availableHarnesses[0]!.id);
    });
  }, [availableHarnesses, agent]);
  const [references, setReferences] = useState<TaskReference[]>([]);
  const [dragging, setDragging] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Drag/paste-to-attach wiring for the prompt textarea, shared with the
  // aside-wide drop zone below (`onAsideDrop`) — see `PromptComposer.tsx`'s
  // `capture` seam doc for why this needs real `useState` dispatchers.
  const capture = usePromptCapture({ textareaRef: promptRef, setPrompt, setReferences });

  // Per-kind cache so switching aliases-of-the-same-kind preserves the prior
  // picks (mode/model/effort are kind-specific, not alias-specific).
  // Reads/writes happen synchronously inside `switchAgent` — no effects, so
  // no transient wrong-slot writes on render commit.
  const agentCache = useRef<Record<AgentKind, { mode: string; model: string; effort: string | null; fast: boolean; maxMode: boolean }>>({
    "claude-code": { mode: initialMode("claude-code"), model: DEFAULT_MODEL["claude-code"], effort: DEFAULT_EFFORT["claude-code"], fast: false, maxMode: false },
    "codex": { mode: initialMode("codex"), model: DEFAULT_MODEL["codex"], effort: DEFAULT_EFFORT["codex"], fast: false, maxMode: false },
    "cursor": { mode: initialMode("cursor"), model: DEFAULT_MODEL["cursor"], effort: DEFAULT_EFFORT["cursor"], fast: false, maxMode: false },
    "gemini": { mode: initialMode("gemini"), model: DEFAULT_MODEL["gemini"], effort: DEFAULT_EFFORT["gemini"], fast: false, maxMode: false },
    "fx": { mode: initialMode("fx"), model: DEFAULT_MODEL["fx"], effort: DEFAULT_EFFORT["fx"], fast: false, maxMode: false },
  });

  // Seed mode + model + effort defaults from the last submitted picks,
  // per kind. Persisted server-side as `lastMode:<kind>` etc. Fires once.
  // Stored ids are validated against the current option set so a stale
  // sentinel (e.g. the old `"default"` placeholder) doesn't reselect
  // nothing — invalid values fall back to the per-kind defaults.
  //
  // `lastEffort:<kind>` is validated against the model we just restored from
  // `lastModel:<kind>` (or the per-kind default when that pref is missing).
  // The two prefs are always written together in `submit`, so in practice
  // they describe a matched (model, effort) pair; if a partial write ever
  // strands an effort against a model that doesn't support it, the
  // validation collapses it to the kind's default.
  useEffect(() => {
    let cancelled = false;
    void api.listPreferences().then((prefs) => {
      if (cancelled) return;
      const seed = (a: AgentKind) => {
        const md = prefs[`lastMode:${a}`];
        const m = prefs[`lastModel:${a}`];
        const e = prefs[`lastEffort:${a}`];
        const f = prefs[`lastFast:${a}`];
        const mm = prefs[`lastMaxMode:${a}`];
        if (md && AGENT_OPTIONS[a].modes.some((x) => x.id === md)) {
          agentCache.current[a].mode = md;
        }
        if (m && AGENT_OPTIONS[a].models.some((x) => x.id === m)) {
          agentCache.current[a].model = m;
        }
        if (e) {
          const supported = supportedEfforts(
            a,
            agentCache.current[a].model,
            discoveredEffortsFor(agentModels[a], agentCache.current[a].model),
          );
          if (supported.some((x) => x.id === e)) {
            agentCache.current[a].effort = e;
          } else if (supported.length === 0) {
            agentCache.current[a].effort = null;
          }
        }
        if (f === "true" || f === "false") {
          agentCache.current[a].fast = f === "true";
        }
        if (mm === "true" || mm === "false") {
          agentCache.current[a].maxMode = mm === "true";
        }
      };
      seed("claude-code");
      seed("codex");
      seed("cursor");
      seed("gemini");
      seed("fx");
      const active = agentCache.current[kind];
      setMode(active.mode);
      setModel(active.model);
      setEffort(active.effort);
      setFast(active.fast);
      setMaxMode(active.maxMode);
    }).catch(() => { /* preferences failure is non-fatal — defaults stay */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchAgent = (nextId: string) => {
    if (nextId === agent) return;
    const next = harnesses.find((h) => h.id === nextId);
    const nextKind = next?.kind ?? "claude-code";
    // Stash the current picks under the current kind, then restore the
    // next kind's picks. Aliases of the same kind share the cache slot, so
    // a swap claude-work ↔ claude-personal keeps the user's last pick.
    agentCache.current[kind] = { mode, model, effort, fast, maxMode };
    const saved = agentCache.current[nextKind];
    setAgent(nextId);
    setMode(saved.mode);
    setModel(saved.model);
    setEffort(saved.effort);
    setFast(saved.fast);
    setMaxMode(saved.maxMode);
  };

  const selectedStatus = agents.find((a) => a.harnessId === agent);
  const { models: staticModels } = AGENT_OPTIONS[kind];
  // `auto` is only valid on models that support real `--permission-mode auto`
  // (all current claude models); other models would error at spawn. supportedModes
  // filters the dropdown so the user can't pick an incompatible combo.
  const modes = supportedModes(kind, model);
  // Merge the curated list with whatever this harness's CLI catalog
  // discovery surfaced, per the shared rules in `mergeModelOptions` (plan
  // `fx-model-catalog-refresh.md` §3 D3). Prefer the per-harness catalog
  // (keyed by harness id — distinguishes a second `fx-2` account from the
  // built-in fx harness) over the kind-level map, which only exists as a
  // fallback for an older daemon predating `GET /agent-models/harnesses`.
  const discoveredForAgent = (harnessModels[agent] ?? agentModels[kind] ?? [])
    .filter((m) => kind !== "cursor" || !cursorModelIdCoveredByCatalog(m.id));
  const models = mergeModelOptions({
    curated: staticModels,
    discovered: discoveredForAgent,
    selected: model,
    scoped: CATALOG_SCOPED_KINDS.has(kind),
    loggedIn: selectedStatus?.loggedIn ?? null,
  });
  // Effort options depend on both kind and model — re-derived each render
  // so a model switch immediately narrows the dropdown. When the new model
  // doesn't accept any effort (Haiku 4.5), effort drops to `null` and the
  // dropdown disables itself. Otherwise we re-pin to the kind's default
  // effort when supported, falling back to the highest available option.
  // The CLI's own discovered per-model efforts (when reported) win over the
  // curated table — see `supportedEfforts`'s third argument. Unlike
  // RunPanel's task-details cascade, there's no prior intent to retain here
  // (a new task doesn't exist yet), so this uses the discovered-wins set
  // strictly.
  const efforts = supportedEfforts(kind, model, discoveredEffortsFor(harnessModels[agent] ?? agentModels[kind], model));
  const effortsKey = efforts.map((o) => o.id).join(",");
  const maxModeAvailable = kind === "cursor" && cursorModelSupportsMaxMode(model);
  const fastAvailable = kind === "cursor" && cursorModelSupportsFast(model, effort);
  useEffect(() => {
    if (efforts.length === 0) {
      if (effort !== null) setEffort(null);
      return;
    }
    if (effort !== null && efforts.some((e) => e.id === effort)) return;
    const fallback = efforts.some((e) => e.id === DEFAULT_EFFORT[kind])
      ? DEFAULT_EFFORT[kind]
      : efforts[0]!.id;
    setEffort(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, model, effortsKey]);
  useEffect(() => {
    if (!fastAvailable && fast) setFast(false);
  }, [fastAvailable, fast]);
  useEffect(() => {
    if (!maxModeAvailable && maxMode) setMaxMode(false);
  }, [maxModeAvailable, maxMode]);
  useEffect(() => {
    if (!modes.some((m) => m.id === mode)) {
      const fallback = modes[0]?.id;
      if (fallback) setMode(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, model]);
  const selectedModeHint = modes.find((m) => m.id === mode)?.hint;
  const codePlan = CODE_PLAN_MODE[kind];
  const primary: "code" | "plan" = mode === codePlan.plan ? "plan" : "code";

  // Clicking the Code pill while already in a code-bucket mode is a no-op —
  // otherwise we'd reset an explicit acceptEdits/ask choice back to auto.
  const onClickCode = () => {
    if (primary === "code") return;
    setMode(codePlan.code);
  };
  const onClickPlan = () => {
    if (primary === "plan") return;
    setMode(codePlan.plan);
  };

  // Gemini's one-shot tmux launch has no deferred-paste fallback for an
  // oversized prompt — surfaced here (and blocking submit) rather than
  // letting it fail at spawn time. Mirrors CreateTaskFromIssueDialog's guard.
  const promptOverage = promptByteOverage(kind, prompt);
  const selectedHarnessLabel = selectedHarness?.label ?? agent;

  const canSubmit =
    title.trim() && prompt.trim() && workdir.trim() && wt.valid
    && promptOverage == null;

  const submit = ({ start }: { start: boolean }) => {
    if (!canSubmit) return;
    onSubmit(
      {
        title: title.trim(),
        prompt: prompt.trim(),
        agent,
        workdir: workdir.trim(),
        // The branch is only meaningful under worktree isolation — see
        // `worktreePayload` for the isolation/baseRef/branch mapping this
        // spreads in.
        ...wt.payload(),
        // model is always an explicit option id. effort is too, except for
        // the Haiku-style "model doesn't accept effort" case which sends null.
        mode,
        model,
        effort,
        fast: kind === "cursor" ? fast : false,
        maxMode: kind === "cursor" ? maxMode : false,
        references,
        taskType,
      },
      { start },
    );
    // Remember the model + effort for next time, per kind (aliases of the
    // same kind share cache). Fire-and-forget — preferences failures
    // shouldn't block the user. Also write into the in-memory cache so a
    // same-session agent switch sees the latest pick.
    agentCache.current[kind] = { mode, model, effort, fast, maxMode };
    void api.setPreference(`lastMode:${kind}`, mode).catch(() => {});
    void api.setPreference(`lastModel:${kind}`, model).catch(() => {});
    if (effort !== null) void api.setPreference(`lastEffort:${kind}`, effort).catch(() => {});
    void api.setPreference(`lastFast:${kind}`, String(kind === "cursor" && fast)).catch(() => {});
    void api.setPreference(`lastMaxMode:${kind}`, String(kind === "cursor" && maxMode)).catch(() => {});
    setTitle("");
    setPrompt("");
    setReferences([]);
    capture.clearDropHint();
    wt.resetAfterSubmit();
    // Keep `workdir`, `model`, `effort`, `mode` set on purpose — the next
    // task should default to the same project + picks the user just used.
  };

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

  return (
    <aside
      onDragOver={onAsideDragOver}
      onDragLeave={onAsideDragLeave}
      onDrop={onAsideDrop}
      className={cn(
        // Width is the only animated property — <main> next door is flex-1,
        // so the board reclaims the space in the same frame with no resize
        // logic on that side.
        "relative flex h-full shrink-0 flex-col border-r border-border/60 bg-card text-card-foreground",
        "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-11" : "w-80",
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
          gutter, so it never covers a card). z-20 keeps it above the board
          and below dialogs/overlays (z-50). top-3 centers it on the 44px
          header row ("New task" title) so it's found where users look. */}
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

      {/* Clip layer: the contents keep their natural width (w-11 rail / w-80
          form) and get cut off by this box while the aside's width animates,
          instead of reflowing every field through 200ms of intermediate
          widths. It can't live on the <aside> itself — that would clip the
          toggle button's overhang. */}
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
              className="rounded-md px-1 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground transition-colors [writing-mode:vertical-rl] hover:text-foreground"
            >
              New task
            </button>
          </div>
        ) : (
          <div className="flex h-full w-80 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold">New task</span>
                <InfoTip
                  label="How these fields fit together"
                  text="A task is a unit of agent work. Type, Title and Prompt say what to do. Project, Branch and Isolate say where — with Isolate on, work happens on a fresh branch in a separate worktree, so your checkout stays clean. Harness, Mode, Model and Effort pick which agent runs it and how much autonomy it gets. Defaults are sensible — a title, a prompt and a project are enough to start."
                />
              </div>
              {selectedStatus?.available && selectedStatus.version && (
                <span className="text-[11px] text-muted-foreground">
                  {selectedStatus.version}
                </span>
              )}
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
              <TaskTypePicker value={taskType} onChange={setTaskType} />

              <div className="space-y-1">
                <label className="text-muted-foreground">Title</label>
                <Input
                  ref={titleRef}
                  placeholder="Short description"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <PromptComposer
                value={prompt}
                onChange={setPrompt}
                agent={agent}
                workdir={workdir}
                branch={wt.baseRef}
                references={references}
                onReferencesChange={setReferences}
                textareaRef={promptRef}
                capture={capture}
                startingFolder={workdir || undefined}
                footer={promptOverage && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                    This prompt is {Math.ceil(promptOverage.bytes / 1024)} KB — {selectedHarnessLabel}'s
                    one-shot launch caps prompts at {Math.floor(promptOverage.limit / 1024)} KB. Pick
                    another harness or trim the prompt.
                  </div>
                )}
              />

              {/* Project + Branch each get their own full-width row. Side-by-side in
                  the ~140px-per-column grid clipped all but the shortest names; full
                  width lets the picker triggers render the full project/branch name. */}
              <div className="min-w-0 space-y-1">
                <label className="text-muted-foreground">Project</label>
                <ProjectPicker
                  value={workdir}
                  onChange={(p) => {
                    setWorkdir(p);
                    // The previously-picked branch likely doesn't exist on the new
                    // project — drop back to HEAD so the picker shows a valid default.
                    wt.resetBaseRef();
                  }}
                  autoSelectFirst
                  placement="bottom"
                  title="Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list."
                />
              </div>
              <WorktreeOptions state={wt} />

              <div className="space-y-1">
                <label className="text-muted-foreground">Harness</label>
                <div className="grid grid-cols-2 gap-1">
                  {availableHarnesses.map((h) => {
                    const status = agents.find((s) => s.harnessId === h.id);
                    const available = status?.available ?? true;
                    return (
                      <Button
                        key={h.id}
                        size="sm"
                        variant={agent === h.id ? "default" : "outline"}
                        onClick={() => switchAgent(h.id)}
                        title={
                          [
                            status?.reason,
                            status?.loggedIn === false ? (status.authHelp ?? "Not logged in") : null,
                            status?.path,
                            status?.version,
                          ]
                            .filter(Boolean)
                            .join(" — ") || h.id
                        }
                        className="justify-start"
                      >
                        <AgentIcon kind={h.kind} className="mr-1" />
                        <span className="truncate">{h.label}</span>
                        <span
                          className={cn(
                            "ml-auto inline-block size-1.5 rounded-full",
                            available ? "bg-success-solid" : "bg-danger-solid",
                          )}
                        />
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-muted-foreground">Mode</label>
                <div className="grid grid-cols-2 gap-1">
                  <Button
                    size="sm"
                    variant={primary === "code" ? "default" : "outline"}
                    onClick={onClickCode}
                    title="Execute changes (auto / accept edits / ask all live under Code — pick the exact variant below)."
                  >
                    <Code2 className="mr-1 size-3.5" />
                    Code
                  </Button>
                  <Button
                    size="sm"
                    variant={primary === "plan" ? "default" : "outline"}
                    onClick={onClickPlan}
                    title={
                      kind === "codex"
                        ? "Codex has no native plan mode — routed to 'ask' so nothing auto-executes."
                        : kind === "cursor"
                        ? "Cursor has no native plan mode — routed to propose-only 'ask' so nothing auto-executes."
                        : kind === "gemini"
                        ? "Routed to gemini's --approval-mode plan — a real read-only mode, no changes made."
                        : kind === "fx"
                        ? "fx has no native plan mode — routed to 'ask': only pre-approved rules run; anything else surfaces as an approval card in the run panel."
                        : "Plan only — agent describes what it would do without making changes."
                    }
                  >
                    <ClipboardList className="mr-1 size-3.5" />
                    Plan
                  </Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <SearchSelect
                    value={mode}
                    onChange={setMode}
                    items={modes.map((m) => ({ value: m.id, label: m.label, hint: m.hint }))}
                    searchable={false}
                    wrapHints
                    placement="bottom"
                    className="min-w-0 flex-1"
                    triggerClassName="h-8 text-xs"
                  />
                  {selectedModeHint && <InfoTip text={selectedModeHint} label="About this mode" />}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1">
                    <label className="text-muted-foreground">Model</label>
                    <button
                      type="button"
                      title="Refresh model list"
                      aria-label="Refresh model list"
                      data-testid="refresh-models"
                      disabled={refreshingModels}
                      className={cn(
                        "text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                        refreshingModels && "animate-spin",
                      )}
                      onClick={async () => {
                        setRefreshingModels(true);
                        try {
                          await onRefreshModels(agent);
                        } catch {
                          // The SSE / ready-retry paths also refetch — a
                          // failed manual probe just leaves the list as-is.
                        } finally {
                          setRefreshingModels(false);
                        }
                      }}
                    >
                      <RefreshCw className="size-3" />
                    </button>
                  </div>
                  <Select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="h-8"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id} title={m.unlisted ? m.hint : undefined}>{m.label}</option>
                    ))}
                  </Select>
                </div>
                <div className="min-w-0 space-y-1">
                  <label className="text-muted-foreground">Effort</label>
                  <Select
                    value={effort ?? ""}
                    onChange={(e) => setEffort(e.target.value)}
                    title={
                      efforts.length === 0
                        ? "This model doesn't accept a reasoning-effort flag."
                        : kind === "claude-code"
                          ? "Appends a thinking keyword (think / think hard / ultrathink) to the prompt."
                          : "Reasoning effort — higher = slower but more thorough."
                    }
                    className="h-8"
                    disabled={efforts.length === 0}
                  >
                    {efforts.length === 0 ? (
                      <option value="">n/a</option>
                    ) : (
                      efforts.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))
                    )}
                  </Select>
                </div>
              </div>

              {kind === "cursor" && (maxModeAvailable || maxMode || fastAvailable || fast) && (
                <div className="grid grid-cols-2 gap-2">
                  {(maxModeAvailable || maxMode) && (
                    <label className="flex h-8 items-center justify-between rounded-md border border-border px-2 text-xs">
                      <span>Max Mode</span>
                      <Switch
                        checked={maxMode}
                        onCheckedChange={setMaxMode}
                        disabled={!maxModeAvailable}
                        aria-label="Use Cursor Max Mode context"
                      />
                    </label>
                  )}
                  {(fastAvailable || fast) && (
                    <label className="flex h-8 items-center justify-between rounded-md border border-border px-2 text-xs">
                      <span>Fast</span>
                      <Switch
                        checked={fast}
                        onCheckedChange={setFast}
                        disabled={!fastAvailable}
                        aria-label="Use Cursor fast variant"
                      />
                    </label>
                  )}
                </div>
              )}

              {/* Fable models (5, 5.1, …) sit above Opus in the picker but bill at
                  2x the usage — surface that under the model row so the cost is
                  obvious before Create. Family check (not an exact id) so every
                  point release picks this up with no code change. */}
              {kind === "claude-code" && model?.startsWith("fable-") && (
                <div className="text-[11px] text-muted-foreground">
                  {models.find((m) => m.id === model)?.label ?? model} uses 2x the usage of Opus.
                </div>
              )}

              {/* Mythos models are Fable's access-gated twin — same 2x usage, plus
                  the Project Glasswing requirement, so both need calling out here. */}
              {kind === "claude-code" && model?.startsWith("mythos-") && (
                <div className="text-[11px] text-muted-foreground">
                  {models.find((m) => m.id === model)?.label ?? model} uses 2x the usage of Opus and requires approved-org (Project Glasswing) access.
                </div>
              )}

              {/* Surfacing a missing-agent error inline so the user sees install
                  guidance before they hit Create and get a delayed failure. */}
              {selectedStatus && !selectedStatus.available && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground">
                  <div className="font-medium">{selectedStatus.reason}</div>
                  {selectedStatus.installHint && (
                    <div className="mt-1 font-mono opacity-80">
                      {selectedStatus.installHint}
                    </div>
                  )}
                </div>
              )}

              {/* Not blocking — Create/Run still work and the run pre-flight
                  reports the actionable error if the turn actually needs
                  credentials. This is a heads-up, not a disable. */}
              <HarnessAuthHint status={selectedStatus} />
            </div>

            <div className="flex shrink-0 gap-2 border-t border-border/60 px-4 py-3">
              <Button
                variant="outline"
                onClick={() => submit({ start: false })}
                className="flex-1"
                disabled={!canSubmit}
                title={
                  workdir.trim()
                    ? "Create the task but don't start it — it sits in Backlog until you start it manually."
                    : "Pick a project first."
                }
              >
                To backlog
              </Button>
              <Button
                onClick={() => submit({ start: true })}
                className="flex-1"
                disabled={!canSubmit}
                title={
                  workdir.trim()
                    ? "Create the task in Ready and hand it to the agent — it'll flip to Running once the harness starts executing."
                    : "Pick a project first."
                }
              >
                Run task
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
