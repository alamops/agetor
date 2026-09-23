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
  isTaskRunCancelling,
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
  validatePipelineGraph,
} from "../shared/pipeline.ts";
import { promptByteOverage } from "../shared/prompt-limits.ts";
import { appendReferences } from "../shared/refs.ts";
import type {
  AgentProfileSnapshot,
  ColumnId,
  GlobalEvent,
  Handoff,
  Pipeline,
  PipelineActiveStep,
  PipelineBlock,
  PipelineBlockKind,
  PipelineGraph,
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

/**
 * Force `run.status = "cancelled"` and persist it that way — UNLESS
 * something is still genuinely blocked (Minor 6), in which case persisting
 * normally (letting `deriveRunStatus` recompute) keeps that blocked reason
 * visible instead of silently overwriting it with a bare, unexplained
 * "cancelled" — `deriveRunStatus` already treats `blocked` as
 * higher-priority than `cancelled`/`idle`, so this is a no-op change in
 * outcome for the "nothing blocked" case and a strict improvement for the
 * "something's blocked" one. Shared by `cancelPipelineRun` and
 * `handleRunStatus`'s cancelled/orphaned-with-nothing-else-live branch —
 * and, transitively, `reconcilePipelineRuns`, which drives missed settles
 * through that same `handleRunStatus` path at boot.
 */
function finalizeCancelled(parentId: string, run: PipelineRunState): void {
  if (run.blocked.length === 0) {
    run.status = "cancelled";
    persist(parentId, run, { preserveStatus: true });
  } else {
    persist(parentId, run);
  }
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
 * Freeze `graph` plus every agent profile any step (or any step's
 * `subagents.profileIds`) references, at `now`. Fails — refusing to start
 * the run at all, per D8/Done-criteria #7 — when any step has no
 * `agentProfileId`, a referenced profile no longer exists, or that
 * profile's own harness no longer resolves. `graph` is expected to already
 * be the NORMALIZED output of {@link validatePipelineGraph} (Major 5) — the
 * caller runs that validation, since it also needs to decide what to do
 * with an invalid stored graph before ever reaching this far.
 */
function buildSnapshot(
  graph: PipelineGraph,
  maxSteps: number,
  now: number,
): { snapshot: PipelineRunSnapshot } | { error: string } {
  const neededIds = new Set<string>();
  for (const step of graph.steps) {
    if (!step.agentProfileId) return { error: `step "${step.name}" has no agent` };
    neededIds.add(step.agentProfileId);
    for (const id of step.subagents.profileIds) neededIds.add(id);
  }
  const profiles: Record<string, AgentProfileSnapshot> = {};
  for (const id of neededIds) {
    const profile = agentProfiles.get(id);
    if (!profile) {
      const owner = graph.steps.find((s) => s.agentProfileId === id)?.name;
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
    snapshot: { graph, maxSteps, profiles, capturedAt: now },
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

/** Record a retryable run-level hold for `step` instead of launching it —
 *  used whenever the pipeline's parent task turns out to be archived (Major
 *  2): the settle/advance that would otherwise launch this step still has
 *  to land somewhere persistable, but must never insert a new step task or
 *  touch the parent's worktree while it's archived. `pending` carries
 *  `previous`'s arrivals so a later Retry (once the task is unarchived)
 *  re-attempts the exact same launch. Note `pending.stepId` (throughout this
 *  module) is always set — every call site that builds a `pending` block
 *  names the step the retry should re-launch; nothing ever constructs one
 *  without it. */
function holdForArchivedParent(
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
): void {
  upsertBlocked(run, {
    taskId: null,
    stepId: step.id,
    kind: "step-failed",
    message: `step "${step.name}" is ready to launch, but the pipeline task is archived — unarchive it and retry`,
    pending: {
      stepId: step.id,
      arrivals: previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff })),
    },
  });
}

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
 * whichever ones happened to launch earlier in the loop. `opts.
 * skipWorktreeRefresh` (Minor 15) lets a caller that already refreshed the
 * parent's worktree ONCE for a whole batch of targets (a fan-out settle, or
 * `advancePipeline`'s own up-front refresh) skip this function's own
 * redundant per-call refresh — `parent` is then trusted to already be
 * current. Mutates `run` and calls `persist` itself — callers don't need to
 * persist again around this (though doing so is harmless/idempotent).
 */
async function launchStep(
  parent: Task,
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
  opts?: { batchSiblingStepIds?: string[]; skipWorktreeRefresh?: boolean },
): Promise<LaunchResult> {
  const snapshot = run.snapshot;
  if (!snapshot) {
    upsertBlocked(run, { taskId: null, stepId: step.id, kind: "profile-missing", message: "pipeline run has no snapshot" });
    persist(parent.id, run);
    return { ok: false };
  }

  const pendingArrivals: PipelineJoinArrival[] = previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff }));

  // Minor 7 / Major 2: check the parent still exists, isn't mid-delete, and
  // isn't archived BEFORE touching its worktree at all — a delete cascade or
  // an archive that raced this launch through the same per-parent lock (or,
  // belt-and-braces, landed outside it) must never have a step inserted, or
  // the worktree refreshed, behind its back.
  const currentParent = tasks.get(parent.id);
  if (tombstonedPipelineParents.has(parent.id) || !currentParent) {
    return { ok: false };
  }
  if (currentParent.archivedAt != null) {
    holdForArchivedParent(run, step, previous);
    persist(parent.id, run);
    return { ok: false };
  }
  parent = currentParent;

  // M6: re-verify the shared worktree right before materializing a new step
  // row against it — a run that's been sitting blocked for a while may have
  // had its worktree cleaned up out from under it.
  if (!opts?.skipWorktreeRefresh) {
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

/**
 * `launchStep` wrapped so a throw from the launch itself can never abort the
 * rest of a multi-target batch (Minor 14) — used by every loop that can
 * resolve to more than one next step from a single settle or manual advance
 * (a `transition: "all"` fan-out, several hand-picked `advancePipeline`
 * targets, or a join that just completed alongside other targets in the
 * same batch), and by `retryPendingBlocks` (Minor 7) for the exact same
 * throw-safety. Distinguishes WHERE the throw landed (Minor 6): if
 * `launchStep` had already inserted the step task (visible as a new entry
 * in `run.active` for `step.id` that wasn't there before this call), the
 * block is recorded against THAT task (`taskId: <inserted>`, no `pending`)
 * so Retry re-runs the already-inserted execution in place instead of
 * inserting a duplicate one on top of it; a throw before the insert instead
 * keeps the old run-level `pending` block (Retry re-attempts the same
 * launch from scratch), and — since `launchStep` bumps `run.stepCount`
 * before it ever reaches the insert — rolls that increment back so a
 * pre-insert throw can never leave the step-cap accounting inflated by a
 * step that was never actually created. Returns `launchStep`'s own result
 * on success (used by `retryPendingBlocks` to report the first successful
 * launch); most callers discard it, same as calling `launchStep` directly
 * in a loop.
 */
async function launchTarget(
  parent: Task,
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
  opts?: { batchSiblingStepIds?: string[]; skipWorktreeRefresh?: boolean },
): Promise<LaunchResult> {
  const activeIdsBefore = new Set(run.active.map((a) => a.taskId));
  const stepCountBefore = run.stepCount;
  try {
    return await launchStep(parent, run, step, previous, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const inserted = run.active.find((a) => a.stepId === step.id && !activeIdsBefore.has(a.taskId));
    if (inserted) {
      upsertBlocked(run, {
        taskId: inserted.taskId,
        stepId: step.id,
        kind: "step-failed",
        message: `step "${step.name}" failed to launch: ${message}`,
      });
    } else {
      if (run.stepCount > stepCountBefore) run.stepCount = stepCountBefore;
      upsertBlocked(run, {
        taskId: null,
        stepId: step.id,
        kind: "step-failed",
        message: `step "${step.name}" failed to launch: ${message}`,
        pending: {
          stepId: step.id,
          arrivals: previous.map((p) => ({ fromStepId: p.stepId, seq: p.seq, handoff: p.handoff })),
        },
      });
    }
    return { ok: false };
  }
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
    // M5: never re-`startTask` an execution whose task is genuinely still
    // live (a fan-out with one branch blocked and another still mid-turn,
    // or a spawn still settling) — `isTaskRunLive` is the authoritative
    // "is this actually busy right now" check, not `column === "running"`,
    // which can lag a beat behind a just-started/just-settled spawn.
    if (isTaskRunLive(a.taskId)) return false;
    if (onlyTaskId) return a.taskId === onlyTaskId;
    // Minor 9: an un-targeted, RUN-LEVEL retry (no `onlyTaskId`) only
    // touches an execution that's actually stuck — one carrying its own
    // blocked entry, or whose latest history outcome recorded a failure or
    // a cancellation — never one quietly sitting in `review` awaiting a
    // human's manual Advance decision (no block, no failed/cancelled
    // outcome — there's nothing broken to retry). A specific `onlyTaskId`
    // retry (the per-step Retry button) is unaffected by this and still
    // fires on the named execution unconditionally, as before.
    if (run.blocked.some((b) => b.taskId === a.taskId)) return true;
    const historyEntry = run.history.find((h) => h.taskId === a.taskId && h.seq === a.seq);
    return historyEntry?.outcome === "failed" || historyEntry?.outcome === "cancelled";
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
  // Minor 10: extend the cap ONCE per retry call, not once per pending
  // `step-cap` block found — the formula stays `maxSteps * (1 +
  // capExtensions)` either way, but a run that somehow queued more than one
  // `step-cap` block must not have this single Retry click silently apply
  // several extensions at once.
  let capExtended = false;
  for (const block of pendingBlocks) {
    const pending = block.pending;
    if (!pending) continue;
    if (block.kind === "step-cap" && !capExtended) {
      run.capExtensions = (run.capExtensions ?? 0) + 1;
      capExtended = true;
    }
    run.blocked = run.blocked.filter((b) => b !== block);
    if (block.kind === "join-incomplete") delete run.joins[pending.stepId];
    const step = run.snapshot?.graph.steps.find((s) => s.id === pending.stepId);
    if (!step) {
      // Nit: never silently drop a pending block whose step vanished from
      // the frozen snapshot (shouldn't normally happen — the snapshot is
      // captured once at first Run — but a corrupted/hand-edited row must
      // not lose the block outright with no trace left for a human to act
      // on) — re-record it, profile-missing-style, instead.
      upsertBlocked(run, {
        taskId: null,
        stepId: pending.stepId,
        kind: "profile-missing",
        message: `step "${pending.stepId}" no longer exists in this run's snapshot`,
        pending,
      });
      continue;
    }
    const previous = pending.arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
    // Minor 15: `parent` here was already freshly refreshed once by this
    // call's sole caller, `performPipelineRetry` — skip `launchStep`'s own
    // redundant per-call refresh. Minor 7: go through `launchTarget`, not
    // `launchStep` directly, so a throw here is caught into a retryable
    // block instead of aborting the rest of this pending-block sweep.
    const launched = await launchTarget(parent, run, step, previous, { skipWorktreeRefresh: true });
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
  // Minor 5: a delete cascade tombstones the parent (and removes its row)
  // before tearing down any step task — a retry racing in through this same
  // per-parent lock must bail before ever touching the worktree.
  if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
    return { error: "pipeline task no longer exists" };
  }
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
    // Nit: `retryPendingBlocks` can mutate `run` (clear/re-add blocks,
    // drop/re-add `run.joins` entries) even when it returns `null` — always
    // persist afterward rather than the old `pendingResult ||
    // pendingResult === null` check, which was vacuously true either way.
    const pendingResult = await retryPendingBlocks(parentRow, run);
    checkJoinIncomplete(run);
    persist(parentRow.id, run);
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
    // Minor 5: a delete cascade tombstones the parent (and removes its row)
    // before tearing down any step task — a start/restart racing in through
    // this same per-parent lock must bail before touching the worktree.
    if (tombstonedPipelineParents.has(parent.id) || !tasks.get(parent.id)) {
      return { error: "pipeline task no longer exists" };
    }
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

    // Major 3 / Minor 3: `restart` means "fresh run from the start step,"
    // for ANY non-running status — blocked, cancelled, done, or even idle (a
    // harmless no-op request in that last case, since idle already falls
    // through to the very same fresh-run code below with nothing to
    // cancel). This used to only take effect for `done`; a restart requested
    // on a blocked/cancelled run fell into the M2 retry-in-place branch
    // below instead and silently became a retry, not a restart. Whatever's
    // still genuinely live from the run being replaced is cancelled further
    // down — only once the fresh run has been validated as startable
    // (Minor 3: a restart that turns out to fail — invalid graph, missing
    // profile, worktree failure — must never have killed the still-live
    // executions it would have replaced).
    const restartTargets: PipelineActiveStep[] = opts?.restart ? run.active.slice() : [];
    if (!opts?.restart) {
      if (run.status === "blocked" || run.status === "cancelled") {
        // M2: absent an explicit restart, blocked/cancelled is ALWAYS a
        // retry-in-place, whether or not anything is currently sitting in
        // `run.active` — a run-level pending block (step-cap,
        // profile-missing, join-incomplete) with zero active executions used
        // to fall through to the "fresh run" branch below, silently
        // discarding history and re-snapshotting from scratch.
        return performPipelineRetry(fresh, run);
      } else if (run.status === "done") {
        return { error: "pipeline already finished — restart it explicitly" };
      }
    }

    // Fresh run (idle, or an explicit restart of any other status):
    // re-resolve the pipeline and (re-)snapshot it. Major 5: the stored
    // graph must be validated (and normalized) before it's ever captured
    // onto a run's frozen snapshot — an edited-in-place or otherwise
    // corrupted graph must fail the run start with a clear error instead of
    // reaching `buildSnapshot`/the runner with malformed shape.
    const pipeline = pipelines.get(fresh.pipelineId);
    let snapshot: PipelineRunSnapshot;
    if (pipeline) {
      const validated = validatePipelineGraph(pipeline.graph);
      if (!validated.ok) return { error: `pipeline graph is invalid: ${validated.error}` };
      const built = buildSnapshot(validated.graph, pipeline.maxSteps, Date.now());
      if ("error" in built) return { error: built.error };
      snapshot = built.snapshot;
    } else if (run.snapshot) {
      // The pipeline row itself is gone (deleted) — the only graph left to
      // run is the one already frozen on this task's previous snapshot.
      // Validate that too: it was built from a real pipeline once, but
      // nothing stops a hand-edited DB row (or a future schema slip) from
      // having corrupted it since.
      const validated = validatePipelineGraph(run.snapshot.graph);
      if (!validated.ok) return { error: `pipeline graph is invalid: ${validated.error}` };
      snapshot = { ...run.snapshot, graph: validated.graph };
    } else {
      return { error: "pipeline no longer exists, and this task has never run it" };
    }

    const startStep = resolveStartStep(snapshot.graph);
    if (!startStep) return { error: "pipeline has no resolvable start step" };

    // Materialize the shared worktree ONCE, here — every step task inserted
    // below copies `branch`/`worktreePath`/`baseRef` straight from the
    // parent, so `prepareWorkdir` on each step hits the reuse branch with no
    // further git calls (D2). `launchStep` re-verifies this itself too
    // (M6), but doing it up front also lets us flip the parent to `running`
    // before the first step lands.
    const prepared = await refreshParentWorktree(fresh);
    if ("error" in prepared) return { error: prepared.error };
    let parentRow = prepared.parent;

    // Minor 3: only now — graph validated, snapshot built, start step
    // resolved, worktree prepared, so this restart is known startable —
    // cancel whatever was still genuinely live from the run being replaced
    // (best-effort: a step whose turn is mid-flight has nothing useful to
    // hand off to a fresh run that's about to discard this run's history
    // anyway).
    for (const a of restartTargets) {
      if (!isTaskRunLive(a.taskId)) continue;
      const stepRunId = tasks.get(a.taskId)?.runId;
      if (stepRunId) await cancelRun(stepRunId);
    }

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

    pipelineUpdateColumn(parentRow.id, null, "running");
    parentRow = tasks.get(parentRow.id) ?? parentRow;

    const result = await launchStep(parentRow, run, startStep, [], { skipWorktreeRefresh: true });
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
    // Minor 5: a delete cascade tombstones the parent before tearing down
    // any step task — an advance racing in through this same per-parent
    // lock must bail before ever touching the worktree.
    if (tombstonedPipelineParents.has(parentId)) {
      return { error: "pipeline task no longer exists", status: 404 as const };
    }
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
      // of which of the three reasons produced it. Minor 8: a task-level
      // `step-failed` block (a step that failed its own turn, was stopped
      // while a fan-out sibling kept going, or hit a post-insert launch
      // throw) is folded in too, but ONLY once its task genuinely isn't
      // live any more — a `step-failed` block can in principle name a task
      // whose replacement turn is already running again (Retry re-sends,
      // the block just hasn't been cleared yet), and hand-picking a next
      // step for THAT would race the same turn `advancePipeline`'s own M4
      // check below refuses for an explicit `fromTaskId`.
      const handoffBlocks = run.blocked.filter(
        (b) =>
          b.taskId !== null &&
          (b.kind === "handoff-missing" ||
            b.kind === "handoff-invalid" ||
            b.kind === "step-blocked" ||
            (b.kind === "step-failed" && !isTaskRunLive(b.taskId))),
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
        // Minor 14/15: `launchTarget` catches a per-target throw into a
        // retryable block instead of aborting the rest of the batch;
        // `parentRow` was already freshly refreshed once, above, for this
        // whole call — skip `launchStep`'s own redundant per-call refresh.
        await launchTarget(parentRow, run, targetStep, previous, {
          batchSiblingStepIds: joinTargets,
          skipWorktreeRefresh: true,
        });
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
          await launchTarget(
            parentRow,
            run,
            targetStep,
            arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })),
            { batchSiblingStepIds: nextStepIds, skipWorktreeRefresh: true },
          );
        } else {
          run.joins[nid] = { arrivals };
        }
      } else {
        await launchTarget(
          parentRow,
          run,
          targetStep,
          [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff }],
          { batchSiblingStepIds: nextStepIds, skipWorktreeRefresh: true },
        );
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

    finalizeCancelled(parentId, run);
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

        // Major 2: re-read the parent fresh — it may have been archived
        // between this settle firing and this handler acquiring the
        // per-parent lock (an `archiveTask` cascade races through the same
        // lock, but sets `archivedAt` on the row BEFORE it ever acquires
        // it). An archived parent must never have this settle spawn a new
        // step task or touch its worktree — every resolved next step is
        // recorded as a retryable pending hold instead of launched.
        const parentForLaunch = tasks.get(parentId) ?? parent;
        const parentArchived = parentForLaunch.archivedAt != null;
        // Minor 5: same tombstone/existence guard as every other locked body
        // that refreshes the worktree — a delete cascade racing in through
        // this same per-parent lock must never have this settle's batch
        // refresh touch the worktree (`launchStep`/`launchTarget` below
        // still bail on this independently, this just skips the redundant
        // refresh call).
        const parentGone = tombstonedPipelineParents.has(parentId) || !tasks.get(parentId);
        // Minor 15: refresh the shared worktree ONCE for this whole batch (a
        // fan-out can resolve several next steps from one settle) instead of
        // once per `launchStep` call — a failed batch refresh here just
        // falls back to `launchStep`'s own per-call refresh (and its own
        // per-target error handling) for every target in the loop below.
        let batchParent = parentForLaunch;
        let worktreeReady = false;
        if (!parentArchived && !parentGone && nextStepIds.length > 0) {
          const refreshedBatch = await refreshParentWorktree(parentForLaunch);
          if (!("error" in refreshedBatch)) {
            batchParent = refreshedBatch.parent;
            worktreeReady = true;
          }
        }

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
              const previousArr = arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff }));
              if (parentArchived) {
                holdForArchivedParent(run, targetStep, previousArr);
              } else {
                // Minor 14: a per-target throw is caught and recorded as its
                // own retryable block instead of aborting the rest of this
                // fan-out batch.
                await launchTarget(batchParent, run, targetStep, previousArr, {
                  batchSiblingStepIds: nextStepIds,
                  skipWorktreeRefresh: worktreeReady,
                });
              }
            } else {
              run.joins[nid] = { arrivals };
            }
          } else {
            const previousArr = [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff: parsed.handoff }];
            if (parentArchived) {
              holdForArchivedParent(run, targetStep, previousArr);
            } else {
              await launchTarget(batchParent, run, targetStep, previousArr, {
                batchSiblingStepIds: nextStepIds,
                skipWorktreeRefresh: worktreeReady,
              });
            }
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
      const stillLiveSiblings = run.active.filter((a) => a.taskId !== taskId && isTaskRunLive(a.taskId));
      // Major 1 (round 3): a WHOLE-pipeline Stop on a fan-out must end
      // `cancelled`, not `blocked` — `cancelPipelineRun` sends the cancel
      // signal to every live sibling and forces `run.status = "cancelled"`
      // (via `finalizeCancelled`) BEFORE any of those siblings' own settle
      // events actually arrive here, so `run.status === "cancelled"` on
      // entry is the signal that THIS settle is part of a deliberate
      // whole-run stop, not an isolated one-step Stop. The same holds when
      // every other still-live sibling is itself mid-cancellation
      // (`isTaskRunCancelling`) — e.g. each active execution was cancelled
      // individually rather than through `cancelPipelineRun` — since none of
      // them is a normally-running sibling this execution would otherwise
      // need to wait on.
      const deliberateWholeRunStop =
        run.status === "cancelled" ||
        (stillLiveSiblings.length > 0 && stillLiveSiblings.every((a) => isTaskRunCancelling(a.taskId)));
      if (stillLiveSiblings.length > 0 && !deliberateWholeRunStop) {
        // Major 1: this execution stopped (or orphaned) but a SIBLING is
        // still genuinely running normally — the whole run must not
        // silently read as `running` with a dead-end execution sitting in
        // `active` with no block to surface it (`deriveRunStatus` would
        // otherwise see `blocked.length === 0` and `active.length > 0` and
        // call it `running`, forever, since nothing is ever going to
        // advance this execution on its own again). Record a retryable
        // block for it now, so `deriveRunStatus` reads `blocked`
        // immediately — and still reads `blocked` once the sibling finishes
        // too, since this block is still sitting there.
        upsertBlocked(run, {
          taskId,
          stepId: activeEntry.stepId,
          kind: "step-failed",
          message: `step "${stepName}" was stopped — retry it or advance past it`,
        });
        persist(parentId, run);
      } else {
        // Either nothing else is live, or every other live sibling is also
        // being deliberately stopped as part of the same whole-run Stop —
        // either way this settle must never add a "was stopped" block of
        // its own; `finalizeCancelled` (idempotent) is the whole story.
        finalizeCancelled(parentId, run);
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
      // Major 2: re-read the parent fresh (same rationale as
      // `handleRunStatus`) — an archive can race this event through the
      // same per-parent lock. Unlike `handleRunStatus`, nothing below this
      // point ever calls `launchStep` or touches the worktree — both
      // branches only ever record/clear a block or reset a history entry —
      // so an archived parent still gets its state recorded correctly with
      // no extra guard needed; `persist` itself already skips column
      // mirroring/event publish for an archived parent (m8).
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
