import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Code2, GitBranch } from "lucide-react";
import { api, type AgentModelMap, type AvailableCommand } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  AGENT_OPTIONS,
  CODE_PLAN_MODE,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentStatus,
  type Harness,
  type Isolation,
  type TaskReference,
} from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";
import { BranchPicker } from "./BranchPicker";
import { ProjectPicker } from "./ProjectPicker";
import {
  ReferencesPicker,
  captureDroppedOrPastedItems,
  mergeRefs,
  type CapturedItem,
} from "./ReferencesPicker";
import { SlashAutocomplete } from "./SlashAutocomplete";
import { spliceAtSelection, readCaret, restoreCaret } from "@/lib/textarea-insert";

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
      mode: string | null;
      model: string | null;
      effort: string | null;
      references: TaskReference[];
    },
    options: { start: boolean },
  ) => void;
  agents: AgentStatus[];
  /** Registered harnesses — built-ins plus user aliases. The agent picker
   *  renders one button per harness. */
  harnesses: Harness[];
  /** Models discovered from each agent's CLI at boot. Merged with the static
   *  AGENT_OPTIONS list. */
  agentModels: AgentModelMap;
}

export function NewTaskForm({ onSubmit, agents, harnesses, agentModels }: Props) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
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
  const [isolate, setIsolate] = useState(true);
  const [baseRef, setBaseRef] = useState("");
  const [mode, setMode] = useState<string>(initialMode("claude-code"));
  const [model, setModel] = useState<string>(DEFAULT_MODEL["claude-code"]);
  // `null` is reserved for the Haiku-style "model doesn't accept effort" case.
  // Every other state is a real effort id from EFFORT_OPTIONS.
  const [effort, setEffort] = useState<string | null>(DEFAULT_EFFORT["claude-code"]);
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
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [agentCommands, setAgentCommands] = useState<AvailableCommand[]>([]);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Refresh the slash-command suggestions whenever the agent / project / branch
  // changes — those three together determine what `/…` entries are reachable.
  // Failures are swallowed: a missing list is no worse than no autocomplete.
  useEffect(() => {
    if (!workdir.trim()) { setAgentCommands([]); return; }
    let cancelled = false;
    // Pass the harness id (not just the kind) so aliased multi-account
    // harnesses read their own per-harness commands/skills — the server
    // resolves it via getByIdOrKind, so a built-in's id-equals-kind is still
    // honored unchanged.
    api
      .listAgentCommands({ agent, workdir: workdir.trim(), branch: baseRef.trim() || undefined })
      .then((cmds) => { if (!cancelled) setAgentCommands(cmds); })
      .catch(() => { if (!cancelled) setAgentCommands([]); });
    return () => { cancelled = true; };
  }, [agent, workdir, baseRef]);

  // Per-kind cache so switching aliases-of-the-same-kind preserves the prior
  // picks (mode/model/effort are kind-specific, not alias-specific).
  // Reads/writes happen synchronously inside `switchAgent` — no effects, so
  // no transient wrong-slot writes on render commit.
  const agentCache = useRef<Record<AgentKind, { mode: string; model: string; effort: string | null }>>({
    "claude-code": { mode: initialMode("claude-code"), model: DEFAULT_MODEL["claude-code"], effort: DEFAULT_EFFORT["claude-code"] },
    "codex": { mode: initialMode("codex"), model: DEFAULT_MODEL["codex"], effort: DEFAULT_EFFORT["codex"] },
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
        if (md && AGENT_OPTIONS[a].modes.some((x) => x.id === md)) {
          agentCache.current[a].mode = md;
        }
        if (m && AGENT_OPTIONS[a].models.some((x) => x.id === m)) {
          agentCache.current[a].model = m;
        }
        if (e) {
          const supported = supportedEfforts(a, agentCache.current[a].model);
          if (supported.some((x) => x.id === e)) {
            agentCache.current[a].effort = e;
          } else if (supported.length === 0) {
            agentCache.current[a].effort = null;
          }
        }
      };
      seed("claude-code");
      seed("codex");
      const active = agentCache.current[kind];
      setMode(active.mode);
      setModel(active.model);
      setEffort(active.effort);
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
    agentCache.current[kind] = { mode, model, effort };
    const saved = agentCache.current[nextKind];
    setAgent(nextId);
    setMode(saved.mode);
    setModel(saved.model);
    setEffort(saved.effort);
  };

  const selectedStatus = agents.find((a) => a.harnessId === agent);
  const { models: staticModels } = AGENT_OPTIONS[kind];
  // `auto` is only valid on models that support real `--permission-mode auto`
  // (Opus 4.7 today); other models would error at spawn. supportedModes
  // filters the dropdown so the user can't pick an incompatible combo.
  const modes = supportedModes(kind, model);
  // Merge in any models the agent's CLI surfaced at boot. We dedup by id and
  // append discovered-only entries after the curated list so the familiar
  // labels stay on top. Discovered ids without a curated label fall through
  // to their raw id as the visible label — better than hiding them.
  const models = (() => {
    const known = new Set(staticModels.map((m) => m.id));
    const extras = (agentModels[kind] ?? [])
      .filter((m) => !known.has(m.id))
      .map((m): typeof staticModels[number] => ({ id: m.id, label: m.label ?? m.id }));
    return [...staticModels, ...extras];
  })();
  // Effort options depend on both kind and model — re-derived each render
  // so a model switch immediately narrows the dropdown. When the new model
  // doesn't accept any effort (Haiku 4.5), effort drops to `null` and the
  // dropdown disables itself. Otherwise we re-pin to the kind's default
  // effort when supported, falling back to the highest available option.
  const efforts = supportedEfforts(kind, model);
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
  }, [kind, model]);
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

  const canSubmit = title.trim() && prompt.trim() && workdir.trim();

  const submit = ({ start }: { start: boolean }) => {
    if (!canSubmit) return;
    onSubmit(
      {
        title: title.trim(),
        prompt: prompt.trim(),
        agent,
        workdir: workdir.trim(),
        isolation: isolate ? "worktree" : "none",
        baseRef: isolate && baseRef.trim() ? baseRef.trim() : undefined,
        // model is always an explicit option id. effort is too, except for
        // the Haiku-style "model doesn't accept effort" case which sends null.
        mode,
        model,
        effort,
        references,
      },
      { start },
    );
    // Remember the model + effort for next time, per kind (aliases of the
    // same kind share cache). Fire-and-forget — preferences failures
    // shouldn't block the user. Also write into the in-memory cache so a
    // same-session agent switch sees the latest pick.
    agentCache.current[kind] = { mode, model, effort };
    void api.setPreference(`lastMode:${kind}`, mode).catch(() => {});
    void api.setPreference(`lastModel:${kind}`, model).catch(() => {});
    if (effort !== null) void api.setPreference(`lastEffort:${kind}`, effort).catch(() => {});
    setTitle("");
    setPrompt("");
    setBaseRef("");
    setReferences([]);
    setDropHint(null);
    // Keep `workdir`, `model`, `effort`, `mode` set on purpose — the next
    // task should default to the same project + picks the user just used.
  };

  const isolateTitle =
    "Runs the agent on a dedicated branch off the chosen base, so parallel tasks "
    + "on the same repo don't collide. No-op when the workdir isn't a git repo.";

  // Sidebar-wide drag/drop — anything dropped on the form (not just the
  // ReferencesPicker) gets added to the references list. The inner picker
  // also accepts drops and calls e.stopPropagation, so we don't double up.
  const onAsideDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onAsideDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  };
  const applyCaptured = (items: CapturedItem[]) => {
    if (!items.length) return;
    setReferences((cur) => mergeRefs(cur, items.map((i) => i.ref)));
    const marker = items.map((i) => `[${i.basename}]`).join(" ");
    // Read the caret synchronously (DOM state, not React state) then drive
    // setPrompt with a functional updater so two captures landing back-to-
    // back across an async boundary don't see stale `prompt` closures.
    const selection = readCaret(promptRef.current);
    let caret = 0;
    setPrompt((cur) => {
      const r = spliceAtSelection(cur, selection, marker);
      caret = r.caret;
      return r.next;
    });
    restoreCaret(promptRef.current, caret);
  };
  const reportCapture = ({ items, skipped, error }: {
    items: CapturedItem[];
    skipped: number;
    error?: string;
  }) => {
    if (error) setDropHint(`Couldn't save screenshot: ${error}`);
    else if (skipped && !items.length) setDropHint("Nothing to attach — drag a file from Finder, or a screenshot blob.");
    else setDropHint(null);
  };
  const onAsideDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setDropHint(null);
    const dt = e.dataTransfer;
    const result = await captureDroppedOrPastedItems(dt);
    reportCapture(result);
    applyCaptured(result.items);
  };
  const onPromptPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    // Only intercept when the clipboard actually carries a file — otherwise
    // let the default text paste run.
    const hasFile = Array.from(cd.items ?? []).some((it) => it.kind === "file");
    if (!hasFile) return;
    e.preventDefault();
    setDropHint(null);
    const result = await captureDroppedOrPastedItems(cd);
    reportCapture(result);
    applyCaptured(result.items);
  };

  return (
    <aside
      onDragOver={onAsideDragOver}
      onDragLeave={onAsideDragLeave}
      onDrop={onAsideDrop}
      className={cn(
        "relative flex h-full w-80 shrink-0 flex-col border-r border-border/60 bg-card text-card-foreground",
        dragging && "ring-2 ring-inset ring-primary",
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
        <span className="text-sm font-semibold">New task</span>
        {selectedStatus?.available && selectedStatus.version && (
          <span className="text-[11px] text-muted-foreground">
            {selectedStatus.version}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        <div className="space-y-1">
          <label className="text-muted-foreground">Title</label>
          <Input
            placeholder="Short description"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <label className="text-muted-foreground">Prompt</label>
          <div className="relative">
            <Textarea
              ref={promptRef}
              placeholder="What should the agent do? Type / for commands."
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); if (dropHint) setDropHint(null); }}
              onPaste={onPromptPaste}
              rows={6}
              className="resize-none"
            />
            <SlashAutocomplete
              commands={agentCommands}
              value={prompt}
              onChange={setPrompt}
              textareaRef={promptRef}
            />
          </div>
          {dropHint && (
            <p className="text-[10px] text-muted-foreground">{dropHint}</p>
          )}
        </div>

        <ReferencesPicker
          variant="expandable"
          label="Files / Folders"
          refs={references}
          onChange={setReferences}
        />

        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 space-y-1">
            <label className="text-muted-foreground">Project</label>
            <ProjectPicker
              value={workdir}
              onChange={(p) => {
                setWorkdir(p);
                // The previously-picked branch likely doesn't exist on the new
                // project — drop back to HEAD so the picker shows a valid default.
                setBaseRef("");
              }}
              autoSelectFirst
              placement="bottom"
              title="Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list."
            />
          </div>
          <div className="min-w-0 space-y-1">
            <label className="text-muted-foreground">Branch</label>
            <BranchPicker
              workdir={workdir}
              value={baseRef}
              onChange={setBaseRef}
              placement="bottom"
              title={
                isolate
                  ? "Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start."
                  : "Isolation is off — the value is recorded but the agent will run directly in the project workdir."
              }
            />
          </div>
        </div>

        <label
          className="flex cursor-pointer items-center gap-1.5"
          title={isolateTitle}
        >
          <input
            type="checkbox"
            checked={isolate}
            onChange={(e) => setIsolate(e.target.checked)}
          />
          <GitBranch className="size-3" />
          <span>Isolate (worktree)</span>
        </label>

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
                    [status?.reason, status?.path, status?.version]
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
                      available ? "bg-emerald-500" : "bg-red-500",
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
                  : "Plan only — agent describes what it would do without making changes."
              }
            >
              <ClipboardList className="mr-1 size-3.5" />
              Plan
            </Button>
          </div>
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="h-8"
          >
            {modes.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
          {selectedModeHint && (
            <p className="text-[11px] leading-snug text-muted-foreground">{selectedModeHint}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 space-y-1">
            <label className="text-muted-foreground">Model</label>
            <Select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-8"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
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
    </aside>
  );
}
