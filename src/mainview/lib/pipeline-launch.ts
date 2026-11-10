/**
 * Pre-submit runnability check for a pipeline selected on a task-launch
 * surface (`TaskLaunchPickers`'s Pipeline section, New Task's own picker).
 *
 * The server is authoritative — `createTask`/`startPipelineRun` re-validate
 * the graph, the start step and the harness gates on every launch (see
 * `src/bun/orchestrator.ts`'s "pipeline" block and `startTaskInner`). This
 * helper exists so the dialog can block **Create & start** and explain why
 * BEFORE submitting: `createAndStartTask` rolls a created parent back when
 * the start fails, so a bad graph or an unavailable harness would otherwise
 * cost a create-then-delete round trip and surface only as a submit error.
 *
 * Its rule order and wording deliberately mirror the server's own messages,
 * so the inline reason reads exactly like the error the user would get after
 * a failed create. Pure and dependency-free (types + the shared pipeline
 * grammar only) so it runs under `bun test` with no DOM — the repo has no
 * React component-test harness (`bunfig.toml`).
 */
import { isHumanStep, resolveStartStep, validatePipelineGraph } from "../../shared/pipeline.ts";
import type {
  AgentProfile,
  AgentStatus,
  Harness,
  HarnessStack,
  PipelineGraph,
  PipelineStep,
} from "../../shared/types.ts";
import { stackBackupCanServe } from "./stack-launch.ts";

/** `no-pipeline` — nothing selected; `checking` — the selected graph names a
 *  profile the not-yet-loaded list can't confirm (never reported as
 *  "deleted"); `blocked` — known-unrunnable, `reason` says why; `ready` — the
 *  server would accept it as far as the client can tell. */
export type PipelineLaunchState = "no-pipeline" | "checking" | "blocked" | "ready";

export interface PipelineLaunchResolution {
  state: PipelineLaunchState;
  /** User-facing reason when `state === "blocked"`; mirrors the server's messages. */
  reason: string | null;
  /** The resolved entry step, when the graph got far enough to resolve one —
   *  returned even for a blocked result so the summary card can still show
   *  the step it would have started with. */
  startStep: PipelineStep | null;
  startProfile: AgentProfile | null;
  startHarness: Harness | null;
  startStatus: AgentStatus | undefined;
}

export interface PipelineLaunchInput {
  /** The selected pipeline's stored graph, or `null` when none is selected. */
  graph: PipelineGraph | null;
  /** The live `AgentProfile` list. May be a warm/stale module cache. */
  profiles: AgentProfile[];
  /** `true` once an agent-profile fetch has succeeded at least once — a
   *  profile missing from a not-yet-`loaded` list must never read as
   *  "deleted" (it becomes `checking` instead). */
  profilesLoaded: boolean;
  /** The last failed agent-profile fetch, if any. When the list has never
   *  loaded AND this is set, an unresolvable profile is a fetch failure to
   *  report (`blocked`) rather than an indeterminate `checking` state that
   *  would leave the picker spinning with no reason. */
  profilesError: string | null;
  harnesses: Harness[];
  agents: AgentStatus[];
  /** Harness account stacks. A start account that is disabled, unavailable or
   *  logged out but sits in a stack with a usable backup is not a block: the
   *  core moves the run to that backup (`stackBackupCanServe`). */
  stacks?: readonly HarnessStack[];
}

/**
 * Decide whether `input.graph` can launch right now. Returns the resolved
 * start step/profile/harness/status even when blocked, and never mutates its
 * inputs.
 *
 * Rule order (each rule mirrors the server's message):
 *  1. no graph → `no-pipeline`
 *  2. invalid stored graph → `pipeline graph is invalid: <error>`
 *  3. no resolvable start step → `pipeline has no resolvable start step`
 *  4. human start step → `a human step can't be the pipeline's start step`
 *     (defense in depth — the validator normally rejects it first)
 *  5. profiles not loaded and the start step's profile can't be resolved
 *     from the warm cache → `checking` (or `blocked` with the fetch error
 *     when the profile fetch itself failed, so the picker never spins
 *     without a reason)
 *  6. any non-human step with no `agentProfileId` → `step "<name>" has no agent`
 *  7. any non-human step whose profile is missing → `agent for step "<name>"
 *     no longer exists` (or `checking`/fetch-error `blocked` while the list
 *     has never loaded)
 *  8. start harness missing/disabled → `<label> is disabled — re-enable it in
 *     Settings to start new runs.` — rules 8–10 are skipped when the start
 *     account is in a stack with a usable backup, because the core's
 *     `startTask` moves the run to that backup instead of refusing it
 *  9. start harness unavailable (or no status) → `<label> is not available —
 *     <reason>[. Install it with: <hint>]`
 * 10. start harness positively logged out → `<label> isn't logged in —
 *     <authHelp>`
 * 11. otherwise `ready`
 *
 * Only the START step's harness is checked: later steps' harnesses surface as
 * run blocks, the same way they already do for a pipeline launched from the
 * New Task form. `createTask` still validates every non-human step's profile.
 */
export function resolvePipelineLaunch(input: PipelineLaunchInput): PipelineLaunchResolution {
  const { graph, profiles, profilesLoaded, profilesError, harnesses, agents, stacks = [] } = input;

  if (graph === null) {
    return {
      state: "no-pipeline",
      reason: null,
      startStep: null,
      startProfile: null,
      startHarness: null,
      startStatus: undefined,
    };
  }

  const validated = validatePipelineGraph(graph);
  if (!validated.ok) {
    return {
      state: "blocked",
      reason: `pipeline graph is invalid: ${validated.error}`,
      startStep: null,
      startProfile: null,
      startHarness: null,
      startStatus: undefined,
    };
  }

  const normalized = validated.graph;
  const startStep = resolveStartStep(normalized);
  if (startStep === null) {
    return {
      state: "blocked",
      reason: "pipeline has no resolvable start step",
      startStep: null,
      startProfile: null,
      startHarness: null,
      startStatus: undefined,
    };
  }

  const startProfile = startStep.agentProfileId
    ? (profiles.find((p) => p.id === startStep.agentProfileId) ?? null)
    : null;
  const startHarness = startProfile
    ? (harnesses.find((h) => h.id === startProfile.harness) ?? null)
    : null;
  const startStatus = startHarness
    ? agents.find((a) => a.harnessId === startHarness.id)
    : undefined;

  const resolved = (
    state: PipelineLaunchState,
    reason: string | null,
  ): PipelineLaunchResolution => ({ state, reason, startStep, startProfile, startHarness, startStatus });

  // The only missing fact in these branches is the profile list. A failed
  // fetch must say so (blocked) instead of staying `checking` forever; a
  // still-in-flight first fetch stays `checking` (no error yet). Graph
  // problems below still win — they don't need the list to be reported.
  const unresolvedProfiles = (): PipelineLaunchResolution =>
    !profilesLoaded && profilesError !== null
      ? resolved("blocked", `Couldn't load agent profiles — ${profilesError}`)
      : resolved("checking", null);

  if (isHumanStep(startStep)) {
    return resolved("blocked", "a human step can't be the pipeline's start step");
  }

  // The start step's own profile could not be resolved: while the list has
  // never loaded, that is unknown — not "deleted" — so report `checking`
  // (or the fetch failure). A loaded list falls through to the per-step
  // loop below, whose message is the server's own ("agent for step … no
  // longer exists").
  if (startStep.agentProfileId !== null && startProfile === null && !profilesLoaded) {
    return unresolvedProfiles();
  }

  for (const step of normalized.steps) {
    if (isHumanStep(step)) continue;
    if (!step.agentProfileId) {
      return resolved("blocked", `step "${step.name}" has no agent`);
    }
    if (!profiles.some((p) => p.id === step.agentProfileId)) {
      // Only a successfully-loaded list can prove a profile is gone.
      if (!profilesLoaded) return unresolvedProfiles();
      return resolved("blocked", `agent for step "${step.name}" no longer exists`);
    }
  }

  // The loop above guarantees a non-human start step with a database profile
  // resolves, but keep a defensive branch for a future graph shape.
  if (startProfile === null) {
    return resolved("blocked", `step "${startStep.name}" has no agent`);
  }

  if (startProfile !== null && stackBackupCanServe(startProfile.harness, stacks, harnesses, agents)) {
    return resolved("ready", null);
  }
  if (startHarness === null) {
    return resolved(
      "blocked",
      `${startProfile.harness} is disabled — re-enable it in Settings to start new runs.`,
    );
  }
  if (!startHarness.enabled) {
    return resolved(
      "blocked",
      `${startHarness.label} is disabled — re-enable it in Settings to start new runs.`,
    );
  }
  if (!startStatus || !startStatus.available) {
    const hint = startStatus?.installHint ? ` Install it with: ${startStatus.installHint}` : "";
    const reason = startStatus?.reason ?? "its status couldn't be determined";
    return resolved("blocked", `${startHarness.label} is not available — ${reason}.${hint}`);
  }
  // Fail-open: only an explicit `false` means the CLI positively reported it
  // is logged out; `null` (not probed / unknown) must never block a launch —
  // the same rule `startTaskInner` applies.
  if (startStatus.loggedIn === false) {
    return resolved(
      "blocked",
      `${startHarness.label} isn't logged in — ${startStatus.authHelp ?? "run its login command"}`,
    );
  }

  return resolved("ready", null);
}
