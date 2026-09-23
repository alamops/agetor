/**
 * The pipeline runner (T3, `docs/plans/pipelines.md` §3/§4). Turns a
 * {@link Pipeline} template into a running, hidden graph of **step tasks**
 * sharing the pipeline task's (the "parent"'s) worktree: `startPipelineRun`
 * launches the graph's start step, a `subscribeGlobal` listener registered
 * by `initPipelineRunner` watches every step task's settle/column events and
 * advances the graph — parsing each step's `<handoff>` (`src/shared/
 * pipeline.ts`), resolving fan-out/fan-in per the graph's edges, and either
 * launching the next step(s), recording the run done, or blocking with a
 * reason a human (or a retry) can act on. `advancePipeline`/
 * `retryPipelineStep`/`cancelPipelineRun` are the three manual interventions
 * `server.ts`'s routes expose; `cascadePipelineDelete`/`cascadePipelineArchive`
 * back `orchestrator.ts`'s `deleteTask`/`archiveTask` cascades (D1/D9);
 * `reconcilePipelineRuns` is the boot-time (or test-time) self-heal for a
 * step settle the runner's listener missed entirely (M16).
 *
 * This module and `orchestrator.ts` reference each other's exports (the
 * runner needs `subscribeGlobal`/`startTask`/`cancelRun`/`deleteTask`/
 * `archiveTask`/`defaultEffortFor`/`isTaskRunLive`/`pipelineUpdateColumn`;
 * `orchestrator.ts`'s `startTaskInner`/`deleteTask`/`archiveTask`/
 * `createTask` need `startPipelineRun`/`cascadePipelineDelete`/
 * `cascadePipelineArchive`/`withPipelineLock`/`initialPipelineRunState`) — a
 * static import cycle, but a safe one: every cross-reference on both sides
 * is used inside a function body, never at module top-level, so by the time
 * either side's code actually runs both modules have finished evaluating.
 * `initPipelineRunner` itself is never auto-invoked at module load (unlike,
 * say, `wireInteractionBroadcast()` in orchestrator.ts) — `index.ts`/
 * `headless.ts` call it explicitly, once, right before `reconcileOrphans()`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentProfiles, dataDir, harnesses, pipelines, runs, tasks } from "./db.ts";
import {
  archiveTask,
  cancelRun,
  defaultEffortFor,
  deleteTask,
  isTaskRunLive,
  pipelineUpdateColumn,
  publishGlobalEvent,
  startTask,
  subscribeGlobal,
} from "./orchestrator.ts";
import { prepareWorkdir } from "./worktree.ts";
import { composeLaunchPrompt, snapshotFromProfile } from "../shared/agent-profile.ts";
import {
  composeStepPrompt,
  deriveRunStatus,
  effectiveStepCap,
  incomingSteps,
  normalizeHandoff,
  outgoingSteps,
  parseHandoff,
  renderHandoffFile,
  resolveNextSteps,
  resolveStartStep,
  stepNameById,
} from "../shared/pipeline.ts";
import { promptByteOverage } from "../shared/prompt-limits.ts";
import { appendReferences } from "../shared/refs.ts";
import type {
  AgentProfileSnapshot,
  ColumnId,
  GlobalEvent,
  Handoff,
  Pipeline,
  PipelineBlock,
  PipelineBlockKind,
  PipelineJoinArrival,
  PipelineRunSnapshot,
  PipelineRunState,
  PipelineRunStatus,
  PipelineStep,
  Task,
  TaskReference,
} from "../shared/types.ts";

/** `dataDir/pipeline-runs/<parentId>` — where every step's handoff JSON
 *  (see D10) is written, and what `cascadePipelineDelete` removes wholesale. */
export function pipelineRunsDir(parentId: string): string {
  return join(dataDir, "pipeline-runs", parentId);
}

/** True for a hidden step task (`pipelineParentId` set) — the board, CLI
 *  `ls`/TUI, and every "can this be deleted/archived on its own?" guard use
 *  this to tell a step row apart from an ordinary (including pipeline
 *  parent) task. */
export function isPipelineStepTask(t: Task): boolean {
  return t.pipelineParentId != null;
}

/** Fresh, never-run state for a task just bound to `p` (`createTask`'s
 *  `pipelineId` path) — idle, no snapshot until the first Run. */
export function initialPipelineRunState(p: Pipeline): PipelineRunState {
  return {
    pipelineId: p.id,
    pipelineName: p.name,
    snapshot: null,
    status: "idle",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: null,
    endedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Per-parent serialization
// ---------------------------------------------------------------------------

/**
 * Every mutation of a given parent's `pipelineRun` — a manual route call
 * (`startPipelineRun`/`advancePipeline`/`retryPipelineStep`/
 * `cancelPipelineRun`) or an async settle/column event for one of its step
 * tasks — is serialized through this per-parent chain, so two events for
 * sibling steps (a fan-out's two branches settling moments apart) or a
 * manual advance racing a settle can never read-modify-write the same
 * `pipelineRun` JSON blob concurrently. `fn`'s return value (and any thrown
 * error) propagates to the caller unchanged; the chain itself never breaks
 * on a rejection — the next queued `fn` still runs.
 */
const parentChains = new Map<string, Promise<unknown>>();
function runExclusive<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (parentChains.get(parentId) ?? Promise.resolve()) as Promise<unknown>;
  const chained = prev.then(fn, fn);
  const guard = chained.then(() => {}, () => {});
  parentChains.set(parentId, guard);
  guard.finally(() => {
    if (parentChains.get(parentId) === guard) parentChains.delete(parentId);
  });
  return chained;
}

/**
 * Exported alias of the per-parent serialization above (M7) — `orchestrator.ts`'s
 * `deleteTask`/`archiveTask` run their pipeline cascades (`cascadePipelineDelete`/
 * `cascadePipelineArchive`) through this so a cascade can never interleave
 * with an in-flight settle/manual-route mutation for the same parent.
 */
export function withPipelineLock<T>(parentId: string, fn: () => Promise<T>): Promise<T> {
  return runExclusive(parentId, fn);
}

/**
 * Parent ids whose delete cascade (`cascadePipelineDelete`) has started —
 * set FIRST, before any step is torn down (M7). `launchStep` re-checks this
 * (and that the parent row still exists) right before inserting a new step
 * row, and again right after `startTask` returns, so a launch that raced a
 * delete can't leave an orphaned step task (or a freshly-spawned agent)
 * behind. Never cleared — parent ids are uuids and never reused, so this is
 * bounded by "how many pipeline tasks this process has ever deleted", not
 * unbounded churn.
 */
export const tombstonedPipelineParents = new Set<string>();

// ---------------------------------------------------------------------------
// Pure-ish helpers over a live (mutable, in-memory) PipelineRunState
// ---------------------------------------------------------------------------

/** Replace any existing blocked entry for `entry.taskId` (there's at most
 *  one at a time per execution) and push `entry`. Run-level blocks
 *  (`taskId: null`, e.g. `step-cap`/`join-incomplete`) are never deduped
 *  against each other this way — callers that add one check for an existing
 *  entry themselves (`checkJoinIncomplete` below). */
function upsertBlocked(run: PipelineRunState, entry: PipelineBlock): void {
  if (entry.taskId !== null) {
    run.blocked = run.blocked.filter((b) => b.taskId !== entry.taskId);
  }
  run.blocked.push(entry);
}

function removeBlockedFor(run: PipelineRunState, taskId: string): void {
  run.blocked = run.blocked.filter((b) => b.taskId !== taskId);
}

/** Add-or-replace a join arrival by `fromStepId` (m10) — a source step that
 *  hands off to the same join twice (a retry, a cycle revisiting the same
 *  join in a later generation while an earlier arrival was never cleared,
 *  …) must overwrite its previous arrival rather than duplicate it, since
 *  "one arrival per distinct incoming source" is exactly what the
 *  join-complete check (`incoming.every((i) => arrivedIds.has(...))`) counts
 *  on. */
function addJoinArrival(existing: PipelineJoinArrival[], entry: PipelineJoinArrival): PipelineJoinArrival[] {
  return [...existing.filter((a) => a.fromStepId !== entry.fromStepId), entry];
}

/** After every settle/advance, decide whether any `join: "all"` step is
 *  stuck forever: no execution is left active, but a partial arrival set is
 *  still sitting in `run.joins`. Idempotent — never adds a second entry for
 *  the same join step. */
function checkJoinIncomplete(run: PipelineRunState): void {
  if (run.active.length > 0 || !run.snapshot) return;
  const graph = run.snapshot.graph;
  for (const [stepId, joinState] of Object.entries(run.joins)) {
    if (joinState.arrivals.length === 0) continue;
    if (run.blocked.some((b) => b.stepId === stepId && b.kind === "join-incomplete")) continue;
    const stepName = stepNameById(graph, stepId);
    const incoming = incomingSteps(graph, stepId);
    const arrivedIds = new Set(joinState.arrivals.map((a) => a.fromStepId));
    const missing = incoming
      .filter((i) => !arrivedIds.has(i.step.id))
      .map((i) => i.step.name);
    run.blocked.push({
      taskId: null,
      stepId,
      kind: "join-incomplete",
      message: missing.length > 0
        ? `step "${stepName}" is waiting on: ${missing.join(", ")} (no path there arrived)`
        : `step "${stepName}" never received all its incoming handoffs`,
      // M2: a manual advance/retry can re-launch this join with exactly the
      // arrivals it already has.
      pending: { stepId, arrivals: joinState.arrivals },
    });
  }
}

/**
 * Persist `run` onto the parent task row, recompute its `status` (unless
 * `preserveStatus` — see `deriveRunStatus`'s doc for why a "cancelled, but
 * kept `active` for retry" state can't be re-derived), mirror the parent's
 * board column, and broadcast the `"pipeline"` GlobalEvent (D12) — UNLESS
 * the parent is archived (m8): an archived task is frozen everywhere else
 * (no board card, no live column), so a background settle must still update
 * the stored run state (reconcile, history, retries all read it) without
 * mirroring a column or firing an event nobody should react to. The single
 * choke point every mutator below ends on.
 */
function persist(parentId: string, run: PipelineRunState, opts?: { preserveStatus?: boolean }): void {
  if (!opts?.preserveStatus) run.status = deriveRunStatus(run);
  if (run.status === "done" || run.status === "cancelled") {
    if (run.endedAt === null) run.endedAt = Date.now();
  } else {
    run.endedAt = null;
  }
  tasks.setPipelineRun(parentId, run);
  const parent = tasks.get(parentId);
  if (parent?.archivedAt != null) return; // m8
  const columnFor: Partial<Record<PipelineRunStatus, ColumnId>> = {
    running: "running",
    blocked: "blocked",
    done: "review",
    cancelled: "ready",
  };
  const nextColumn = columnFor[run.status];
  if (nextColumn && parent && parent.column !== nextColumn) {
    pipelineUpdateColumn(parentId, null, nextColumn);
  }
  publishGlobalEvent({
    kind: "pipeline",
    taskId: parentId,
    status: run.status,
    activeStepIds: run.active.map((a) => a.stepId),
    stepCount: run.stepCount,
    ts: Date.now(),
  } satisfies GlobalEvent);
}

/** Re-read a FRESH copy of the parent's run from the DB and record a
 *  `step-failed` block for `taskId`'s active execution with `err`'s message
 *  (M16) — the fallback every event handler below reaches for when its own
 *  body throws partway through mutating an in-memory `run` that was never
 *  persisted. Deliberately re-fetches rather than trusting whatever the
 *  caller's own (possibly half-mutated) `run` variable holds, since that
 *  object was never written to the DB if the throw happened before its own
 *  `persist()` call — the actual DB row is untouched, so reading fresh here
 *  can't double-apply a partial mutation. A no-op when the parent, its run,
 *  or this specific active entry no longer exist. */
function persistReconcileFailure(parentId: string, taskId: string, err: unknown): void {
  try {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineRun) return;
    const run = parent.pipelineRun;
    const activeEntry = run.active.find((a) => a.taskId === taskId);
    if (!activeEntry) return;
    const message = err instanceof Error ? err.message : String(err);
    upsertBlocked(run, {
      taskId,
      stepId: activeEntry.stepId,
      kind: "step-failed",
      message: `internal error while processing this step: ${message}`,
    });
    checkJoinIncomplete(run);
    persist(parentId, run);
  } catch {
    // Best-effort — if even this fails, the step just stays `active` with
    // no block until the next event or `reconcilePipelineRuns` sweep.
  }
}

/** Concatenate a run's main-stream (`subagentId == null`) `assistant` rows
 *  in id order — the text `parseHandoff` scans for the step's trailing
 *  `<handoff>` block. */
function assistantTextForRun(runId: string): string {
  return runs
    .events(runId)
    .filter((e) => e.stream === "assistant" && e.subagentId == null)
    .map((e) => e.data)
    .join("\n");
}

/** Best-effort "why did it fail" tail for a `step-failed` blocked message —
 *  the run's last main-stream `status`/`stderr` row, capped so one giant
 *  stack trace doesn't blow up the blocked entry's `message`. `null` when
 *  the run has nothing of the sort (rare, but cheap to tolerate). */
function lastStatusLineForRun(runId: string): string | null {
  const events = runs.events(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.subagentId != null) continue;
    if (e.stream !== "status" && e.stream !== "stderr") continue;
    return e.data.length > 240 ? `${e.data.slice(0, 240)}…` : e.data;
  }
  return null;
}

function reasonMessage(reason: string | undefined, stepName: string): string {
  switch (reason) {
    case "approval":
      return `step "${stepName}" is waiting for you`;
    case "api-error":
      return `step "${stepName}" hit an API error`;
    case "session-died":
      return `step "${stepName}" session ended unexpectedly`;
    case "unknown-command":
      return `step "${stepName}" hit an unknown command error`;
    default:
      return `step "${stepName}" is blocked`;
  }
}

// ---------------------------------------------------------------------------
// Snapshot capture (D8)
// ---------------------------------------------------------------------------

/**
 * Freeze `pipeline`'s graph plus every agent profile any step (or any
 * step's `subagents.profileIds`) references, at `now`. Fails — refusing to
 * start the run at all, per D8/Done-criteria #7 — when any step has no
 * `agentProfileId`, a referenced profile no longer exists, or that
 * profile's own harness no longer resolves.
 */
function buildSnapshot(pipeline: Pipeline, now: number): { snapshot: PipelineRunSnapshot } | { error: string } {
  const neededIds = new Set<string>();
  for (const step of pipeline.graph.steps) {
    if (!step.agentProfileId) return { error: `step "${step.name}" has no agent` };
    neededIds.add(step.agentProfileId);
    for (const id of step.subagents.profileIds) neededIds.add(id);
  }
  const profiles: Record<string, AgentProfileSnapshot> = {};
  for (const id of neededIds) {
    const profile = agentProfiles.get(id);
    if (!profile) {
      const owner = pipeline.graph.steps.find((s) => s.agentProfileId === id)?.name;
      return {
        error: owner
          ? `agent "${id}" for step "${owner}" no longer exists`
          : `agent "${id}" (a step's delegation list) no longer exists`,
      };
    }
    const harness = harnesses.getByIdOrKind(profile.harness);
    if (!harness) return { error: `harness for agent "${profile.name}" no longer exists` };
    profiles[id] = snapshotFromProfile(profile, { kind: harness.kind, label: harness.label }, now);
  }
  return {
    snapshot: { graph: pipeline.graph, maxSteps: pipeline.maxSteps, profiles, capturedAt: now },
  };
}

// ---------------------------------------------------------------------------
// Worktree upkeep (M6)
// ---------------------------------------------------------------------------

/** Re-materialize (or verify) the parent's shared worktree and persist any
 *  branch/worktreePath change onto its row. Shared by every manual entry
 *  point that might act on a parent whose worktree has gone stale (removed
 *  on disk, source repo moved) since the run last touched it. */
async function refreshParentWorktree(parent: Task): Promise<{ parent: Task } | { error: string }> {
  const prepared = await prepareWorkdir(parent, {
    takenBranches: new Set(
      tasks.list().filter((t) => t.id !== parent.id).map((t) => t.branch).filter((b): b is string => Boolean(b)),
    ),
  });
  if ("error" in prepared) return { error: prepared.error };
  const updated = tasks.update(parent.id, { branch: prepared.branch, worktreePath: prepared.worktreePath }) ?? parent;
  return { parent: updated };
}

/** Copy the parent's current `branch`/`worktreePath` onto every step row
 *  still `active` in `run`, so each step's own `startTask` → `prepareWorkdir`
 *  reuse-check sees the up-to-date path instead of whatever it was inserted
 *  with (M6). No-op for a row already in sync. */
function propagateWorktreeToActiveSteps(parent: Task, run: PipelineRunState): void {
  for (const a of run.active) {
    const step = tasks.get(a.taskId);
    if (step && (step.worktreePath !== parent.worktreePath || step.branch !== parent.branch)) {
      tasks.update(a.taskId, { worktreePath: parent.worktreePath, branch: parent.branch });
    }
  }
}

// ---------------------------------------------------------------------------
// Launching a step
// ---------------------------------------------------------------------------

type LaunchResult = { ok: true; runId: string; pending?: true } | { ok: false };

/**
 * Launch one step execution: re-verifies the shared worktree (M6), writes
 * every non-null `previous` handoff to `pipelineRunsDir(parent.id)` (via
 * {@link renderHandoffFile}, which wraps the JSON with the untrusted-content
 * warning), composes the step's prompt (D10 — `composeStepPrompt`, which
 * enforces its own 16 KB inline-handoff budget; re-composed with
 * `inlineHandoff: false` on top of that if the gemini argv cap would
 * otherwise be blown once wrapped for launch), inserts the hidden step task
 * (frozen profile fields copied straight from the snapshot — this task will
 * never go through `effectiveAgentProfile`'s "live" branch, see the guard
 * added there), records it in `run.active`/`run.history`, persists, and
 * calls the ordinary `startTask` on it. A worktree failure, step-cap, or
 * profile-missing failure (the latter only reachable if a profile vanished
 * between snapshot capture and this specific launch — buildSnapshot already
 * checked every step up front) records a blocked entry instead of ever
 * calling `startTask`; the worktree/step-cap/profile-missing blocks all
 * carry `pending` (M2) so a later Retry/Advance can re-attempt the exact
 * same launch. `opts.batchSiblingStepIds` (m9) names every OTHER step being
 * launched in the same fan-out batch as this one — passed by the caller
 * up front, before any of them have actually landed in `run.active` yet, so
 * every prompt in the batch sees the full sibling set instead of only
 * whichever ones happened to launch earlier in the loop. Mutates `run` and
 * calls `persist` itself — callers don't need to persist again around this
 * (though doing so is harmless/idempotent).
 */
async function launchStep(
  parent: Task,
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
  opts?: { batchSiblingStepIds?: string[] },
): Promise<LaunchResult> {
  const snapshot = run.snapshot;
  if (!snapshot) {
    upsertBlocked(run, { taskId: null, stepId: step.id, kind: "profile-missing", message: "pipeline run has no snapshot" });
    persist(parent.id, run);
    return { ok: false };
  }

  const pendingArrivals: PipelineJoinArrival[] = previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff }));

  // M6: re-verify the shared worktree right before materializing a new step
  // row against it — a run that's been sitting blocked for a while may have
  // had its worktree cleaned up out from under it.
  const prepared = await refreshParentWorktree(parent);
  if ("error" in prepared) {
    upsertBlocked(run, {
      taskId: null,
      stepId: step.id,
      kind: "step-failed",
      message: `could not prepare the pipeline's worktree: ${prepared.error}`,
      pending: { stepId: step.id, arrivals: pendingArrivals },
    });
    persist(parent.id, run);
    return { ok: false };
  }
  parent = prepared.parent;

  // M7: bail before creating anything if the parent has been (or is being)
  // deleted — a delete cascade that raced this launch through the same
  // per-parent lock will have already removed every step; don't add a new
  // one behind its back.
  if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
    return { ok: false };
  }

  if (run.stepCount >= effectiveStepCap(run)) {
    upsertBlocked(run, {
      taskId: null,
      stepId: step.id,
      kind: "step-cap",
      message: `reached the ${effectiveStepCap(run)}-step cap for this run — retry to keep going, or stop here`,
      pending: { stepId: step.id, arrivals: pendingArrivals },
    });
    persist(parent.id, run);
    return { ok: false };
  }
  const profile = step.agentProfileId ? snapshot.profiles[step.agentProfileId] : undefined;
  if (!profile) {
    upsertBlocked(run, {
      taskId: null,
      stepId: step.id,
      kind: "profile-missing",
      message: `step "${step.name}" has no agent`,
      pending: { stepId: step.id, arrivals: pendingArrivals },
    });
    persist(parent.id, run);
    return { ok: false };
  }

  const seq = ++run.stepCount;

  const runDir = pipelineRunsDir(parent.id);
  mkdirSync(runDir, { recursive: true });
  const previousWithFiles: { stepName: string; handoff: Handoff | null; filePath: string | null }[] = [];
  const handoffRefs: TaskReference[] = [];
  for (const p of previous) {
    const fromStep = snapshot.graph.steps.find((s) => s.id === p.stepId);
    const stepName = fromStep?.name ?? p.stepId;
    let filePath: string | null = null;
    if (p.handoff) {
      filePath = join(runDir, `handoff-${seq}-from-${p.seq}.json`);
      writeFileSync(filePath, renderHandoffFile({ fromStepName: stepName, seq: p.seq, handoff: p.handoff }));
      handoffRefs.push({ path: filePath, isDirectory: false });
    }
    previousWithFiles.push({ stepName, handoff: p.handoff, filePath });
  }

  const outgoing = outgoingSteps(snapshot.graph, step.id).map((o) => ({ name: o.step.name, label: o.edge.label }));
  const siblingNames = new Set<string>();
  for (const a of run.active) {
    if (a.stepId !== step.id) siblingNames.add(stepNameById(snapshot.graph, a.stepId));
  }
  for (const id of opts?.batchSiblingStepIds ?? []) {
    if (id !== step.id) siblingNames.add(stepNameById(snapshot.graph, id));
  }
  const parallelSiblings = [...siblingNames];
  const subagentProfiles = step.subagents.profileIds
    .map((id) => snapshot.profiles[id])
    .filter((p): p is AgentProfileSnapshot => p !== undefined);

  const composeArgs = {
    pipelineName: run.pipelineName,
    step,
    stepIndex: seq,
    stepCap: effectiveStepCap(run),
    goal: parent.prompt,
    previous: previousWithFiles,
    outgoing,
    transition: step.transition,
    subagentProfiles,
    subagentCap: step.subagents.cap,
    parallelSiblings,
  };
  // M10: step tasks carry the parent's own references plus every handoff
  // file this launch just wrote.
  const references: TaskReference[] = [...(parent.references ?? []), ...handoffRefs];

  let composed = composeStepPrompt({ ...composeArgs, inlineHandoff: true });
  // m12/D10: measure the SAME wrapping `startTaskInner` will actually launch
  // with — `composeLaunchPrompt` (the profile's instructions/skills
  // preamble) then `appendReferences` (the references block) — not the raw
  // step prompt on its own, since either wrapper can push a borderline
  // prompt over gemini's argv cap even when the unwrapped text doesn't.
  if (profile.harnessKind === "gemini") {
    const fullPrompt = appendReferences(composeLaunchPrompt(profile, composed), references);
    if (promptByteOverage("gemini", fullPrompt)) {
      composed = composeStepPrompt({ ...composeArgs, inlineHandoff: false });
    }
  }

  const now = Date.now();
  const childId = randomUUID();
  tasks.insert({
    id: childId,
    title: `${run.pipelineName} · ${step.name}`,
    prompt: composed,
    column: "ready",
    agent: profile.harness,
    workdir: parent.workdir,
    isolation: parent.isolation,
    taskType: parent.taskType,
    branch: parent.branch,
    branchSource: parent.branchSource,
    worktreePath: parent.worktreePath,
    baseRef: parent.baseRef,
    prUrl: null,
    issueUrl: null,
    mode: profile.mode,
    model: profile.model,
    effort: profile.effort ?? defaultEffortFor(profile.harnessKind, profile.model, profile.harness),
    fast: profile.fast,
    maxMode: profile.maxMode,
    agentProfileId: profile.id,
    agentProfile: profile,
    references,
    backlog: [],
    draft: null,
    plans: [],
    todoProgress: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    pipelineId: null,
    pipelineRun: null,
    pipelineParentId: parent.id,
    pipelineStepId: step.id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });

  run.active.push({ stepId: step.id, taskId: childId, seq });
  run.history.push({ seq, stepId: step.id, taskId: childId, startedAt: now, endedAt: null, outcome: null, handoff: null, nextStepIds: [] });
  persist(parent.id, run);

  const started = await startTask(childId);

  // M7: the parent may have been deleted WHILE `startTask` was in flight
  // (an unlocked, very-slow spawn racing a delete that queued behind this
  // same launch — belt-and-braces on top of the pre-insert check above).
  if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
    if (!("error" in started)) await deleteTask(childId, { fromPipeline: true });
    return { ok: false };
  }

  if ("error" in started) {
    upsertBlocked(run, { taskId: childId, stepId: step.id, kind: "step-failed", message: started.error });
    persist(parent.id, run);
    return { ok: false };
  }
  return { ok: true, runId: started.runId, ...(started.pending ? { pending: true as const } : {}) };
}

// ---------------------------------------------------------------------------
// Retry (shared by startPipelineRun's "retry a blocked/cancelled run" branch
// and retryPipelineStep)
// ---------------------------------------------------------------------------

async function retryActiveExecutions(
  parent: Task,
  run: PipelineRunState,
  onlyTaskId?: string,
): Promise<{ runId: string; pending?: true } | { error: string }> {
  const targets = run.active.filter((a) => {
    if (onlyTaskId && a.taskId !== onlyTaskId) return false;
    // M5: never re-`startTask` an execution whose task is genuinely still
    // live (a fan-out with one branch blocked and another still mid-turn,
    // or a spawn still settling) — `isTaskRunLive` is the authoritative
    // "is this actually busy right now" check, not `column === "running"`,
    // which can lag a beat behind a just-started/just-settled spawn.
    return !isTaskRunLive(a.taskId);
  });
  if (targets.length === 0) return { error: "nothing to retry" };

  let first: { runId: string; pending?: true } | null = null;
  for (const t of targets) {
    run.blocked = run.blocked.filter((b) => b.taskId !== t.taskId);
    const started = await startTask(t.taskId);
    if ("error" in started) {
      upsertBlocked(run, { taskId: t.taskId, stepId: t.stepId, kind: "step-failed", message: started.error });
    } else if (!first) {
      first = { runId: started.runId, ...(started.pending ? { pending: true as const } : {}) };
    }
  }
  checkJoinIncomplete(run);
  persist(parent.id, run);
  return first ?? { error: "retry failed for every blocked step" };
}

/** Re-attempt every run-level `pending` block (`step-cap`/`profile-missing`/
 *  a worktree failure/`join-incomplete`) — M2's "dead-end" recovery: a block
 *  with nothing in `run.active` to retry via `retryActiveExecutions` would
 *  otherwise have no way forward at all besides a full restart. A `step-cap`
 *  block's retry first extends the run's allowance (`run.capExtensions`);
 *  a `join-incomplete` block's retry drops the now-redundant `run.joins`
 *  entry (the pending arrivals travel with the block itself) before
 *  re-launching. Returns the first successful launch's result, or `null`
 *  when there was nothing pending (or every pending launch itself re-blocked).
 *  Never persists itself — callers persist once after, alongside whatever
 *  else they touched. */
async function retryPendingBlocks(
  parent: Task,
  run: PipelineRunState,
): Promise<{ runId: string; pending?: true } | null> {
  const pendingBlocks = run.blocked.filter((b) => b.taskId === null && b.pending);
  let first: { runId: string; pending?: true } | null = null;
  for (const block of pendingBlocks) {
    const pending = block.pending;
    if (!pending) continue;
    if (block.kind === "step-cap") {
      run.capExtensions = (run.capExtensions ?? 0) + 1;
    }
    run.blocked = run.blocked.filter((b) => b !== block);
    if (block.kind === "join-incomplete") delete run.joins[pending.stepId];
    const step = run.snapshot?.graph.steps.find((s) => s.id === pending.stepId);
    if (!step) continue;
    const previous = pending.arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
    const launched = await launchStep(parent, run, step, previous);
    if (launched.ok && !first) first = { runId: launched.runId, ...(launched.pending ? { pending: true as const } : {}) };
  }
  return first;
}

/**
 * Shared retry path for `startPipelineRun`'s "blocked/cancelled" branch and
 * `retryPipelineStep`: refuses an archived parent (M6), re-verifies the
 * shared worktree and propagates it onto every still-active step row, then
 * retries whatever's retryable — active executions first, and (unless a
 * specific `onlyTaskId` was given, which can only ever name an active
 * execution) every run-level pending block too (M2). Never starts a fresh
 * run — a blocked/cancelled pipeline is retried, not restarted.
 */
async function performPipelineRetry(
  parent: Task,
  run: PipelineRunState,
  onlyTaskId?: string,
): Promise<{ runId: string; pending?: true } | { error: string }> {
  if (parent.archivedAt != null) {
    return { error: "pipeline task is archived — unarchive it first" };
  }
  const refreshed = await refreshParentWorktree(parent);
  if ("error" in refreshed) return { error: refreshed.error };
  const parentRow = refreshed.parent;
  propagateWorktreeToActiveSteps(parentRow, run);

  const activeResult = await retryActiveExecutions(parentRow, run, onlyTaskId);
  let result: { runId: string; pending?: true } | null = "error" in activeResult ? null : activeResult;

  if (!onlyTaskId) {
    const pendingResult = await retryPendingBlocks(parentRow, run);
    if (pendingResult || pendingResult === null) {
      checkJoinIncomplete(run);
      persist(parentRow.id, run);
    }
    if (pendingResult && !result) result = pendingResult;
  }

  if (!result) {
    return "error" in activeResult ? { error: activeResult.error } : { error: "nothing to retry" };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API — manual route entry points
// ---------------------------------------------------------------------------

/**
 * Run (or retry) a pipeline task. Called from `orchestrator.ts`'s
 * `startTaskInner` whenever `task.pipelineId` is set — the parent never
 * spawns an agent of its own, so this bypasses every harness/worktree/
 * prompt pre-flight `startTaskInner` normally runs (each hidden step task
 * gets its own, via the ordinary `startTask` call inside `launchStep`).
 *
 * A `blocked`/`cancelled` run is always retried in place (`performPipelineRetry`
 * — never a fresh run, M2); a `done` run refuses unless `opts.restart` is
 * set (the `POST /tasks/:id/pipeline/restart` route's explicit opt-in),
 * since re-running a finished pipeline from scratch is destructive to its
 * history and should never happen from a plain Run click.
 */
export async function startPipelineRun(
  parent: Task,
  opts?: { restart?: boolean },
): Promise<{ runId: string; pending?: true } | { error: string }> {
  return runExclusive(parent.id, async () => {
    const fresh = tasks.get(parent.id) ?? parent;
    if (!fresh.pipelineId) return { error: "not a pipeline task" };
    if (fresh.archivedAt != null) return { error: "pipeline task is archived — unarchive it first" };

    let run: PipelineRunState = fresh.pipelineRun ?? {
      pipelineId: fresh.pipelineId,
      pipelineName: fresh.title,
      snapshot: null,
      status: "idle",
      active: [],
      joins: {},
      blocked: [],
      history: [],
      stepCount: 0,
      startedAt: null,
      endedAt: null,
    };

    if (run.status === "running") return { error: "pipeline is already running" };

    // M2: blocked/cancelled is ALWAYS a retry-in-place, whether or not
    // anything is currently sitting in `run.active` — a run-level pending
    // block (step-cap, profile-missing, join-incomplete) with zero active
    // executions used to fall through to the "fresh run" branch below,
    // silently discarding history and re-snapshotting from scratch.
    if (run.status === "blocked" || run.status === "cancelled") {
      return performPipelineRetry(fresh, run);
    }

    if (run.status === "done" && !opts?.restart) {
      return { error: "pipeline already finished — restart it explicitly" };
    }

    // Fresh run (idle, or an explicit restart of a finished run): re-resolve
    // the pipeline and (re-)snapshot it.
    const pipeline = pipelines.get(fresh.pipelineId);
    let snapshot: PipelineRunSnapshot;
    if (pipeline) {
      const built = buildSnapshot(pipeline, Date.now());
      if ("error" in built) return { error: built.error };
      snapshot = built.snapshot;
    } else if (run.snapshot) {
      snapshot = run.snapshot;
    } else {
      return { error: "pipeline no longer exists, and this task has never run it" };
    }

    const startStep = resolveStartStep(snapshot.graph);
    if (!startStep) return { error: "pipeline has no resolvable start step" };

    run = {
      pipelineId: fresh.pipelineId,
      pipelineName: pipeline?.name ?? run.pipelineName,
      snapshot,
      status: "running",
      active: [],
      joins: {},
      blocked: [],
      history: [],
      stepCount: 0,
      startedAt: Date.now(),
      endedAt: null,
    };

    // Materialize the shared worktree ONCE, here — every step task inserted
    // below copies `branch`/`worktreePath`/`baseRef` straight from the
    // parent, so `prepareWorkdir` on each step hits the reuse branch with no
    // further git calls (D2). `launchStep` re-verifies this itself too
    // (M6), but doing it up front also lets us flip the parent to `running`
    // before the first step lands.
    const prepared = await refreshParentWorktree(fresh);
    if ("error" in prepared) return { error: prepared.error };
    let parentRow = prepared.parent;

    pipelineUpdateColumn(parentRow.id, null, "running");
    parentRow = tasks.get(parentRow.id) ?? parentRow;

    const result = await launchStep(parentRow, run, startStep, []);
    checkJoinIncomplete(run);
    persist(parentRow.id, run);
    if (!result.ok) {
      return { error: "pipeline failed to start — see the run's blocked step for details" };
    }
    return { runId: result.runId, ...(result.pending ? { pending: true as const } : {}) };
  });
}

/**
 * Manually resolve whatever a pipeline run is currently waiting on: the
 * execution named by `opts.fromTaskId`, else the sole blocked-on-handoff
 * execution (`handoff-missing`/`handoff-invalid`, or a step that reported
 * `status:"blocked"` in its own handoff — M1), else the sole
 * `join-incomplete` run-level block (launches that join step now, with
 * whatever handoffs arrived), else the sole active execution sitting in
 * `review` — 409 otherwise. `opts.nextStepIds: null` ends that path
 * (terminal); a non-null array launches each named step (joins bypassed —
 * a manual advance into a join step runs it with whatever arrived).
 *
 * Refuses (409) an archived parent (M6) and a target execution whose task
 * still has a genuinely live run (M4 — `isTaskRunLive`, not `column`): you
 * can't hand-pick the next step for a turn that hasn't actually finished.
 */
export async function advancePipeline(
  parentId: string,
  opts: { nextStepIds: string[] | null; handoff?: Partial<Handoff>; fromTaskId?: string },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (parent.archivedAt != null) {
      return { error: "pipeline task is archived — unarchive it first", status: 409 as const };
    }
    if (!parent.pipelineRun || !parent.pipelineRun.snapshot) {
      return { error: "pipeline has never run", status: 409 as const };
    }
    const run: PipelineRunState = parent.pipelineRun;
    const graph = run.snapshot!.graph;

    const refreshed = await refreshParentWorktree(parent);
    if ("error" in refreshed) return { error: refreshed.error, status: 409 as const };
    let parentRow = refreshed.parent;
    propagateWorktreeToActiveSteps(parentRow, run);

    let targetTaskId: string | null = null;
    let joinStepId: string | null = null;

    if (opts.fromTaskId) {
      if (!run.active.some((a) => a.taskId === opts.fromTaskId)) {
        return { error: "no active execution for that task", status: 400 as const };
      }
      targetTaskId = opts.fromTaskId;
    } else {
      // M1: a step that reported `status:"blocked"` in its own (otherwise
      // valid) handoff is recorded as a `step-blocked` entry WITH a taskId —
      // fold it into the same auto-detect set as an unparsable handoff, so
      // a lone blocked-on-handoff execution resolves the same way regardless
      // of which of the three reasons produced it.
      const handoffBlocks = run.blocked.filter(
        (b) => b.taskId !== null && (b.kind === "handoff-missing" || b.kind === "handoff-invalid" || b.kind === "step-blocked"),
      );
      const joinBlocks = run.blocked.filter((b) => b.taskId === null && b.kind === "join-incomplete");
      if (handoffBlocks.length === 1 && joinBlocks.length === 0) {
        targetTaskId = handoffBlocks[0]!.taskId;
      } else if (joinBlocks.length === 1 && handoffBlocks.length === 0) {
        joinStepId = joinBlocks[0]!.stepId;
      } else {
        const reviewCandidates = run.active.filter((a) => tasks.get(a.taskId)?.column === "review");
        if (reviewCandidates.length === 1) {
          targetTaskId = reviewCandidates[0]!.taskId;
        } else {
          return { error: "nothing to advance — specify fromTaskId", status: 409 as const };
        }
      }
    }

    if (joinStepId) {
      // M3: `nextStepIds: null` drops the partial join outright — it never
      // arrives, this path is over, and the run's status/blocked state is
      // simply recomputed (which may surface a DIFFERENT, still-pending
      // join elsewhere, or resolve the whole run to `done`). A non-null
      // list launches each named step; only the one that IS the join step
      // itself gets the accumulated arrivals as `previous` — any other
      // step named alongside it is an arbitrary manual choice unrelated to
      // this join and starts with no prior context.
      if (opts.nextStepIds !== null) {
        for (const id of opts.nextStepIds) {
          if (!graph.steps.some((s) => s.id === id)) return { error: `unknown step id "${id}"`, status: 400 as const };
        }
      }
      const arrivals = run.joins[joinStepId]?.arrivals ?? [];
      delete run.joins[joinStepId];
      run.blocked = run.blocked.filter((b) => !(b.stepId === joinStepId && b.kind === "join-incomplete"));

      const joinTargets = opts.nextStepIds === null ? [] : [...new Set(opts.nextStepIds)];
      for (const nid of joinTargets) {
        const targetStep = graph.steps.find((s) => s.id === nid);
        if (!targetStep) continue;
        const previous = nid === joinStepId
          ? arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }))
          : [];
        await launchStep(parentRow, run, targetStep, previous, { batchSiblingStepIds: joinTargets });
      }

      checkJoinIncomplete(run);
      persist(parentId, run);
      return { task: tasks.get(parentId)! };
    }

    if (!targetTaskId) return { error: "nothing to advance", status: 409 as const };
    const activeEntry = run.active.find((a) => a.taskId === targetTaskId);
    if (!activeEntry) return { error: "no active execution for that task", status: 400 as const };

    // M4: refuse to hand-pick a next step for a turn that's still actually
    // in flight — `isTaskRunLive`, not the (laggier) task column.
    if (isTaskRunLive(targetTaskId)) {
      return { error: "step is still running — stop it before advancing", status: 409 as const };
    }

    if (opts.nextStepIds !== null) {
      for (const id of opts.nextStepIds) {
        if (!graph.steps.some((s) => s.id === id)) return { error: `unknown step id "${id}"`, status: 400 as const };
      }
    }
    const nextStepIds = opts.nextStepIds === null ? [] : [...new Set(opts.nextStepIds)];

    // m13: a manual-advance handoff goes through the SAME normalize/cap
    // pipeline a parsed one does (`normalizeHandoff`); `next` defaults to
    // the target step's NAME (matching what `resolveNextSteps` itself
    // matches against), not its id — an explicit `opts.handoff.next` still
    // wins when given.
    const fallbackNextName = nextStepIds.length === 1 ? stepNameById(graph, nextStepIds[0]!) : null;
    const handoffInput: Record<string, unknown> = { reason: "manually advanced", ...opts.handoff };
    if (!(typeof handoffInput.next === "string" && handoffInput.next.trim().length > 0)) {
      handoffInput.next = fallbackNextName;
    }
    const handoff = normalizeHandoff(handoffInput);

    const historyEntry = run.history.find((h) => h.taskId === targetTaskId && h.seq === activeEntry.seq);
    run.active = run.active.filter((a) => a.taskId !== targetTaskId);
    removeBlockedFor(run, targetTaskId);
    if (historyEntry) {
      historyEntry.endedAt = Date.now();
      historyEntry.outcome = "advanced-manually";
      historyEntry.handoff = handoff;
      historyEntry.nextStepIds = nextStepIds;
    }
    pipelineUpdateColumn(targetTaskId, tasks.get(targetTaskId)?.runId ?? null, "done");

    // m9: every target launched in THIS batch counts as a parallel sibling
    // of every other one — computed up front so the first step launched
    // sees the last one too, not just whichever already landed in
    // `run.active` by the time its own turn in the loop comes up.
    for (const nid of nextStepIds) {
      const targetStep = graph.steps.find((s) => s.id === nid);
      if (!targetStep) continue;
      if (targetStep.join === "all") {
        const arrivals = addJoinArrival(run.joins[nid]?.arrivals ?? [], { fromStepId: activeEntry.stepId, seq: activeEntry.seq, handoff });
        const incoming = incomingSteps(graph, nid);
        const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
        const complete = incoming.every((i) => arrivedIds.has(i.step.id));
        if (complete) {
          delete run.joins[nid];
          await launchStep(parentRow, run, targetStep, arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })), { batchSiblingStepIds: nextStepIds });
        } else {
          run.joins[nid] = { arrivals };
        }
      } else {
        await launchStep(parentRow, run, targetStep, [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff }], { batchSiblingStepIds: nextStepIds });
      }
    }

    checkJoinIncomplete(run);
    persist(parentId, run);
    return { task: tasks.get(parentId)! };
  });
}

/**
 * Retry every currently-blocked (or, for a stopped run, every non-live)
 * active execution — or just `opts.taskId`'s, when given — plus (when no
 * specific `opts.taskId` was given) every run-level pending block (M2).
 * 409 unless the run is `blocked`/`cancelled`, or the parent is archived.
 */
export async function retryPipelineStep(
  parentId: string,
  opts?: { taskId?: string },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;
    if (run.status !== "blocked" && run.status !== "cancelled") {
      return { error: "pipeline is not blocked or cancelled", status: 409 as const };
    }
    const result = await performPipelineRetry(parent, run, opts?.taskId);
    if ("error" in result) return { error: result.error, status: 409 as const };
    return { task: tasks.get(parentId)! };
  });
}

/**
 * Stop every currently-running active execution (D9: "Stop on the parent
 * cancels every active execution and returns the parent to ready … active
 * set kept so Run retries them"). 409 when nothing is actually live
 * (M5 — `isTaskRunLive`, not `column`).
 */
export async function cancelPipelineRun(parentId: string): Promise<{ task: Task } | { error: string; status: 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;

    const runningTargets = run.active.filter((a) => isTaskRunLive(a.taskId));
    if (runningTargets.length === 0) return { error: "pipeline is not running", status: 409 as const };

    for (const t of runningTargets) {
      const runId = tasks.get(t.taskId)?.runId;
      if (runId) await cancelRun(runId);
    }

    run.status = "cancelled";
    persist(parentId, run, { preserveStatus: true });
    return { task: tasks.get(parentId)! };
  });
}

// ---------------------------------------------------------------------------
// Cascades (orchestrator.ts's deleteTask/archiveTask call into these)
// ---------------------------------------------------------------------------

/** Delete every step task of pipeline task `parentId`, then remove its
 *  `pipeline-runs` directory (handoff JSON files). Best-effort per step —
 *  `deleteTask` itself already swallows teardown errors internally.
 *  Tombstones `parentId` FIRST (M7) so any launch still in flight (racing
 *  in via the same `withPipelineLock`-serialized chain, or — belt-and-braces
 *  — landing outside it) bails instead of inserting a step behind this
 *  cascade's back. */
export async function cascadePipelineDelete(parentId: string): Promise<void> {
  tombstonedPipelineParents.add(parentId);
  for (const step of tasks.stepsForParent(parentId)) {
    await deleteTask(step.id, { fromPipeline: true });
  }
  try {
    rmSync(pipelineRunsDir(parentId), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[agetor] failed to remove pipeline run dir for ${parentId}:`, e);
  }
}

/** Archive every not-yet-archived step task of pipeline task `parentId`.
 *  Best-effort — a step that refuses to archive (logged) doesn't block the
 *  rest, or the parent's own subsequent archive. */
export async function cascadePipelineArchive(parentId: string): Promise<void> {
  for (const step of tasks.stepsForParent(parentId)) {
    if (step.archivedAt != null) continue;
    const result = await archiveTask(step.id, { force: true, stopRun: true, fromPipeline: true });
    if ("error" in result) {
      console.warn(`[agetor] failed to archive pipeline step task ${step.id}:`, result.error);
    }
  }
}

// ---------------------------------------------------------------------------
// Settle/column event handling
// ---------------------------------------------------------------------------

async function handleRunStatus(
  taskId: string,
  runId: string,
  status: "succeeded" | "failed" | "cancelled" | "orphaned",
): Promise<void> {
  const task = tasks.get(taskId);
  const parentId = task?.pipelineParentId;
  if (!task || !parentId) return;

  await runExclusive(parentId, async () => {
    try {
      const parent = tasks.get(parentId);
      if (!parent || !parent.pipelineRun || !parent.pipelineRun.snapshot) return;
      const run = parent.pipelineRun;
      const activeIdx = run.active.findIndex((a) => a.taskId === taskId);
      if (activeIdx === -1) return;
      const activeEntry = run.active[activeIdx]!;
      const graph = run.snapshot!.graph;
      const stepName = stepNameById(graph, activeEntry.stepId);
      const historyEntry = run.history.find((h) => h.taskId === taskId && h.seq === activeEntry.seq);

      if (status === "succeeded") {
        const parsed = parseHandoff(assistantTextForRun(runId));
        if (!parsed.ok) {
          const kind: PipelineBlockKind = parsed.raw === null ? "handoff-missing" : "handoff-invalid";
          const detail = parsed.raw === null
            ? `step "${stepName}" finished but never emitted a <handoff> block`
            : `step "${stepName}" emitted a <handoff> block agetor couldn't parse: ${parsed.error}`;
          upsertBlocked(run, { taskId, stepId: activeEntry.stepId, kind, message: detail });
          checkJoinIncomplete(run);
          persist(parentId, run);
          return;
        }

        // M1: a step can emit a perfectly valid handoff and still report it
        // could not finish (`status:"blocked"`) — record it on the history
        // entry (so the blocked reason and the step's own summary/artifacts
        // are visible), but do NOT resolve/advance: the execution stays in
        // `run.active` exactly like an unresolved handoff, waiting on a
        // Retry (re-run the step) or a manual Advance.
        if (parsed.handoff.status === "blocked") {
          const oq = parsed.handoff.openQuestions.length > 0
            ? ` (open questions: ${parsed.handoff.openQuestions.join("; ")})`
            : "";
          const reasonText = parsed.handoff.reason.trim().length > 0 ? parsed.handoff.reason : "no reason given";
          upsertBlocked(run, {
            taskId,
            stepId: activeEntry.stepId,
            kind: "step-blocked",
            message: `step "${stepName}" reported it is blocked: ${reasonText}${oq}`,
          });
          if (historyEntry) historyEntry.handoff = parsed.handoff;
          checkJoinIncomplete(run);
          persist(parentId, run);
          return;
        }

        const resolved = resolveNextSteps(graph, activeEntry.stepId, parsed.handoff);
        if (resolved.kind === "ambiguous" || resolved.kind === "unknown") {
          const candidates = resolved.candidates.join(", ") || "(no outgoing steps)";
          const message = resolved.kind === "ambiguous"
            ? `step "${stepName}" finished but didn't say which step comes next — choices: ${candidates}`
            : `step "${stepName}" asked for step "${resolved.next}", which doesn't match any of: ${candidates}`;
          upsertBlocked(run, { taskId, stepId: activeEntry.stepId, kind: "handoff-invalid", message });
          checkJoinIncomplete(run);
          persist(parentId, run);
          return;
        }

        // Resolved (terminal or a real set of next steps) — this execution is
        // done. Remove it, mark history, move the step task to `done`.
        run.active.splice(activeIdx, 1);
        removeBlockedFor(run, taskId);
        const nextStepIds = resolved.kind === "steps" ? resolved.stepIds : [];
        if (historyEntry) {
          historyEntry.endedAt = Date.now();
          historyEntry.outcome = "succeeded";
          historyEntry.handoff = parsed.handoff;
          historyEntry.nextStepIds = nextStepIds;
        }
        pipelineUpdateColumn(taskId, runId, "done");

        const parentForLaunch = tasks.get(parentId) ?? parent;
        for (const nid of nextStepIds) {
          const targetStep = graph.steps.find((s) => s.id === nid);
          if (!targetStep) continue;
          if (targetStep.join === "all") {
            const arrivals = addJoinArrival(run.joins[nid]?.arrivals ?? [], {
              fromStepId: activeEntry.stepId,
              seq: activeEntry.seq,
              handoff: parsed.handoff,
            });
            const incoming = incomingSteps(graph, nid);
            const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
            const complete = incoming.every((i) => arrivedIds.has(i.step.id));
            if (complete) {
              delete run.joins[nid];
              await launchStep(
                parentForLaunch,
                run,
                targetStep,
                arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })),
                { batchSiblingStepIds: nextStepIds },
              );
            } else {
              run.joins[nid] = { arrivals };
            }
          } else {
            await launchStep(
              parentForLaunch,
              run,
              targetStep,
              [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff: parsed.handoff }],
              { batchSiblingStepIds: nextStepIds },
            );
          }
        }

        checkJoinIncomplete(run);
        persist(parentId, run);
        return;
      }

      if (status === "failed") {
        const tail = lastStatusLineForRun(runId);
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-failed",
          message: tail ? `step "${stepName}" failed — ${tail}` : `step "${stepName}" failed`,
        });
        if (historyEntry) {
          historyEntry.endedAt = Date.now();
          historyEntry.outcome = "failed";
        }
        persist(parentId, run);
        return;
      }

      // cancelled / orphaned: clean up any blocked entry for this execution,
      // keep it in `active` (retry finds it there), and mark its history
      // outcome. M5: whether this also forces the WHOLE run to `cancelled`
      // (and the parent back to `ready`) depends on whether any OTHER
      // execution is still genuinely live — a Stop pressed from this one
      // step's own panel (a fan-out sibling keeps running) must not cancel
      // the run out from under the sibling; only the "nothing else is live"
      // case (including `cancelPipelineRun`'s own already-set status,
      // idempotently reaffirmed here) collapses the whole run.
      removeBlockedFor(run, taskId);
      if (historyEntry) {
        historyEntry.endedAt = Date.now();
        historyEntry.outcome = "cancelled";
      }
      const otherLive = run.active.some((a) => a.taskId !== taskId && isTaskRunLive(a.taskId));
      if (otherLive) {
        persist(parentId, run);
      } else {
        run.status = "cancelled";
        persist(parentId, run, { preserveStatus: true });
      }
    } catch (err) {
      persistReconcileFailure(parentId, taskId, err);
    }
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed handling run-status for task ${taskId}:`, err);
  });
}

type ColumnGlobalEvent = Extract<GlobalEvent, { kind: "column" }>;

async function handleColumnChange(
  taskId: string,
  column: ColumnId,
  reason: ColumnGlobalEvent["reason"],
): Promise<void> {
  // "pipeline"-reasoned transitions are the runner's OWN column writes
  // (`pipelineUpdateColumn`) — reprocessing them here would be at best
  // redundant, at worst a feedback loop.
  if (reason === "pipeline") return;
  const task = tasks.get(taskId);
  const parentId = task?.pipelineParentId;
  if (!task || !parentId) return;

  await runExclusive(parentId, async () => {
    try {
      const parent = tasks.get(parentId);
      if (!parent || !parent.pipelineRun) return;
      const run = parent.pipelineRun;
      const activeEntry = run.active.find((a) => a.taskId === taskId);
      if (!activeEntry) return;

      if (column === "blocked") {
        const stepName = run.snapshot ? stepNameById(run.snapshot.graph, activeEntry.stepId) : activeEntry.stepId;
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-blocked",
          message: reasonMessage(reason, stepName),
        });
        persist(parentId, run);
      } else if (column === "running") {
        // m11: a step task genuinely running again (a manual resend from
        // its own panel, or a retry) clears ANY block that named it —
        // not just a column-reasoned `step-blocked` one, since a
        // handoff-missing/invalid/step-cap-adjacent block naming this task
        // is equally stale the moment it's actually running again — and
        // resets its history record's outcome/endedAt so it reads as
        // in-flight, not as whatever it last settled as.
        const beforeLen = run.blocked.length;
        run.blocked = run.blocked.filter((b) => b.taskId !== taskId);
        let changed = run.blocked.length !== beforeLen;
        const historyEntry = run.history.find((h) => h.taskId === taskId && h.seq === activeEntry.seq);
        if (historyEntry && (historyEntry.outcome !== null || historyEntry.endedAt !== null)) {
          historyEntry.outcome = null;
          historyEntry.endedAt = null;
          changed = true;
        }
        if (changed) persist(parentId, run);
      }
    } catch (err) {
      persistReconcileFailure(parentId, taskId, err);
    }
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed handling column change for task ${taskId}:`, err);
  });
}

// ---------------------------------------------------------------------------
// Boot-time (or test-time) self-heal for a missed settle (M16)
// ---------------------------------------------------------------------------

/** Record `taskId`'s active execution as failed with "step never started" —
 *  used by {@link reconcilePipelineRuns} for an active entry whose task has
 *  no run row at all (the insert landed but `startTask` itself never
 *  actually produced a run, e.g. a crash between the two). */
function markStepNeverStarted(parentId: string, taskId: string): void {
  const parent = tasks.get(parentId);
  if (!parent || !parent.pipelineRun) return;
  const run = parent.pipelineRun;
  const idx = run.active.findIndex((a) => a.taskId === taskId);
  if (idx === -1) return;
  const entry = run.active[idx]!;
  const stepName = run.snapshot ? stepNameById(run.snapshot.graph, entry.stepId) : entry.stepId;
  upsertBlocked(run, { taskId, stepId: entry.stepId, kind: "step-failed", message: `step "${stepName}" never started` });
  const h = run.history.find((x) => x.taskId === taskId && x.seq === entry.seq);
  if (h) {
    h.endedAt = Date.now();
    h.outcome = "failed";
  }
  checkJoinIncomplete(run);
  persist(parentId, run);
}

/**
 * Self-heal pass for a step settle the runner's `subscribeGlobal` listener
 * never saw — the boot-time case (`index.ts`/`headless.ts` call this right
 * after `reconcileOrphans()`, per the module doc) where `reconcileOrphans`
 * itself already re-emitted `run-status`/`column` events for anything it
 * touched (so most cases are already handled by the time this runs), plus
 * any edge case where a step's run genuinely resolved with nobody listening
 * (e.g. in tests, or a process crash between the run settling and this
 * runner's own handler completing).
 *
 * For every non-archived pipeline parent whose run is `running` (or
 * `blocked` with at least one still-`active` execution), walks every active
 * entry: skips it if `isTaskRunLive` says it's genuinely still busy;
 * otherwise reads that step task's latest run row and feeds it through the
 * exact same settle path `handleRunStatus` uses for a live event
 * (`succeeded`/`failed`/`cancelled`/`orphaned`), or — no run row at all —
 * marks it `step-failed` "never started". Each entry's own handling is
 * wrapped so a throw records a `step-failed` block (via
 * `persistReconcileFailure`) instead of silently leaving that one execution
 * stuck forever while the rest of the sweep continues. Returns how many
 * entries this pass actually reconciled.
 */
export async function reconcilePipelineRuns(): Promise<number> {
  let count = 0;
  const parents = tasks.list().filter((t) => {
    if (t.pipelineId == null || t.pipelineParentId != null || t.archivedAt != null || !t.pipelineRun) return false;
    const status = t.pipelineRun.status;
    return status === "running" || (status === "blocked" && t.pipelineRun.active.length > 0);
  });

  for (const parent of parents) {
    const activeSnapshot = parent.pipelineRun!.active.slice();
    for (const a of activeSnapshot) {
      if (isTaskRunLive(a.taskId)) continue;
      try {
        const stepRuns = runs.listForTask(a.taskId);
        const latest = stepRuns[0] ?? null;
        if (!latest) {
          await runExclusive(parent.id, async () => markStepNeverStarted(parent.id, a.taskId));
          count++;
        } else if (latest.status !== "running") {
          await handleRunStatus(a.taskId, latest.id, latest.status);
          count++;
        }
      } catch (err) {
        await runExclusive(parent.id, async () => persistReconcileFailure(parent.id, a.taskId, err)).catch(() => {});
      }
    }
  }
  return count;
}

let runnerInitialized = false;

/** Test-only kill switch for the subscribed listener below — lets a test
 *  simulate a step settle the runner's listener never saw at all (M16: "a
 *  process crash between the run settling and this runner's own handler
 *  completing", or simply this process never having been subscribed for
 *  that event), so `reconcilePipelineRuns` has something real to catch.
 *  Defaults to enabled; production code never touches this. */
let listenerEnabled = true;

/**
 * Subscribe the runner to the orchestrator's global lifecycle stream.
 * Idempotent — safe to call more than once (a second call is a no-op).
 * `index.ts`/`headless.ts` call this once, at boot, immediately BEFORE
 * `reconcileOrphans()` — so a step task's own boot-time orphan→ready
 * transition (fired by `reconcileOrphans` as an ordinary `run-status`
 * "orphaned" event) reaches this listener and flips its pipeline parent
 * back to `ready`/`cancelled`-with-retry, the same as a live cancellation.
 */
export function initPipelineRunner(): void {
  if (runnerInitialized) return;
  runnerInitialized = true;
  subscribeGlobal((e: GlobalEvent) => {
    if (!listenerEnabled) return;
    if (e.kind === "run-status") {
      void handleRunStatus(e.taskId, e.runId, e.status);
    } else if (e.kind === "column") {
      void handleColumnChange(e.taskId, e.column, e.reason);
    }
  });
}

/** Test-only seam (`pipeline-runner.test.ts`) — see `listenerEnabled`'s doc
 *  above and `handleRunStatus`'s own doc for why a test needs to call it
 *  directly to simulate a missed settle. Never imported outside this
 *  module's own test file. */
export const __forTest = {
  setListenerEnabled(enabled: boolean): void {
    listenerEnabled = enabled;
  },
  handleRunStatus,
};
