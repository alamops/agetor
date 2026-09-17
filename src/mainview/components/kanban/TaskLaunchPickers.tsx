import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api, type AgentModelMap } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { discoveredEffortsFor, mergeModelOptions } from "../../../shared/model-options.ts";
import {
  AGENT_OPTIONS,
  CATALOG_SCOPED_KINDS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  cursorModelIdCoveredByCatalog,
  cursorModelSupportsFast,
  cursorModelSupportsMaxMode,
  defaultModeFor,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentOption,
  type AgentProfile,
  type AgentStatus,
  type Harness,
} from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";
import { AgentProfileCard } from "./AgentProfileCard";
import { AgentProfilePicker } from "./AgentProfilePicker";
import { HarnessAuthHint } from "./HarnessAuthHint";

const initialMode = (kind: AgentKind) => defaultModeFor(kind);

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
  /** Cursor-only "fast variant" toggle — auto-clears to `false` whenever
   *  `fastAvailable` goes false (kind/model/effort change), mirroring
   *  `NewTaskForm`'s identical rule. */
  fast: boolean;
  /** Cursor-only "Max Mode" (extra context) toggle — same auto-clear rule
   *  as `fast`, keyed on `maxModeAvailable`. */
  maxMode: boolean;
  setFast: (fast: boolean) => void;
  setMaxMode: (maxMode: boolean) => void;
  fastAvailable: boolean;
  maxModeAvailable: boolean;
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
   *  mirroring `ResolveConflictsDialog`'s inline `setPreference` calls. A
   *  no-op while a profile is selected (`agentProfileId !== null`) — the
   *  launch didn't come from manually-picked values, so there's nothing of
   *  the user's own intent to remember. */
  rememberPicks: () => void;
  /** Selected {@link AgentProfile} id, or `null` for the manual
   *  harness/mode/model/effort block (`useTaskLaunch`'s "one selection" —
   *  plan D5). */
  agentProfileId: string | null;
  setAgentProfileId: (id: string | null) => void;
  /** Live agent profiles — empty when `opts.withProfiles === false` (the
   *  profile form itself doesn't need its own picker's list). */
  profiles: AgentProfile[];
  /** `profiles.find(p => p.id === agentProfileId)`, or `null`. */
  selectedProfile: AgentProfile | null;
  /** Refetch `profiles` (e.g. after a Settings → Agents create/edit/delete
   *  elsewhere touches the module-cached list). */
  refreshProfiles: () => Promise<void>;
  /** The harness kind a launch will actually run under — the selected
   *  profile's harness kind when one is selected (resolved through
   *  `harnesses`, falling back to `"claude-code"` if that harness is gone),
   *  else the manually-picked `kind`. Client-side prompt-budget pre-checks
   *  (`promptByteOverage`) must use this, not the bare `kind`. */
  effectiveKind: AgentKind;
  /** The harness id a launch will actually run under — mirrors
   *  `effectiveKind`. */
  effectiveAgent: string;
  /** `agents.find(a => a.harnessId === effectiveAgent)` — the availability/
   *  auth status for whichever harness a launch will actually run under.
   *  Consumers must gate submit and render the availability/auth hint off
   *  THIS, not `selectedStatus` (which only ever reflects the manual
   *  picker and goes stale — silently — once a profile is selected and
   *  hides that block). */
  effectiveStatus: AgentStatus | undefined;
  /** Apply a batch of values onto the manual picker state — used by the
   *  Agents Settings edit form to seed the picker from the profile being
   *  edited. Applies `agent` first via the same reset-to-kind-defaults path
   *  as `switchAgent`, then overrides whichever of the remaining fields are
   *  present (fields omitted from `values` are left untouched). */
  seed: (values: Partial<{
    agent: string;
    mode: string;
    model: string;
    effort: string | null;
    fast: boolean;
    maxMode: boolean;
  }>) => void;
}

export function useTaskLaunch(
  open: boolean,
  opts?: {
    withProfiles?: boolean;
    /**
     * Seed values for the manual harness/mode/model/effort/fast/maxMode
     * block, resolved by the open-effect INSTEAD OF `prefs.defaultHarness` /
     * `lastMode:<kind>` / `lastModel:<kind>` / `lastEffort:<kind>` — for a
     * caller seeding the picker from an already-fully-formed object (e.g.
     * Settings → Agents editing an existing `AgentProfile`), where falling
     * back to the user's ambient last-picked defaults would silently
     * overwrite the very thing being edited.
     *
     * Fixes a real race (phase 8 finding F2): the open-effect below used to
     * ALWAYS resolve from prefs, and `AgentProfilesSection` compensated with
     * its own second effect that re-seeded from the profile afterward,
     * gated on `!launch.loading`. That guard didn't work: `loading` starts
     * `false`, and on the render where `open` flips true, BOTH effects run
     * in the same commit (this hook's fetch effect first, since it's
     * declared earlier in the calling component's hook-call order) — the
     * fetch effect's `setLoading(true)` doesn't take effect until the next
     * render, so the seeding effect still reads the stale `loading === false`
     * and reseeds immediately. Its seed then loses the race against this
     * effect's own async `Promise.all(...).then(...)`, which resolves later
     * and overwrites the profile's values with `prefs.defaultHarness`/
     * `last*:<kind>`. Passing `initial` in here instead means there is only
     * ONE place that ever resolves the "what should the picker show" answer
     * for an edit — inside this same `.then()`, atomically with the harness
     * fetch it depends on to resolve the profile's harness kind — so there
     * is nothing left to race.
     */
    initial?: {
      agent: string;
      mode: string | null;
      model: string;
      effort: string | null;
      fast: boolean;
      maxMode: boolean;
    };
  },
): TaskLaunch {
  const withProfiles = opts?.withProfiles !== false;
  const initial = opts?.initial;
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModelMap>({ "claude-code": [], codex: [], cursor: [], gemini: [], fx: [] });
  const [harnessModels, setHarnessModels] = useState<Record<string, { id: string; label?: string }[]>>({});
  // Seeded from `open` (not a bare `false`) so a hook whose owning component
  // mounts already-open is truthful on its very first render instead of
  // reporting "not loading" for one paint before the effect below flips it —
  // the same class of desync as the seed race this option fixes.
  const [loading, setLoading] = useState(open);
  const [loadError, setLoadError] = useState<string | null>(null);

  const availableHarnesses = useMemo(() => harnesses.filter((h) => h.enabled), [harnesses]);

  // When `initial` is supplied (the Settings edit form), seed the six launch
  // values from it SYNCHRONOUSLY so the very first paint already shows the
  // record being edited — the open-effect below re-applies the same values
  // once harnesses have loaded (resolving the kind properly). Without this
  // the form flashed the claude-code defaults until the harness fetch
  // resolved, which under load lasted long enough to read as "the edit form
  // shows the wrong model". `initial.mode === null` can't be resolved to a
  // kind default before harnesses load unless the id IS a built-in kind
  // name; the effect fixes that up, and it's only a placeholder until then.
  const [agent, setAgent] = useState<string>(initial?.agent ?? "claude-code");
  const selectedHarness = useMemo(
    () => harnesses.find((h) => h.id === agent) ?? null,
    [harnesses, agent],
  );
  const kind: AgentKind = selectedHarness?.kind ?? "claude-code";
  const selectedStatus = agents.find((a) => a.harnessId === agent);

  const [mode, setMode] = useState<string>(() => {
    if (!initial) return initialMode("claude-code");
    if (initial.mode) return initial.mode;
    const guessKind = (Object.keys(AGENT_OPTIONS) as AgentKind[]).includes(initial.agent as AgentKind)
      ? (initial.agent as AgentKind)
      : "claude-code";
    return initialMode(guessKind);
  });
  const [model, setModel] = useState<string>(initial?.model ?? DEFAULT_MODEL["claude-code"]);
  const [effort, setEffort] = useState<string | null>(initial ? initial.effort : DEFAULT_EFFORT["claude-code"]);
  const [fast, setFast] = useState(initial?.fast ?? false);
  const [maxMode, setMaxMode] = useState(initial?.maxMode ?? false);

  const [agentProfileId, setAgentProfileId] = useState<string | null>(null);
  const { profiles: fetchedProfiles, refresh: refreshProfiles } = useAgentProfiles({
    enabled: open && withProfiles,
  });
  const profiles = withProfiles ? fetchedProfiles : [];
  const selectedProfile = agentProfileId ? (profiles.find((p) => p.id === agentProfileId) ?? null) : null;

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

        if (initial) {
          // See `initial`'s doc comment above: resolve straight from the
          // caller-provided values instead of `prefs`. Deliberately do NOT
          // require `initial.agent` to be a member of `enabled` — a profile
          // can reference a harness that's since been disabled or deleted,
          // and the form must keep showing exactly what the profile
          // references (the picker/card renders its own disabled/missing
          // marker) rather than silently swapping in a different harness.
          const nextAgent = initial.agent;
          const nextHarness = payload.harnesses.find((h) => h.id === nextAgent);
          const nextKind: AgentKind = nextHarness?.kind ?? "claude-code";
          setAgent(nextAgent);
          setMode(initial.mode ?? initialMode(nextKind));
          setModel(initial.model);
          setEffort(initial.effort);
          setFast(initial.fast);
          setMaxMode(initial.maxMode);
          return;
        }

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
        // Mirror the `models` memo below exactly (curated/discovered/scoped/
        // loggedIn inputs) rather than reading the raw discovered list, so
        // effort discovery goes through the same rule-7 logged-out distrust
        // the Model picker gets — rule 8 stays a single source.
        const nextLoggedIn = payload.statuses.find((a) => a.harnessId === nextAgent)?.loggedIn ?? null;
        const nextDiscovered = (harnessModelPayload.byHarness[nextAgent] ?? models[nextKind] ?? [])
          .filter((m) => nextKind !== "cursor" || !cursorModelIdCoveredByCatalog(m.id));
        const nextModelRows = mergeModelOptions({
          curated: AGENT_OPTIONS[nextKind].models,
          discovered: nextDiscovered,
          selected: resolvedModel,
          scoped: CATALOG_SCOPED_KINDS.has(nextKind),
          loggedIn: nextLoggedIn,
        });
        const supportedEff = supportedEfforts(
          nextKind,
          resolvedModel,
          discoveredEffortsFor(nextModelRows, resolvedModel),
        );
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
  // Discovered-wins, no retain logic — mirrors NewTaskForm: there's no prior
  // intent to preserve for a task that doesn't exist yet. Reads from `models`
  // (the merged rows above), not the raw `harnessModels`/`agentModels` maps,
  // so a logged-out harness's discovery is distrusted here too (rule 7).
  const efforts = supportedEfforts(kind, model, discoveredEffortsFor(models, model));
  const effortsKey = efforts.map((o) => o.id).join(",");
  const maxModeAvailable = kind === "cursor" && cursorModelSupportsMaxMode(model);
  const fastAvailable = kind === "cursor" && cursorModelSupportsFast(model, effort);

  useEffect(() => {
    if (efforts.length === 0) {
      if (effort !== null) setEffort(null);
      return;
    }
    if (effort !== null && efforts.some((e) => e.id === effort)) return;
    const fallback = efforts.some((e) => e.id === DEFAULT_EFFORT[kind]) ? DEFAULT_EFFORT[kind] : efforts[0]!.id;
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

  const seed = (values: Partial<{
    agent: string;
    mode: string;
    model: string;
    effort: string | null;
    fast: boolean;
    maxMode: boolean;
  }>) => {
    if (values.agent !== undefined) switchAgent(values.agent);
    if (values.mode !== undefined) setMode(values.mode);
    if (values.model !== undefined) setModel(values.model);
    if (values.effort !== undefined) setEffort(values.effort);
    if (values.fast !== undefined) setFast(values.fast);
    if (values.maxMode !== undefined) setMaxMode(values.maxMode);
  };

  const rememberPicks = () => {
    // A profile-backed launch didn't come from manually-picked values —
    // nothing of the user's own intent to remember (see the `TaskLaunch`
    // doc comment).
    if (agentProfileId) return;
    void api.setPreference(`lastMode:${kind}`, mode).catch(() => {});
    void api.setPreference(`lastModel:${kind}`, model).catch(() => {});
    if (effort !== null) void api.setPreference(`lastEffort:${kind}`, effort).catch(() => {});
  };

  const effectiveAgent = selectedProfile ? selectedProfile.harness : agent;
  const effectiveKind: AgentKind = selectedProfile
    ? (harnesses.find((h) => h.id === selectedProfile.harness)?.kind ?? "claude-code")
    : kind;
  // `AgentStatus` for whichever harness a launch will ACTUALLY run under —
  // the selected profile's harness when one is picked, else the manually-
  // picked `agent`. Callers must gate submit / render availability+auth
  // hints off this, not the bare `selectedStatus` (which stays pinned to
  // the manual picker and is invisible once a profile hides that block) —
  // finding F2-3.
  const effectiveStatus = agents.find((a) => a.harnessId === effectiveAgent);

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
    fast,
    maxMode,
    setFast,
    setMaxMode,
    fastAvailable,
    maxModeAvailable,
    models,
    modes,
    efforts,
    setMode,
    setModel,
    setEffort,
    switchAgent,
    rememberPicks,
    agentProfileId,
    setAgentProfileId,
    profiles,
    selectedProfile,
    refreshProfiles,
    effectiveKind,
    effectiveAgent,
    effectiveStatus,
    seed,
  };
}

/** Harness grid + Mode select + Model/Effort grid — the picker markup shared
 *  between `ResolveConflictsDialog` and `CreateTaskFromIssueDialog` (and, via
 *  `hideProfilePicker`, the Agents Settings form itself). Renders nothing
 *  about loading/error states; the consumer owns those around it (they
 *  differ per dialog — e.g. the issue dialog also waits on a thread fetch).
 *
 *  Renders an `<AgentProfilePicker>` above the manual controls unless
 *  `hideProfilePicker` is set. Once `launch.agentProfileId` names a profile,
 *  the harness grid / mode / model / effort / fast / max-mode controls are
 *  replaced by a single `<AgentProfileCard variant="selected">` — the
 *  launch form's "one selection" rule (plan D5). */
export function TaskLaunchPickers({
  launch,
  hideProfilePicker,
  onManageProfiles,
}: {
  launch: TaskLaunch;
  hideProfilePicker?: boolean;
  onManageProfiles?: () => void;
}) {
  const {
    harnesses,
    availableHarnesses,
    agents,
    agent,
    selectedStatus,
    effectiveStatus,
    mode,
    modes,
    model,
    models,
    effort,
    efforts,
    fast,
    maxMode,
    setFast,
    setMaxMode,
    fastAvailable,
    maxModeAvailable,
    switchAgent,
    setMode,
    setModel,
    setEffort,
    agentProfileId,
    setAgentProfileId,
    profiles,
    selectedProfile,
    kind,
  } = launch;

  return (
    <>
      {!hideProfilePicker && (
        <div className="space-y-1">
          <label className="text-muted-foreground">Agent</label>
          <AgentProfilePicker
            value={agentProfileId}
            onChange={setAgentProfileId}
            profiles={profiles}
            harnesses={harnesses}
            onManage={onManageProfiles}
          />
        </div>
      )}

      {selectedProfile ? (
        <>
          <AgentProfileCard profile={selectedProfile} harnesses={harnesses} variant="selected" />
          {/* Same availability/auth hint the manual branch below shows,
           *  but keyed off `effectiveStatus` (the PROFILE's harness) — a
           *  profile whose harness is unavailable or logged out must not
           *  block Start with no visible reason (finding F2-3). */}
          {effectiveStatus && !effectiveStatus.available && (
            <div
              data-testid="launch-agent-unavailable-hint"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground"
            >
              <div className="font-medium">{effectiveStatus.reason}</div>
              {effectiveStatus.installHint && (
                <div className="mt-1 font-mono opacity-80">{effectiveStatus.installHint}</div>
              )}
            </div>
          )}
          <HarnessAuthHint status={effectiveStatus} />
        </>
      ) : (
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
              <div
                data-testid="launch-agent-unavailable-hint"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive-foreground"
              >
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

          {kind === "cursor" && (maxModeAvailable || maxMode || fastAvailable || fast) && (
            <div className="grid grid-cols-2 gap-2">
              {(maxModeAvailable || maxMode) && (
                <label
                  data-testid="launch-max-mode-toggle"
                  className="flex h-8 items-center justify-between rounded-md border border-border px-2 text-xs"
                >
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
                <label
                  data-testid="launch-fast-toggle"
                  className="flex h-8 items-center justify-between rounded-md border border-border px-2 text-xs"
                >
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
        </>
      )}
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
