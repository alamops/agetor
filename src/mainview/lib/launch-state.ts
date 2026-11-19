/**
 * The pure decision rules of a task launch, lifted out of `NewTaskForm.tsx` so
 * every launch surface (the panel, the issue and PR dialogs, Clone, Settings →
 * Agents) shares ONE implementation, and so they are unit-testable: `bun test`
 * has no DOM and no React hook runner (docs/architecture/task-launch-ui.md).
 *
 * `lib/use-task-launch.ts` keeps only the orchestration (state, effects,
 * fetches); every "what should the picks become" rule is here.
 */
import { isSpeed } from "../../shared/speed.ts";
import {
  AGENT_OPTIONS,
  CODE_PLAN_MODE,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  defaultModeFor,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type AgentOption,
  type AgentProfile,
  type AgentStatus,
  type Speed,
} from "../../shared/types.ts";
import {
  CLI_AUTHORITATIVE_CATALOG_KINDS,
  resolveDefaultModel,
  seedModelStep,
} from "../../shared/model-catalog.ts";
import type { DiscoveredModel, ModelOption } from "../../shared/model-options.ts";
import type { PipelineLaunchState } from "./pipeline-launch.ts";

/** Every kind a launch can pick, in the order the caches are built. */
export const LAUNCH_KINDS: readonly AgentKind[] = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "antigravity",
  "fx",
  "opencode",
  "copilot",
];

/** The manual picks of one harness kind. */
export type LaunchPicks = {
  mode: string;
  model: string;
  /** `null` is reserved for "the model doesn't accept an effort". */
  effort: string | null;
  speed: Speed;
  maxMode: boolean;
};

/** Per-kind picks, so switching harnesses (or aliases of one kind) restores the
 *  prior picks instead of resetting them. */
export type PickCache = Record<AgentKind, LaunchPicks>;

/** A remembered `lastModel:<kind>` the curated list lacks, held until discovery
 *  shows it is real. `applied` flips once it has been applied. */
export type PendingSeeds = Partial<Record<AgentKind, PendingSeed>>;
export interface PendingSeed {
  model: string;
  effort: string | null;
  applied?: boolean;
  /** The catalog ruled the remembered model out: nothing is waiting on it any more. */
  settled?: boolean;
}

export function defaultPicks(kind: AgentKind): LaunchPicks {
  return {
    mode: defaultModeFor(kind),
    model: DEFAULT_MODEL[kind],
    effort: DEFAULT_EFFORT[kind],
    speed: "off",
    maxMode: false,
  };
}

export function initialPickCache(): PickCache {
  const cache = {} as PickCache;
  for (const kind of LAUNCH_KINDS) cache[kind] = defaultPicks(kind);
  return cache;
}

/**
 * Seed the per-kind cache from the remembered `last*:<kind>` preferences, for
 * every kind in one pass (`NewTaskForm`'s mount-once seed). Stored ids are
 * validated against the current option set, so a stale sentinel falls back to
 * the kind's default instead of selecting nothing.
 *
 * - A model the curated list lacks, and EVERY model of a CLI-authoritative kind,
 *   becomes a *pending* seed: it is applied once discovery shows it is real.
 * - A remembered effort is validated against the curated table only (discovery
 *   has not landed yet); the render-path effort check is the authority later.
 */
export function seedPickCache(
  cache: PickCache,
  prefs: Record<string, string | undefined>,
): { cache: PickCache; pending: PendingSeeds } {
  const next = {} as PickCache;
  const pending: PendingSeeds = {};
  for (const kind of LAUNCH_KINDS) {
    const picks: LaunchPicks = { ...cache[kind] };
    const md = prefs[`lastMode:${kind}`];
    const m = prefs[`lastModel:${kind}`];
    const e = prefs[`lastEffort:${kind}`];
    const sp = prefs[`lastSpeed:${kind}`];
    const mm = prefs[`lastMaxMode:${kind}`];
    if (md && AGENT_OPTIONS[kind].modes.some((x) => x.id === md)) picks.mode = md;
    if (m && !CLI_AUTHORITATIVE_CATALOG_KINDS.has(kind) && AGENT_OPTIONS[kind].models.some((x) => x.id === m)) {
      picks.model = m;
    } else if (m) {
      pending[kind] = { model: m, effort: e ?? null };
    }
    if (e && !pending[kind]) {
      const supported = supportedEfforts(kind, picks.model);
      if (supported.some((x) => x.id === e)) picks.effort = e;
      else if (supported.length === 0) picks.effort = null;
    }
    if (isSpeed(sp)) picks.speed = sp;
    if (mm === "true" || mm === "false") picks.maxMode = mm === "true";
    next[kind] = picks;
  }
  return { cache: next, pending };
}

/**
 * Switch the harness kind: stash the current picks under the current kind and
 * restore the next kind's. Aliases of one kind share a cache slot, so a swap
 * between two accounts of the same kind keeps the user's picks.
 */
export function switchPicks(
  cache: PickCache,
  fromKind: AgentKind,
  current: LaunchPicks,
  toKind: AgentKind,
): { cache: PickCache; next: LaunchPicks } {
  const stashed: PickCache = { ...cache, [fromKind]: current };
  return { cache: stashed, next: stashed[toKind] };
}

/**
 * The preference writes a launch makes so the next one starts on the same
 * picks (`lastMode`, `lastModel`, `lastEffort` when set, `lastSpeed`,
 * `lastMaxMode`). Max Mode is cursor-only, so any other kind writes `"false"`.
 */
export function rememberPickPrefs(kind: AgentKind, picks: LaunchPicks): Array<[key: string, value: string]> {
  const out: Array<[string, string]> = [
    [`lastMode:${kind}`, picks.mode],
    [`lastModel:${kind}`, picks.model],
  ];
  if (picks.effort !== null) out.push([`lastEffort:${kind}`, picks.effort]);
  out.push([`lastSpeed:${kind}`, picks.speed]);
  out.push([`lastMaxMode:${kind}`, String(kind === "cursor" && picks.maxMode)]);
  return out;
}

/**
 * What a launch submits for the agent fields. A selected profile's own values
 * replace the manual picks (the server re-resolves from the profile anyway).
 * The speed tier is sent for EVERY kind: the picks' speed is already reset to
 * Off whenever the harness does not offer it, so claude-code's and codex's Fast
 * is no longer dropped on submit. Max Mode is cursor-only.
 */
export function submitPicks(a: {
  kind: AgentKind;
  picks: LaunchPicks;
  profile: AgentProfile | null;
}): { mode: string | null; model: string | null; effort: string | null; speed: Speed; maxMode: boolean } {
  if (a.profile) {
    return {
      mode: a.profile.mode,
      model: a.profile.model,
      effort: a.profile.effort,
      speed: a.profile.speed,
      maxMode: a.profile.maxMode,
    };
  }
  return {
    mode: a.picks.mode,
    model: a.picks.model,
    effort: a.picks.effort,
    speed: a.picks.speed,
    maxMode: a.kind === "cursor" ? a.picks.maxMode : false,
  };
}

/** The Code | Plan bucket a mode id belongs to: Plan only for the kind's plan
 *  mode, every other id (auto, acceptEdits, ask, …) is Code. */
export function primaryModeOf(kind: AgentKind, mode: string): "code" | "plan" {
  return mode === CODE_PLAN_MODE[kind].plan ? "plan" : "code";
}

/**
 * The mode to switch to for a Code | Plan click, or `null` for a no-op:
 * clicking Code while already in a code-bucket mode keeps an explicit
 * acceptEdits/ask choice instead of resetting it to auto.
 */
export function modeForPrimary(kind: AgentKind, mode: string, target: "code" | "plan"): string | null {
  if (primaryModeOf(kind, mode) === target) return null;
  return CODE_PLAN_MODE[kind][target];
}

/** The code-bucket variants a kind offers for a model (everything but the
 *  plan mode). The variant picker only shows when there is more than one. */
export function codeVariants(kind: AgentKind, model: string): AgentOption[] {
  const plan = CODE_PLAN_MODE[kind].plan;
  return supportedModes(kind, model).filter((m) => m.id !== plan);
}

export type StatusTone = "ok" | "warn" | "error" | "unknown";

/** The dot tone of a harness row: unavailable → error, available but logged out
 *  → warn, available → ok, and no status row yet → unknown (never red before
 *  the probe has answered). */
export function harnessStatusTone(status: AgentStatus | undefined): StatusTone {
  if (!status) return "unknown";
  if (!status.available) return "error";
  if (status.loggedIn === false) return "warn";
  return "ok";
}

export interface LaunchGateInput {
  title: string;
  prompt: string;
  /** The panel needs a title; the Git dialogs derive theirs. */
  requireTitle: boolean;
  reposCount: number;
  worktreeValid: boolean;
  /** The prompt exceeds the one-shot launch cap of the effective harness. */
  overage: boolean;
  effectiveLaunchable: boolean;
  effectiveHarnessLabel: string;
  /** Why the harness can't start (its status reason), when it can't. */
  effectiveReason?: string | null;
  /** False while the harness's status row hasn't arrived yet (default true):
   *  Run waits ("Checking …") instead of claiming the harness can't start. */
  statusKnown?: boolean;
  pipelineSelected: boolean;
  pipelineReady: boolean;
  pipelineState: PipelineLaunchState;
  pipelineProblem: string | null;
}

export interface LaunchGate {
  canRun: boolean;
  canBacklog: boolean;
  runBlockedReason: string | null;
}

/**
 * The single rule for "may this launch run?" on the panel and both Git dialogs.
 *
 * - Missing title (when required), prompt or project, an invalid worktree or an
 *   oversize prompt block BOTH actions: nothing can be created from them.
 * - An unavailable harness or a pipeline that can't start blocks only **Run**:
 *   **Add to backlog** stays the "queue it anyway" path.
 *
 * The reason is plain text so the footer can show it: a disabled button shows
 * no tooltip (`disabled:pointer-events-none`).
 */
export function launchGate(i: LaunchGateInput): LaunchGate {
  const missing =
    (i.requireTitle && !i.title.trim()) || !i.prompt.trim() || i.reposCount === 0;
  if (missing) {
    const needs: string[] = [];
    if (i.requireTitle && !i.title.trim()) needs.push("a title");
    if (!i.prompt.trim()) needs.push("a prompt");
    if (i.reposCount === 0) needs.push("a project");
    const reason = `Add ${needs.length > 1 ? `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}` : needs[0]}`;
    return { canRun: false, canBacklog: false, runBlockedReason: reason };
  }
  if (!i.worktreeValid) {
    const reason = "Fix the branch name first";
    return { canRun: false, canBacklog: false, runBlockedReason: reason };
  }
  if (i.overage) {
    const reason = "The prompt is too long for this harness";
    return { canRun: false, canBacklog: false, runBlockedReason: reason };
  }
  if (i.pipelineSelected && !i.pipelineReady) {
    const reason =
      i.pipelineState === "checking"
        ? "Checking the pipeline's start step…"
        : (i.pipelineProblem ?? "The pipeline can't start yet");
    return { canRun: false, canBacklog: true, runBlockedReason: reason };
  }
  if (!i.effectiveLaunchable && i.statusKnown === false) {
    return {
      canRun: false,
      canBacklog: true,
      runBlockedReason: `Checking ${i.effectiveHarnessLabel} availability…`,
    };
  }
  if (!i.effectiveLaunchable) {
    const why = i.effectiveReason ? `: ${i.effectiveReason}` : "";
    return {
      canRun: false,
      canBacklog: true,
      runBlockedReason: `${i.effectiveHarnessLabel} can't start${why}. Add it to the backlog or pick another harness`,
    };
  }
  return { canRun: true, canBacklog: true, runBlockedReason: null };
}

export type SeedOutcome =
  /** Nothing to do yet (or ever, for a hand-picked model). */
  | { action: "keep" }
  /** Start on `model`. `first` is true the first time a pending seed applies (the
   *  caller then also applies `effort` when the model offers it); `confirmed`
   *  says the catalog vouches for it, so the pending seed can be dropped. */
  | { action: "apply"; model: string; effort: string | null; first: boolean; confirmed: boolean }
  /** No remembered pick (or a trusted catalog lacking it): start on the owner's
   *  default model, or the CLI's own when its trusted catalog lacks that one. */
  | { action: "default"; model: string };

/**
 * What a launch does with the model as the catalog arrives (`NewTaskForm`'s
 * pending-seed effect). The caller skips this entirely for a kind whose model
 * the user already chose by hand. `rows` is the merged option list for the
 * current model; `discovered` the harness's raw catalog.
 */
export function resolveSeedOutcome(a: {
  kind: AgentKind;
  currentModel: string;
  pending: PendingSeed | undefined;
  rows: readonly ModelOption[];
  discovered: readonly DiscoveredModel[];
  loggedIn: boolean | null | undefined;
}): SeedOutcome {
  const step = a.pending ? seedModelStep(a.kind, a.pending.model, a.rows, a.discovered, a.loggedIn) : null;
  // Not carried yet: wait while discovery has nothing trustworthy for this harness.
  if (step?.action === "wait") return { action: "keep" };
  if (a.pending && step?.action === "apply") {
    return {
      action: "apply",
      model: step.model,
      effort: a.pending.effort,
      first: !a.pending.applied,
      confirmed: step.confirmed,
    };
  }
  if (step?.action !== "default" && a.currentModel !== DEFAULT_MODEL[a.kind]) return { action: "keep" };
  return { action: "default", model: resolveDefaultModel(a.kind, a.discovered, a.loggedIn) };
}
