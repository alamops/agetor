import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, type AgentModelMap } from "@/lib/api";
import { mergeModelOptions } from "../../../shared/model-options.ts";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  cursorModelIdCoveredByCatalog,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentOption,
  type AgentStatus,
  type Harness,
} from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";
import { HarnessAuthHint } from "./HarnessAuthHint";

const initialMode = (kind: AgentKind) => AGENT_OPTIONS[kind].modes[0]?.id ?? "auto";

/**
 * Generic "create-and-start a task from a prefilled prompt" launch state —
 * harness/mode/model/effort selection plus the fetch that backs it. Lifted
 * out of `ResolveConflictsDialog` (its original home) so a second consumer
 * (`CreateTaskFromIssueDialog`) doesn't have to duplicate ~130 lines of
 * fetch/seed/fallback logic. `ResolveConflictsDialog` itself is refactored
 * onto this module in a later change — this file must reproduce its
 * behavior exactly rather than drift from it.
 */
export interface TaskLaunch {
  loading: boolean;
  loadError: string | null;
  harnesses: Harness[];
  availableHarnesses: Harness[];
  agents: AgentStatus[];
  agentModels: AgentModelMap;
  /** Per-harness model catalog (fx account-scoped, keyed by harness id) —
   *  preferred over `agentModels`' kind-level list when it has an entry for
   *  the selected harness, mirroring `NewTaskForm`'s `harnessModels` prop. */
  harnessModels: Record<string, { id: string; label?: string }[]>;
  agent: string;
  kind: AgentKind;
  selectedStatus: AgentStatus | undefined;
  mode: string;
  model: string;
  effort: string | null;
  models: AgentOption[];
  modes: AgentOption[];
  efforts: AgentOption[];
  setMode: (mode: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string | null) => void;
  /** Switches the selected harness, resetting mode/model/effort to the new
   *  kind's defaults when the kind actually changes (matches
   *  `ResolveConflictsDialog`'s `switchAgent`). */
  switchAgent: (nextId: string) => void;
  /** Persists the current mode/model/effort as `lastMode/lastModel/lastEffort:<kind>`
   *  preferences — call this right after a successful `createAndStartTask()`,
   *  mirroring `ResolveConflictsDialog`'s inline `setPreference` calls. */
  rememberPicks: () => void;
}

export function useTaskLaunch(open: boolean): TaskLaunch {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModelMap>({ "claude-code": [], codex: [], cursor: [], gemini: [], fx: [] });
  const [harnessModels, setHarnessModels] = useState<Record<string, { id: string; label?: string }[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const availableHarnesses = useMemo(() => harnesses.filter((h) => h.enabled), [harnesses]);

  const [agent, setAgent] = useState<string>("claude-code");
  const selectedHarness = useMemo(
    () => harnesses.find((h) => h.id === agent) ?? null,
    [harnesses, agent],
  );
  const kind: AgentKind = selectedHarness?.kind ?? "claude-code";
  const selectedStatus = agents.find((a) => a.harnessId === agent);

  const [mode, setMode] = useState<string>(initialMode("claude-code"));
  const [model, setModel] = useState<string>(DEFAULT_MODEL["claude-code"]);
  const [effort, setEffort] = useState<string | null>(DEFAULT_EFFORT["claude-code"]);

  // Self-fetch harness data on open — mirrors NewTaskForm/App.tsx's own
  // fetch, but scoped to whichever dialog mounts this hook (it's mounted
  // lazily rather than always-on like the sidebar form).
  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    setLoading(true);
    let cancelled = false;
    Promise.all([api.listHarnesses(), api.listAgentModels(), api.listHarnessModels(), api.listPreferences()])
      .then(([payload, models, harnessModelPayload, prefs]) => {
        if (cancelled) return;
        setHarnesses(payload.harnesses);
        setAgents(payload.statuses);
        setAgentModels(models);
        setHarnessModels(harnessModelPayload.byHarness);
        const enabled = payload.harnesses.filter((h) => h.enabled);
        const want = prefs.defaultHarness;
        const nextAgent =
          want && enabled.some((h) => h.id === want)
            ? want
            : (enabled.some((h) => h.id === agent) ? agent : enabled[0]?.id ?? "claude-code");
        const nextHarness = enabled.find((h) => h.id === nextAgent);
        const nextKind: AgentKind = nextHarness?.kind ?? "claude-code";
        setAgent(nextAgent);

        const seedMode = prefs[`lastMode:${nextKind}`];
        const seedModel = prefs[`lastModel:${nextKind}`];
        const seedEffort = prefs[`lastEffort:${nextKind}`];
        const resolvedModel =
          seedModel && AGENT_OPTIONS[nextKind].models.some((m) => m.id === seedModel)
            ? seedModel
            : DEFAULT_MODEL[nextKind];
        const resolvedMode =
          seedMode && supportedModes(nextKind, resolvedModel).some((m) => m.id === seedMode)
            ? seedMode
            : initialMode(nextKind);
        const supportedEff = supportedEfforts(nextKind, resolvedModel);
        const resolvedEffort =
          seedEffort && supportedEff.some((e) => e.id === seedEffort)
            ? seedEffort
            : supportedEff.some((e) => e.id === DEFAULT_EFFORT[nextKind])
              ? DEFAULT_EFFORT[nextKind]
              : (supportedEff[0]?.id ?? null);
        setMode(resolvedMode);
        setModel(resolvedModel);
        setEffort(resolvedEffort);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { models: staticModels } = AGENT_OPTIONS[kind];
  const modes = supportedModes(kind, model);
  // Merge the curated list with whatever this harness's CLI catalog
  // discovery surfaced, per the shared rules in `mergeModelOptions` — mirrors
  // `NewTaskForm`'s identical computation. Prefer the per-harness catalog
  // (keyed by harness id — distinguishes a second `fx-2` account from the
  // built-in fx harness) over the kind-level map, which only exists as a
  // fallback for an older daemon predating `GET /agent-models/harnesses`.
  const models = useMemo(() => {
    const discoveredForAgent = (harnessModels[agent] ?? agentModels[kind] ?? [])
      .filter((m) => kind !== "cursor" || !cursorModelIdCoveredByCatalog(m.id));
    return mergeModelOptions({
      curated: staticModels,
      discovered: discoveredForAgent,
      selected: model,
      scoped: CATALOG_SCOPED_KINDS.has(kind),
      loggedIn: selectedStatus?.loggedIn ?? null,
    });
  }, [staticModels, harnessModels, agentModels, agent, kind, model, selectedStatus?.loggedIn]);
  const efforts = supportedEfforts(kind, model);

  useEffect(() => {
    if (efforts.length === 0) {
      if (effort !== null) setEffort(null);
      return;
    }
    if (effort !== null && efforts.some((e) => e.id === effort)) return;
    const fallback = efforts.some((e) => e.id === DEFAULT_EFFORT[kind]) ? DEFAULT_EFFORT[kind] : efforts[0]!.id;
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

  const switchAgent = (nextId: string) => {
    if (nextId === agent) return;
    const next = harnesses.find((h) => h.id === nextId);
    const nextKind = next?.kind ?? "claude-code";
    setAgent(nextId);
    if (nextKind !== kind) {
      setMode(initialMode(nextKind));
      setModel(DEFAULT_MODEL[nextKind]);
      setEffort(DEFAULT_EFFORT[nextKind]);
    }
  };

  const rememberPicks = () => {
    void api.setPreference(`lastMode:${kind}`, mode).catch(() => {});
    void api.setPreference(`lastModel:${kind}`, model).catch(() => {});
    if (effort !== null) void api.setPreference(`lastEffort:${kind}`, effort).catch(() => {});
  };

  return {
    loading,
    loadError,
    harnesses,
    availableHarnesses,
    agents,
    agentModels,
    harnessModels,
    agent,
    kind,
    selectedStatus,
    mode,
    model,
    effort,
    models,
    modes,
    efforts,
    setMode,
    setModel,
    setEffort,
    switchAgent,
    rememberPicks,
  };
}

/** Harness grid + Mode select + Model/Effort grid — the picker markup shared
 *  between `ResolveConflictsDialog` and `CreateTaskFromIssueDialog`. Renders
 *  nothing about loading/error states; the consumer owns those around it
 *  (they differ per dialog — e.g. the issue dialog also waits on a thread
 *  fetch). */
export function TaskLaunchPickers({ launch }: { launch: TaskLaunch }) {
  const { availableHarnesses, agents, agent, selectedStatus, mode, modes, model, models, effort, efforts, switchAgent, setMode, setModel, setEffort } = launch;
  return (
    <>
      <div className="space-y-1">
        <label className="text-muted-foreground">Harness</label>
        <div className="grid grid-cols-2 gap-1">
          {availableHarnesses.map((h) => {
            const status = agents.find((s) => s.harnessId === h.id);
            const available = status?.available ?? false;
            const loggedOut = available && status?.loggedIn === false;
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
                    !available ? "bg-danger-solid" : loggedOut ? "bg-warning-solid" : "bg-success-solid",
                  )}
                />
              </Button>
            );
          })}
        </div>
        {selectedStatus && !selectedStatus.available && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground">
            <div className="font-medium">{selectedStatus.reason}</div>
            {selectedStatus.installHint && (
              <div className="mt-1 font-mono opacity-80">{selectedStatus.installHint}</div>
            )}
          </div>
        )}
        <HarnessAuthHint status={selectedStatus} />
      </div>

      <div className="space-y-1">
        <label className="text-muted-foreground">Mode</label>
        <Select value={mode} onChange={(e) => setMode(e.target.value)} className="h-8">
          {modes.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1">
          <label className="text-muted-foreground">Model</label>
          <Select value={model} onChange={(e) => setModel(e.target.value)} className="h-8">
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
            disabled={efforts.length === 0}
            className="h-8"
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
    </>
  );
}

/**
 * `createTask` → `startTask`, with a delete-rollback on start failure so a
 * retry doesn't trip the taken-branch guard on the row this call just
 * created. Mirrors `ResolveConflictsDialog`'s inline `submit()` body
 * (lines 194-207) exactly, including both error message shapes. Resolves to
 * the created task's id.
 */
export async function createAndStartTask(input: Parameters<typeof api.createTask>[0]): Promise<string> {
  const created = await api.createTask(input);
  try {
    await api.startTask(created.id);
  } catch (startErr) {
    const detail = startErr instanceof Error ? startErr.message : String(startErr);
    const rolledBack = await api.deleteTask(created.id).then(() => true, () => false);
    throw new Error(
      rolledBack
        ? `couldn't start the task: ${detail}`
        : `task was created but couldn't start (${detail}) — find it on the board and start it manually`,
    );
  }
  return created.id;
}
