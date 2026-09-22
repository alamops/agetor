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
 * back `orchestrator.ts`'s `deleteTask`/`archiveTask` cascades (D1/D9).
 *
 * This module and `orchestrator.ts` reference each other's exports (the
 * runner needs `subscribeGlobal`/`startTask`/`cancelRun`/`deleteTask`/
 * `archiveTask`/`defaultEffortFor`/`pipelineUpdateColumn`; `orchestrator.ts`'s
 * `startTaskInner`/`deleteTask`/`archiveTask`/`createTask` need
 * `startPipelineRun`/`cascadePipelineDelete`/`cascadePipelineArchive`/
 * `initialPipelineRunState`) — a static import cycle, but a safe one: every
 * cross-reference on both sides is used inside a function body, never at
 * module top-level, so by the time either side's code actually runs both
 * modules have finished evaluating. `initPipelineRunner` itself is never
 * auto-invoked at module load (unlike, say, `wireInteractionBroadcast()` in
 * orchestrator.ts) — `index.ts`/`headless.ts` call it explicitly, once, right
 * before `reconcileOrphans()`.
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
  pipelineUpdateColumn,
  publishGlobalEvent,
  startTask,
  subscribeGlobal,
} from "./orchestrator.ts";
import { prepareWorkdir } from "./worktree.ts";
import { snapshotFromProfile } from "../shared/agent-profile.ts";
import {
  composeStepPrompt,
  deriveRunStatus,
  incomingSteps,
  outgoingSteps,
  parseHandoff,
  resolveNextSteps,
  resolveStartStep,
  stepNameById,
} from "../shared/pipeline.ts";
import { promptByteOverage } from "../shared/prompt-limits.ts";
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
    });
  }
}

/**
 * Persist `run` onto the parent task row, recompute its `status` (unless
 * `preserveStatus` — see `deriveRunStatus`'s doc for why a "cancelled, but
 * kept `active` for retry" state can't be re-derived), mirror the parent's
 * board column, and broadcast the `"pipeline"` GlobalEvent (D12). The single
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
  const columnFor: Partial<Record<PipelineRunStatus, ColumnId>> = {
    running: "running",
    blocked: "blocked",
    done: "review",
    cancelled: "ready",
  };
  const nextColumn = columnFor[run.status];
  const parent = tasks.get(parentId);
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

function normalizeHandoff(partial: Partial<Handoff> | undefined, singleNext: string | null): Handoff {
  const p = partial ?? {};
  return {
    schemaVersion: 1,
    purpose: typeof p.purpose === "string" ? p.purpose : "",
    summary: typeof p.summary === "string" ? p.summary : "",
    reason: typeof p.reason === "string" ? p.reason : "manually advanced",
    next: typeof p.next === "string" && p.next.trim().length > 0 ? p.next : singleNext,
    artifacts: Array.isArray(p.artifacts) ? p.artifacts.filter((x): x is string => typeof x === "string") : [],
    openQuestions: Array.isArray(p.openQuestions)
      ? p.openQuestions.filter((x): x is string => typeof x === "string")
      : [],
    ...(p.status === "done" || p.status === "blocked" ? { status: p.status } : {}),
  };
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
// Launching a step
// ---------------------------------------------------------------------------

type LaunchResult = { ok: true; runId: string; pending?: true } | { ok: false };

/**
 * Launch one step execution: writes every non-null `previous` handoff to
 * `pipelineRunsDir(parent.id)`, composes the step's prompt (D10 —
 * `composeStepPrompt`, re-composed with `inlineHandoff: false` if the
 * gemini argv cap would otherwise be blown), inserts the hidden step task
 * (frozen profile fields copied straight from the snapshot — this task will
 * never go through `effectiveAgentProfile`'s "live" branch, see the guard
 * added there), records it in `run.active`/`run.history`, persists, and
 * calls the ordinary `startTask` on it. A step-cap or profile-missing
 * failure (the latter only reachable if a profile vanished between snapshot
 * capture and this specific launch — buildSnapshot already checked every
 * step up front) records a blocked entry instead of ever calling
 * `startTask`. Mutates `run` and calls `persist` itself — callers don't
 * need to persist again around this (though doing so is harmless/idempotent).
 */
async function launchStep(
  parent: Task,
  run: PipelineRunState,
  step: PipelineStep,
  previous: { stepId: string; seq: number; handoff: Handoff | null }[],
): Promise<LaunchResult> {
  const snapshot = run.snapshot;
  if (!snapshot) {
    upsertBlocked(run, { taskId: null, stepId: step.id, kind: "profile-missing", message: "pipeline run has no snapshot" });
    persist(parent.id, run);
    return { ok: false };
  }
  if (run.stepCount >= snapshot.maxSteps) {
    upsertBlocked(run, {
      taskId: null,
      stepId: step.id,
      kind: "step-cap",
      message: `reached the ${snapshot.maxSteps}-step cap for this run — retry to keep going, or stop here`,
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
      writeFileSync(filePath, JSON.stringify(p.handoff, null, 2));
      handoffRefs.push({ path: filePath, isDirectory: false });
    }
    previousWithFiles.push({ stepName, handoff: p.handoff, filePath });
  }

  const outgoing = outgoingSteps(snapshot.graph, step.id).map((o) => ({ name: o.step.name, label: o.edge.label }));
  const parallelSiblings = run.active
    .filter((a) => a.stepId !== step.id)
    .map((a) => stepNameById(snapshot.graph, a.stepId));
  const subagentProfiles = step.subagents.profileIds
    .map((id) => snapshot.profiles[id])
    .filter((p): p is AgentProfileSnapshot => p !== undefined);

  const composeArgs = {
    pipelineName: run.pipelineName,
    step,
    stepIndex: seq,
    stepCap: snapshot.maxSteps,
    goal: parent.prompt,
    previous: previousWithFiles,
    outgoing,
    transition: step.transition,
    subagentProfiles,
    subagentCap: step.subagents.cap,
    parallelSiblings,
  };
  let composed = composeStepPrompt({ ...composeArgs, inlineHandoff: true });
  // D10: gemini's tmux-argv launch cap has no deferred-paste fallback
  // (unlike claude's persistent REPL) — an inlined handoff big enough to
  // blow that budget must fall back to the file-only reference instead of
  // failing the launch outright.
  if (profile.harnessKind === "gemini" && promptByteOverage("gemini", composed)) {
    composed = composeStepPrompt({ ...composeArgs, inlineHandoff: false });
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
    references: handoffRefs,
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
    // Never re-`startTask` an execution whose task is genuinely still
    // running (a fan-out with one branch blocked and another still mid-turn).
    return tasks.get(a.taskId)?.column !== "running";
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

// ---------------------------------------------------------------------------
// Public API — manual route entry points
// ---------------------------------------------------------------------------

/**
 * Run (or retry) a pipeline task. Called from `orchestrator.ts`'s
 * `startTaskInner` whenever `task.pipelineId` is set — the parent never
 * spawns an agent of its own, so this bypasses every harness/worktree/
 * prompt pre-flight `startTaskInner` normally runs (each hidden step task
 * gets its own, via the ordinary `startTask` call inside `launchStep`).
 */
export async function startPipelineRun(
  parent: Task,
): Promise<{ runId: string; pending?: true } | { error: string }> {
  return runExclusive(parent.id, async () => {
    const fresh = tasks.get(parent.id) ?? parent;
    if (!fresh.pipelineId) return { error: "not a pipeline task" };

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

    if ((run.status === "blocked" || run.status === "cancelled") && run.active.length > 0) {
      return retryActiveExecutions(fresh, run);
    }

    // Fresh run (or a blocked/cancelled run with nothing left `active` to
    // retry — e.g. every execution already finished terminal, or the only
    // block was a run-level `step-cap`/`join-incomplete`): re-resolve the
    // pipeline and (re-)snapshot it.
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
    // further git calls (D2).
    const prepared = await prepareWorkdir(fresh, {
      takenBranches: new Set(
        tasks.list().filter((t) => t.id !== fresh.id).map((t) => t.branch).filter((b): b is string => Boolean(b)),
      ),
    });
    if ("error" in prepared) return { error: prepared.error };
    let parentRow = tasks.update(fresh.id, { branch: prepared.branch, worktreePath: prepared.worktreePath }) ?? fresh;

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
 * execution (`handoff-missing`/`handoff-invalid`), else the sole
 * `join-incomplete` run-level block (launches that join step now, with
 * whatever handoffs arrived), else the sole active execution sitting in
 * `review` — 409 otherwise. `opts.nextStepIds: null` ends that path
 * (terminal); a non-null array launches each named step (joins bypassed —
 * a manual advance into a join step runs it with whatever arrived).
 */
export async function advancePipeline(
  parentId: string,
  opts: { nextStepIds: string[] | null; handoff?: Partial<Handoff>; fromTaskId?: string },
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun || !parent.pipelineRun.snapshot) {
      return { error: "pipeline has never run", status: 409 as const };
    }
    const run: PipelineRunState = parent.pipelineRun;
    const graph = run.snapshot!.graph;

    let targetTaskId: string | null = null;
    let joinStepId: string | null = null;

    if (opts.fromTaskId) {
      if (!run.active.some((a) => a.taskId === opts.fromTaskId)) {
        return { error: "no active execution for that task", status: 400 as const };
      }
      targetTaskId = opts.fromTaskId;
    } else {
      const handoffBlocks = run.blocked.filter(
        (b) => b.taskId !== null && (b.kind === "handoff-missing" || b.kind === "handoff-invalid"),
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
      const targetStep = graph.steps.find((s) => s.id === joinStepId);
      if (!targetStep) return { error: "unknown step", status: 400 as const };
      const arrivals = run.joins[joinStepId]?.arrivals ?? [];
      delete run.joins[joinStepId];
      run.blocked = run.blocked.filter((b) => !(b.stepId === joinStepId && b.kind === "join-incomplete"));
      await launchStep(parent, run, targetStep, arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })));
      checkJoinIncomplete(run);
      persist(parentId, run);
      return { task: tasks.get(parentId)! };
    }

    if (!targetTaskId) return { error: "nothing to advance", status: 409 as const };
    const activeEntry = run.active.find((a) => a.taskId === targetTaskId);
    if (!activeEntry) return { error: "no active execution for that task", status: 400 as const };

    if (opts.nextStepIds !== null) {
      for (const id of opts.nextStepIds) {
        if (!graph.steps.some((s) => s.id === id)) return { error: `unknown step id "${id}"`, status: 400 as const };
      }
    }
    const nextStepIds = opts.nextStepIds === null ? [] : [...new Set(opts.nextStepIds)];
    const handoff = normalizeHandoff(opts.handoff, nextStepIds.length === 1 ? nextStepIds[0]! : null);

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

    for (const nid of nextStepIds) {
      const targetStep = graph.steps.find((s) => s.id === nid);
      if (!targetStep) continue;
      if (targetStep.join === "all") {
        const arrivals: PipelineJoinArrival[] = [...(run.joins[nid]?.arrivals ?? []), { fromStepId: activeEntry.stepId, seq: activeEntry.seq, handoff }];
        const incoming = incomingSteps(graph, nid);
        const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
        const complete = incoming.every((i) => arrivedIds.has(i.step.id));
        if (complete) {
          delete run.joins[nid];
          await launchStep(parent, run, targetStep, arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })));
        } else {
          run.joins[nid] = { arrivals };
        }
      } else {
        await launchStep(parent, run, targetStep, [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff }]);
      }
    }

    checkJoinIncomplete(run);
    persist(parentId, run);
    return { task: tasks.get(parentId)! };
  });
}

/**
 * Retry every currently-blocked (or, for a stopped run, every non-running)
 * active execution — or just `opts.taskId`'s, when given. 409 unless the
 * run is `blocked`/`cancelled`.
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
    const result = await retryActiveExecutions(parent, run, opts?.taskId);
    if ("error" in result) return { error: result.error, status: 409 as const };
    return { task: tasks.get(parentId)! };
  });
}

/**
 * Stop every currently-running active execution (D9: "Stop on the parent
 * cancels every active execution and returns the parent to ready … active
 * set kept so Run retries them"). 409 when nothing is actually running.
 */
export async function cancelPipelineRun(parentId: string): Promise<{ task: Task } | { error: string; status: 404 | 409 }> {
  return runExclusive(parentId, async () => {
    const parent = tasks.get(parentId);
    if (!parent || !parent.pipelineId) return { error: "not a pipeline task", status: 404 as const };
    if (!parent.pipelineRun) return { error: "pipeline has never run", status: 409 as const };
    const run = parent.pipelineRun;

    const runningTargets = run.active.filter((a) => tasks.get(a.taskId)?.column === "running");
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
 *  `deleteTask` itself already swallows teardown errors internally. */
export async function cascadePipelineDelete(parentId: string): Promise<void> {
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

      for (const nid of nextStepIds) {
        const targetStep = graph.steps.find((s) => s.id === nid);
        if (!targetStep) continue;
        if (targetStep.join === "all") {
          const arrivals: PipelineJoinArrival[] = [
            ...(run.joins[nid]?.arrivals ?? []),
            { fromStepId: activeEntry.stepId, seq: activeEntry.seq, handoff: parsed.handoff },
          ];
          const incoming = incomingSteps(graph, nid);
          const arrivedIds = new Set(arrivals.map((a) => a.fromStepId));
          const complete = incoming.every((i) => arrivedIds.has(i.step.id));
          if (complete) {
            delete run.joins[nid];
            await launchStep(parent, run, targetStep, arrivals.map((a) => ({ stepId: a.fromStepId, seq: a.seq, handoff: a.handoff })));
          } else {
            run.joins[nid] = { arrivals };
          }
        } else {
          await launchStep(parent, run, targetStep, [{ stepId: activeEntry.stepId, seq: activeEntry.seq, handoff: parsed.handoff }]);
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

    // cancelled / orphaned: clean up any blocked entry, keep the execution
    // in `active` (retry finds it there), reaffirm the cancelled run state —
    // idempotent when `cancelPipelineRun` already set this explicitly.
    removeBlockedFor(run, taskId);
    if (historyEntry) {
      historyEntry.endedAt = Date.now();
      historyEntry.outcome = "cancelled";
    }
    run.status = "cancelled";
    persist(parentId, run, { preserveStatus: true });
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
      const before = run.blocked.length;
      run.blocked = run.blocked.filter((b) => !(b.taskId === taskId && b.kind === "step-blocked"));
      if (run.blocked.length !== before) persist(parentId, run);
    }
  }).catch((err) => {
    console.warn(`[agetor] pipeline runner failed handling column change for task ${taskId}:`, err);
  });
}

let runnerInitialized = false;

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
    if (e.kind === "run-status") {
      void handleRunStatus(e.taskId, e.runId, e.status);
    } else if (e.kind === "column") {
      void handleColumnChange(e.taskId, e.column, e.reason);
    }
  });
}
