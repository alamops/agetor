import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ColumnId } from "../shared/types.ts";
import type { ContinuationHooks, SpawnedAgent } from "./claude-tmux.ts";
import { CONTINUATION_STATUS_TEXT, type ContinuationTrigger } from "../shared/types.ts";

/*
 * Covers `startContinuationRun` (src/bun/orchestrator.ts, ~line 1365) — the
 * factory the orchestrator installs via `setContinuationRunFactory` at
 * module init (claude-tmux.ts wiring, see docs/plans/
 * fix-stream-list-stalls-with-bg-agents.md sections 4/T4a and 5/TT5).
 *
 * `startContinuationRun` is NOT exported. The only way to reach it from a
 * test is through the injected-setter seam itself: `setContinuationRunFactory`
 * returns the PREVIOUS value when called, so calling it with `null` captures
 * whatever orchestrator.ts registered at module load, and we immediately pass
 * that same value back in to restore it (a true no-op from the module's
 * point of view — we never leave the factory unset for any other test file
 * or later test in this file). This mirrors the save/restore discipline
 * `subagent-hold.test.ts` uses for its own env-var seam.
 */

// Only AGETOR_DATA_DIR belongs at module top level: db.ts captures it at first
// import, and a `beforeAll` would race a sibling file that already imported
// db.ts. The value is unique per file so nobody inherits it harmfully.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-"));

// Every OTHER override is scoped to this file and restored afterwards — see
// subagent-hold.test.ts's comment on why AGETOR_CLAUDE_DRIVER=fake /
// AGETOR_TMUX_BIN=/bin/echo must not leak into files (like reconcile.test.ts)
// that deliberately exercise the real driver.
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake", // not actually used to spawn here (we call the
  // factory directly), but harmless and keeps this file consistent with its
  // siblings in case a future test in here calls startTask/sendInput's spawn
  // path.
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo", // tmux probe + every `tmux(...)` call (pasteFollowUp,
  // sessionLiveness, etc.) becomes a no-op success — required for the
  // fold-while-busy test (#4), which drives real claude-tmux code paths.
  AGETOR_CLAUDE_ARGS: "",
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
};
const savedEnv: Record<string, string | undefined> = {};

let realFactory: ((taskId: string, trigger?: ContinuationTrigger) => ContinuationHooks | null) | null = null;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // Force orchestrator.ts's module-init side effects (including
  // `setContinuationRunFactory(startContinuationRun)`) to have run before we
  // try to capture the factory.
  await import("./orchestrator.ts");
  const { setContinuationRunFactory } = await import("./claude-tmux.ts");
  realFactory = setContinuationRunFactory(null);
  setContinuationRunFactory(realFactory); // restore immediately — see file header.
  if (!realFactory) {
    throw new Error(
      "expected orchestrator.ts to have registered a continuation-run factory via setContinuationRunFactory",
    );
  }
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

// Same shared-DB hygiene as subagent-hold.test.ts: `bun test` runs every
// *.test.ts in one process against one SQLite DB, and boot-reconciliation-style
// global scans in other files could pick up a leftover `running` row. Every
// task created here is tracked and hard-deleted in `afterEach` (cascades to
// runs/subagents/run_events via FK).
const createdTaskIds: string[] = [];
afterEach(async () => {
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

async function createTaskWithAgent(title: string, agent: "claude-code" | "codex"): Promise<string> {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "hello",
    agent,
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo during tests
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

/**
 * Seed a "prior run" row directly (bypassing startTask/spawnAgent entirely)
 * so the factory has something to inherit `claudeSessionId` from and a
 * column to pull the card back from. Defaults model the common #92-hold
 * shape: a succeeded claude run sitting in `review`.
 */
async function seedPriorRun(
  taskId: string,
  opts: {
    agent?: string;
    claudeSessionId?: string | null;
    codexSessionId?: string | null;
    column?: ColumnId;
  } = {},
): Promise<string> {
  const { runs, tasks } = await import("./db.ts");
  const runId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runId,
    taskId,
    agent: opts.agent ?? "claude-code",
    status: "succeeded",
    startedAt: now - 5000,
    endedAt: now,
    exitCode: 0,
    tmuxSession: `agetor-test-${taskId}`,
    claudeSessionId: opts.claudeSessionId ?? null,
    codexSessionId: opts.codexSessionId ?? null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  tasks.update(taskId, { column: opts.column ?? "review", runId });
  return runId;
}

async function insertRunningSubagent(taskId: string): Promise<string> {
  const { subagents } = await import("./db.ts");
  const id = `agent-${randomUUID()}`;
  subagents.insertIfAbsent({
    id,
    taskId,
    runId: null, // the hold gate only keys off task_id — see subagents.hasRunning
    parentKind: "subagent",
    agentType: "Explore",
    description: "test subagent",
    spawnDepth: 1,
    sourcePath: `/tmp/${id}.jsonl`,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });
  return id;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A never-resolving `done` — used when a test only cares about adoption/
 *  registration, not the resolve path, and doesn't want a dangling `.then`
 *  to fire mid-test. */
function neverDone(): Promise<number> {
  return new Promise<number>(() => {});
}

// ── 1. Guard rails ──────────────────────────────────────────────────────────

test("factory returns null for an unknown taskId", () => {
  expect(realFactory!(randomUUID())).toBeNull();
});

test("factory returns null for the synthetic __rebuild__ taskId", () => {
  expect(realFactory!("__rebuild__")).toBeNull();
});

test("factory returns null for an archived task", async () => {
  const taskId = await createTaskWithAgent("continuation-archived", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });
  const { tasks } = await import("./db.ts");
  tasks.update(taskId, { archivedAt: Date.now() });

  expect(realFactory!(taskId)).toBeNull();
});

// ── 2. Happy path ────────────────────────────────────────────────────────────

test("happy path: new run row (origin continuation, inherited session, running) + column pulled back from review", async () => {
  const taskId = await createTaskWithAgent("continuation-happy", "claude-code");
  const priorSessionId = `sess-${randomUUID()}`;
  const priorRunId = await seedPriorRun(taskId, { claudeSessionId: priorSessionId, column: "review" });

  const hooks = realFactory!(taskId);
  expect(hooks).not.toBeNull();

  const { tasks, runs } = await import("./db.ts");
  const task = tasks.get(taskId);
  expect(task?.column).toBe("running");
  expect(task?.runId).not.toBeNull();
  expect(task?.runId).not.toBe(priorRunId);

  const newRunId = task!.runId!;
  const newRun = runs.get(newRunId);
  expect(newRun?.status).toBe("running");
  expect(newRun?.origin).toBe("continuation");
  expect(newRun?.claudeSessionId).toBe(priorSessionId);
  expect(newRun?.tmuxSession).not.toBeNull();

  const events = runs.events(newRunId);
  expect(
    events.some((e) => e.stream === "status" && e.data === "auto-continued after background task"),
  ).toBe(true);
});

test("trigger wording: each trigger opens the run with a status line saying what actually happened", async () => {
  const cases: Array<[ContinuationTrigger, string]> = [
    ["notification", "auto-continued after background task"],
    ["user", "turn started from the terminal"],
    ["assistant", "Claude continued on its own"],
  ];
  const { tasks, runs } = await import("./db.ts");
  for (const [trigger, text] of cases) {
    expect(CONTINUATION_STATUS_TEXT[trigger]).toBe(text);
    const taskId = await createTaskWithAgent(`continuation-trigger-${trigger}`, "claude-code");
    await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}`, column: "review" });

    expect(realFactory!(taskId, trigger)).not.toBeNull();

    const task = tasks.get(taskId);
    expect(task?.column).toBe("running");
    const newRun = runs.get(task!.runId!);
    expect(newRun?.origin).toBe("continuation");
    const statuses = runs.events(task!.runId!).filter((e) => e.stream === "status").map((e) => e.data);
    expect(statuses).toContain(text);
    // Exactly one opening line — never the notification wording on a
    // terminal- or assistant-triggered turn.
    for (const [other, otherText] of cases) {
      if (other !== trigger) expect(statuses).not.toContain(otherText);
    }
  }
});

test("happy path: pulls back from an arbitrary non-running column too (continuations always land in running)", async () => {
  // The plan (section 4/T4a, section 3 decision 4) says continuation runs
  // always pull the card to `running` regardless of prior column — unlike
  // the parked-discovery pull-back, which is narrowly `review`-only. Exercise
  // a non-review starting column to pin that distinction down.
  const taskId = await createTaskWithAgent("continuation-happy-blocked", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}`, column: "blocked" });

  const hooks = realFactory!(taskId);
  expect(hooks).not.toBeNull();

  const { tasks } = await import("./db.ts");
  expect(tasks.get(taskId)?.column).toBe("running");
});

// ── 3. onAdopted: active-map registration + done resolution ────────────────

test("onAdopted registers the continuation run as active (cancelRun succeeds against it)", async () => {
  const taskId = await createTaskWithAgent("continuation-adopt-active", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });

  const hooks = realFactory!(taskId)!;
  const { tasks } = await import("./db.ts");
  const newRunId = tasks.get(taskId)!.runId!;

  let killed = false;
  const handle: SpawnedAgent = {
    kill: () => { killed = true; },
    writeInput: () => true,
    done: neverDone(),
  };
  hooks.onAdopted(handle);

  // There's no exported accessor for the orchestrator's in-memory `active`
  // map, so `cancelRun` — the public API that consults it — is the
  // documented way to observe registration (same technique
  // subagent-hold.test.ts uses for the settle-hook side of #92).
  const { cancelRun } = await import("./orchestrator.ts");
  const result = await cancelRun(newRunId);
  expect(result).toBe(true);
  expect(killed).toBe(true);
});

test("attachDoneHandler resolves the run: exit 0 -> succeeded, column -> review (no running subagents)", async () => {
  const taskId = await createTaskWithAgent("continuation-done-review", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });

  const hooks = realFactory!(taskId)!;
  const { tasks, runs } = await import("./db.ts");
  const newRunId = tasks.get(taskId)!.runId!;

  let resolveDone!: (code: number) => void;
  const donePromise = new Promise<number>((r) => { resolveDone = r; });
  hooks.onAdopted({ kill: () => {}, writeInput: () => true, done: donePromise });

  resolveDone(0);
  await wait(75);

  expect(runs.get(newRunId)?.status).toBe("succeeded");
  expect(tasks.get(taskId)?.column).toBe("review");
});

test("attachDoneHandler + a running subagent: the #92 hold applies to continuation runs too — task stays HELD in running", async () => {
  const taskId = await createTaskWithAgent("continuation-done-held", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });
  await insertRunningSubagent(taskId);

  const hooks = realFactory!(taskId)!;
  const { tasks, runs, subagents } = await import("./db.ts");
  const newRunId = tasks.get(taskId)!.runId!;

  let resolveDone!: (code: number) => void;
  const donePromise = new Promise<number>((r) => { resolveDone = r; });
  hooks.onAdopted({ kill: () => {}, writeInput: () => true, done: donePromise });

  resolveDone(0);
  await wait(75);

  expect(runs.get(newRunId)?.status).toBe("succeeded");
  expect(subagents.hasRunning(taskId)).toBe(true);
  // Held, not advanced — matches isHeldByBackgroundAgents/attachDoneHandler's
  // holdForSubagents branch.
  expect(tasks.get(taskId)?.column).toBe("running");
});

// ── 4. Fold-while-busy for a continuation run ───────────────────────────────

test("a follow-up sent while the continuation run is in flight folds into it (busy branch), not a new row", async () => {
  // sendClaudeTurn's fold path requires BOTH `hasSessionState(taskId)` (a
  // real, in-memory claude-tmux SessionState — NOT something
  // startContinuationRun touches) AND `active.has(task.runId)` (populated by
  // onAdopted above). claude-tmux.ts exposes `__forTest.installSession` for
  // exactly this — the same seam orchestrator.test.ts's own
  // "sendInput folds a follow-up into the in-flight run" test uses — so this
  // IS cheap to drive with the fake driver + /bin/echo tmux stub; no skip
  // needed.
  const taskId = await createTaskWithAgent("continuation-fold", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });

  const hooks = realFactory!(taskId)!;
  const { tasks, runs } = await import("./db.ts");
  const newRunId = tasks.get(taskId)!.runId!;

  const donePromise = neverDone(); // stays "in flight" for the whole test
  hooks.onAdopted({ kill: () => {}, writeInput: () => true, done: donePromise });

  const claudeTmux = await import("./claude-tmux.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-cont-fold-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  claudeTmux.__forTest.installSession(taskId, jsonlPath);
  try {
    const { sendInput } = await import("./orchestrator.ts");
    const sent = await sendInput(newRunId, "follow-up while continuation is in flight");
    expect(sent.delivered).toBe(true);
    if (sent.delivered) expect(sent.runId).toBe(newRunId);

    // No third run row: exactly the seeded prior run + the continuation run.
    const rows = runs.listForTask(taskId);
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.id === newRunId)).toBe(true);

    const events = runs.eventsForTask(taskId);
    expect(
      events.some(
        (e) => e.stream === "user" && e.data.includes("follow-up while continuation is in flight"),
      ),
    ).toBe(true);
  } finally {
    claudeTmux.__forTest.uninstallSession(taskId);
  }
});

// ── 5. Codex — is the factory actually agent-kind-guarded? ─────────────────

test("codex task → factory returns null (agent-kind guard)", async () => {
  // In production this factory is only ever invoked from claude-tmux.ts's
  // `dispatchLine` — codex-tmux.ts never references
  // `continuationRunFactory`/`setContinuationRunFactory` at all (grepped;
  // zero hits), so a codex task's session never reaches this path today.
  // `startContinuationRun`'s own body (orchestrator.ts ~1365) now guards on
  // `resolveHarness(task.agent)?.kind !== "claude-code"` in addition to the
  // `"__rebuild__"` and unknown/archived-task checks — continuations are a
  // claude-JSONL concept (a background-task auto-continuation observed via
  // `dispatchLine`'s tail of the session's own JSONL); codex is one-shot per
  // turn and has no equivalent notion of "kept talking after end_turn". This
  // test asserts the factory declines a codex task outright — defense in
  // depth for a path that's inert today but would otherwise mint a real
  // `origin: "continuation"` run row stamped with codex's agent id if a
  // future caller or refactor ever wired codex into this factory.
  const taskId = await createTaskWithAgent("continuation-codex-gap", "codex");
  const priorRunId = await seedPriorRun(taskId, {
    agent: "codex",
    codexSessionId: `codex-sess-${randomUUID()}`,
    column: "review",
  });

  const hooks = realFactory!(taskId);
  expect(hooks).toBeNull();

  const { tasks, runs } = await import("./db.ts");
  const task = tasks.get(taskId);
  // No adoption happened: column and runId stay exactly as seeded.
  expect(task?.column).toBe("review");
  expect(task?.runId).toBe(priorRunId);
  // No new run row was created — only the seeded prior run exists.
  const rows = runs.listForTask(taskId);
  expect(rows.length).toBe(1);
  expect(rows[0]?.id).toBe(priorRunId);
});

// ── 6. D12: adoption declines while an agetor-initiated turn is being minted ─
//
// docs/plans/handoff-identification-fix.md §3.2. `startingTaskIds` is held
// across a fresh `startTask` spawn, a `--resume` spawn and the idle mint
// (whose `sendTurn` flushSync can dispatch a notification line). An
// agetor-initiated turn being minted owns the content that arrives in that
// window, so the factory declines instead of overwriting `task.runId`.

test("D12: the factory declines while a startTask spawn holds the startingTaskIds claim, and adopts again once it is released", async () => {
  const taskId = await createTaskWithAgent("continuation-d12", "claude-code");
  const { startTask, cancelRun, isTaskRunLive } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const prevDelay = process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "400";
  try {
    const starting = startTask(taskId);
    // The claim is taken synchronously-ish inside startTask; the fake spawn
    // then sits on its 400 ms delay with the claim held.
    const deadline = Date.now() + 2000;
    while (!isTaskRunLive(taskId) && Date.now() < deadline) await wait(10);
    expect(isTaskRunLive(taskId)).toBe(true);

    // Mid-spawn: a continuation must not be adopted over the run being started.
    const before = tasks.get(taskId)!.runId;
    expect(realFactory!(taskId, "notification")).toBeNull();
    expect(tasks.get(taskId)!.runId).toBe(before);
    expect(runs.listForTask(taskId).some((r) => r.origin === "continuation")).toBe(false);

    const started = await starting;
    expect("error" in started).toBe(false);
    // Stop the fake run so the claim-free control below starts from rest.
    if ("runId" in started) await cancelRun(started.runId);
    await wait(50);

    // Control: with the claim released the same call adopts, so the decline
    // above was the claim and nothing else (task is not archived, is claude).
    const hooks = realFactory!(taskId, "notification");
    expect(hooks).not.toBeNull();
    expect(runs.get(tasks.get(taskId)!.runId!)?.origin).toBe("continuation");
  } finally {
    if (prevDelay === undefined) delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
    else process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = prevDelay;
  }
});

// ── 7. Displaced step-run settle report (runner-only, never the global bus) ──
//
// docs/plans/handoff-identification-fix.md §3.3 (RC3, O6). `attachDoneHandler`
// suppresses the column move and the `run-status` event for a run that is no
// longer the task's current run; for a STEP task it now reports that settle to
// the pipeline runner through a dedicated setter hook instead.

/** Open a continuation run on `taskId` and return its id and a resolver for
 *  its `done`. Opening a second one displaces the first as `task.runId`. */
async function openContinuation(taskId: string): Promise<{
  runId: string;
  finish: (code: number) => void;
  fail: (err: Error) => void;
}> {
  const hooks = realFactory!(taskId)!;
  expect(hooks).not.toBeNull();
  const { tasks } = await import("./db.ts");
  const runId = tasks.get(taskId)!.runId!;
  let finish!: (code: number) => void;
  let fail!: (err: Error) => void;
  const done = new Promise<number>((resolve, reject) => { finish = resolve; fail = reject; });
  hooks.onAdopted({ kill: () => {}, writeInput: () => true, done });
  return { runId, finish, fail };
}

/** Mark `taskId` as a hidden pipeline step row (these columns are server-
 *  managed, so the test writes them directly). */
async function makeStepTask(taskId: string): Promise<void> {
  const { db } = await import("./db.ts");
  db.run(`UPDATE tasks SET pipeline_parent_id = ?, pipeline_step_id = ? WHERE id = ?`, [
    `parent-${randomUUID()}`,
    "step-1",
    taskId,
  ]);
}

test("a displaced STEP run's settle is reported to the runner hook (succeeded and failed), with no run-status on the global bus", async () => {
  const { setDisplacedStepRunSettledHandler, subscribeGlobal } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  const taskId = await createTaskWithAgent("displaced-step", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });
  await makeStepTask(taskId);

  const reported: Array<{ taskId: string; runId: string; status: string }> = [];
  const prev = setDisplacedStepRunSettledHandler((tid, rid, status) => {
    reported.push({ taskId: tid, runId: rid, status });
  });
  const events: Array<{ kind: string; runId?: string }> = [];
  const unsubscribe = subscribeGlobal((e) => {
    if ("taskId" in e && e.taskId === taskId) events.push({ kind: e.kind, runId: "runId" in e ? (e.runId ?? undefined) : undefined });
  });
  try {
    // B then C: C displaces B as the task's current run.
    const b = await openContinuation(taskId);
    const c = await openContinuation(taskId);
    expect(tasks.get(taskId)!.runId).toBe(c.runId);

    b.finish(0);
    await wait(75);
    expect(runs.get(b.runId)?.status).toBe("succeeded");
    expect(reported).toEqual([{ taskId, runId: b.runId, status: "succeeded" }]);
    // The displaced run moved no column and emitted no run-status.
    expect(events.filter((e) => e.kind === "run-status")).toEqual([]);
    expect(tasks.get(taskId)!.runId).toBe(c.runId);
    expect(tasks.get(taskId)!.column).toBe("running");

    // The current run's own settle is NOT a displaced report; it reaches the
    // bus as run-status exactly as before.
    c.finish(0);
    await wait(75);
    expect(reported.length).toBe(1);
    expect(events.filter((e) => e.kind === "run-status" && e.runId === c.runId).length).toBe(1);
  } finally {
    unsubscribe();
    setDisplacedStepRunSettledHandler(prev);
  }
});

test("a displaced step run that REJECTS is reported as failed (the .catch branch), and a throwing handler never breaks settlement", async () => {
  const { setDisplacedStepRunSettledHandler } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  const taskId = await createTaskWithAgent("displaced-step-catch", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });
  await makeStepTask(taskId);

  const reported: Array<{ runId: string; status: string }> = [];
  const prev = setDisplacedStepRunSettledHandler((_tid, rid, status) => {
    reported.push({ runId: rid, status });
    throw new Error("runner exploded");
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const b = await openContinuation(taskId);
    const c = await openContinuation(taskId);

    b.fail(new Error("tailer died"));
    await wait(75);

    expect(reported).toEqual([{ runId: b.runId, status: "failed" }]);
    // Settlement still completed despite the handler throwing.
    expect(runs.get(b.runId)?.status).toBe("failed");
    expect(tasks.get(taskId)!.runId).toBe(c.runId);
  } finally {
    console.warn = warn;
    setDisplacedStepRunSettledHandler(prev);
  }
});

test("a displaced run of an ORDINARY (non-step) task fires nothing — the hook is step-only", async () => {
  const { setDisplacedStepRunSettledHandler } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  const taskId = await createTaskWithAgent("displaced-plain", "claude-code");
  await seedPriorRun(taskId, { claudeSessionId: `sess-${randomUUID()}` });

  const reported: string[] = [];
  const prev = setDisplacedStepRunSettledHandler((_tid, rid) => { reported.push(rid); });
  try {
    const b = await openContinuation(taskId);
    await openContinuation(taskId);
    b.finish(0);
    await wait(75);
    expect(runs.get(b.runId)?.status).toBe("succeeded");
    expect(reported).toEqual([]);
  } finally {
    setDisplacedStepRunSettledHandler(prev);
  }
});

test("setDisplacedStepRunSettledHandler returns the previous handler so callers can restore it", async () => {
  const { setDisplacedStepRunSettledHandler } = await import("./orchestrator.ts");
  const a = () => {};
  const base = setDisplacedStepRunSettledHandler(a);
  try {
    expect(setDisplacedStepRunSettledHandler(null)).toBe(a);
  } finally {
    setDisplacedStepRunSettledHandler(base);
  }
});
