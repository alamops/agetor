/**
 * The ONE launch state of every task-launch surface (docs/architecture/task-launch-ui.md):
 * harness / mode / model / effort / speed / max-mode selection, the agent
 * profile and pipeline "one selection", the remembered per-kind picks, the
 * model catalog and the pre-submit gates. The New Task panel, the issue and PR
 * dialogs, Clone's "Explain this repository" and Settings → Agents all render
 * from this hook; the pure decision rules live in `lib/launch-state.ts`.
 *
 * Two data modes, one behavior:
 *  - **source mode** (`opts.source`): the panel feeds App's live harness,
 *    status, stack and model data (15 s poll + SSE-driven catalog refetch).
 *    Nothing is fetched here except the remembered preferences, once per mount.
 *  - **self-fetch mode** (no source): a dialog fetches harnesses, statuses,
 *    stacks, catalogs and preferences when it opens, and re-seeds the per-kind
 *    cache from the preferences on every open.
 *
 * Both modes share the per-kind pick cache, the pending-seed handling for a
 * remembered model only the CLI catalog carries, and the fallback effects.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AgentModelMap } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { usePipelines } from "@/lib/pipelines";
import { resolvePipelineLaunch, type PipelineLaunchState } from "@/lib/pipeline-launch";
import { stackBackupCanServe } from "@/lib/stack-launch";
import {
  codeVariants as codeVariantsFor,
  harnessStatusTone,
  initialPickCache,
  primaryModeOf,
  rememberPickPrefs,
  resolveSeedOutcome,
  seedPickCache,
  switchPicks,
  type PendingSeeds,
  type PickCache,
  type StatusTone,
} from "@/lib/launch-state";
import type { DiscoveredModel, ModelOption } from "../../shared/model-options.ts";
import {
  buildModelOptions,
  effortOptionsFor,
  resolveDefaultEffort,
  speedOptionsFor,
  speedTiersKnown,
} from "../../shared/model-catalog.ts";
import {
  AGENT_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  cursorModelSupportsMaxMode,
  defaultModeFor,
  supportedModes,
  type AgentKind,
  type AgentOption,
  type AgentProfile,
  type AgentStatus,
  type Harness,
  type HarnessStack,
  type Pipeline,
  type Speed,
} from "../../shared/types.ts";

const initialMode = (kind: AgentKind) => defaultModeFor(kind);

/** Live harness and catalog data a surface that already has it (the New Task
 *  panel, fed by App) hands the hook instead of letting it fetch. */
export interface LaunchSource {
  harnesses: Harness[];
  agents: AgentStatus[];
  stacks: HarnessStack[];
  agentModels: AgentModelMap;
  harnessModels: Record<string, DiscoveredModel[]>;
  /** Force a fresh discovery probe for one harness, then refetch the maps. */
  refreshModels: (harnessId?: string) => Promise<void>;
}

/**
 * The launch state every task-launch surface shares: harness / mode / model /
 * effort selection plus the data that backs it (see the file header).
 */
export interface TaskLaunch {
  loading: boolean;
  loadError: string | null;
  harnesses: Harness[];
  /** Harness account stacks, for the `n/m` position chip next to each
   *  account (same chip as the New Task form). */
  stacks: HarnessStack[];
  availableHarnesses: Harness[];
  agents: AgentStatus[];
  agentModels: AgentModelMap;
  /** Per-harness model catalog (fx account-scoped, keyed by harness id) —
   *  preferred over `agentModels`' kind-level list when it has an entry for
   *  the selected harness, mirroring `NewTaskForm`'s `harnessModels` prop. */
  harnessModels: Record<string, DiscoveredModel[]>;
  agent: string;
  kind: AgentKind;
  selectedStatus: AgentStatus | undefined;
  mode: string;
  model: string;
  effort: string | null;
  /** Speed tier (`off | fast | ultrafast`). Cursor auto-clears it to
   *  `"off"` whenever the model/effort pair has no Fast variant (and every
   *  kind but fx whenever the tier isn't offered); fx resets it only on a
   *  user model change whose new model's tiers are known and exclude it
   *  (see `setModel`) — never on load, since discovery may not be ready. */
  speed: Speed;
  /** Cursor-only "Max Mode" (extra context) toggle — auto-clears to
   *  `false` whenever `maxModeAvailable` goes false. */
  maxMode: boolean;
  setSpeed: (speed: Speed) => void;
  setMaxMode: (maxMode: boolean) => void;
  /** The tiers the current kind/model/effort offers (`supportedSpeeds`, fed
   *  the selected model's merged option so fx's discovery flags count). */
  speedOptions: Speed[];
  maxModeAvailable: boolean;
  models: ModelOption[];
  modes: AgentOption[];
  efforts: AgentOption[];
  setMode: (mode: string) => void;
  /** A user model pick. For fx it also resets `speed` to `"off"` when the
   *  new model's tiers are known (discovery non-empty and trusted) and
   *  don't include the current tier. */
  setModel: (model: string) => void;
  setEffort: (effort: string | null) => void;
  /** Switches the selected harness. The current picks are stashed under the
   *  current kind and the next kind's last picks are restored (a kind never
   *  visited starts on its defaults), so codex → claude → codex keeps codex's
   *  picks. Two accounts of one kind share one slot. */
  switchAgent: (nextId: string) => void;
  /** Persists the current picks as the five `last*:<kind>` preferences
   *  (`rememberPickPrefs`) and updates the in-memory per-kind cache — call this
   *  right after a successful launch. A no-op while a profile or pipeline is
   *  selected: the launch didn't come from manually-picked values, so there's
   *  nothing of the user's own intent to remember. */
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
   *  picker and goes stale — silently — once a profile or pipeline is
   *  selected and hides that block). */
  effectiveStatus: AgentStatus | undefined;
  /** True when the account a launch will run under is in a stack with a
   *  usable backup: the core moves the run there instead of refusing it, so
   *  an unavailable, disabled or logged-out `effectiveStatus` is not a block. */
  effectiveStackFallback: boolean;
  /** Whether the launch identity can start right now: its CLI is available,
   *  or a stack backup can serve it (`effectiveStackFallback`). Gate submit
   *  on this, not on `effectiveStatus.available` alone. */
  effectiveLaunchable: boolean;
  /** `true` only when the hook was created with `{ withPipelines: true }` —
   *  every pipeline field below is inert (`[]`/`null`/`false`) otherwise, so
   *  the Agent Settings form and `CloneProjectDialog` render exactly the same
   *  DOM they always have. */
  withPipelines: boolean;
  /** Module-cached pipeline list (see `usePipelines`) — empty while not
   *  opted in. */
  pipelines: Pipeline[];
  /** `true` once a pipeline fetch has succeeded at least once. */
  pipelinesLoaded: boolean;
  /** A pipeline fetch is in flight with no cached list to show yet. */
  pipelinesLoading: boolean;
  /** The last failed pipeline fetch, if any (a stale cache may still be
   *  shown alongside it — see `usePipelines`). */
  pipelinesError: string | null;
  /** Selected pipeline id, or `null` for "no pipeline". Mutually exclusive
   *  with `agentProfileId`: a non-null pick through either setter clears the
   *  other (the hook's one-selection invariant). */
  pipelineId: string | null;
  setPipelineId: (id: string | null) => void;
  /** `pipelines.find(p => p.id === pipelineId)`, or `null`. */
  selectedPipeline: Pipeline | null;
  /** Result of the pre-submit runnability check for the selected pipeline
   *  (`resolvePipelineLaunch`) — `no-pipeline` when none is selected. */
  pipelineState: PipelineLaunchState;
  /** The user-facing reason the selected pipeline can't launch yet, mirroring
   *  the server's own wording — `null` while ready/checking/none selected. */
  pipelineProblem: string | null;
  /** `true` when it's safe to submit: either no pipeline is selected, or the
   *  selected one resolved to `ready`. Both dialogs' `canSubmit` includes
   *  this. */
  pipelineReady: boolean;
  /** The selected pipeline's start-step profile (also returned while
   *  blocked) — what the summary's "starts with" line names. */
  pipelineStartProfile: AgentProfile | null;
  /** The harness kind the prompt-byte overage check should key on. `null`
   *  while a pipeline is selected but its start step's profile/harness can't
   *  be resolved (nothing to check — the inline problem explains why). */
  overageKind: AgentKind | null;
  /** Display label matching {@link overageKind} — the start-step harness's
   *  label for a pipeline, else the effective harness's label. */
  overageLabel: string;
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
    speed: Speed;
    maxMode: boolean;
  }>) => void;
  /** Force a fresh discovery probe for the selected harness and refetch the
   *  model catalogs (the ↻ button). One-shot: no poll, no stream. */
  refreshModels: () => Promise<void>;
  /** True while {@link refreshModels} is in flight. */
  refreshingModels: boolean;
  /** `true` once an agent-profile fetch has succeeded at least once. */
  profilesLoaded: boolean;
  /** Code | Plan bucket of the current `mode`. */
  primaryMode: "code" | "plan";
  /** The code-bucket mode variants the current kind/model offers. */
  codeVariants: AgentOption[];
  /** The status-dot tone of a harness row (`unknown` until its probe lands). */
  statusTone: (harnessId: string) => StatusTone;
}

export function useTaskLaunch(
  open: boolean,
  opts?: {
    withProfiles?: boolean;
    /**
     * Opt into the pipeline section: loads the module-cached pipeline list,
     * adds `pipelineId`/`setPipelineId` with the same one-selection rule as
     * the agent profile, runs the pre-submit runnability check, and reports
     * the start-step profile as the effective launch identity.
     */
    withPipelines?: boolean;
    /**
     * Seed values for the manual harness/mode/model/effort/speed/maxMode
     * block, resolved INSTEAD OF `prefs.defaultHarness` / `last*:<kind>` — for
     * a caller seeding the picker from an already-fully-formed object (Settings
     * → Agents editing an existing `AgentProfile`), where falling back to the
     * user's ambient last-picked defaults would silently overwrite the very
     * thing being edited. Resolved inside the same `.then()` as the harness
     * fetch it depends on, so there is nothing left to race (phase 8 F2). An
     * `initial` launch never applies a pending model seed or the default-model
     * rule: the profile's own model stays exactly as stored.
     */
    initial?: {
      agent: string;
      mode: string | null;
      model: string;
      effort: string | null;
      speed: Speed;
      maxMode: boolean;
    };
    /** Live data from the caller (the New Task panel): no fetch except the
     *  remembered preferences, and ↻ delegates to `source.refreshModels`. */
    source?: LaunchSource;
  },
): TaskLaunch {
  const withProfiles = opts?.withProfiles !== false;
  const withPipelines = opts?.withPipelines === true;
  const initial = opts?.initial;
  const source = opts?.source;

  // Self-fetched data (unused in source mode).
  const [fetchedHarnesses, setFetchedHarnesses] = useState<Harness[]>([]);
  const [fetchedStacks, setFetchedStacks] = useState<HarnessStack[]>([]);
  const [fetchedAgents, setFetchedAgents] = useState<AgentStatus[]>([]);
  const [fetchedAgentModels, setFetchedAgentModels] = useState<AgentModelMap>({
    "claude-code": [], codex: [], cursor: [], gemini: [], antigravity: [], fx: [], opencode: [], copilot: [],
  });
  const [fetchedHarnessModels, setFetchedHarnessModels] = useState<Record<string, DiscoveredModel[]>>({});
  const harnesses = source ? source.harnesses : fetchedHarnesses;
  const stacks = source ? source.stacks : fetchedStacks;
  const agents = source ? source.agents : fetchedAgents;
  const agentModels = source ? source.agentModels : fetchedAgentModels;
  const harnessModels = source ? source.harnessModels : fetchedHarnessModels;

  // Seeded from `open` (not a bare `false`) so a hook whose owning component
  // mounts already-open is truthful on its very first render. Source mode never loads.
  const [loading, setLoading] = useState(!source && open);
  const [loadError, setLoadError] = useState<string | null>(null);

  const availableHarnesses = useMemo(() => harnesses.filter((h) => h.enabled), [harnesses]);

  // With `initial`, seed the six launch values SYNCHRONOUSLY so the very first
  // paint already shows the record being edited; the fetch effect re-applies
  // the same values once harnesses have loaded (resolving the kind properly).
  const [agent, setAgent] = useState<string>(initial?.agent ?? "claude-code");
  const selectedHarness = useMemo(() => harnesses.find((h) => h.id === agent) ?? null, [harnesses, agent]);
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
  // `null` is reserved for the "model doesn't accept an effort" case.
  const [effort, setEffort] = useState<string | null>(initial ? initial.effort : DEFAULT_EFFORT["claude-code"]);
  const [speed, setSpeed] = useState<Speed>(initial?.speed ?? "off");
  const [maxMode, setMaxMode] = useState(initial?.maxMode ?? false);

  // Latest kind, for async seeds that resolve after the user already switched.
  const kindRef = useRef(kind);
  kindRef.current = kind;
  // Per-kind picks, so switching harnesses (or aliases of one kind) keeps the
  // prior picks. Read and written synchronously — no effect, so no transient
  // wrong-slot writes on render commit.
  const pickCache = useRef<PickCache>(initialPickCache());
  // A remembered `lastModel:<kind>` the curated list lacks, held until
  // discovery shows it is real, and the kinds whose model the user already
  // chose by hand this session.
  const pendingSeed = useRef<PendingSeeds>({});
  const modelTouched = useRef<Partial<Record<AgentKind, boolean>>>({});
  // True once the remembered picks have been read (or failed to read): the
  // pending-seed effect re-runs on it, because the catalog can land BEFORE the
  // preferences do.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // Bumped every time a self-fetching dialog re-seeds the per-kind cache from the
  // remembered picks (i.e. on EVERY open). `prefsLoaded` stays true across opens and
  // the catalog ids rarely change, so without it the pending-seed effect below would
  // not re-run on a second open and the remembered model/effort would be replaced
  // by the kind's default (and then overwritten by `rememberPicks` on Run).
  const [seedGeneration, setSeedGeneration] = useState(0);
  const prefsRef = useRef<Record<string, string | undefined>>({});
  const defaultHarnessApplied = useRef(false);

  const [agentProfileId, setAgentProfileIdState] = useState<string | null>(null);
  // A pipeline and an agent profile are two ways to name ONE launch identity
  // — picking either clears the other (the hook's one-selection invariant).
  const [pipelineId, setPipelineIdState] = useState<string | null>(null);
  const setAgentProfileId = useCallback((id: string | null) => {
    setAgentProfileIdState(id);
    if (id !== null) setPipelineIdState(null);
  }, []);
  const setPipelineId = useCallback((id: string | null) => {
    setPipelineIdState(id);
    if (id !== null) setAgentProfileIdState(null);
  }, []);
  // A pipeline's preflight needs the profile list even on a surface that
  // hides the Agent picker (`withProfiles: false`).
  const {
    profiles: fetchedProfiles,
    loaded: profilesLoaded,
    error: profilesError,
    refresh: refreshProfiles,
  } = useAgentProfiles({ enabled: open && (withProfiles || withPipelines) });
  const profiles = withProfiles ? fetchedProfiles : [];
  const selectedProfile = agentProfileId ? (profiles.find((p) => p.id === agentProfileId) ?? null) : null;
  // Module-cached (App mounts it at boot) — a Git dialog that opens later
  // reads the resolved list instantly.
  const {
    pipelines,
    loaded: pipelinesLoaded,
    loading: pipelinesLoading,
    error: pipelinesError,
  } = usePipelines({ enabled: open && withPipelines });
  const selectedPipeline = pipelineId ? (pipelines.find((p) => p.id === pipelineId) ?? null) : null;

  // Every open starts with no pipeline selected — there's deliberately no
  // "last used pipeline" preference (owner D5), matching New Task's post-submit reset.
  useEffect(() => {
    if (!open) return;
    setPipelineIdState(null);
  }, [open]);

  // Stale-selection guards: clear a selected pipeline / profile that no longer
  // exists, but only once its list has actually loaded — never while the module
  // cache is still empty on the very first fetch.
  useEffect(() => {
    if (pipelineId !== null && pipelinesLoaded && !pipelines.some((p) => p.id === pipelineId)) {
      setPipelineIdState(null);
    }
  }, [pipelines, pipelineId, pipelinesLoaded]);
  useEffect(() => {
    if (agentProfileId !== null && withProfiles && profilesLoaded && !fetchedProfiles.some((p) => p.id === agentProfileId)) {
      setAgentProfileIdState(null);
    }
  }, [fetchedProfiles, agentProfileId, profilesLoaded, withProfiles]);

  // Pre-submit runnability (server-authoritative, advisory here): mirrors the
  // graph/profile/harness gates `createTask` and `startTask` would apply, so a
  // surface can explain a bad pipeline BEFORE it creates and rolls back a row.
  const pipelineLaunch = useMemo(
    () =>
      resolvePipelineLaunch({
        graph: selectedPipeline?.graph ?? null,
        profiles: fetchedProfiles,
        profilesLoaded,
        profilesError,
        harnesses,
        agents,
        stacks,
      }),
    [selectedPipeline, fetchedProfiles, profilesLoaded, profilesError, harnesses, agents, stacks],
  );

  const applyPicks = useCallback((p: { mode: string; model: string; effort: string | null; speed: Speed; maxMode: boolean }) => {
    setMode(p.mode);
    setModel(p.model);
    setEffort(p.effort);
    setSpeed(p.speed);
    setMaxMode(p.maxMode);
  }, []);

  // SOURCE MODE: read the remembered picks once per mount and seed the
  // per-kind cache from them; the active kind's picks are applied straight away.
  useEffect(() => {
    if (!open || !source || initial) return;
    let cancelled = false;
    void api
      .listPreferences()
      .then((prefs) => {
        if (cancelled) return;
        prefsRef.current = prefs;
        const seeded = seedPickCache(pickCache.current, prefs);
        pickCache.current = seeded.cache;
        pendingSeed.current = seeded.pending;
        applyPicks(seeded.cache[kindRef.current]);
        setPrefsLoaded(true);
      })
      .catch(() => {
        /* preferences failure is non-fatal — defaults stay */
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // Once per mount: `open` never flips for the always-mounted panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!source]);

  // SOURCE MODE: `defaultHarness` applies once, when the first non-empty enabled
  // list and the preferences are both in; and when the selected harness later
  // disappears (deleted or disabled), fall back to the first available one.
  useEffect(() => {
    if (!source || initial || availableHarnesses.length === 0) return;
    if (!defaultHarnessApplied.current) {
      if (!prefsLoaded) return;
      defaultHarnessApplied.current = true;
      const want = prefsRef.current.defaultHarness;
      const target =
        want && availableHarnesses.some((h) => h.id === want)
          ? want
          : availableHarnesses.some((h) => h.id === agent)
            ? agent
            : availableHarnesses[0]!.id;
      if (target !== agent) switchAgent(target);
      return;
    }
    if (!availableHarnesses.some((h) => h.id === agent)) switchAgent(availableHarnesses[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableHarnesses, agent, prefsLoaded]);

  // SELF-FETCH MODE: fetch harness data on open — scoped to whichever dialog
  // mounts this hook (mounted unconditionally, but fetching only while open).
  useEffect(() => {
    if (!open || source) return;
    setLoadError(null);
    setLoading(true);
    let cancelled = false;
    Promise.all([api.listHarnesses(), api.listAgentModels(), api.listHarnessModels(), api.listPreferences()])
      .then(([payload, models, harnessModelPayload, prefs]) => {
        if (cancelled) return;
        setFetchedHarnesses(payload.harnesses);
        setFetchedStacks(payload.stacks ?? []);
        setFetchedAgents(payload.statuses);
        setFetchedAgentModels(models);
        setFetchedHarnessModels(harnessModelPayload.byHarness);
        const enabled = payload.harnesses.filter((h) => h.enabled);

        if (initial) {
          // Resolve straight from the caller-provided values instead of `prefs`.
          // Deliberately do NOT require `initial.agent` to be a member of
          // `enabled` — a profile can reference a harness that's since been
          // disabled or deleted, and the form must keep showing exactly what the
          // profile references rather than silently swapping in another harness.
          const nextHarness = payload.harnesses.find((h) => h.id === initial.agent);
          const nextKind: AgentKind = nextHarness?.kind ?? "claude-code";
          setAgent(initial.agent);
          applyPicks({
            mode: initial.mode ?? initialMode(nextKind),
            model: initial.model,
            effort: initial.effort,
            speed: initial.speed,
            maxMode: initial.maxMode,
          });
          return;
        }

        // Re-seed the per-kind cache from the remembered picks on EVERY open.
        prefsRef.current = prefs;
        const seeded = seedPickCache(initialPickCache(), prefs);
        pickCache.current = seeded.cache;
        pendingSeed.current = seeded.pending;
        modelTouched.current = {};
        const want = prefs.defaultHarness;
        const nextAgent =
          want && enabled.some((h) => h.id === want)
            ? want
            : enabled.some((h) => h.id === agent)
              ? agent
              : (enabled[0]?.id ?? "claude-code");
        const nextKind: AgentKind = enabled.find((h) => h.id === nextAgent)?.kind ?? "claude-code";
        setAgent(nextAgent);
        applyPicks(seeded.cache[nextKind]);
        setPrefsLoaded(true);
        setSeedGeneration((g) => g + 1);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const modes = supportedModes(kind, model);
  // Merge the curated list with whatever this harness's CLI catalog discovery
  // surfaced, per the shared rules in `mergeModelOptions`. Prefer the
  // per-harness catalog (keyed by harness id — distinguishes a second `fx-2`
  // account from the built-in fx harness) over the kind-level map, which only
  // exists as a fallback for an older daemon predating `GET /agent-models/harnesses`.
  const discoveredForAgent = harnessModels[agent] ?? agentModels[kind] ?? [];
  const loggedIn = selectedStatus?.loggedIn ?? null;
  const models = useMemo(
    () => buildModelOptions(kind, { discovered: discoveredForAgent, selected: model, loggedIn }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [harnessModels, agentModels, agent, kind, model, loggedIn],
  );
  const modelsKey = models.filter((m) => !m.unlisted).map((m) => m.id).join(",");
  // Discovered-wins, no retain logic: there's no prior intent to preserve for a
  // task that doesn't exist yet. Reads from `models` (the merged rows), so a
  // logged-out harness's discovery is distrusted here too (rule 7).
  const efforts = effortOptionsFor(kind, model, models);
  const effortsKey = efforts.map((o) => o.id).join(",");
  const maxModeAvailable = kind === "cursor" && cursorModelSupportsMaxMode(model);
  const speedOptions = speedOptionsFor(kind, model, effort, models);
  const tiersKnown = speedTiersKnown(kind, discoveredForAgent, loggedIn);
  // Only offer-checked once the kind's tiers are known: before a discovered
  // kind's catalog loads its tiers read `["off"]` and must not reset a tier.
  const speedOptionsKey = tiersKnown ? speedOptions.join(",") : null;

  // Apply a remembered model the curated list lacked (or the CLI's own default)
  // once the loaded rows show it is real — unless the user already chose one.
  // Never fights a later manual pick. An `initial` launch never runs it.
  useEffect(() => {
    if (initial || !prefsLoaded || modelTouched.current[kind]) return;
    const pending = pendingSeed.current[kind];
    const out = resolveSeedOutcome({ kind, currentModel: model, pending, rows: models, discovered: discoveredForAgent, loggedIn });
    if (out.action === "keep") return;
    if (out.action === "apply") {
      if (out.first && pending) {
        pending.applied = true;
        pickCache.current[kind] = { ...pickCache.current[kind], model: out.model };
        setModel(out.model);
        const offered = effortOptionsFor(kind, out.model, models);
        if (out.effort && offered.some((o) => o.id === out.effort)) setEffort(out.effort);
      }
      // A codex/copilot model only the frozen curated rows vouch for stays
      // pending: a trusted catalog that then lacks it sends the form back to the
      // default, instead of leaving it on a model the CLI refuses.
      if (out.confirmed) delete pendingSeed.current[kind];
      return;
    }
    pickCache.current[kind] = { ...pickCache.current[kind], model: out.model };
    if (out.model !== model) setModel(out.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, modelsKey, prefsLoaded, seedGeneration]);

  useEffect(() => {
    if (efforts.length === 0) {
      if (effort !== null) setEffort(null);
      return;
    }
    if (effort !== null && efforts.some((e) => e.id === effort)) return;
    setEffort(resolveDefaultEffort(kind, model, models));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, model, effortsKey]);
  // A tier the kind's (known) options no longer include falls back to Off —
  // cursor: the model/effort pair lost its Fast variant; fx, codex, claude: the
  // model's discovered flags changed. Never while the tiers are unknown.
  useEffect(() => {
    if (speed === "off" || speedOptionsKey === null) return;
    if (!speedOptions.includes(speed)) setSpeed("off");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, speed, speedOptionsKey]);
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

  const currentPicks = () => ({ mode, model, effort, speed, maxMode });

  const switchAgent = (nextId: string) => {
    if (nextId === agent) return;
    const nextKind = harnesses.find((h) => h.id === nextId)?.kind ?? "claude-code";
    // Stash the current picks under the current kind, restore the next kind's.
    const r = switchPicks(pickCache.current, kind, currentPicks(), nextKind);
    pickCache.current = r.cache;
    setAgent(nextId);
    applyPicks(r.next);
  };

  // The user-facing model pick. A deliberate model change drops a tier the new
  // model does not offer, but only when the harness's tiers are known
  // (discovered catalog non-empty and not distrusted as logged out) — the merged
  // rows then carry the new model's real flags. It also marks the kind touched,
  // so a later pending seed never overrides the choice.
  const pickModel = (next: string) => {
    modelTouched.current[kind] = true;
    setModel(next);
    if (speed === "off" || next === model || !tiersKnown) return;
    if (!speedOptionsFor(kind, next, effort, models).includes(speed)) setSpeed("off");
  };

  const seed = (values: Partial<{
    agent: string;
    mode: string;
    model: string;
    effort: string | null;
    speed: Speed;
    maxMode: boolean;
  }>) => {
    if (values.agent !== undefined) switchAgent(values.agent);
    if (values.mode !== undefined) setMode(values.mode);
    if (values.model !== undefined) setModel(values.model);
    if (values.effort !== undefined) setEffort(values.effort);
    if (values.speed !== undefined) setSpeed(values.speed);
    if (values.maxMode !== undefined) setMaxMode(values.maxMode);
  };

  const rememberPicks = () => {
    // A profile- or pipeline-backed launch didn't come from manually-picked
    // values — nothing of the user's own intent to remember (owner D12).
    if (agentProfileId || pipelineId) return;
    pickCache.current[kind] = currentPicks();
    for (const [key, value] of rememberPickPrefs(kind, currentPicks())) {
      void api.setPreference(key, value).catch(() => {});
    }
  };

  // ↻ in the Model field: one-shot probe + refetch, never a poll or a stream.
  const [refreshingModels, setRefreshingModels] = useState(false);
  const refreshModels = async () => {
    setRefreshingModels(true);
    try {
      if (source) {
        await source.refreshModels(agent);
      } else {
        await api.refreshAgentModels(agent);
        const [m, h] = await Promise.all([api.listAgentModels(), api.listHarnessModels()]);
        setFetchedAgentModels(m);
        setFetchedHarnessModels(h.byHarness);
      }
    } catch {
      // The SSE / ready-retry paths also refetch — a failed manual probe just
      // leaves the list as it was.
    } finally {
      setRefreshingModels(false);
    }
  };

  // A pipeline's start-step profile is the launch identity while one is
  // selected: the composer's discovery, the overage check, the availability/auth
  // hint and the submit gate all describe the harness whose step will actually
  // run first — not the hidden manual picker.
  const pipelineProfile = pipelineLaunch.startProfile;
  const effectiveAgent = pipelineProfile
    ? pipelineProfile.harness
    : selectedProfile ? selectedProfile.harness : agent;
  const effectiveHarness = harnesses.find((h) => h.id === effectiveAgent) ?? null;
  const effectiveKind: AgentKind =
    (selectedProfile || pipelineProfile) ? (effectiveHarness?.kind ?? kind) : kind;
  // `AgentStatus` for whichever harness a launch will ACTUALLY run under — not
  // the bare `selectedStatus`, which stays pinned to the manual picker and is
  // invisible once a profile/pipeline hides that block (finding F2-3).
  const effectiveStatus = agents.find((a) => a.harnessId === effectiveAgent);
  const effectiveStackFallback = stackBackupCanServe(effectiveAgent, stacks, harnesses, agents);
  const effectiveLaunchable = !!effectiveStatus?.available || effectiveStackFallback;
  const effectiveHarnessLabel = effectiveHarness?.label ?? effectiveAgent;
  // For a pipeline the manual `effectiveKind` is meaningless (each step runs its
  // own profile's harness), so the prompt-budget check keys on the START step's
  // bound harness — `null` when that can't be resolved yet.
  const overageKind: AgentKind | null = pipelineId !== null
    ? (pipelineLaunch.startHarness?.kind ?? null)
    : effectiveKind;
  const overageLabel = pipelineId !== null
    ? (pipelineLaunch.startHarness?.label ?? pipelineProfile?.harness ?? "the start step's harness")
    : effectiveHarnessLabel;

  return {
    loading,
    loadError,
    harnesses,
    stacks,
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
    speed,
    maxMode,
    setSpeed,
    setMaxMode,
    speedOptions,
    maxModeAvailable,
    models,
    modes,
    efforts,
    setMode,
    setModel: pickModel,
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
    effectiveStackFallback,
    effectiveLaunchable,
    withPipelines,
    pipelines,
    pipelinesLoaded,
    pipelinesLoading,
    pipelinesError,
    pipelineId,
    setPipelineId,
    selectedPipeline,
    pipelineState: pipelineLaunch.state,
    pipelineProblem: pipelineLaunch.reason,
    pipelineReady: pipelineId === null || pipelineLaunch.state === "ready",
    pipelineStartProfile: pipelineLaunch.startProfile,
    overageKind,
    overageLabel,
    seed,
    refreshModels,
    refreshingModels,
    profilesLoaded,
    primaryMode: primaryModeOf(kind, mode),
    codeVariants: codeVariantsFor(kind, model),
    statusTone: (harnessId: string) => harnessStatusTone(agents.find((a) => a.harnessId === harnessId)),
  };
}
