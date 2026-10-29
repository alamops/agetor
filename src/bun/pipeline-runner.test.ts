import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — set it (and
// the fake-driver env) before any dynamic import touches db.ts/orchestrator.ts,
// mirroring orchestrator-agent-profiles.test.ts's own bootstrap.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-runner-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // tmux -V probe in agent-status passes

// The runner only processes settle/column events once subscribed — in the
// real app `index.ts`/`headless.ts` call this at boot; tests must call it
// themselves exactly once before the first `startTask` on a pipeline task,
// or every run silently wedges in `running` forever (nothing is listening).
beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

// `bun test` runs every file listed on the command line in ONE process with
// a shared module cache: `db.ts` opens `agetor.sqlite` exactly once, in
// whichever *.test.ts file's AGETOR_DATA_DIR happened to be captured first —
// see `test-data-dir.ts`'s doc comment. That means this file's fake-driver
// timers (`makeFakeAgent`'s `after(ms, …)` closures in agents.ts) and this
// runner's own async step-launch/settle continuations are NOT necessarily
// scoped to this file's own process lifetime the way they'd be if each file
// got its own DB: a timer left running past the end of a test here can fire
// while a LATER *.test.ts file in the same invocation is mid-`beforeEach`
// truncating shared tables, producing an unhandled `FOREIGN KEY constraint
// failed` in `runs.appendEvent` that derails bun's test runner for every
// file after it. `liveParentIds` + `waitUntilIdle` below exist to make sure
// nothing is left running when a test returns.
let liveParentIds: string[] = [];

/** Wait until pipeline task `parentId` is fully idle: its own
 *  `pipelineRun.status` isn't `"running"` AND no step task's `column` is
 *  `"running"` either — the same test `cancelPipelineRun` itself uses
 *  (`run.active.filter((a) => tasks.get(a.taskId)?.column === "running")`)
 *  to decide what's still live. A task that no longer exists (already
 *  deleted by the test itself) counts as idle. Every test that starts a run
 *  must await this before returning — see the file-level comment above for
 *  why a still-pending fake-driver timer is dangerous, not just untidy. */
async function waitUntilIdle(parentId: string, timeoutMs = 5000): Promise<void> {
  const { tasks } = await import("./db.ts");
  await waitFor(() => {
    const t = tasks.get(parentId);
    if (!t) return true;
    if (t.pipelineRun?.status === "running") return undefined;
    if (tasks.stepsForParent(parentId).some((s) => s.column === "running")) return undefined;
    return true;
  }, timeoutMs);
}

// Safety net: even with every test awaiting `waitUntilIdle` on its own
// happy path, an assertion that throws mid-test would skip that final wait
// and leave a run mid-flight. `deleteTask` kills any active handle
// (including a fake driver's pending timers) synchronously as part of its
// own cascade, so it doubles as a forceful "make sure nothing is still
// ticking" — safe to call on a task that's already idle or already deleted.
afterEach(async () => {
  const ids = liveParentIds;
  liveParentIds = [];
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const id of ids) {
    if (!tasks.get(id)) continue;
    await deleteTask(id).catch(() => {});
  }
});

// Final sweep: delete anything `afterEach` didn't already remove (a test
// that intentionally leaves its parent task around for its own assertions),
// then every pipeline/profile row this file created, then give any
// still-in-flight fake-driver timer/continuation one more beat to drain
// before attempting to remove the data dir (a no-op when `agetor.sqlite` is
// still open under another file's AGETOR_DATA_DIR — see `rmTestDataDir`).
afterAll(async () => {
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const t of tasks.list()) {
    if (t.pipelineId && !t.pipelineParentId) await deleteTask(t.id).catch(() => {});
  }
  for (const p of pipelines.list()) pipelines.delete(p.id);
  for (const p of agentProfiles.list()) agentProfiles.delete(p.id);
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

function uniqueName(label: string): string {
  return `pipeline-runner-${label}-${randomUUID()}`;
}

function freshWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-pipeline-runner-wd-"));
}

/** Poll `fn` until it returns a truthy value or `timeoutMs` elapses. */
async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 5000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Standalone helper: run git in a directory (mirrors worktree.test.ts).
async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A throwaway git repo with one commit on `main` — the source repo a
 *  worktree-isolated pipeline task points its `workdir` at, so branches and
 *  worktrees land in a temp repo, never in whatever `process.cwd()` is. */
async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-runner-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

async function makeProfile(label: string) {
  const { agentProfiles } = await import("./db.ts");
  return agentProfiles.insert({
    name: uniqueName(label),
    harness: "claude-code",
    model: "fake-model",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
}

test("linear A→B→C reaches review with 3 succeeded history records, handoff files, and B's prompt carrying A's handoff + the goal", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { pipelineRunsDir } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("linear");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `Do B. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `Do C. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: B.id, to: C.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("linear-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "linear run",
    prompt: "the overall goal text",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });

  expect(finished.column).toBe("review");
  const run = finished.pipelineRun!;
  expect(run.history.length).toBe(3);
  expect(run.history.every((h) => h.outcome === "succeeded")).toBe(true);
  expect(run.blocked.length).toBe(0);

  const steps = tasks.stepsForParent(parentId);
  expect(steps.length).toBe(3);
  for (const s of steps) expect(s.column).toBe("done");

  const stepB = steps.find((s) => s.pipelineStepId === B.id)!;
  expect(stepB.prompt).toContain("the overall goal text");
  expect(stepB.prompt).toContain("fake purpose");
  expect(stepB.prompt).toContain('From "A"');

  const dir = pipelineRunsDir(parentId);
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(dir).length).toBeGreaterThan(0);
  await waitUntilIdle(parentId);
});

test("a step row copies its profile's speed tier from the frozen snapshot, and the parent mirrors the start step's speed", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, agentProfiles } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = agentProfiles.insert({
    name: uniqueName("speed"),
    harness: "claude-code",
    model: "fake-model",
    effort: null,
    mode: null,
    speed: "fast",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `Do A. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = pipelines.insert({
    name: uniqueName("speed-pipeline"),
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });

  const created = await createTask({
    title: "speed run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  expect(created.task.speed).toBe("fast");

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const step = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  expect(step.speed).toBe("fast");
  expect(step.agentProfile?.speed).toBe("fast");

  await waitFor(() => tasks.get(parentId)?.pipelineRun?.status === "done");
  await waitUntilIdle(parentId);
});

test("branching by name: A picks C over B via handoff.next", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("branch");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "choose", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:C` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("branch-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "branch run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });

  expect(finished.pipelineRun!.history.length).toBe(2);
  const steps = tasks.stepsForParent(parentId);
  expect(steps.length).toBe(2);
  expect(steps.some((s) => s.pipelineStepId === C.id)).toBe(true);
  expect(steps.some((s) => s.pipelineStepId === B.id)).toBe(false);
  await waitUntilIdle(parentId);
});

test(":missing → blocked handoff-missing; advancePipeline(nextStepIds:[B]) continues to done", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("missing");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("missing-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "missing run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.column).toBe("blocked");
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);
  expect(blocked.pipelineRun!.active.length).toBe(1);

  const advanced = await advancePipeline(parentId, { nextStepIds: [B.id] });
  if ("error" in advanced) throw new Error(advanced.error);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.column).toBe("review");
  const advancedRecord = done.pipelineRun!.history.find((h) => h.stepId === A.id);
  expect(advancedRecord?.outcome).toBe("advanced-manually");
  await waitUntilIdle(parentId);
});

test(":invalid → blocked handoff-invalid", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("invalid");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:invalid` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("invalid-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "invalid run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-invalid")).toBe(true);
  await waitUntilIdle(parentId);
});

test("fan-out transition:\"all\" (A→B,C) then join:\"all\" (D) — both branches run in parallel, D starts once with two previous handoffs", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("fanout-all");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-all-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-all run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  // L-R9: a deterministic seam instead of polling for a transient window —
  // hold every fake turn open long enough (700ms) that B and C are provably
  // BOTH active/running at once; the fan-out is observed as a state, not
  // raced against a 3ms poll loop.
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const bothRunning = await waitFor(() => {
      const t = tasks.get(parentId);
      const bc = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId === B.id || s.pipelineStepId === C.id);
      return bc.length === 2 && bc.every((s) => s.column === "running") && (t?.pipelineRun?.active.length ?? 0) === 2 ? t : undefined;
    }, 8000);
    expect(bothRunning.pipelineRun!.active.map((a) => a.stepId).sort()).toEqual([B.id, C.id].sort());
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 10000);

  const steps = tasks.stepsForParent(parentId);
  const dSteps = steps.filter((s) => s.pipelineStepId === D.id);
  expect(dSteps.length).toBe(1);
  expect(dSteps[0]!.prompt).toContain('From "B"');
  expect(dSteps[0]!.prompt).toContain('From "C"');
  expect(finished.pipelineRun!.history.length).toBe(4);
  expect(Object.keys(finished.pipelineRun!.joins).length).toBe(0);
  await waitUntilIdle(parentId);
});

test("join:\"any\" (D, default) starts twice — once per arrival", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("fanout-any");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "any", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-any-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-any run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);

  const steps = tasks.stepsForParent(parentId);
  const dSteps = steps.filter((s) => s.pipelineStepId === D.id);
  expect(dSteps.length).toBe(2);
  expect(finished.pipelineRun!.history.length).toBe(5); // A, B, C, D, D
  await waitUntilIdle(parentId);
});

test("join-incomplete when the other incoming path never arrives; manual advance launches the join with the partial arrival", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("join-incomplete");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  // C never actually hands off to D — it picks E instead (marker :E).
  const C = newStep({ name: "C", agentProfileId: profile.id, transition: "choose", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:E` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const E = newStep({ name: "E", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D, E],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
      { id: "e5", from: C.id, to: E.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-incomplete-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-incomplete run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const block = blocked.pipelineRun!.blocked.find((b) => b.kind === "join-incomplete");
  expect(block).toBeTruthy();
  expect(block!.stepId).toBe(D.id);
  expect(blocked.pipelineRun!.active.length).toBe(0);
  expect(blocked.pipelineRun!.joins[D.id]?.arrivals.length).toBe(1);

  const advanced = await advancePipeline(parentId, { nextStepIds: [D.id] });
  if ("error" in advanced) throw new Error(advanced.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  const steps = tasks.stepsForParent(parentId);
  const dStep = steps.find((s) => s.pipelineStepId === D.id)!;
  expect(dStep.prompt).toContain('From "B"');
  expect(dStep.prompt).not.toContain('From "C"');
  expect(Object.keys(finished.pipelineRun!.joins).length).toBe(0);
  await waitUntilIdle(parentId);
});

test("step cap: A↔B cycle with maxSteps 3 blocks with step-cap after 3 executions", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("cap");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: B.id, to: A.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("cap-pipeline"), graph, maxSteps: 3 });

  const created = await createTask({ title: "cap run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  expect(blocked.pipelineRun!.stepCount).toBe(3);
  expect(blocked.pipelineRun!.history.length).toBe(3);
  await waitUntilIdle(parentId);
});

test("cancel mid-step then retry restarts the same step task", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { cancelPipelineRun, retryPipelineStep } = await import("./pipeline-runner.ts");

  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const profile = await makeProfile("cancel");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = { steps: [A], edges: [], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("cancel-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "cancel run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    await waitFor(() => {
      const steps = tasks.stepsForParent(parentId);
      return steps[0]?.column === "running" ? steps[0] : undefined;
    });

    const cancelled = await cancelPipelineRun(parentId);
    if ("error" in cancelled) throw new Error(cancelled.error);

    const afterCancel = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "cancelled" ? t : undefined;
    });
    expect(afterCancel.column).toBe("ready");
    expect(afterCancel.pipelineRun!.active.length).toBe(1);
    const stepsBeforeRetry = tasks.stepsForParent(parentId);
    expect(stepsBeforeRetry.length).toBe(1);

    const retried = await retryPipelineStep(parentId);
    if ("error" in retried) throw new Error(retried.error);

    const runningAgain = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "running" ? t : undefined;
    });
    expect(runningAgain.pipelineRun!.active.length).toBe(1);
    // Retry re-runs the SAME step task, never inserts a second one.
    expect(tasks.stepsForParent(parentId).length).toBe(1);

    // Let the retried run's fake-driver resolve (bounded by the 700ms delay
    // above) actually fire before this test returns — the closure captured
    // `resolveDelayMs` at spawn time, so deleting the env var in `finally`
    // below does NOT stop it. Without this wait the retried run's turn
    // resolves ~700ms after this test has already ended, well after this
    // whole file's own tests may be done — see the file-level comment above
    // `waitUntilIdle` for why a fake-driver timer that outlives its test is
    // dangerous under a shared-process `bun test` invocation, not just untidy.
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("delete cascade removes step tasks + run dir; archive cascade archives steps; a direct step delete/archive is refused", async () => {
  const { createTask, startTask, deleteTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { pipelineRunsDir } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("cascade");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("cascade-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "cascade run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");

  const stepsBefore = tasks.stepsForParent(parentId);
  expect(stepsBefore.length).toBe(2);

  // Direct step archive/delete is refused (no `fromPipeline`) — both the
  // step and the parent survive untouched.
  const stepArchiveResult = await archiveTask(stepsBefore[0]!.id, { force: true });
  expect("error" in stepArchiveResult).toBe(true);
  expect(tasks.get(stepsBefore[0]!.id)?.archivedAt ?? null).toBeNull();

  await deleteTask(stepsBefore[0]!.id);
  expect(tasks.get(stepsBefore[0]!.id)).not.toBeNull();
  expect(tasks.get(parentId)).not.toBeNull();

  // Archive cascade: force past the "must be in Done" gate (the parent is
  // in `review`, matching a real pipeline task that hasn't been dragged to
  // Done yet) — every step archives along with it.
  const archived = await archiveTask(parentId, { force: true });
  if ("error" in archived) throw new Error(archived.error);
  for (const s of tasks.stepsForParent(parentId)) {
    expect(s.archivedAt).not.toBeNull();
  }

  const dir = pipelineRunsDir(parentId);
  expect(existsSync(dir)).toBe(true);

  // Delete cascade: parent + every step + the run dir are all gone.
  await deleteTask(parentId);
  expect(tasks.get(parentId)).toBeNull();
  for (const s of stepsBefore) {
    expect(tasks.get(s.id)).toBeNull();
  }
  expect(existsSync(dir)).toBe(false);
  await waitUntilIdle(parentId); // no-op here (parent already gone) — kept for consistency
});

test("createTask rejects pipelineId+agentProfileId together, an unknown pipeline, and a pipeline with a step that has no agent", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");

  const profile = await makeProfile("createtask-reject");

  const noAgentGraph = { steps: [newStep({ name: "A", agentProfileId: null })], edges: [], startStepId: null };
  const noAgentPipeline = pipelines.insert({ name: uniqueName("no-agent-pipeline"), graph: noAgentGraph, maxSteps: 5 });
  const rejectedNoAgent = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: noAgentPipeline.id,
  });
  expect("error" in rejectedNoAgent).toBe(true);

  const goodGraph = { steps: [newStep({ name: "A", agentProfileId: profile.id })], edges: [], startStepId: null };
  const goodPipeline = pipelines.insert({ name: uniqueName("good-pipeline"), graph: goodGraph, maxSteps: 5 });

  const both = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: goodPipeline.id, agentProfileId: profile.id,
  });
  expect("error" in both).toBe(true);

  const unknown = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: "not-a-real-pipeline-id",
  });
  expect("error" in unknown).toBe(true);

  const ok = await createTask({
    title: "x", prompt: "y", workdir: freshWorkdir(), isolation: "none", pipelineId: goodPipeline.id,
  });
  expect("error" in ok).toBe(false);
  if (!("error" in ok)) {
    expect(ok.task.pipelineId).toBe(goodPipeline.id);
    expect(ok.task.agentProfileId).toBeNull();
    expect(ok.task.pipelineRun?.status).toBe("idle");
    expect(ok.task.agent).toBe("claude-code");
  }
});

test("effectiveAgentProfile returns the frozen snapshot (never \"live\") for a step task", async () => {
  const { createTask, startTask, effectiveAgentProfile } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("effective-profile");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("effective-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "effective run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  const resolved = effectiveAgentProfile(stepTask);
  expect(resolved).not.toBeNull();
  expect(resolved!.source).toBe("snapshot");
  expect(resolved!.profile.id).toBe(profile.id);

  // The step's fake handoff turn is still in flight at this point (only its
  // task ROW has appeared, not its resolve) — let it finish before this
  // test returns, same reasoning as every other test in this file.
  await waitUntilIdle(parentId);
});

// ---------------------------------------------------------------------------
// Review-fix regression coverage (M1-M16, m8-m13)
// ---------------------------------------------------------------------------

test("M1: handoff status:\"blocked\" records a step-blocked entry without advancing; advancePipeline resolves it", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline, __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("blocked-status");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("blocked-status-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "blocked-status run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Simulate A's OWN turn ending with a well-formed handoff whose
    // `status` is `"blocked"` (a real handoff, just one reporting it
    // couldn't finish) — appended after the fake driver's own `:done`
    // handoff so `parseHandoff`'s "last block wins" picks this one up.
    const blockedHandoff = {
      schemaVersion: 1,
      purpose: "p",
      summary: "s",
      reason: "waiting on a decision",
      next: null,
      artifacts: [] as string[],
      openQuestions: ["which approach?"],
      status: "blocked" as const,
    };
    runs.appendEvent(runRow.id, "assistant", `Done.\n<${HANDOFF_TAG}>\n${JSON.stringify(blockedHandoff)}\n</${HANDOFF_TAG}>`);
    await __forTest.handleRunStatus(stepA.id, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const afterBlock = tasks.get(parentId)!;
  const run = afterBlock.pipelineRun!;
  const block = run.blocked.find((b) => b.taskId === stepA!.id);
  expect(block?.kind).toBe("step-blocked");
  expect(block?.message).toContain("reported it is blocked");
  expect(block?.message).toContain("which approach?");
  // Not advanced — the execution is still sitting in `active`, not resolved.
  expect(run.active.length).toBe(1);
  expect(run.active[0]!.taskId).toBe(stepA!.id);
  const historyA = run.history.find((h) => h.taskId === stepA!.id);
  expect(historyA?.outcome).toBeNull();
  expect(historyA?.endedAt).toBeNull();
  expect(historyA?.handoff?.status).toBe("blocked");

  const advanced = await advancePipeline(parentId, { nextStepIds: [B.id] });
  if ("error" in advanced) throw new Error(advanced.error);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.column).toBe("review");
  const advancedRecord = done.pipelineRun!.history.find((h) => h.taskId === stepA!.id);
  expect(advancedRecord?.outcome).toBe("advanced-manually");
  await waitUntilIdle(parentId);
});

test("M2: a step-cap block carries a pending launch; retryPipelineStep extends the cap and continues", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("cap-retry");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: B.id, to: A.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("cap-retry-pipeline"), graph, maxSteps: 3 });

  const created = await createTask({ title: "cap-retry run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  const capBlock = blocked.pipelineRun!.blocked.find((b) => b.kind === "step-cap");
  expect(capBlock).toBeTruthy();
  expect(capBlock?.pending).toBeTruthy();
  expect(blocked.pipelineRun!.stepCount).toBe(3);

  const retried = await retryPipelineStep(parentId);
  if ("error" in retried) throw new Error(retried.error);

  // effectiveStepCap is maxSteps * (1 + capExtensions) — one extension on a
  // maxSteps:3 run raises the allowance to 3 * (1 + 1) = 6, so the run keeps
  // going (steps 4, 5, 6) before blocking on step-cap again at 6.
  const blockedAgain = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.stepCount > 3 ? t : undefined;
  }, 8000);
  expect(blockedAgain.pipelineRun!.stepCount).toBe(6);
  expect(blockedAgain.pipelineRun!.capExtensions).toBe(1);
  expect(blockedAgain.pipelineRun!.blocked.some((b) => b.kind === "step-cap")).toBe(true);
  // M-C5: the run-level `step-cap` block is replaced in place on the second
  // hit, never stacked — exactly one, even though the cap was reached twice.
  expect(blockedAgain.pipelineRun!.blocked.filter((b) => b.kind === "step-cap").length).toBe(1);

  // L-R9: a SECOND Retry extends the allowance once more — additive, not
  // multiplicative: 3 * (1 + 2) = 9, so steps 7, 8, 9 run before the cap
  // blocks a third time at 9.
  const retriedAgain = await retryPipelineStep(parentId);
  if ("error" in retriedAgain) throw new Error(retriedAgain.error);
  const blockedThird = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.stepCount > 6 ? t : undefined;
  }, 10000);
  expect(blockedThird.pipelineRun!.stepCount).toBe(9);
  expect(blockedThird.pipelineRun!.capExtensions).toBe(2);
  expect(blockedThird.pipelineRun!.blocked.filter((b) => b.kind === "step-cap").length).toBe(1);
  await waitUntilIdle(parentId);
});

test("M2: a finished pipeline refuses a plain Run (\"restart it explicitly\"); startPipelineRun({restart:true}) starts fresh", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { startPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("restart");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("restart-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "restart run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");
  expect(finished.pipelineRun!.history.length).toBe(1);

  const plainRun = await startTask(parentId);
  expect("error" in plainRun).toBe(true);
  if ("error" in plainRun) expect(plainRun.error).toContain("restart it explicitly");
  // Refusing must not have mutated anything.
  expect(tasks.get(parentId)!.pipelineRun!.status).toBe("done");

  const restarted = await startPipelineRun(tasks.get(parentId)!, { restart: true });
  if ("error" in restarted) throw new Error(restarted.error);

  const finishedAgain = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" && t.pipelineRun.startedAt !== finished.pipelineRun!.startedAt ? t : undefined;
  });
  // A fresh run — history reset to exactly this run's one execution, not
  // accumulated on top of the prior run's.
  expect(finishedAgain.pipelineRun!.history.length).toBe(1);
  await waitUntilIdle(parentId);
});

test("a pipeline parked in Done survives a same-status persist, and Restart pulls the card back", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { startPipelineRun, __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("park-done");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("park-done-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "park done", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");

  // The Done button's park. The HTTP guard is covered in
  // pipelines-endpoint.test.ts; here the column is written the same way
  // the route's `tasks.update` does, then a same-status persist must leave
  // it alone.
  tasks.update(parentId, { column: "done" });
  __forTest.persist(parentId, tasks.get(parentId)!.pipelineRun!);
  expect(tasks.get(parentId)!.column).toBe("done");
  expect(tasks.get(parentId)!.pipelineRun!.status).toBe("done");

  // Hold the restarted step in flight long enough to observe the column
  // follow the status change to Running before the new run finishes in Review.
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const restarted = await startPipelineRun(tasks.get(parentId)!, { restart: true });
    if ("error" in restarted) throw new Error(restarted.error);
    const running = tasks.get(parentId)!;
    expect(running.pipelineRun!.status).toBe("running");
    expect(running.column).toBe("running");

    const finishedAgain = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" && t.pipelineRun.startedAt !== finished.pipelineRun!.startedAt ? t : undefined;
    }, 10000);
    expect(finishedAgain.column).toBe("review");
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M4: advancePipeline refuses (409) while the target step is still genuinely live", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { advancePipeline } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("advance-live-guard");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = { steps: [A], edges: [], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("advance-live-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "advance-live run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => {
      const s = tasks.stepsForParent(parentId)[0];
      return s?.column === "running" ? s : undefined;
    });

    const result = await advancePipeline(parentId, { fromTaskId: stepA.id, nextStepIds: null });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("still running");
    }
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M5: stopping one step directly (not the whole pipeline) doesn't cancel a still-live sibling", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { advancePipeline } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("stop-one-of-two");
    const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = {
      steps: [A, B, C],
      edges: [
        { id: "e1", from: A.id, to: B.id, label: "" },
        { id: "e2", from: A.id, to: C.id, label: "" },
      ],
      startStepId: A.id,
    };
    const pipeline = pipelines.insert({ name: uniqueName("stop-one-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "stop-one run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    await waitFor(() => {
      const steps = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId !== A.id);
      return steps.length === 2 && steps.every((s) => s.column === "running") ? steps : undefined;
    }, 8000);
    const stepB = tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === B.id)!;

    await cancelRun(stepB.runId!);

    // Wait on the PIPELINE RUN's own reflection of the stop, not just B's
    // task column — `updateColumn` (sync) and this runner's own
    // `handleRunStatus` (dispatched via `void handleRunStatus(...)`, so
    // genuinely async relative to the column flip) are two separate
    // observers of the same settle event, and the column can flip to
    // `ready` a beat before the pipeline history entry is updated.
    const afterStop = await waitFor(() => {
      const t = tasks.get(parentId);
      const h = t?.pipelineRun?.history.find((x) => x.taskId === stepB.id);
      return h?.outcome === "cancelled" ? t : undefined;
    });
    // The whole run must NOT have been cancelled — C is still live.
    expect(afterStop!.pipelineRun!.status).not.toBe("cancelled");
    expect(afterStop!.column).not.toBe("ready");
    const runAfterStop = afterStop!.pipelineRun!;
    expect(runAfterStop.active.some((a) => a.taskId === stepB.id)).toBe(true);
    const bHistory = runAfterStop.history.find((h) => h.taskId === stepB.id);
    expect(bHistory?.outcome).toBe("cancelled");

    // Clean up the dangling stopped-but-not-resolved step so the run can
    // reach a terminal state (mirrors what a user would do from the UI:
    // Advance it to a dead end since it wasn't going to be retried).
    const resolvedB = await advancePipeline(parentId, { fromTaskId: stepB.id, nextStepIds: null });
    if ("error" in resolvedB) throw new Error(resolvedB.error);

    const finished = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" ? t : undefined;
    }, 8000);
    expect(finished.column).toBe("review");
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M3: join-incomplete advance with nextStepIds:null drops the partial join and finishes without launching it", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("join-incomplete-null");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  // C never actually hands off to D — it picks E instead (marker :E).
  const C = newStep({ name: "C", agentProfileId: profile.id, transition: "choose", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:E` });
  const D = newStep({ name: "D", agentProfileId: profile.id, join: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const E = newStep({ name: "E", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C, D, E],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
      { id: "e3", from: B.id, to: D.id, label: "" },
      { id: "e4", from: C.id, to: D.id, label: "" },
      { id: "e5", from: C.id, to: E.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("join-null-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "join-incomplete-null run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "join-incomplete")).toBe(true);

  const advanced = await advancePipeline(parentId, { nextStepIds: null });
  if ("error" in advanced) throw new Error(advanced.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  const steps = tasks.stepsForParent(parentId);
  expect(steps.some((s) => s.pipelineStepId === D.id)).toBe(false);
  expect(Object.keys(finished.pipelineRun!.joins).length).toBe(0);
  await waitUntilIdle(parentId);
});

test("M10: step tasks carry the parent's own references plus the handoff file reference", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("refs-propagation");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("refs-pipeline"), graph, maxSteps: 25 });

  const parentRefPath = path.join(freshWorkdir(), "notes.md");
  const created = await createTask({
    title: "refs run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
    references: [{ path: parentRefPath, isDirectory: false }],
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  expect(created.task.references).toEqual([{ path: parentRefPath, isDirectory: false }]);

  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");

  const steps = tasks.stepsForParent(parentId);
  const stepA = steps.find((s) => s.pipelineStepId === A.id)!;
  const stepB = steps.find((s) => s.pipelineStepId === B.id)!;

  // A is the first step — no prior handoff, so its references are just the
  // parent's own.
  expect(stepA.references).toEqual([{ path: parentRefPath, isDirectory: false }]);

  // B's references carry the parent's own reference PLUS a handoff file
  // reference written from A's handoff.
  expect(stepB.references.some((r) => r.path === parentRefPath)).toBe(true);
  expect(stepB.references.length).toBeGreaterThan(1);
  expect(stepB.references.some((r) => r.path.includes("handoff-") && r.path.endsWith(".json"))).toBe(true);

  await waitUntilIdle(parentId);
});

test("M16: reconcilePipelineRuns catches a step settle the listener never saw", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { reconcilePipelineRuns, __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("reconcile-missed");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("reconcile-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "reconcile run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status === "succeeded" ? r : undefined;
    });

    // The listener never processed this settle — the parent is still
    // "running" with A sitting in `active` even though its real run has
    // already succeeded.
    expect(tasks.get(parentId)!.pipelineRun!.active.length).toBe(1);
    expect(tasks.get(parentId)!.pipelineRun!.status).toBe("running");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const reconciledCount = await reconcilePipelineRuns();
  expect(reconciledCount).toBeGreaterThanOrEqual(1);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(finished.column).toBe("review");
  await waitUntilIdle(parentId);
});

test("archived pipeline parent refuses start/advance/retry with archived-guard errors", async () => {
  const { createTask, startTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { advancePipeline, retryPipelineStep, startPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("archived-guard");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("archived-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "archived run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);

  const archived = await archiveTask(parentId, { force: true });
  if ("error" in archived) throw new Error(archived.error);
  expect(tasks.get(parentId)!.archivedAt).not.toBeNull();

  const advanceResult = await advancePipeline(parentId, { nextStepIds: null });
  expect("error" in advanceResult).toBe(true);
  if ("error" in advanceResult) {
    expect(advanceResult.status).toBe(409);
    expect(advanceResult.error).toContain("archived");
  }

  const retryResult = await retryPipelineStep(parentId);
  expect("error" in retryResult).toBe(true);
  if ("error" in retryResult) {
    expect(retryResult.status).toBe(409);
    expect(retryResult.error).toContain("archived");
  }

  // `startTask` itself auto-unarchives ANY task (including a pipeline
  // parent) before dispatching, by design — so the archived guard here is
  // only reachable via a caller that bypasses that, exactly like the real
  // `POST /tasks/:id/pipeline/restart` route does (it calls
  // `startPipelineRun` directly, never through `startTaskInner`).
  const startResult = await startPipelineRun(tasks.get(parentId)!, { restart: true });
  expect("error" in startResult).toBe(true);
  if ("error" in startResult) expect(startResult.error).toContain("archived");
});

// ---------------------------------------------------------------------------
// Round-2 review-fix regression coverage (Major 1/2/3/5, Minor 6/10/14/15)
// ---------------------------------------------------------------------------

test("Major 1: a step stopped while a fan-out sibling is still live reads as blocked (not stuck running), then retry brings it home to done", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { retryPipelineStep } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("major1-stop-retry");
    const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = {
      steps: [A, B, C],
      edges: [
        { id: "e1", from: A.id, to: B.id, label: "" },
        { id: "e2", from: A.id, to: C.id, label: "" },
      ],
      startStepId: A.id,
    };
    const pipeline = pipelines.insert({ name: uniqueName("major1-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "major1 run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    await waitFor(() => {
      const steps = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId !== A.id);
      return steps.length === 2 && steps.every((s) => s.column === "running") ? steps : undefined;
    }, 8000);
    const stepB = tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === B.id)!;

    await cancelRun(stepB.runId!);

    // The run must read `blocked` — not stuck `running` forever — the
    // moment B's stop is processed, even though C is still genuinely live.
    const afterStop = await waitFor(() => {
      const t = tasks.get(parentId);
      const h = t?.pipelineRun?.blocked.find((b) => b.taskId === stepB.id);
      return h ? t : undefined;
    });
    expect(afterStop!.pipelineRun!.status).toBe("blocked");
    expect(afterStop!.column).toBe("blocked");
    const holdBlock = afterStop!.pipelineRun!.blocked.find((b) => b.taskId === stepB.id)!;
    expect(holdBlock.kind).toBe("step-failed");
    expect(holdBlock.message).toContain("stopped");

    // Once C ALSO finishes, the run must still read `blocked` — not flip
    // back to `running` (nothing left active to run) and not silently
    // resolve as `done` with B's dead-end execution just... gone.
    await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.history.some((h) => h.stepId === C.id && h.outcome === "succeeded") ? t : undefined;
    }, 8000);
    const afterSiblingDone = tasks.get(parentId)!;
    expect(afterSiblingDone.pipelineRun!.status).toBe("blocked");
    expect(afterSiblingDone.pipelineRun!.blocked.some((b) => b.taskId === stepB.id)).toBe(true);

    // Retry re-runs B in place; once it succeeds too, the whole run
    // finishes.
    const retried = await retryPipelineStep(parentId);
    if ("error" in retried) throw new Error(retried.error);

    const finished = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" ? t : undefined;
    }, 8000);
    expect(finished.column).toBe("review");
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("Major 2: a step settling after its parent was archived records a pending hold and never launches the next step", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("archived-settle");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("archived-settle-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "archived settle run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Simulate the parent being archived WHILE A's settle is still
    // in flight, unprocessed — the exact race Major 2 guards against:
    // `archiveTask` sets `archivedAt` on the row before it ever acquires
    // the per-parent pipeline lock this settle also has to go through.
    tasks.update(parentId, { archivedAt: Date.now() });

    await __forTest.handleRunStatus(stepA.id, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const afterSettle = tasks.get(parentId)!;
  // B was never launched.
  expect(tasks.stepsForParent(parentId).length).toBe(1);
  const run = afterSettle.pipelineRun!;
  const hold = run.blocked.find((b) => b.stepId === B.id && b.taskId === null);
  expect(hold).toBeTruthy();
  expect(hold?.kind).toBe("step-failed");
  expect(hold?.message).toContain("archived");
  expect(hold?.pending?.stepId).toBe(B.id);
  // A's own settle still got recorded correctly despite the hold.
  const historyA = run.history.find((h) => h.taskId === stepA!.id);
  expect(historyA?.outcome).toBe("succeeded");

  await waitUntilIdle(parentId);
  await deleteTask(parentId);
});

test("Major 3: startPipelineRun({restart:true}) on a BLOCKED run starts fresh instead of retrying in place", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { startPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("restart-blocked");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("restart-blocked-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "restart-blocked run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  });
  expect(blocked.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);
  expect(tasks.stepsForParent(parentId).length).toBe(1);

  const restarted = await startPipelineRun(tasks.get(parentId)!, { restart: true });
  if ("error" in restarted) throw new Error(restarted.error);

  // A fresh run — a SECOND step-A task task inserted (the retry-in-place
  // path would instead re-run the existing one), and the blocked reason
  // from the first attempt is gone (a new run replaces `blocked`/`history`
  // wholesale).
  const afterRestart = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "running" && tasks.list().filter((s) => s.pipelineParentId === parentId).length === 2 ? t : undefined;
  }, 8000);
  expect(afterRestart.pipelineRun!.blocked.length).toBe(0);
  expect(afterRestart.pipelineRun!.history.length).toBe(1);
  // M-R8: the replaced run's step row is retired (archived) by the restart;
  // only the fresh run's step is live. Read via `tasks.list()` (which
  // carries archived rows) so this holds whether or not `stepsForParent`
  // filters archived rows out.
  const stepRows = tasks.list().filter((t) => t.pipelineParentId === parentId);
  expect(stepRows.length).toBe(2);
  expect(stepRows.filter((t) => t.archivedAt != null).length).toBe(1);
  const freshStep = stepRows.find((t) => t.archivedAt == null)!;
  expect(afterRestart.pipelineRun!.active[0]?.taskId).toBe(freshStep.id);

  const finished = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  // The restarted run reaches its own `:missing` handoff block again — a
  // fresh run of the SAME single-step pipeline behaves identically to the
  // first, just starting over rather than reusing the old step task.
  expect(finished.pipelineRun!.blocked.some((b) => b.kind === "handoff-missing")).toBe(true);
  await waitUntilIdle(parentId);
});

test("Major 5: an invalid stored pipeline graph is rejected at run start, never reaching the runner", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, db } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("invalid-graph");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("invalid-graph-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({ title: "invalid graph run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  // Corrupt the STORED pipeline row directly (bypassing `pipelines.insert`/
  // `update`'s own `validatePipelineGraph` call) — simulates a hand-edited
  // row, or a future schema slip, putting a structurally invalid graph in
  // the DB: an edge pointing at a step id that doesn't exist.
  const corrupted = { steps: [A], edges: [{ id: "bad-edge", from: A.id, to: "does-not-exist", label: "" }], startStepId: A.id };
  db.run("UPDATE pipelines SET graph = ? WHERE id = ?", [JSON.stringify(corrupted), pipeline.id]);

  const startResult = await startTask(parentId);
  expect("error" in startResult).toBe(true);
  if ("error" in startResult) {
    expect(startResult.error).toContain("pipeline graph is invalid");
  }

  // Nothing was launched — the run never left `idle`, no step task exists.
  const after = tasks.get(parentId)!;
  expect(after.pipelineRun?.status ?? "idle").toBe("idle");
  expect(tasks.stepsForParent(parentId).length).toBe(0);
});

// Round-3 review-fix regression coverage (Major 1, Minor 3/5/6/7/8/9)

test("Major 1 (round 3): a WHOLE-pipeline Stop on a fan-out ends cancelled — not blocked — with no \"was stopped\" entries; retry then finishes it", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { cancelPipelineRun, retryPipelineStep } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("whole-run-stop");
    const A = newStep({ name: "A", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = {
      steps: [A, B, C],
      edges: [
        { id: "e1", from: A.id, to: B.id, label: "" },
        { id: "e2", from: A.id, to: C.id, label: "" },
      ],
      startStepId: A.id,
    };
    const pipeline = pipelines.insert({ name: uniqueName("whole-run-stop-pipeline"), graph, maxSteps: 25 });

    const created = await createTask({ title: "whole-run-stop run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    await waitFor(() => {
      const steps = tasks.stepsForParent(parentId).filter((s) => s.pipelineStepId !== A.id);
      return steps.length === 2 && steps.every((s) => s.column === "running") ? steps : undefined;
    }, 8000);

    // Stop the WHOLE pipeline (not one step's own panel) while both B and C
    // are still genuinely live.
    const cancelled = await cancelPipelineRun(parentId);
    if ("error" in cancelled) throw new Error(cancelled.error);

    const afterCancel = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "cancelled" ? t : undefined;
    });
    expect(afterCancel.column).toBe("ready");
    expect(afterCancel.pipelineRun!.active.length).toBe(2);
    expect(afterCancel.pipelineRun!.blocked.length).toBe(0);

    // Wait for BOTH B's and C's own async settle events (dispatched via the
    // run-status listener, genuinely concurrent with `cancelPipelineRun`
    // itself having already forced `status: "cancelled"`) to land. Neither
    // must ever add a "was stopped" step-failed block — that's exactly the
    // bug: a deliberate whole-run Stop must never end up reading `blocked`.
    const bothSettled = await waitFor(() => {
      const t = tasks.get(parentId);
      const run = t?.pipelineRun;
      if (!run) return undefined;
      const bDone = run.history.some((h) => h.stepId === B.id && h.outcome === "cancelled");
      const cDone = run.history.some((h) => h.stepId === C.id && h.outcome === "cancelled");
      return bDone && cDone ? t : undefined;
    }, 8000);
    expect(bothSettled.pipelineRun!.status).toBe("cancelled");
    expect(bothSettled.column).toBe("ready");
    expect(bothSettled.pipelineRun!.blocked.length).toBe(0);

    // Retry brings both stopped executions back and the run finishes.
    const retried = await retryPipelineStep(parentId);
    if ("error" in retried) throw new Error(retried.error);

    const runningAgain = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "running" ? t : undefined;
    }, 8000);
    expect(runningAgain.pipelineRun!.active.length).toBe(2);
    // Retry re-ran the SAME two step tasks, never inserted duplicates.
    expect(tasks.stepsForParent(parentId).length).toBe(3);

    const finished = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" ? t : undefined;
    }, 8000);
    expect(finished.column).toBe("review");
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

// ---------------------------------------------------------------------------
// One-shot handoff reminder (owner request, docs/plans/pipelines.md)
// ---------------------------------------------------------------------------

test(":missing-then-done — one automatic reminder, then advances to done with responseKind \"handoff\"", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("missing-then-done");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing-then-done`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("missing-then-done-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "missing-then-done run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  expect(done.column).toBe("review");
  const run = done.pipelineRun!;
  expect(run.blocked.length).toBe(0);

  const record = run.history.find((h) => h.stepId === A.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder).not.toBeNull();
  expect(record?.reminder?.reason).toBe("handoff-missing");
  expect(record?.reminder?.runId).not.toBeNull();

  // The reminder itself landed as a `user` event on one of A's runs.
  const stepRuns = runs.listForTask(stepA.id);
  const reminderEvents = stepRuns
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents.length).toBe(1);

  await waitUntilIdle(parentId);
});

test("continue-then-done: the continuation's handoff advances the step and no reminder is sent", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("cont-done");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:continue-then-done`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("cont-done-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "continue-then-done run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  expect(done.column).toBe("review");
  const record = done.pipelineRun!.history.find((h) => h.stepId === A.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder ?? null).toBeNull();

  const stepRuns = runs.listForTask(stepA.id);
  const reminderEvents = stepRuns
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents.length).toBe(0);
  const continued = stepRuns
    .flatMap((r) => runs.events(r.id))
    .some((e) => e.stream === "status" && e.data.includes("auto-continued after background task"));
  expect(continued).toBe(true);

  await waitUntilIdle(parentId);
});

test(":missing (never fixed) — exactly one reminder, then blocks with the after-one-reminder message; execution stays active", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("missing-never-fixed");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("missing-stuck-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "missing never fixed run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);

  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const run = blocked.pipelineRun!;
  expect(run.active.length).toBe(1);
  expect(run.active[0]!.taskId).toBe(stepA.id);

  const block = run.blocked.find((b) => b.taskId === stepA.id);
  expect(block?.kind).toBe("handoff-missing");
  expect(block?.message).toContain("still no valid handoff after one reminder");

  const record = run.history.find((h) => h.stepId === A.id);
  expect(record?.responseKind).toBe("handoff-missing");
  expect(record?.reminder).not.toBeNull();
  expect(record?.reminder?.reason).toBe("handoff-missing");

  // Exactly one reminder sent — never a second one on the block settle.
  const stepRuns = runs.listForTask(stepA.id);
  expect(stepRuns.length).toBe(2); // the original turn + the one reminder follow-up
  const reminderEvents = stepRuns
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents.length).toBe(1);

  await waitUntilIdle(parentId);
});

test("a reminder send that fails AFTER the send budget is not recorded as delivered — the step blocks with the real reason", async () => {
  // Regression for the bounded `sendInput`: the reminder used to await the
  // HTTP-only 1.5 s budget, so a send that was refused (or withheld — the
  // claude modal grace is the same 1.5 s) after it came back
  // `{ delivered: true, pending: true }` and was stamped as a sent reminder.
  // Here the refusal is made slow by holding the step's teardown FIFO past
  // the budget, then lands on the step-worktree guard.
  const { createTask, startTask, __enqueueTeardownForTest } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { SPAWN_RESPONSE_BUDGET_MS } = await import("../shared/types.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("reminder-slow-refusal");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("reminder-slow-refusal-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "reminder slow refusal run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let sendHookAt = 0;
  __forTest.setBeforeReminderSend(async () => {
    sendHookAt = Date.now();
    const step = tasks.stepsForParent(parentId)[0]!;
    void __enqueueTeardownForTest(
      step.id,
      `hold-${step.id}`,
      () => new Promise<void>((r) => setTimeout(r, SPAWN_RESPONSE_BUDGET_MS + 500)),
    );
    tasks.update(step.id, { isolation: "worktree", worktreePath: path.join(DATA_DIR, "no-such-step-worktree") });
  });
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);

    const blocked = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "blocked" ? t : undefined;
    }, 8000);
    expect(sendHookAt).toBeGreaterThan(0);
    expect(Date.now() - sendHookAt).toBeGreaterThanOrEqual(SPAWN_RESPONSE_BUDGET_MS);

    const run = blocked.pipelineRun!;
    const block = run.blocked.find((b) => b.taskId === stepA.id);
    expect(block?.kind).toBe("handoff-missing");
    expect(block?.message).toContain("automatic reminder could not be sent");
    expect(block?.message).toContain("worktree is missing");

    const record = run.history.find((h) => h.stepId === A.id);
    expect(record?.reminder ?? null).toBeNull();
    const reminderEvents = runs.listForTask(stepA.id)
      .flatMap((r) => runs.events(r.id))
      .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
    expect(reminderEvents).toEqual([]);
  } finally {
    __forTest.setBeforeReminderSend(null);
  }
  await waitUntilIdle(parentId);
});

test(":invalid-then-done — one automatic reminder, then advances to done", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("invalid-then-done");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:invalid-then-done`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("invalid-then-done-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "invalid-then-done run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  expect(done.column).toBe("review");
  const run = done.pipelineRun!;
  expect(run.blocked.length).toBe(0);

  const record = run.history.find((h) => h.stepId === A.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder).not.toBeNull();
  expect(record?.reminder?.reason).toBe("handoff-invalid");

  const stepRuns = runs.listForTask(stepA.id);
  const reminderEvents = stepRuns
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents.length).toBe(1);

  await waitUntilIdle(parentId);
});

test(":missing-then-B — after the reminder, the step picks B by name; C is never started", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("missing-then-B");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    transition: "choose",
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing-then-B`,
  });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C],
    edges: [
      { id: "eb", from: A.id, to: B.id, label: "" },
      { id: "ec", from: A.id, to: C.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("missing-then-B-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "missing-then-B run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  expect(done.column).toBe("review");
  const run = done.pipelineRun!;
  expect(run.blocked.length).toBe(0);

  const recordA = run.history.find((h) => h.stepId === A.id);
  expect(recordA?.reminder).not.toBeNull();
  expect(recordA?.nextStepIds).toEqual([B.id]);
  expect(run.history.some((h) => h.stepId === B.id)).toBe(true);
  expect(run.history.some((h) => h.stepId === C.id)).toBe(false);
  expect(tasks.stepsForParent(parentId).some((s) => s.pipelineStepId === C.id)).toBe(false);

  await waitUntilIdle(parentId);
});

test("M1 + reminder: handoff.status:\"blocked\" on the first reply records step-blocked without ever sending a reminder", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("blocked-status-no-reminder");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("blocked-no-remind-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "blocked-status no reminder run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    const blockedHandoff = {
      schemaVersion: 1,
      purpose: "p",
      summary: "s",
      reason: "waiting on a decision",
      next: null,
      artifacts: [] as string[],
      openQuestions: ["which approach?"],
      status: "blocked" as const,
    };
    runs.appendEvent(runRow.id, "assistant", `Done.\n<${HANDOFF_TAG}>\n${JSON.stringify(blockedHandoff)}\n</${HANDOFF_TAG}>`);
    await __forTest.handleRunStatus(stepA.id, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const afterBlock = tasks.get(parentId)!;
  const run = afterBlock.pipelineRun!;
  const block = run.blocked.find((b) => b.taskId === stepA!.id);
  expect(block?.kind).toBe("step-blocked");
  const record = run.history.find((h) => h.taskId === stepA!.id);
  expect(record?.responseKind).toBe("handoff-blocked");
  expect(record?.reminder ?? null).toBeNull();

  await waitUntilIdle(parentId);
});

test("a running successor suppresses the handoff reminder; its own handoff advances the step", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("cont-skip");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("continuation-suppress-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "continuation suppresses reminder",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const settled = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // The background-task continuation is already the step's current run
    // and still writing when the previous run (no `<handoff>`) settles. It
    // is a REAL live run (an `active` handle), since the runner waits on
    // what the orchestrator reports live, not on a bare `running` row.
    const continuation = await openLiveRun(stepA.id, null, "notification");
    const continuationId = continuation.runId;

    await __forTest.handleRunStatus(stepA.id, settled.id, "succeeded");

    const afterDefer = tasks.get(parentId)!;
    const deferred = afterDefer.pipelineRun!;
    expect(deferred.status).not.toBe("done");
    expect(deferred.blocked.filter((b) => b.taskId === stepA!.id)).toEqual([]);
    expect(deferred.active.some((a) => a.taskId === stepA!.id)).toBe(true);
    const deferredRecord = deferred.history.find((h) => h.taskId === stepA!.id);
    expect(deferredRecord?.reminder ?? null).toBeNull();
    expect(deferredRecord?.responseKind ?? null).toBeNull();
    const reminderEvents = runs.listForTask(stepA.id)
      .flatMap((r) => runs.events(r.id))
      .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
    expect(reminderEvents).toEqual([]);

    const doneHandoff = {
      schemaVersion: 1,
      purpose: "p",
      summary: "s",
      reason: "finished on the continuation",
      next: null,
      artifacts: [] as string[],
      openQuestions: [] as string[],
      status: "done" as const,
    };
    continuation.say(`Skill scan.\n<${HANDOFF_TAG}>\n${JSON.stringify(doneHandoff)}\n</${HANDOFF_TAG}>`);
    await continuation.finish();
    await __forTest.handleRunStatus(stepA.id, continuationId, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const after = tasks.get(parentId)!;
  expect(after.pipelineRun?.status).toBe("done");
  expect(after.column).toBe("review");
  const record = after.pipelineRun!.history.find((h) => h.taskId === stepA!.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder ?? null).toBeNull();
  expect(record?.handoff?.next ?? null).toBeNull();

  await waitUntilIdle(parentId);
});

test("a finished successor does not suppress the handoff reminder", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("succ-done");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("finished-successor-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "finished successor still reminds",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const settled = await waitFor(() => {
      const r = runs.listForTask(stepA.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Already terminal — its own settle owns the outcome, so a missing
    // handoff on the run that just settled still gets the one reminder.
    const successorId = randomUUID();
    runs.insert({
      ...settled,
      id: successorId,
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      origin: "continuation",
    });
    tasks.update(stepA.id, { runId: successorId });

    // The settled run's own event already fired while the listener was
    // off. Turn it back on before the reminder send so the reminder
    // turn's settle is observed and the run can leave `running`.
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(stepA.id, settled.id, "succeeded");

    const reminderEvents = await waitFor(() => {
      const found = runs.listForTask(stepA.id)
        .flatMap((r) => runs.events(r.id))
        .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
      return found.length > 0 ? found : undefined;
    }, 8000);
    expect(reminderEvents.length).toBeGreaterThan(0);
  } finally {
    __forTest.setListenerEnabled(true);
  }

  await waitUntilIdle(parentId);
});

test("a finished successor that already has a handoff is classified instead of reminded", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("term-handoff");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("term-handoff-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "terminal successor with handoff",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const settled = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Already terminal, and it carries the handoff. Queuing a reminder off
    // the previous run must re-classify this run instead of pasting.
    const successorId = randomUUID();
    runs.insert({
      ...settled,
      id: successorId,
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      exitCode: 0,
      origin: "continuation",
    });
    const doneHandoff = {
      schemaVersion: 1,
      purpose: "p",
      summary: "s",
      reason: "finished on the continuation",
      next: null,
      artifacts: [] as string[],
      openQuestions: [] as string[],
      status: "done" as const,
    };
    runs.appendEvent(
      successorId,
      "assistant",
      `Skill scan.\n<${HANDOFF_TAG}>\n${JSON.stringify(doneHandoff)}\n</${HANDOFF_TAG}>`,
    );
    tasks.update(stepA.id, { runId: successorId });

    await __forTest.handleRunStatus(stepA.id, settled.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const after = tasks.get(parentId)!;
  expect(after.pipelineRun?.status).toBe("done");
  expect(after.column).toBe("review");
  const record = after.pipelineRun!.history.find((h) => h.taskId === stepA!.id);
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder ?? null).toBeNull();
  const reminderEvents = runs.listForTask(stepA!.id)
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents).toEqual([]);

  await waitUntilIdle(parentId);
});

test("a successor settle is classified while the handoff reminder is still queued", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("flag-handoff");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("flag-handoff-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "in-flight successor settle",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const settled = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    const successorId = randomUUID();
    __forTest.setBeforeReminderSend(async () => {
      // The reminder is queued (`remindersInFlight` set) and has not been
      // sent. Settling the continuation here used to return without
      // classifying, and the send then pasted the reminder anyway.
      runs.insert({
        ...settled,
        id: successorId,
        status: "succeeded",
        startedAt: Date.now(),
        endedAt: Date.now(),
        exitCode: 0,
        origin: "continuation",
      });
      const doneHandoff = {
        schemaVersion: 1,
        purpose: "p",
        summary: "s",
        reason: "finished while the reminder was queued",
        next: null,
        artifacts: [] as string[],
        openQuestions: [] as string[],
        status: "done" as const,
      };
      runs.appendEvent(
        successorId,
        "assistant",
        `Skill scan.\n<${HANDOFF_TAG}>\n${JSON.stringify(doneHandoff)}\n</${HANDOFF_TAG}>`,
      );
      tasks.update(stepA!.id, { runId: successorId });
      await __forTest.handleRunStatus(stepA!.id, successorId, "succeeded");
    });

    await __forTest.handleRunStatus(stepA.id, settled.id, "succeeded");
  } finally {
    __forTest.setBeforeReminderSend(null);
    __forTest.setListenerEnabled(true);
  }

  const after = tasks.get(parentId)!;
  expect(after.pipelineRun?.status).toBe("done");
  expect(after.column).toBe("review");
  const record = after.pipelineRun!.history.find((h) => h.taskId === stepA!.id);
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder ?? null).toBeNull();
  const reminderEvents = runs.listForTask(stepA!.id)
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents).toEqual([]);

  await waitUntilIdle(parentId);
});

test("a running successor that appears before the reminder is stamped is not recorded", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_TAG } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("pre-stamp");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("pre-stamp-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "stamp-window successor",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  const continuationId = randomUUID();
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const settled = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    __forTest.setBeforeReminderStamp(() => {
      // After `sendInput` returns and before the stamp lock records the
      // reminder. The post-send defer already ran and saw no successor.
      runs.insert({
        ...settled,
        id: continuationId,
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        origin: "continuation",
      });
      tasks.update(stepA!.id, { runId: continuationId });
    });

    await __forTest.handleRunStatus(stepA.id, settled.id, "succeeded");

    const deferred = tasks.get(parentId)!.pipelineRun!;
    expect(deferred.status).not.toBe("done");
    expect(deferred.blocked.filter((b) => b.taskId === stepA!.id)).toEqual([]);
    expect(deferred.active.some((a) => a.taskId === stepA!.id)).toBe(true);
    const deferredRecord = deferred.history.find((h) => h.taskId === stepA!.id);
    expect(deferredRecord?.reminder ?? null).toBeNull();
    expect(deferredRecord?.responseKind ?? null).toBeNull();

    const doneHandoff = {
      schemaVersion: 1,
      purpose: "p",
      summary: "s",
      reason: "finished after the stamp window",
      next: null,
      artifacts: [] as string[],
      openQuestions: [] as string[],
      status: "done" as const,
    };
    runs.appendEvent(
      continuationId,
      "assistant",
      `Skill scan.\n<${HANDOFF_TAG}>\n${JSON.stringify(doneHandoff)}\n</${HANDOFF_TAG}>`,
    );
    // `sendInput` returns before the fake driver's resolve timer writes its
    // chunks. Drain that reminder turn while the listener is still off and
    // the run row still exists, so the timer cannot append after
    // `deleteTask` — and because the step never advances while a run of it
    // is still live (D5), the continuation's settle has to come after it.
    await waitFor(() => {
      const pending = runs.listForTask(stepA!.id).some((r) => r.id !== continuationId && r.status === "running");
      return pending ? undefined : true;
    });
    await __forTest.handleRunStatus(stepA.id, continuationId, "succeeded");
  } finally {
    __forTest.setBeforeReminderStamp(null);
    __forTest.setListenerEnabled(true);
  }

  const after = tasks.get(parentId)!;
  expect(after.pipelineRun?.status).toBe("done");
  expect(after.column).toBe("review");
  const record = after.pipelineRun!.history.find((h) => h.taskId === stepA!.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder ?? null).toBeNull();

  await waitUntilIdle(parentId);
});

test("a failed run records step-failed with no reminder and responseKind \"error\"", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("failed-run-no-reminder");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("failed-no-remind-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "failed run no reminder",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepA: ReturnType<typeof tasks.get> = null;
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Simulate the run actually failing — e.g. an api-error/session-died
    // settle — regardless of the (irrelevant) assistant text the fake
    // driver already emitted for its `:done` handoff. The run row has to say
    // `failed` too: a SUCCEEDED run of the attempt holding a valid handoff
    // would otherwise be the look-back's supplier (see U7(10d)).
    runs.update(runRow.id, { status: "failed", exitCode: 1 });
    await __forTest.handleRunStatus(stepA.id, runRow.id, "failed");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const afterFail = tasks.get(parentId)!;
  const run = afterFail.pipelineRun!;
  const block = run.blocked.find((b) => b.taskId === stepA!.id);
  expect(block?.kind).toBe("step-failed");
  expect(run.active.length).toBe(1);
  expect(run.active[0]!.taskId).toBe(stepA!.id);

  const record = run.history.find((h) => h.taskId === stepA!.id);
  expect(record?.outcome).toBe("failed");
  expect(record?.responseKind).toBe("error");
  expect(record?.reminder ?? null).toBeNull();

  await waitUntilIdle(parentId);
});

test("Retry of a reminded execution that again omits the handoff blocks immediately — no second reminder", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("retry-still-missing");
  const A = newStep({
    name: "A",
    agentProfileId: profile.id,
    instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing`,
  });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("retry-still-miss-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "retry still missing run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);

  const blockedFirst = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const firstRecord = blockedFirst.pipelineRun!.history.find((h) => h.taskId === stepA.id);
  expect(firstRecord?.reminder).not.toBeNull();
  const runsBeforeRetry = runs.listForTask(stepA.id).length;
  expect(runsBeforeRetry).toBe(2); // original turn + the one reminder follow-up

  const retried = await retryPipelineStep(parentId, { taskId: stepA.id });
  if ("error" in retried) throw new Error(retried.error);
  // Blocked entries are cleared synchronously as part of the retry call —
  // the run reads `running` again immediately, before the retried turn
  // settles, which is what lets the next `waitFor` distinguish the OLD
  // block from a genuinely fresh one instead of racing a stale read.
  expect(retried.task.pipelineRun!.status).toBe("running");

  const blockedAgain = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const run = blockedAgain.pipelineRun!;
  expect(run.active.length).toBe(1);
  expect(run.active[0]!.taskId).toBe(stepA.id);

  const block = run.blocked.find((b) => b.taskId === stepA.id);
  expect(block?.kind).toBe("handoff-missing");
  expect(block?.message).toContain("still no valid handoff after one reminder");

  const record = run.history.find((h) => h.taskId === stepA.id);
  expect(record?.reminder).not.toBeNull();
  // Retry re-ran the SAME execution in place — never a duplicate task row.
  expect(tasks.stepsForParent(parentId).length).toBe(1);

  // The retried turn added exactly one more run row — no second reminder
  // turn was ever spawned.
  const stepRuns = runs.listForTask(stepA.id);
  expect(stepRuns.length).toBe(runsBeforeRetry + 1);
  const reminderEvents = stepRuns
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents.length).toBe(1);

  await waitUntilIdle(parentId);
});


test("a stale pending interaction registered under a DIFFERENT runId does not turn a valid handoff into user-ask", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { registerTmuxPrompt } = await import("./interactions.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("stale-interaction");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("stale-interaction-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "stale-interaction run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepA!.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Register a pending interaction against the SAME step task, but under
    // a runId that is NOT the run that just settled (e.g. a leftover from
    // an earlier run of this step, or — as in `pipelines-endpoint.test.ts`'s
    // aggregation test — a fixture registered under a synthetic runId and
    // never cleared). Scoped-by-run counting must ignore it entirely.
    registerTmuxPrompt({
      taskId: stepA!.id,
      runId: "stale-run-id-does-not-match",
      paneText: "pane",
      choices: [{ key: "1", label: "Yes" }],
      fingerprint: `fp-stale-${stepA!.id}`,
    });

    await __forTest.handleRunStatus(stepA!.id, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  expect(done.column).toBe("review");
  const run = done.pipelineRun!;
  expect(run.blocked.length).toBe(0);
  const record = run.history[0]!;
  expect(record.outcome).toBe("succeeded");
  // Proves the stale interaction was never counted — a genuine `user-ask`
  // classification would have left this execution `active`/unresolved
  // instead of reaching `succeeded` with a `"handoff"` responseKind.
  expect(record.responseKind).toBe("handoff");

  await waitUntilIdle(parentId);
});

// ---------------------------------------------------------------------------
// Round-4 review-fix regression coverage (handoff-reminder flow)
// ---------------------------------------------------------------------------

test("Major 1: a handoff-missing settle is blocked (never reminded) once the parent — and, via the archive cascade, the step task itself — is archived", async () => {
  const { createTask, startTask, archiveTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("archived-no-reminder");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("archived-no-remind-pipe"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "archived no reminder run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepAId = "";
  let stepARunId = "";
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    stepAId = stepA!.id;
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepAId)[0];
      return r && r.status !== "running" ? r : undefined;
    });
    stepARunId = runRow.id;

    // Archive the pipeline task WHILE the listener is disabled — the step's
    // own settle event (fired for real, but never delivered to this module)
    // is "queued" exactly like a genuine archive-races-a-settle scenario.
    // `cascadePipelineArchive` also archives every non-archived step task,
    // so this single archive covers BOTH halves of the Major 1 guard (an
    // archived parent, and an archived step task).
    const archived = await archiveTask(parentId, { force: true });
    if ("error" in archived) throw new Error(archived.error);
    expect(tasks.get(stepAId)?.archivedAt).not.toBeNull();

    await __forTest.handleRunStatus(stepAId, stepARunId, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const parent = tasks.get(parentId)!;
  const run = parent.pipelineRun!;
  expect(run.status).toBe("blocked");
  const block = run.blocked.find((b) => b.taskId === stepAId);
  expect(block?.kind).toBe("handoff-missing");
  expect(block?.message).toContain("automatic reminder skipped");

  const record = run.history.find((h) => h.stepId === A.id);
  expect(record?.reminder ?? null).toBeNull();

  // No reminder follow-up run was ever created — `sendInput` was never
  // called.
  const stepARuns = runs.listForTask(stepAId);
  expect(stepARuns.length).toBe(1);

  await waitUntilIdle(parentId);
});

test("Major 2: a step that finished with a bad handoff while the whole run is being deliberately stopped is blocked without ever sending a reminder", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "2000";
  try {
    const { createTask, startTask } = await import("./orchestrator.ts");
    const { tasks, pipelines, runs } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { cancelPipelineRun, __forTest } = await import("./pipeline-runner.ts");

    const profile = await makeProfile("stop-while-succeeding");
    const Root = newStep({ name: "Root", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
    const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = {
      steps: [Root, A, B],
      edges: [
        { id: "e1", from: Root.id, to: A.id, label: "" },
        { id: "e2", from: Root.id, to: B.id, label: "" },
      ],
      startStepId: Root.id,
    };
    const pipeline = pipelines.insert({ name: uniqueName("stop-while-live-pipe"), graph, maxSteps: 25 });

    const created = await createTask({
      title: "stop-while-succeeding run",
      prompt: "goal",
      workdir: freshWorkdir(),
      isolation: "none",
      pipelineId: pipeline.id,
    });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);

    let stepAId = "";
    __forTest.setListenerEnabled(false);
    try {
      const started = await startTask(parentId);
      if ("error" in started) throw new Error(started.error);

      const rootTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
      const rootRun = await waitFor(() => {
        const r = runs.listForTask(rootTask!.id)[0];
        return r && r.status !== "running" ? r : undefined;
      }, 8000);

      // Root's fan-out is normally driven by the listener — drive it
      // manually (listener disabled) so this test controls exactly when A
      // and B get launched, and when each of their own settles is
      // processed.
      await __forTest.handleRunStatus(rootTask!.id, rootRun.id, "succeeded");

      const stepA = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === A.id));
      stepAId = stepA!.id;
      const stepB = await waitFor(() => tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === B.id));

      // A's assistant text (no `<handoff>` tag) lands ~20ms into its turn
      // regardless of the 3s resolve delay above — wait for it so the
      // manual "succeeded" settle below has something real to classify.
      const aRunRow = await waitFor(() => {
        const r = runs.listForTask(stepAId)[0];
        if (!r) return undefined;
        return runs.events(r.id).some((e) => e.stream === "assistant") ? r : undefined;
      });
      await waitFor(() => runs.listForTask(stepB!.id)[0]);

      expect(tasks.get(stepAId)?.column).toBe("running");
      expect(tasks.get(stepB!.id)?.column).toBe("running");

      // Stop the WHOLE pipeline (not one step's own panel) while both A and
      // B are still genuinely live — `cancelPipelineRun` forces
      // `run.status = "cancelled"` synchronously, before either step's real
      // settle event has a chance to reach this module. Both A's and B's
      // real cancellation land (via `stopActiveHandle`) essentially
      // immediately, but with the listener disabled neither is EVER
      // re-delivered later just by re-enabling the listener — a dropped
      // event isn't queued for replay, it's simply gone (the same reason
      // `reconcilePipelineRuns` exists for a boot-time sweep). So this test
      // drives both settles manually, deterministically, instead of racing
      // real timing against the listener's on/off state.
      const cancelled = await cancelPipelineRun(parentId);
      if ("error" in cancelled) throw new Error(cancelled.error);
      expect(tasks.get(parentId)!.pipelineRun!.status).toBe("cancelled");

      const bRunRow = await waitFor(() => {
        const r = runs.listForTask(stepB!.id)[0];
        return r && r.status !== "running" ? r : undefined;
      });

      // A's own "succeeded" settle — it had already finished its turn with
      // a bad handoff (its assistant text was already persisted above) —
      // reaches this handler only now, AFTER the whole-run stop already
      // forced `status: "cancelled"`. It must not send the automatic
      // reminder and must not revive the run back into `running`.
      await __forTest.handleRunStatus(stepAId, aRunRow.id, "succeeded");
      // B's own real cancellation, fed through the same path a live
      // listener would have used.
      await __forTest.handleRunStatus(stepB!.id, bRunRow.id, "cancelled");
    } finally {
      __forTest.setListenerEnabled(true);
    }

    const parent = tasks.get(parentId)!;
    const run = parent.pipelineRun!;
    expect(run.status === "cancelled" || run.status === "blocked").toBe(true);
    expect(run.status).not.toBe("running");

    const record = run.history.find((h) => h.stepId === A.id);
    expect(record?.reminder ?? null).toBeNull();

    // No reminder follow-up run was ever created for A.
    const stepARuns = runs.listForTask(stepAId);
    expect(stepARuns.length).toBe(1);

    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
}, 15000);

test("Medium 3: a reminder that fails to deliver records nothing on `reminder` (so the next settle may try again) and folds the failure into the block message", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs, db } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("delivery-fails");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("delivery-fails-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "delivery fails run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepAId = "";
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    stepAId = stepA!.id;
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepAId)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // Force `sendInput`'s own reminder-delivery attempt to fail
    // deterministically: delete the run row it would target. The FK
    // cascade also wipes its `run_events` — harmless here, since the
    // classification above is already forced to "handoff-missing" by the
    // step's own `:missing` marker, and an empty `assistantTextForRun`
    // classifies exactly the same way.
    db.run("DELETE FROM runs WHERE id = ?", [runRow.id]);

    await __forTest.handleRunStatus(stepAId, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const parent = tasks.get(parentId)!;
  const run = parent.pipelineRun!;
  const block = run.blocked.find((b) => b.taskId === stepAId);
  expect(block?.kind).toBe("handoff-missing");
  expect(block?.message).toContain("automatic reminder could not be sent");
  expect(block?.message).toContain("run not found");

  const record = run.history.find((h) => h.stepId === A.id);
  // Medium 3: nothing recorded on `reminder` when delivery fails — the NEXT
  // settle for this execution may still try once.
  expect(record?.reminder ?? null).toBeNull();

  await waitUntilIdle(parentId);
});

test("Medium 4: a response with no valid handoff but a pending interaction blocks the run as step-blocked (not silently active), and the block clears once the step genuinely runs again", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { registerTmuxPrompt } = await import("./interactions.ts");
  const { __forTest, retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("user-ask-block");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("user-ask-block-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "user-ask-block run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  let stepAId = "";
  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    stepAId = stepA!.id;
    const runRow = await waitFor(() => {
      const r = runs.listForTask(stepAId)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    registerTmuxPrompt({
      taskId: stepAId,
      runId: runRow.id,
      paneText: "pane",
      choices: [{ key: "1", label: "Yes" }],
      fingerprint: `fp-user-ask-${stepAId}`,
    });

    await __forTest.handleRunStatus(stepAId, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const blocked = tasks.get(parentId)!;
  const run = blocked.pipelineRun!;
  expect(run.status).toBe("blocked");
  const block = run.blocked.find((b) => b.taskId === stepAId);
  expect(block?.kind).toBe("step-blocked");
  expect(block?.message).toContain("is waiting for you");

  const record = run.history.find((h) => h.stepId === A.id);
  expect(record?.responseKind).toBe("user-ask");
  expect(record?.reminder ?? null).toBeNull(); // no automatic reminder for a pending card

  // Once the step task genuinely runs again, the "running"-column handler
  // (m11) clears ANY block naming it — including this one — and resets the
  // stale history outcome/endedAt/responseKind. `retryPipelineStep`'s own
  // in-memory `run.blocked` filter (for a single targeted taskId) is never
  // itself persisted, so this is a real exercise of that handler, not of
  // retry's own bookkeeping.
  const retried = await retryPipelineStep(parentId, { taskId: stepAId });
  if ("error" in retried) throw new Error(retried.error);

  await waitFor(() => {
    const t = tasks.get(parentId);
    const stillBlocked = t?.pipelineRun?.blocked.some((b) => b.taskId === stepAId);
    return stillBlocked === false ? t : undefined;
  });
  const afterRunning = tasks.get(parentId)!.pipelineRun!;
  const recordAfterRunning = afterRunning.history.find((h) => h.stepId === A.id);
  expect(recordAfterRunning?.responseKind ?? null).toBeNull();
  expect(recordAfterRunning?.outcome ?? null).toBeNull();
  expect(recordAfterRunning?.endedAt ?? null).toBeNull();

  await waitUntilIdle(parentId);
});

test("Low: a handoff whose `next` doesn't resolve to a real step gets the one reminder (reason handoff-next-unknown), then blocks with responseKind overridden to \"handoff-invalid\"", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep, HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("next-unknown");
  const A = newStep({ name: "A", agentProfileId: profile.id, transition: "choose", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:nope` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = {
    steps: [A, B, C],
    edges: [
      { id: "e1", from: A.id, to: B.id, label: "" },
      { id: "e2", from: A.id, to: C.id, label: "" },
    ],
    startStepId: A.id,
  };
  const pipeline = pipelines.insert({ name: uniqueName("next-unknown-pipeline"), graph, maxSteps: 25 });

  const created = await createTask({
    title: "next-unknown run",
    prompt: "goal",
    workdir: freshWorkdir(),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  const stepA = await waitFor(() => tasks.stepsForParent(parentId)[0]);

  const blockedTask = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const run = blockedTask.pipelineRun!;
  expect(run.active.length).toBe(1);
  expect(run.active[0]!.taskId).toBe(stepA.id);
  // B and C were never launched — the graph never resolved to either.
  expect(tasks.stepsForParent(parentId).length).toBe(1);

  const block = run.blocked.find((b) => b.taskId === stepA.id);
  expect(block?.kind).toBe("handoff-invalid");
  expect(block?.message).toContain("still no valid handoff after one reminder");
  expect(block?.message).toContain('asked for step "nope"');

  const record = run.history.find((h) => h.stepId === A.id);
  // Overridden from `classifyStepResponse`'s own "handoff" stamp — an
  // unresolved `next` is a malformed handoff, not a valid one.
  expect(record?.responseKind).toBe("handoff-invalid");
  expect(record?.reminder).not.toBeNull();
  expect(record?.reminder?.reason).toBe("handoff-next-unknown");
  expect(record?.reminder?.delivered).toBe(true);
  expect(record?.reminder?.runId).not.toBeNull();

  const stepRuns = runs.listForTask(stepA.id);
  expect(stepRuns.length).toBe(2); // the original turn + the one reminder follow-up
  const reminderEvents = stepRuns
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
  expect(reminderEvents.length).toBe(1);

  await waitUntilIdle(parentId);
});

// ---------------------------------------------------------------------------
// Review round 5 fixes (H1, M-R2..M-R8, L-R9)
// ---------------------------------------------------------------------------

test("H1: a step stopped during the bounded-spawn pending window settles the pipeline cancelled — never stranded running", async () => {
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "2200";
  try {
    const { createTask, startTask, cancelRun, isTaskRunLive } = await import("./orchestrator.ts");
    const { tasks, runs, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

    const profile = await makeProfile("pending-cancel");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = { steps: [A], edges: [], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("pending-cancel-pipeline"), graph, maxSteps: 25 });
    const created = await createTask({ title: "pending-cancel run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);

    // The step's own `startTask` answers within the 1.5s budget with
    // `pending: true` — the fake spawn is still ~700ms away.
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    expect(started.pending).toBe(true);
    const step = tasks.stepsForParent(parentId)[0]!;
    expect(step.runId).toBe(started.runId);
    expect(isTaskRunLive(step.id)).toBe(true);
    expect(tasks.get(parentId)!.pipelineRun!.status).toBe("running");

    // Stop mid-window: there's no `active` handle yet — `cancelRun` records
    // the intent and the continuation honors it on settle. Before H1 that
    // settle emitted no `run-status`, so the pipeline sat `running` forever.
    expect(await cancelRun(step.runId!)).toBe(true);

    const settled = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "cancelled" ? t : undefined;
    }, 6000);
    expect(settled.column).toBe("ready");
    expect(runs.get(step.runId!)?.status).toBe("cancelled");
    expect(tasks.get(step.id)?.column).toBe("ready");
    const record = settled.pipelineRun!.history.find((h) => h.taskId === step.id);
    expect(record?.outcome).toBe("cancelled");
    // Kept `active` so Retry can re-attempt it, exactly like a live Stop.
    expect(settled.pipelineRun!.active.length).toBe(1);
    expect(settled.pipelineRun!.blocked.length).toBe(0);
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  }
});

test("M-R2: a step that succeeds after the whole run was stopped records its outcome and HOLDS its successors instead of launching them; Retry continues", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest, retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("stop-then-succeed");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("stop-then-succeed-pipeline"), graph, maxSteps: 25 });
  const created = await createTask({ title: "stop-then-succeed run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  // Let A's turn settle with nobody listening, then simulate the whole-run
  // Stop having landed FIRST (`cancelPipelineRun` records `stopRequestedAt`
  // and forces `status: "cancelled"` before any sibling's own settle
  // reaches the runner) and deliver A's succeeded settle on top of it.
  __forTest.setListenerEnabled(false);
  let stepAId: string;
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    stepAId = tasks.stepsForParent(parentId)[0]!.id;
    const runRow = await waitFor(() => {
      const r = runs.get(started.runId);
      return r?.status === "succeeded" ? r : undefined;
    });
    const before = tasks.get(parentId)!.pipelineRun!;
    tasks.setPipelineRun(parentId, { ...before, status: "cancelled", stopRequestedAt: Date.now() });

    await __forTest.handleRunStatus(stepAId, runRow.id, "succeeded");
  } finally {
    __forTest.setListenerEnabled(true);
  }

  const after = tasks.get(parentId)!;
  const run = after.pipelineRun!;
  const aRecord = run.history.find((h) => h.taskId === stepAId);
  expect(aRecord?.outcome).toBe("succeeded");
  expect(aRecord?.nextStepIds).toEqual([B.id]);
  expect(tasks.get(stepAId)?.column).toBe("done");
  // B was never launched — it's a run-level pending hold naming it, so the
  // run never silently revived to `running`.
  expect(tasks.stepsForParent(parentId).length).toBe(1);
  expect(run.active.length).toBe(0);
  const hold = run.blocked.find((b) => b.taskId === null && b.stepId === B.id);
  expect(hold?.kind).toBe("step-failed");
  expect(hold?.pending?.stepId).toBe(B.id);
  expect(hold?.pending?.arrivals[0]?.fromStepId).toBe(A.id);
  expect(hold?.message).toContain("stopped");
  expect(run.status).not.toBe("running");
  expect(after.column).not.toBe("running");

  // Retry picks the hold back up (`retryPendingBlocks`) and finishes.
  const retried = await retryPipelineStep(parentId);
  if ("error" in retried) throw new Error(retried.error);
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
  expect(done.pipelineRun!.history.length).toBe(2);
  expect(done.pipelineRun!.blocked.length).toBe(0);
  expect(tasks.stepsForParent(parentId).length).toBe(2);
  await waitUntilIdle(parentId);
});

test("M-R3: a step held by background subagents stays active (not advanced) until the last helper settles; Stop/Advance stay honest meanwhile", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask, isTaskRunLive } = await import("./orchestrator.ts");
    const { tasks, runs, pipelines, subagents } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { advancePipeline } = await import("./pipeline-runner.ts");
    const { settleSubagentById } = await import("./claude-subagents.ts");

    const profile = await makeProfile("held");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("held-pipeline"), graph, maxSteps: 25 });
    const created = await createTask({ title: "held run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const step = await waitFor(() => {
      const s = tasks.stepsForParent(parentId)[0];
      return s?.column === "running" && s.runId ? s : undefined;
    });
    // A background helper the step "spawned" — inserted directly like the
    // Monitor tests do; `subagents.hasRunning` is what the done handler's
    // hold and `isTaskRunLive` both key on.
    const helperId = `agent-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: helperId,
      taskId: step.id,
      runId: step.runId,
      parentKind: "subagent",
      agentType: "Explore",
      description: "helper",
      spawnDepth: 1,
      sourcePath: `/tmp/${helperId}.jsonl`,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    });

    // The turn itself succeeds…
    await waitFor(() => (runs.get(step.runId!)?.status === "succeeded" ? true : undefined), 6000);
    // …but the step is HELD: the card stays parked in `running`, and the
    // runner saw the `run-status` event, stamped the classification, and
    // deliberately left the execution active — B is NOT launched.
    const held = await waitFor(() => {
      const t = tasks.get(parentId);
      const h = t?.pipelineRun?.history.find((x) => x.taskId === step.id);
      return h?.responseKind === "handoff" ? t : undefined;
    }, 6000);
    expect(tasks.get(step.id)?.column).toBe("running");
    expect(held.pipelineRun!.status).toBe("running");
    expect(held.pipelineRun!.active.some((a) => a.taskId === step.id)).toBe(true);
    expect(held.pipelineRun!.history.find((x) => x.taskId === step.id)?.outcome).toBeNull();
    expect(tasks.stepsForParent(parentId).length).toBe(1);
    // Honest liveness: Retry/Advance/Stop all read the held step as busy.
    expect(isTaskRunLive(step.id)).toBe(true);
    const refused = await advancePipeline(parentId, { fromTaskId: step.id, nextStepIds: null });
    expect("error" in refused ? refused.status : null).toBe(409);

    // The last helper settles → `maybeReleaseHeldTask` releases the card
    // to `review` → the runner's `review` column branch performs the real
    // advance off the (already succeeded) run row.
    expect(settleSubagentById(helperId, "completed", "receipt")).toBe(true);
    const done = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "done" ? t : undefined;
    }, 8000);
    expect(done.pipelineRun!.history.length).toBe(2);
    expect(done.pipelineRun!.history.find((x) => x.taskId === step.id)?.outcome).toBe("succeeded");
    expect(tasks.stepsForParent(parentId).length).toBe(2);
    expect(tasks.get(step.id)?.column).toBe("done");
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M-R4 / L-R9: a start-step launch that throws BEFORE the insert records a retryable pending block with stepCount rolled back and a consistent column; Retry then starts it", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { pipelineRunsDir, retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("launch-throw-pre");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("launch-throw-pre-pipeline"), graph, maxSteps: 25 });
  const created = await createTask({ title: "launch-throw-pre run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  // A regular FILE where the run dir must go: `mkdirSync(runDir,
  // {recursive: true})` throws EEXIST inside `launchStep` before any step
  // row is inserted — the pre-insert throw `launchTarget` distinguishes.
  mkdirSync(path.dirname(pipelineRunsDir(parentId)), { recursive: true });
  writeFileSync(pipelineRunsDir(parentId), "not a directory");

  const started = await startTask(parentId);
  expect("error" in started).toBe(true);
  const t = tasks.get(parentId)!;
  const run = t.pipelineRun!;
  expect(run.status).toBe("blocked");
  expect(t.column).toBe("blocked");
  expect(run.stepCount).toBe(0);
  expect(run.active.length).toBe(0);
  expect(run.history.length).toBe(0);
  expect(tasks.stepsForParent(parentId).length).toBe(0);
  const block = run.blocked.find((b) => b.taskId === null && b.stepId === A.id);
  expect(block?.kind).toBe("step-failed");
  expect(block?.pending?.stepId).toBe(A.id);
  expect(block?.message).toContain("failed to launch");
  expect(run.blocked.length).toBe(1);

  rmSync(pipelineRunsDir(parentId), { force: true });
  const retried = await retryPipelineStep(parentId);
  if ("error" in retried) throw new Error(retried.error);
  const done = await waitFor(() => {
    const t2 = tasks.get(parentId);
    return t2?.pipelineRun?.status === "done" ? t2 : undefined;
  }, 8000);
  expect(done.pipelineRun!.stepCount).toBe(1);
  expect(done.pipelineRun!.blocked.length).toBe(0);
  expect(tasks.stepsForParent(parentId).length).toBe(1);
  await waitUntilIdle(parentId);
});

test("L-R9: a launch that throws AFTER the step insert records the block against the inserted task (no pending, stepCount kept); Retry re-runs it in place", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("launch-throw-post");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("launch-throw-post-pipeline"), graph, maxSteps: 25 });
  const created = await createTask({ title: "launch-throw-post run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  // `startPipelineRun` persists the fresh run once (call 1) BEFORE
  // launching; `launchStep` persists again right after `tasks.insert`
  // (call 2) — make THAT one throw, so the step row exists when the throw
  // reaches `launchTarget`.
  const original = tasks.setPipelineRun;
  let calls = 0;
  const patched: typeof tasks.setPipelineRun = (taskId, run) => {
    calls++;
    if (calls === 2) throw new Error("simulated persist failure");
    return original.call(tasks, taskId, run);
  };
  tasks.setPipelineRun = patched;
  let started: Awaited<ReturnType<typeof startTask>>;
  try {
    started = await startTask(parentId);
  } finally {
    tasks.setPipelineRun = original;
  }
  expect("error" in started).toBe(true);

  const t = tasks.get(parentId)!;
  const run = t.pipelineRun!;
  const step = tasks.stepsForParent(parentId)[0];
  expect(step).toBeTruthy();
  expect(run.stepCount).toBe(1);
  expect(run.active.some((a) => a.taskId === step!.id)).toBe(true);
  const block = run.blocked.find((b) => b.taskId === step!.id);
  expect(block?.kind).toBe("step-failed");
  expect(block?.pending).toBeUndefined();
  expect(block?.message).toContain("failed to launch");
  expect(run.status).toBe("blocked");
  expect(t.column).toBe("blocked");

  // Retry re-runs the SAME inserted step task — no duplicate row.
  const retried = await retryPipelineStep(parentId);
  if ("error" in retried) throw new Error(retried.error);
  const done = await waitFor(() => {
    const t2 = tasks.get(parentId);
    return t2?.pipelineRun?.status === "done" ? t2 : undefined;
  }, 8000);
  expect(done.pipelineRun!.history.length).toBe(1);
  expect(done.pipelineRun!.stepCount).toBe(1);
  expect(tasks.stepsForParent(parentId).length).toBe(1);
  await waitUntilIdle(parentId);
});

test("M-R6 / M-R5: worktree-isolated pipeline — the shared worktree is only VERIFIED under a live step, re-materialized and propagated onto active steps on Retry, and a step row refuses start/send while it's missing", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "700";
  try {
    const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
    const { tasks, pipelines } = await import("./db.ts");
    const { newStep } = await import("../shared/pipeline.ts");
    const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
    const { advancePipeline, retryPipelineStep } = await import("./pipeline-runner.ts");

    const repo = await makeRepo();
    const profile = await makeProfile("worktree");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
    // B never emits a handoff → one reminder, then a block with B still active.
    const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
    const graph = { steps: [A, B], edges: [{ id: "e1", from: A.id, to: B.id, label: "" }], startStepId: A.id };
    const pipeline = pipelines.insert({ name: uniqueName("worktree-pipeline"), graph, maxSteps: 25 });
    // `isolation` defaults to "worktree"; `workdir` is a real (temp) git repo.
    const created = await createTask({ title: "worktree run", prompt: "goal", workdir: repo, pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);

    const stepA = await waitFor(() => {
      const s = tasks.stepsForParent(parentId).find((x) => x.pipelineStepId === A.id);
      return s?.column === "running" ? s : undefined;
    }, 10000);
    const parentLive = tasks.get(parentId)!;
    expect(parentLive.isolation).toBe("worktree");
    expect(parentLive.worktreePath).toBeTruthy();
    expect(existsSync(parentLive.worktreePath!)).toBe(true);
    expect(stepA.worktreePath).toBe(parentLive.worktreePath);
    expect(stepA.branch).toBe(parentLive.branch);

    // M-R6: with A genuinely live, a manual route only VERIFIES the shared
    // worktree — a missing one is refused outright rather than
    // `prepareWorkdir`-ed underneath the running agent.
    rmSync(parentLive.worktreePath!, { recursive: true, force: true });
    const refused = await advancePipeline(parentId, { nextStepIds: null });
    expect("error" in refused ? refused.error : "").toContain("still running");
    // (A's own settle re-materializes it — nothing live any more — before
    // launching B; no manual restore needed.)

    // B blocks on its handoff (after one automatic reminder) with B active.
    const blocked = await waitFor(() => {
      const t = tasks.get(parentId);
      return t?.pipelineRun?.status === "blocked" ? t : undefined;
    }, 20000);
    const stepB = tasks.stepsForParent(parentId).find((x) => x.pipelineStepId === B.id)!;
    expect(blocked.pipelineRun!.active.some((a) => a.taskId === stepB.id)).toBe(true);
    expect(existsSync(tasks.get(parentId)!.worktreePath!)).toBe(true);
    expect(stepB.worktreePath).toBe(tasks.get(parentId)!.worktreePath);

    // M6 (`startTaskInner`) + M-R5 (`sendInput`): a step row whose worktree
    // is gone is refused on both paths — only the pipeline task
    // re-materializes the shared checkout.
    rmSync(tasks.get(parentId)!.worktreePath!, { recursive: true, force: true });
    const startRefused = await startTask(stepB.id);
    expect("error" in startRefused ? startRefused.error : "").toBe("step task's worktree is missing — run the pipeline task instead");
    const sendRefused = await sendInput(stepB.runId!, "hello");
    expect(sendRefused.delivered).toBe(false);
    expect(!sendRefused.delivered ? sendRefused.reason : "").toBe("step task's worktree is missing — run the pipeline task instead");
    expect(existsSync(tasks.get(parentId)!.worktreePath!)).toBe(false);

    // Retry on the PARENT re-materializes the shared worktree (nothing live
    // → full `prepareWorkdir`, re-attaching the existing branch) and
    // propagates it onto the still-active step row — skewed first, so the
    // propagation is observable.
    tasks.update(stepB.id, { worktreePath: "/nonexistent/agetor-step-wt", branch: "bogus-branch" });
    const retried = await retryPipelineStep(parentId);
    if ("error" in retried) throw new Error(retried.error);
    const parentAfter = tasks.get(parentId)!;
    expect(existsSync(parentAfter.worktreePath!)).toBe(true);
    expect(parentAfter.worktreePath).toBe(parentLive.worktreePath);
    expect(parentAfter.branch).toBe(parentLive.branch);
    const stepBAfter = tasks.get(stepB.id)!;
    expect(stepBAfter.worktreePath).toBe(parentAfter.worktreePath);
    expect(stepBAfter.branch).toBe(parentAfter.branch);

    // The retried B still never emits a handoff and was already reminded
    // once → blocks again immediately; let it settle before returning.
    await waitFor(() => {
      const t = tasks.get(parentId);
      const h = t?.pipelineRun?.history.find((x) => x.taskId === stepB.id);
      return t?.pipelineRun?.status === "blocked" && h?.responseKind === "handoff-missing" && h.endedAt === null ? t : undefined;
    }, 15000);
    await waitUntilIdle(parentId);
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("M-R7: a delete cascade that throws un-tombstones the parent, which stays runnable; a later delete succeeds", async () => {
  const { createTask, startTask, deleteTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { tombstonedPipelineParents, startPipelineRun } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("tombstone");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const graph = { steps: [A], edges: [], startStepId: A.id };
  const pipeline = pipelines.insert({ name: uniqueName("tombstone-pipeline"), graph, maxSteps: 25 });
  const created = await createTask({ title: "tombstone run", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => (tasks.get(parentId)?.pipelineRun?.status === "done" ? true : undefined));

  // Make the cascade's own step enumeration throw exactly once.
  const originalList = tasks.list;
  let armed = true;
  const patched: typeof tasks.list = function (this: typeof tasks, ...args: Parameters<typeof tasks.list>) {
    if (armed) {
      armed = false;
      throw new Error("simulated cascade failure");
    }
    return originalList.apply(this, args);
  };
  tasks.list = patched;
  let threw = false;
  try {
    await deleteTask(parentId);
  } catch {
    threw = true;
  } finally {
    tasks.list = originalList;
  }
  expect(threw).toBe(true);
  expect(tombstonedPipelineParents.has(parentId)).toBe(false);
  expect(tasks.get(parentId)).not.toBeNull();

  // Still runnable — with a stale tombstone this would be refused with
  // "pipeline task no longer exists".
  const restarted = await startPipelineRun(tasks.get(parentId)!, { restart: true });
  if ("error" in restarted) throw new Error(restarted.error);
  await waitFor(() => (tasks.get(parentId)?.pipelineRun?.status === "done" ? true : undefined), 8000);

  await deleteTask(parentId);
  expect(tasks.get(parentId)).toBeNull();
  expect(tombstonedPipelineParents.has(parentId)).toBe(true);
  expect(tasks.list().some((t) => t.pipelineParentId === parentId)).toBe(false);
});

// ---------------------------------------------------------------------------
// Handoff look-back across overlapping runs of one step task
// (docs/plans/handoff-identification-fix.md, U7)
// ---------------------------------------------------------------------------

/** A short pause so consecutive runs get distinct `startedAt`/`endedAt`
 *  milliseconds — the look-back orders by them. */
function tick(ms = 6): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An assistant reply ending in a valid `<handoff>` block. */
async function handoffReply(reason: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { HANDOFF_TAG } = await import("../shared/pipeline.ts");
  const body = {
    schemaVersion: 1,
    purpose: "p",
    summary: "s",
    reason,
    next: null,
    artifacts: [] as string[],
    openQuestions: [] as string[],
    status: "done",
    ...extra,
  };
  return `Work.\n<${HANDOFF_TAG}>\n${JSON.stringify(body)}\n</${HANDOFF_TAG}>`;
}

interface OverlapStep {
  parentId: string;
  stepTaskId: string;
  /** The step's first run (the fake driver's own turn) — already settled,
   *  carrying whatever `suffix` made it write. */
  firstRunId: string;
}

/** A one-step pipeline started with the runner's listener OFF: its first run
 *  settles unobserved, so the test decides exactly when (and for which run)
 *  each settle reaches the runner. The caller re-enables the listener. */
async function startOverlapStep(label: string, suffix = "missing"): Promise<OverlapStep> {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile(label);
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}` });
  const pipeline = pipelines.insert({
    name: uniqueName(`${label}-pipeline`),
    graph: { steps: [A], edges: [], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({ title: `${label} run`, prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const stepTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  const first = await waitFor(() => {
    const r = runs.listForTask(stepTask.id)[0];
    return r && r.status !== "running" ? r : undefined;
  });
  return { parentId, stepTaskId: stepTask.id, firstRunId: first.id };
}

interface LiveRun {
  runId: string;
  /** Write a further assistant chunk into the still-open run. */
  say(text: string): void;
  /** End the run (exit code 0 unless given) and wait for its row to settle. */
  finish(code?: number): Promise<void>;
}

/** Open a REAL live run on a claude step task the way a background-task
 *  continuation (`trigger: "notification"`) or a message typed in the
 *  terminal (`"user"`) does — it becomes `task.runId` and registers an
 *  `active` handle — and hold it open until the test calls `finish()`, so the
 *  order in which overlapping runs end is exactly the test's. */
async function openLiveRun(taskId: string, reply: string | null, trigger: "notification" | "user" = "notification"): Promise<LiveRun> {
  const { openContinuationRun } = await import("./claude-tmux.ts");
  const { tasks, runs } = await import("./db.ts");
  const hooks = openContinuationRun(taskId, trigger);
  if (!hooks) throw new Error("no continuation run factory is installed");
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((res) => { resolveDone = res; });
  hooks.onAdopted({ kill: () => resolveDone(0), writeInput: () => true, done });
  const runId = tasks.get(taskId)!.runId!;
  if (reply) hooks.onChunk("assistant", reply);
  return {
    runId,
    say: (text) => hooks.onChunk("assistant", text),
    async finish(code = 0) {
      hooks.onChunk("status", "turn complete");
      resolveDone(code);
      await waitFor(() => {
        const r = runs.get(runId);
        return r && r.status !== "running" ? r : undefined;
      });
    },
  };
}

/** Every handoff-reminder `user` event across all runs of a step task. */
async function reminderEventsOf(stepTaskId: string): Promise<string[]> {
  const { runs } = await import("./db.ts");
  const { HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
  return runs.listForTask(stepTaskId)
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER))
    .map((e) => e.data);
}

async function statusLinesOf(runId: string): Promise<string[]> {
  const { runs } = await import("./db.ts");
  return runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
}

/** The step execution is still waiting: active, unblocked, un-reminded,
 *  un-resolved, with the run not finished. */
async function expectStepWaiting(s: OverlapStep): Promise<void> {
  const { tasks } = await import("./db.ts");
  const run = tasks.get(s.parentId)!.pipelineRun!;
  expect(run.status).toBe("running");
  expect(run.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
  expect(run.blocked.filter((b) => b.taskId === s.stepTaskId)).toEqual([]);
  const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
  expect(record.outcome).toBeNull();
  expect(record.reminder ?? null).toBeNull();
  expect(record.responseKind ?? null).toBeNull();
  expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
}

async function waitForPipelineDone(parentId: string) {
  const { tasks } = await import("./db.ts");
  return waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  }, 8000);
}

/** Wait until no run of the step task is `running` (a reminder turn the fake
 *  driver is still writing would otherwise append after `deleteTask`). */
async function waitForStepRunsIdle(stepTaskId: string): Promise<void> {
  const { runs } = await import("./db.ts");
  await waitFor(() => (runs.listForTask(stepTaskId).some((r) => r.status === "running") ? undefined : true), 8000);
}

test("U7(1) incident shape: A has no handoff, B (displaced) has one, C (current) has none — the step advances on B once both end, with no reminder", async () => {
  const { HANDOFF_FROM_NEWER_RUN_STATUS } = await import("../shared/pipeline.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startOverlapStep("u7-incident");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
    expect(tasks.get(s.stepTaskId)!.runId).toBe(C.runId);

    // A's settle reaches the runner while B and C are both writing: the step
    // waits instead of reminding about a handoff B has already written.
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    await expectStepWaiting(s);

    // B ends first. It is no longer `task.runId`, so only the orchestrator's
    // displaced-run report reaches the runner — and C is still live.
    await B.finish();
    await tick(80);
    await expectStepWaiting(s);

    await tick();
    await C.finish();
    const done = await waitForPipelineDone(s.parentId);

    const record = done.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.responseKind).toBe("handoff");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
    expect(record.handoff?.reason).toBe("finished on B");
    expect(record.reminder ?? null).toBeNull();
    expect(done.pipelineRun!.blocked).toEqual([]);

    // The supplying run explains itself; the others stay quiet.
    expect(await statusLinesOf(B.runId)).toContain(HANDOFF_FROM_NEWER_RUN_STATUS);
    expect(await statusLinesOf(C.runId)).not.toContain(HANDOFF_FROM_NEWER_RUN_STATUS);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
    expect(runs.listForTask(s.stepTaskId).length).toBe(3);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(2) the current run C ends first while the displaced B is still live — nothing is reminded or blocked until B's displaced settle advances the step", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");

  const s = await startOverlapStep("u7-c-first");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");

    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    // C (the current run) ends with no handoff while B is still writing.
    await C.finish();
    await tick(80);
    await expectStepWaiting(s);

    // B's settle is the displaced-run report; it re-settles C and the
    // look-back finds B's handoff.
    await tick();
    await B.finish();
    const done = await waitForPipelineDone(s.parentId);
    const record = done.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

/** B (done) then C (blocked) both end with the runner deaf, then B's late
 *  settle arrives: the newest settled handoff — C's `status:"blocked"` — wins. */
async function setupNewerBlockedHandoff(label: string) {
  const { __forTest } = await import("./pipeline-runner.ts");
  const s = await startOverlapStep(label);
  await tick();
  const B = await openLiveRun(s.stepTaskId, await handoffReply("older, done"), "notification");
  await B.finish();
  await tick();
  const C = await openLiveRun(s.stepTaskId, await handoffReply("newer, needs a decision", { status: "blocked" }), "user");
  await C.finish();
  await __forTest.handleRunStatus(s.stepTaskId, B.runId, "succeeded");
  return { s, B, C };
}

test("U7(3) D10: an older done handoff and a newer blocked one — the newest settled wins, so the step blocks with the newer handoff", async () => {
  const { HANDOFF_FROM_OTHER_RUN_STATUS } = await import("../shared/pipeline.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const { s, B, C } = await setupNewerBlockedHandoff("u7-newest-wins");
  try {
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.status).toBe("blocked");
    expect(run.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
    const block = run.blocked.find((b) => b.taskId === s.stepTaskId);
    expect(block?.kind).toBe("step-blocked");
    expect(block?.message).toContain("newer, needs a decision");
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBeNull();
    expect(record.responseKind).toBe("handoff-blocked");
    expect(record.handoffRunId).toBe(C.runId);
    expect(record.handoffFromOtherRun).toBe(true);
    expect(record.handoff?.reason).toBe("newer, needs a decision");
    // B (the settling run) started BEFORE the supplier, so the supplier's
    // line says "another run", not "newer run".
    expect(await statusLinesOf(C.runId)).toContain(HANDOFF_FROM_OTHER_RUN_STATUS);
    expect(await statusLinesOf(B.runId)).not.toContain(HANDOFF_FROM_OTHER_RUN_STATUS);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId).catch(() => {});
});

test("U7(3b) a manual Advance clears the supplying-run fields", async () => {
  const { __forTest, advancePipeline } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const { s } = await setupNewerBlockedHandoff("u7-advance-clears");
  try {
    const advanced = await advancePipeline(s.parentId, { nextStepIds: null, fromTaskId: s.stepTaskId });
    if ("error" in advanced) throw new Error(advanced.error);
    const record = tasks.get(s.parentId)!.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("advanced-manually");
    expect(record.handoffRunId).toBeNull();
    expect(record.handoffFromOtherRun).toBe(false);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(3c) m11: the step genuinely running again resets the supplying-run fields", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const { s } = await setupNewerBlockedHandoff("u7-m11-resets");
  try {
    expect(tasks.get(s.parentId)!.pipelineRun!.history[0]!.handoffRunId).not.toBeNull();
    await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);
    const record = tasks.get(s.parentId)!.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.responseKind ?? null).toBeNull();
    expect(record.handoffRunId).toBeNull();
    expect(record.handoffFromOtherRun).toBe(false);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  // The execution reads `running` again with nothing left to drive it, so
  // `waitUntilIdle` would never return; no run is live, which is what matters.
  await waitForStepRunsIdle(s.stepTaskId);
});

test("U7(4a) D11: a handoff from before the last Retry cannot satisfy the new attempt — the new run's settle reminds instead", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-retry-window");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("from the previous attempt"), "notification");
    await B.finish();

    // The Retry: the execution's attempt window now starts after B ended.
    await tick();
    const parent = tasks.get(s.parentId)!;
    const run = parent.pipelineRun!;
    run.history.find((h) => h.taskId === s.stepTaskId)!.attemptStartedAt = Date.now();
    tasks.setPipelineRun(s.parentId, run);
    await tick();

    const C = await openLiveRun(s.stepTaskId, "retried, forgot the handoff", "user");
    await C.finish();
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "succeeded");

    // B's handoff is out of the window: no advance, and the one reminder goes out.
    const after = tasks.get(s.parentId)!.pipelineRun!;
    expect(after.status).not.toBe("done");
    expect(after.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
    const record = after.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBeNull();
    expect(record.handoffRunId ?? null).toBeNull();
    expect(record.reminder?.reason).toBe("handoff-missing");
    expect((await reminderEventsOf(s.stepTaskId)).length).toBe(1);
    await waitForStepRunsIdle(s.stepTaskId);
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("U7(4b) D11: a user's own follow-up run does not move the window — the handoff written before it still advances the step", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-user-window");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("written before the follow-up"), "notification");
    await B.finish();
    await tick();
    // A message typed into the step ("thanks") that gets a handoff-less reply.
    const U = await openLiveRun(s.stepTaskId, "You're welcome.", "user");
    await U.finish();
    await __forTest.handleRunStatus(s.stepTaskId, U.runId, "succeeded");

    const done = tasks.get(s.parentId)!.pipelineRun!;
    expect(done.status).toBe("done");
    const record = done.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(4c) a successful Retry stamps attemptStartedAt on the execution", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("u7-retry-stamp");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const pipeline = pipelines.insert({ name: uniqueName("u7-retry-stamp-pipeline"), graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
  const created = await createTask({ title: "retry stamp", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  // :missing → one reminder → blocked "still no valid handoff after one reminder".
  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const before = blocked.pipelineRun!.history[0]!;
  expect(before.attemptStartedAt ?? null).toBeNull();

  const retried = await retryPipelineStep(parentId);
  if ("error" in retried) throw new Error(retried.error);
  const after = tasks.get(parentId)!.pipelineRun!.history[0]!;
  expect(after.attemptStartedAt).not.toBeNull();
  expect(after.attemptStartedAt!).toBeGreaterThanOrEqual(before.startedAt);

  await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" && t.pipelineRun.blocked.length > 0 ? t : undefined;
  }, 8000);
  await waitForStepRunsIdle(tasks.stepsForParent(parentId)[0]!.id);
});

test("U7(5) D14: an already-reminded, blocked execution advances once a displaced run carrying a handoff settles", async () => {
  const { tasks } = await import("./db.ts");
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile("u7-reminded");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const pipeline = pipelines.insert({ name: uniqueName("u7-reminded-pipeline"), graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
  const created = await createTask({ title: "reminded then handoff elsewhere", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  // The original turn and the one reminder both omit the handoff: blocked.
  const blocked = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "blocked" ? t : undefined;
  }, 8000);
  const stepTaskId = tasks.stepsForParent(parentId)[0]!.id;
  expect(blocked.pipelineRun!.history[0]!.reminder).not.toBeNull();
  expect(blocked.pipelineRun!.blocked[0]?.message).toContain("still no valid handoff after one reminder");
  await waitForStepRunsIdle(stepTaskId);

  // Claude then answers on two overlapping runs: X (displaced) carries the
  // handoff, Y (current) does not.
  await tick();
  const X = await openLiveRun(stepTaskId, await handoffReply("finished on X"), "notification");
  await tick();
  const Y = await openLiveRun(stepTaskId, "Picking this back up.", "user");
  await Y.finish();
  await tick(80);
  const waiting = tasks.get(parentId)!.pipelineRun!;
  expect(waiting.status).not.toBe("done");
  expect(waiting.active.some((a) => a.taskId === stepTaskId)).toBe(true);

  await tick();
  await X.finish();
  const done = await waitForPipelineDone(parentId);
  const record = done.pipelineRun!.history.find((h) => h.taskId === stepTaskId)!;
  expect(record.outcome).toBe("succeeded");
  expect(record.reminder).not.toBeNull(); // the stamped reminder no longer blocks
  expect(record.handoffRunId).toBe(X.runId);
  expect(record.handoffFromOtherRun).toBe(true);
  expect(done.pipelineRun!.blocked).toEqual([]);
  await waitUntilIdle(parentId);
});

test("U7(6) D15: with the runner deaf to every settle, reconcilePipelineRuns advances on the look-back", async () => {
  const { __forTest, reconcilePipelineRuns } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-reconcile");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
    await B.finish();
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
    await C.finish();
    expect(tasks.get(s.parentId)!.pipelineRun!.status).toBe("running");

    const count = await reconcilePipelineRuns();
    expect(count).toBeGreaterThanOrEqual(1);

    const done = tasks.get(s.parentId)!.pipelineRun!;
    expect(done.status).toBe("done");
    const record = done.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

/** A subagent of `runId` that ended after the run did — the DB trace of a
 *  held step that was released. */
async function insertReleasedSubagent(s: OverlapStep): Promise<void> {
  const { subagents } = await import("./db.ts");
  subagents.insertIfAbsent({
    id: randomUUID(),
    taskId: s.stepTaskId,
    runId: s.firstRunId,
    parentKind: "subagent",
    agentType: "general-purpose",
    description: "background work",
    spawnDepth: 1,
    sourcePath: "/tmp/u7-subagent.jsonl",
    status: "completed",
    startedAt: Date.now() - 500,
    endedAt: Date.now(),
  });
}

test("U7(7a) grace: a released held run with no handoff and no continuation waits out the grace, then gets the one reminder", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-grace-expires");
  const previous = __forTest.setReleaseGraceMs(200);
  try {
    await tick();
    await insertReleasedSubagent(s);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    // Inside the grace: nothing sent, nothing blocked, no outcome stamped.
    await expectStepWaiting(s);
    await tick(80);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);

    // The grace timer re-settles the run; with no continuation it reminds.
    const reminders = await waitFor(() => {
      const found = tasks.get(s.parentId)!.pipelineRun!.history[0]!.reminder;
      return found ?? undefined;
    }, 4000);
    expect(reminders.reason).toBe("handoff-missing");
    expect((await reminderEventsOf(s.stepTaskId)).length).toBe(1);
    await waitForStepRunsIdle(s.stepTaskId);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("U7(7b) grace: a continuation adopted inside the grace is advanced on — no reminder, now or when the grace ends", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");

  const s = await startOverlapStep("u7-grace-cont");
  const previous = __forTest.setReleaseGraceMs(300);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    await expectStepWaiting(s);

    const B = await openLiveRun(s.stepTaskId, await handoffReply("continued after the helper finished"), "notification");
    await B.finish();
    const done = await waitForPipelineDone(s.parentId);
    const record = done.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(false);

    // Past the original deadline the (cleared) timer must not remind anyone.
    await tick(400);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(8) D6: a run turns live between the reminder decision and the send — the idle-only send is refused, nothing is recorded or blocked, and the run's own handoff advances the step", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-idle-only");
  let B: LiveRun | null = null;
  try {
    __forTest.setListenerEnabled(true);
    __forTest.setBeforeReminderDispatch(async () => {
      // The pre-send recheck saw an idle step; a continuation starts now.
      B = await openLiveRun(s.stepTaskId, await handoffReply("continuation won the race"), "notification");
    });
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    expect(B).not.toBeNull();
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
    expect(run.blocked.filter((b) => b.taskId === s.stepTaskId)).toEqual([]);
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.reminder ?? null).toBeNull();
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);

    await B!.finish();
    const done = await waitForPipelineDone(s.parentId);
    const advanced = done.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(advanced.outcome).toBe("succeeded");
    expect(advanced.responseKind).toBe("handoff");
    expect(advanced.handoffRunId).toBe(B!.runId);
    expect(advanced.reminder ?? null).toBeNull();
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setBeforeReminderDispatch(null);
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(9) a pending question on the settling run wins over an older run's handoff", async () => {
  const { registerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-user-ask");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("older, done"), "notification");
    await B.finish();
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Which database should I use?", "user");
    await C.finish();
    registerTmuxPrompt({
      taskId: s.stepTaskId,
      runId: C.runId,
      paneText: "pane",
      choices: [{ key: "1", label: "Postgres" }],
      fingerprint: `fp-u7-user-ask-${s.stepTaskId}`,
    });

    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "succeeded");

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.status).toBe("blocked");
    expect(run.blocked.find((b) => b.taskId === s.stepTaskId)?.message).toContain("is waiting for you");
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.responseKind).toBe("user-ask");
    expect(record.outcome).toBeNull();
    expect(record.handoffRunId ?? null).toBeNull();
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
    cancelPendingForTask(s.stepTaskId, "test cleanup");
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId).catch(() => {});
});

/** B (handoff) and C (none) have both ended with the runner deaf. */
async function setupHandoffThenSilentRun(label: string) {
  const s = await startOverlapStep(label);
  await tick();
  const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
  await B.finish();
  await tick();
  const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
  await C.finish();
  return { s, B, C };
}

test("U7(10a) an orphaned settle looks back and advances on an earlier run's handoff", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const { s, B, C } = await setupHandoffThenSilentRun("u7-orph-look");
  try {
    runs.update(C.runId, { status: "orphaned" });
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "orphaned");

    const done = tasks.get(s.parentId)!.pipelineRun!;
    expect(done.status).toBe("done");
    const record = done.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(10b) an orphaned settle during a whole-run stop does NOT look back", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const { s, C } = await setupHandoffThenSilentRun("u7-orphaned-stop");
  try {
    const parent = tasks.get(s.parentId)!;
    const run = parent.pipelineRun!;
    // What `cancelPipelineRun` records: the marker, then a forced status.
    run.stopRequestedAt = Date.now();
    run.status = "cancelled";
    __forTest.persist(s.parentId, run, { preserveStatus: true });

    runs.update(C.runId, { status: "orphaned" });
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "orphaned");

    const after = tasks.get(s.parentId)!.pipelineRun!;
    expect(after.status).toBe("cancelled");
    expect(after.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
    const record = after.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("cancelled");
    expect(record.handoffRunId ?? null).toBeNull();
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("U7(10c) a cancelled settle (a deliberate Stop) never looks back", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const { s, C } = await setupHandoffThenSilentRun("u7-cancelled");
  try {
    runs.update(C.runId, { status: "cancelled" });
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "cancelled");

    const after = tasks.get(s.parentId)!.pipelineRun!;
    expect(after.status).toBe("cancelled");
    expect(after.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
    const record = after.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("cancelled");
    expect(record.handoffRunId ?? null).toBeNull();
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("U7(10d) a failed settle looks back and advances on an earlier run's handoff", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const { s, B, C } = await setupHandoffThenSilentRun("u7-fail-look");
  try {
    runs.update(C.runId, { status: "failed", exitCode: 1 });
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "failed");

    const done = tasks.get(s.parentId)!.pipelineRun!;
    expect(done.status).toBe("done");
    const record = done.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
    expect(done.blocked).toEqual([]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(11) a column-event settle uses the step's current run, not the newest-started one — a displaced run that started in the same millisecond is not mistaken for it", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, db } = await import("./db.ts");

  const s = await startOverlapStep("u7-current-run");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
    expect(tasks.get(s.stepTaskId)!.runId).toBe(C.runId);
    await B.finish();
    await tick();
    await C.finish();
    // Make the displaced B sort first by `started_at DESC` — the tie two
    // overlapping continuations hit when they open in the same millisecond.
    const cStartedAt = db.query<{ started_at: number }, [string]>(`SELECT started_at FROM runs WHERE id = ?`).get(C.runId)!.started_at;
    db.query(`UPDATE runs SET started_at = ? WHERE id = ?`).run(cStartedAt + 1, B.runId);

    __forTest.setListenerEnabled(true);
    await __forTest.handleColumnChange(s.stepTaskId, "review", undefined);
    const done = await waitForPipelineDone(s.parentId);
    const record = done.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.handoffRunId).toBe(B.runId);
    expect(record.handoffFromOtherRun).toBe(true);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

// ---------------------------------------------------------------------------
// Review round fixes (handoff-identification-fix code review: M1, M2, L1–L4)
// ---------------------------------------------------------------------------

/** A step whose first continuation B reported `status:"blocked"` and was
 *  settled — the execution reads blocked on B's handoff. */
async function setupBlockedOnOwnHandoff(label: string) {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");
  const s = await startOverlapStep(label);
  await tick();
  const B = await openLiveRun(s.stepTaskId, await handoffReply("waiting on a decision", { status: "blocked" }), "notification");
  await B.finish();
  await __forTest.handleRunStatus(s.stepTaskId, B.runId, "succeeded");
  const run = tasks.get(s.parentId)!.pipelineRun!;
  expect(run.blocked.find((b) => b.taskId === s.stepTaskId)?.message).toContain("waiting on a decision");
  return { s, B };
}

test("M1: a reply to a step blocked on its own handoff that lacks a handoff gets the reminder — the stale blocked handoff no longer supplies it", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const { s, B } = await setupBlockedOnOwnHandoff("m1-blocked-reply");
  try {
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Thanks — on it.", "user");
    // What the runner sees when the reply starts (m11 clears the block).
    await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);
    await C.finish();
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "succeeded");

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.active.some((a) => a.taskId === s.stepTaskId)).toBe(true);
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.reminder?.reason).toBe("handoff-missing");
    expect(record.handoffRunId ?? null).toBeNull();
    expect((await reminderEventsOf(s.stepTaskId)).length).toBe(1);
    // The old blocked reason was not re-recorded.
    expect(run.blocked.some((b) => b.message.includes("waiting on a decision"))).toBe(false);
    expect((await statusLinesOf(B.runId)).filter((l) => l.startsWith("handoff taken"))).toEqual([]);
    await waitForStepRunsIdle(s.stepTaskId);
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("M1: a FAILED reply to a step blocked on its own handoff blocks step-failed, not with the old blocked reason", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const { s } = await setupBlockedOnOwnHandoff("m1-blocked-fail");
  try {
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Trying again…", "user");
    await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);
    await C.finish();
    runs.update(C.runId, { status: "failed", exitCode: 1 });
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "failed");

    const run = tasks.get(s.parentId)!.pipelineRun!;
    const block = run.blocked.find((b) => b.taskId === s.stepTaskId);
    expect(block?.kind).toBe("step-failed");
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("failed");
    expect(record.responseKind).toBe("error");
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("M1: a blocked handoff on a run that overlapped the settling one still blocks (it was not superseded)", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("m1-overlap");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, null, "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
    B.say(await handoffReply("blocked, written beside the newer run", { status: "blocked" }));
    await C.finish();
    await tick();
    await B.finish();
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "succeeded");

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.blocked.find((b) => b.taskId === s.stepTaskId)?.message).toContain("blocked, written beside the newer run");
    expect(run.history.find((h) => h.taskId === s.stepTaskId)!.handoffRunId).toBe(B.runId);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("M2: the release grace covers a continuation held by a background agent tagged with an EARLIER run", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, subagents, runs } = await import("./db.ts");

  const s = await startOverlapStep("m2-grace");
  const previous = __forTest.setReleaseGraceMs(200);
  try {
    await tick();
    // The first helper finished and its notification started continuation B;
    // the second helper — discovered under the first run — kept running
    // past B's end, holding B, and was released just now.
    const B = await openLiveRun(s.stepTaskId, "First helper done; waiting on the second.", "notification");
    await B.finish();
    await tick();
    subagents.insertIfAbsent({
      id: randomUUID(),
      taskId: s.stepTaskId,
      runId: s.firstRunId,
      parentKind: "subagent",
      agentType: "general-purpose",
      description: "second helper",
      spawnDepth: 1,
      sourcePath: "/tmp/m2-subagent.jsonl",
      status: "completed",
      startedAt: runs.get(s.firstRunId)!.startedAt,
      endedAt: Date.now(),
    });
    await __forTest.handleRunStatus(s.stepTaskId, B.runId, "succeeded");

    await expectStepWaiting(s);
    const reminder = await waitFor(() => tasks.get(s.parentId)!.pipelineRun!.history[0]!.reminder ?? undefined, 4000);
    expect(reminder.reason).toBe("handoff-missing");
    await waitForStepRunsIdle(s.stepTaskId);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("L1: a reminder turn that settles before the reminder is stamped is re-settled afterwards — the step blocks instead of sitting active forever", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startOverlapStep("l1-early-settle");
  try {
    // Listener stays OFF: the reminder turn's own settle never reaches the
    // runner, exactly as when it lands while the reminder is still in flight.
    __forTest.setBeforeReminderStamp(async () => {
      await waitFor(() => {
        const all = runs.listForTask(s.stepTaskId);
        return all.length >= 2 && all.every((r) => r.status !== "running") ? true : undefined;
      }, 6000);
    });
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    const run = tasks.get(s.parentId)!.pipelineRun!;
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.reminder?.delivered).toBe(true);
    const block = run.blocked.find((b) => b.taskId === s.stepTaskId);
    expect(block?.message).toContain("still no valid handoff after one reminder");
    expect(run.status).toBe("blocked");
  } finally {
    __forTest.setBeforeReminderStamp(null);
    __forTest.setListenerEnabled(true);
  }
});

test("L2: Stop on a pipeline whose step is only live through a DISPLACED run stops it (no 409)", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { isAnyRunOfTaskLive, isTaskRunLive } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startOverlapStep("l2-displaced-stop");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, "still working", "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "a reply", "user");
    await C.finish();
    expect(isTaskRunLive(s.stepTaskId)).toBe(false);
    expect(isAnyRunOfTaskLive(s.stepTaskId)).toBe(true);

    const result = await cancelPipelineRun(s.parentId);
    if ("error" in result) throw new Error(result.error);
    expect(result.task.pipelineRun!.status).toBe("cancelled");
    await waitFor(() => (runs.get(B.runId)!.status !== "running" ? true : undefined), 4000);
    expect(isAnyRunOfTaskLive(s.stepTaskId)).toBe(false);
    expect(tasks.get(s.parentId)!.pipelineRun!.status).toBe("cancelled");
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("L3: an idle-only refusal with no live run is re-settled a bounded number of times, then blocks with the reason", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("l3-busy-no-live");
  let sends = 0;
  try {
    __forTest.setBusyRecheckDelaysMs([20, 20]);
    __forTest.setReminderSend(async () => {
      sends++;
      return { delivered: false, reason: "busy", busy: true };
    });
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    const block = await waitFor(() => {
      const run = tasks.get(s.parentId)!.pipelineRun!;
      return run.blocked.find((b) => b.taskId === s.stepTaskId);
    }, 4000);
    expect(block.message).toContain("still reports a turn in progress");
    expect(sends).toBe(3);
    const record = tasks.get(s.parentId)!.pipelineRun!.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.reminder ?? null).toBeNull();
    // The block states what the turn answered, even though the queued
    // reminder cleared the classification while it waited.
    expect(record.responseKind).toBe("handoff-missing");
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setReminderSend(null);
    __forTest.setBusyRecheckDelaysMs(null);
    __forTest.setListenerEnabled(true);
  }
});

test("L4: a finished run's parse is cached, and parsed again once the run gains events", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { runs } = await import("./db.ts");

  const s = await startOverlapStep("l4-parse-cache");
  try {
    expect(__forTest.parsedRunResponse(s.firstRunId).kind).toBe("handoff-missing");
    expect(__forTest.parsedRunResponse(s.firstRunId)).toBe(__forTest.parsedRunResponse(s.firstRunId));
    runs.appendEvent(s.firstRunId, "assistant", await handoffReply("written by a rebuild"));
    const reparsed = __forTest.parsedRunResponse(s.firstRunId);
    expect(reparsed.kind).toBe("handoff");
    expect(reparsed.handoff?.reason).toBe("written by a rebuild");
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("U7(12) the supplier's status line is worded against the step's newest run — the oldest run settling last still reads \"newer run had none\"", async () => {
  const { HANDOFF_FROM_NEWER_RUN_STATUS, HANDOFF_FROM_OTHER_RUN_STATUS } = await import("../shared/pipeline.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("u7-late-oldest");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
    await B.finish();
    await tick();
    await C.finish();
    // The first run's settle reaches the lock only now, with nothing live —
    // the order a loaded machine produces.
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    const done = tasks.get(s.parentId)!.pipelineRun!;
    expect(done.status).toBe("done");
    expect(done.history.find((h) => h.taskId === s.stepTaskId)!.handoffRunId).toBe(B.runId);
    const lines = await statusLinesOf(B.runId);
    expect(lines).toContain(HANDOFF_FROM_NEWER_RUN_STATUS);
    expect(lines).not.toContain(HANDOFF_FROM_OTHER_RUN_STATUS);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("U7(12b) a same-millisecond tie between the supplier and the current run still counts the current run as newer", async () => {
  const { HANDOFF_FROM_NEWER_RUN_STATUS } = await import("../shared/pipeline.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, db } = await import("./db.ts");

  const s = await startOverlapStep("u7-tie");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, await handoffReply("finished on B"), "notification");
    const C = await openLiveRun(s.stepTaskId, "Picking this back up.", "user");
    await B.finish();
    await C.finish();
    // The fake driver opens both continuations back to back, so they often
    // share a millisecond.
    const bStartedAt = db.query<{ started_at: number }, [string]>(`SELECT started_at FROM runs WHERE id = ?`).get(B.runId)!.started_at;
    db.query(`UPDATE runs SET started_at = ? WHERE id = ?`).run(bStartedAt, C.runId);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "succeeded");

    const done = tasks.get(s.parentId)!.pipelineRun!;
    expect(done.status).toBe("done");
    expect(await statusLinesOf(B.runId)).toContain(HANDOFF_FROM_NEWER_RUN_STATUS);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

// ---------------------------------------------------------------------------
// A whole-run Stop is durable (round-2 review, HIGH): `run.stopRequestedAt`
// keeps the run stopped through every later persist, so no re-settle — the
// release grace, a wait or busy recheck, a displaced run's report, a reminder
// mid-send — can remind, block or relaunch after the user pressed Stop.
// ---------------------------------------------------------------------------

/** No reminder ever reached the step, the run reads stopped, and nothing is
 *  blocked. */
async function expectStoppedCleanly(s: { parentId: string; stepTaskId: string }): Promise<void> {
  const { tasks } = await import("./db.ts");
  const parent = tasks.get(s.parentId)!;
  const run = parent.pipelineRun!;
  expect(run.status).toBe("cancelled");
  expect(run.stopRequestedAt).toBeNumber();
  expect(parent.column).toBe("ready");
  expect(run.blocked).toEqual([]);
  const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
  expect(record.reminder ?? null).toBeNull();
  expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
}

test("Stop on a step held by a background agent stays cancelled — the release grace never reminds after it (listener on)", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines, subagents } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { cancelPipelineRun, __forTest } = await import("./pipeline-runner.ts");

  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
  const previousGrace = __forTest.setReleaseGraceMs(300);
  try {
    const profile = await makeProfile("stop-held");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
    const pipeline = pipelines.insert({ name: uniqueName("stop-held"), graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
    const created = await createTask({ title: "stop held", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);

    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const step = await waitFor(() => {
      const t = tasks.stepsForParent(parentId)[0];
      return t?.column === "running" && t.runId ? t : undefined;
    });
    // A background agent still running when the turn ends holds the step.
    const helperId = `agent-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: helperId, taskId: step.id, runId: step.runId, parentKind: "subagent", agentType: "Explore",
      description: "helper", spawnDepth: 1, sourcePath: `/tmp/${helperId}.jsonl`, status: "running",
      startedAt: Date.now(), endedAt: null,
    });
    await waitFor(() => (runs.get(step.runId!)?.status === "succeeded" ? true : undefined), 6000);
    await waitFor(() => (tasks.get(parentId)?.pipelineRun?.history[0]?.responseKind === "handoff-missing" ? true : undefined), 6000);
    expect(tasks.get(step.id)?.column).toBe("running"); // held

    const result = await cancelPipelineRun(parentId);
    if ("error" in result) throw new Error(result.error);
    expect(result.task.pipelineRun!.status).toBe("cancelled");

    // Stopping orphans the helper (it "ended after the run"), which is the
    // shape the release grace keys on. Wait past the grace.
    await tick(800);
    const s = { parentId, stepTaskId: step.id };
    await expectStoppedCleanly(s);
    const record = tasks.get(parentId)!.pipelineRun!.history[0]!;
    expect(record.outcome).toBe("cancelled");
    expect(record.responseKind).toBe("handoff-missing");
    expect(runs.listForTask(step.id).length).toBe(1);
  } finally {
    __forTest.setReleaseGraceMs(previousGrace);
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("Stop on a step live only through a DISPLACED run stays cancelled — the displaced report and the wait recheck never remind (listener on)", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { isAnyRunOfTaskLive, isTaskRunLive } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");

  const s = await startOverlapStep("stop-displaced");
  try {
    await tick();
    const B = await openLiveRun(s.stepTaskId, "still working", "notification");
    await tick();
    const C = await openLiveRun(s.stepTaskId, "a reply", "user");
    await C.finish();
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, C.runId, "succeeded");
    expect(isTaskRunLive(s.stepTaskId)).toBe(false);
    expect(isAnyRunOfTaskLive(s.stepTaskId)).toBe(true);

    const result = await cancelPipelineRun(s.parentId);
    if ("error" in result) throw new Error(result.error);
    await waitFor(() => (runs.get(B.runId)!.status !== "running" ? true : undefined), 4000);
    // Long enough for the displaced report, its re-settle and every wait
    // recheck probe that could follow.
    await tick(600);
    await expectStoppedCleanly(s);
    expect(runs.listForTask(s.stepTaskId).map((r) => r.status).sort()).toEqual(["cancelled", "succeeded", "succeeded"]);
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("Stop while a step waits out the release grace stops it (no 409), records it cancelled, and Retry resumes the run", async () => {
  const { __forTest, cancelPipelineRun, retryPipelineStep } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("stop-in-grace");
  const previous = __forTest.setReleaseGraceMs(300);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    await expectStepWaiting(s);

    const result = await cancelPipelineRun(s.parentId);
    if ("error" in result) throw new Error(result.error);
    expect(result.task.pipelineRun!.status).toBe("cancelled");
    await tick(600); // past the grace: its timer was cancelled
    await expectStoppedCleanly(s);
    const record = tasks.get(s.parentId)!.pipelineRun!.history[0]!;
    expect(record.outcome).toBe("cancelled");
    expect(record.responseKind).toBe("handoff-missing");

    // Retry clears the marker and re-runs the stopped execution.
    const retried = await retryPipelineStep(s.parentId);
    if ("error" in retried) throw new Error(retried.error);
    expect(retried.task.pipelineRun!.stopRequestedAt ?? null).toBeNull();
    expect(retried.task.pipelineRun!.status).not.toBe("cancelled");
    await waitForStepRunsIdle(s.stepTaskId);
    await waitUntilIdle(s.parentId, 8000);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("Stop while the busy backstop waits stops it (no 409): no further send, no block", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("stop-busy");
  let sends = 0;
  try {
    __forTest.setBusyRecheckDelaysMs([150, 150]);
    __forTest.setReminderSend(async () => {
      sends++;
      return { delivered: false, reason: "busy", busy: true };
    });
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    expect(sends).toBe(1);

    const result = await cancelPipelineRun(s.parentId);
    if ("error" in result) throw new Error(result.error);
    await tick(500); // past every backstop delay
    expect(sends).toBe(1);
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.status).toBe("cancelled");
    expect(run.blocked).toEqual([]);
    expect(run.history[0]!.outcome).toBe("cancelled");
    expect(run.history[0]!.responseKind).toBe("handoff-missing");
  } finally {
    __forTest.setReminderSend(null);
    __forTest.setBusyRecheckDelaysMs(null);
    __forTest.setListenerEnabled(true);
  }
});

test("Stop while a reminder is queued outside the lock abandons the send — nothing is pasted, the run stays stopped", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("stop-mid-send");
  let sends = 0;
  try {
    __forTest.setReminderSend(async () => {
      sends++;
      return { delivered: false, reason: "should not be sent" };
    });
    __forTest.setBeforeReminderSend(async () => {
      const stopped = await cancelPipelineRun(s.parentId);
      if ("error" in stopped) throw new Error(stopped.error);
    });
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    await waitFor(() => (tasks.get(s.parentId)!.pipelineRun!.history[0]!.outcome === "cancelled" ? true : undefined));
    expect(sends).toBe(0);
    await expectStoppedCleanly(s);
  } finally {
    __forTest.setBeforeReminderSend(null);
    __forTest.setReminderSend(null);
    __forTest.setListenerEnabled(true);
  }
});

test("a re-settle of a stopped step that succeeded without a handoff keeps the run stopped (idempotent)", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("stop-resettle");
  const previous = __forTest.setReleaseGraceMs(5_000);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const result = await cancelPipelineRun(s.parentId);
    if ("error" in result) throw new Error(result.error);

    // The paths that used to undo the Stop: a plain persist, then re-settles.
    __forTest.persist(s.parentId, tasks.get(s.parentId)!.pipelineRun!);
    await __forTest.resettleCurrentRun(s.stepTaskId);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    await expectStoppedCleanly(s);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("Advance on a stopped run resumes it: the marker clears and the run finishes", async () => {
  const { __forTest, cancelPipelineRun, advancePipeline } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("stop-advance");
  const previous = __forTest.setReleaseGraceMs(5_000);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const result = await cancelPipelineRun(s.parentId);
    if ("error" in result) throw new Error(result.error);

    const advanced = await advancePipeline(s.parentId, { nextStepIds: null, fromTaskId: s.stepTaskId });
    if ("error" in advanced) throw new Error(advanced.error);
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt ?? null).toBeNull();
    expect(run.status).toBe("done");
    expect(run.history[0]!.outcome).toBe("advanced-manually");
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

// ---------------------------------------------------------------------------
// Scope of a Stop (review round 3): only the pipeline's own Stop is a durable
// whole-run stop. A Stop on one step's own panel stops that execution
// (`stoppedAt`), an orphaned settle stops nothing, and a turn the user starts
// on a stopped step resumes it.
// ---------------------------------------------------------------------------

/** A two-step pipeline A → Z whose A ends without a handoff; A's first run
 *  settles with the runner's listener OFF (the caller re-enables it). */
async function startLinearAZ(label: string): Promise<OverlapStep> {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile(label);
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const Z = newStep({ name: "Z", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = pipelines.insert({
    name: uniqueName(`${label}-pipeline`),
    graph: { steps: [A, Z], edges: [{ id: "e1", from: A.id, to: Z.id, label: "" }], startStepId: A.id },
    maxSteps: 25,
  });
  const created = await createTask({ title: `${label} run`, prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);
  const stepTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
  const first = await waitFor(() => {
    const r = runs.listForTask(stepTask.id)[0];
    return r && r.status !== "running" ? r : undefined;
  });
  return { parentId, stepTaskId: stepTask.id, firstRunId: first.id };
}

/** The user's Stop on one step's own panel, on a live run of it. */
async function stopLiveRunFromPanel(stepTaskId: string): Promise<string> {
  const { cancelRun } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  const working = await openLiveRun(stepTaskId, null, "user");
  expect(await cancelRun(working.runId)).toBe(true);
  await waitFor(() => (runs.get(working.runId)!.status === "cancelled" ? true : undefined));
  return working.runId;
}

/** Wait until the runner recorded `stepTaskId`'s execution outcome. */
async function waitForOutcome(parentId: string, stepTaskId: string, outcome: string): Promise<void> {
  const { tasks } = await import("./db.ts");
  await waitFor(() =>
    tasks.get(parentId)!.pipelineRun!.history.find((h) => h.taskId === stepTaskId)?.outcome === outcome ? true : undefined,
  );
}

test("R3-3: Stop on the only live step from its own panel, then the user's redirect turn with a handoff, continues the pipeline", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startLinearAZ("r3-redirect");
  try {
    __forTest.setListenerEnabled(true);
    await tick();
    await stopLiveRunFromPanel(s.stepTaskId);
    await waitForOutcome(s.parentId, s.stepTaskId, "cancelled");

    const stopped = tasks.get(s.parentId)!.pipelineRun!;
    expect(stopped.status).toBe("cancelled");
    expect(stopped.stopRequestedAt).toBeNull();
    expect(stopped.history[0]!.stoppedAt).toBeNumber();
    // A later bookkeeping persist keeps it stopped: every active execution is.
    __forTest.persist(s.parentId, stopped);
    expect(tasks.get(s.parentId)!.pipelineRun!.status).toBe("cancelled");

    await tick();
    const redirect = await openLiveRun(s.stepTaskId, await handoffReply("redirected"), "user");
    await redirect.finish();
    await waitFor(() => (tasks.stepsForParent(s.parentId).length === 2 ? true : undefined));

    const run = tasks.get(s.parentId)!.pipelineRun!;
    const record = run.history.find((h) => h.taskId === s.stepTaskId)!;
    expect(record.outcome).toBe("succeeded");
    expect(record.stoppedAt).toBeNull();
    expect(record.handoffRunId).toBe(redirect.runId);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
    await waitForPipelineDone(s.parentId);
  } finally {
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("R3-2: after the pipeline's Stop, a turn the user types on a step resumes the run, and its handoff continues the pipeline", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startLinearAZ("r3-resume");
  const previous = __forTest.setReleaseGraceMs(5_000);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const stopped = await cancelPipelineRun(s.parentId);
    if ("error" in stopped) throw new Error(stopped.error);
    expect(stopped.task.pipelineRun!.stopRequestedAt).toBeNumber();

    await tick();
    const reply = await openLiveRun(s.stepTaskId, await handoffReply("user redirect"), "user");
    await waitFor(() => (tasks.get(s.parentId)!.pipelineRun!.stopRequestedAt === null ? true : undefined));
    await reply.finish();
    await waitFor(() => (tasks.stepsForParent(s.parentId).length === 2 ? true : undefined));
    await waitForPipelineDone(s.parentId);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId);
});

test("R3-4: an orphaned settle (agetor restarted mid-turn) is not a user Stop — no marker, no stoppedAt", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startLinearAZ("r3-orphan");
  try {
    __forTest.setListenerEnabled(true);
    runs.update(s.firstRunId, { status: "orphaned" });
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "orphaned");
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.status).toBe("cancelled");
    expect(run.stopRequestedAt).toBeNull();
    expect(run.history[0]!.outcome).toBe("cancelled");
    expect(run.history[0]!.stoppedAt).toBeNull();
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("R3-1: a Stop on one fan-out branch's own panel while a sibling waits out its release grace blocks the stopped branch only — the sibling still gets its reminder", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines, subagents } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest, retryPipelineStep } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("r3-fan");
  const S = newStep({ name: "S", agentProfileId: profile.id, transition: "all", instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
  const pipeline = pipelines.insert({
    name: uniqueName("r3-fan"),
    graph: {
      steps: [S, A, B],
      edges: [{ id: "e1", from: S.id, to: A.id, label: "" }, { id: "e2", from: S.id, to: B.id, label: "" }],
      startStepId: S.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "r3 fan", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  const previous = __forTest.setReleaseGraceMs(400);
  let aTaskId = "";
  let bTaskId = "";
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const sTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const sRun = await waitFor(() => {
      const r = runs.listForTask(sTask.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });
    await __forTest.handleRunStatus(sTask.id, sRun.id, "succeeded");
    const steps = await waitFor(() => {
      const all = tasks.stepsForParent(parentId);
      return all.length === 3 ? all : undefined;
    });
    aTaskId = steps.find((t) => t.title.endsWith("A"))!.id;
    bTaskId = steps.find((t) => t.title.endsWith("B"))!.id;
    const bFirst = await waitFor(() => {
      const r = runs.listForTask(bTaskId)[0];
      return r && r.status !== "running" ? r : undefined;
    });
    await waitFor(() => {
      const r = runs.listForTask(aTaskId)[0];
      return r && r.status !== "running" ? r : undefined;
    });

    // B: a released held run, waiting out its release grace.
    subagents.insertIfAbsent({
      id: randomUUID(), taskId: bTaskId, runId: bFirst.id, parentKind: "subagent", agentType: "general-purpose",
      description: "bg", spawnDepth: 1, sourcePath: "/tmp/r3-fan.jsonl", status: "completed",
      startedAt: Date.now() - 500, endedAt: Date.now(),
    });
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(bTaskId, bFirst.id, "succeeded");

    // A: live, then stopped from its own panel.
    await tick();
    const aLive = await openLiveRun(aTaskId, null, "user");
    expect(await cancelRun(aLive.runId)).toBe(true);
    await waitForOutcome(parentId, aTaskId, "cancelled");

    const mid = tasks.get(parentId)!.pipelineRun!;
    expect(mid.stopRequestedAt).toBeNull();
    expect(mid.status).toBe("blocked");
    expect(mid.blocked.map((b) => b.taskId)).toEqual([aTaskId]);
    expect(mid.blocked[0]!.message).toContain("was stopped");

    // B's grace ends: it is not stopped, so it gets its one reminder.
    const { HANDOFF_REMINDER_MARKER } = await import("../shared/pipeline.ts");
    await waitFor(() => {
      const sent = runs.listForTask(bTaskId)
        .flatMap((r) => runs.events(r.id))
        .filter((e) => e.stream === "user" && e.data.includes(HANDOFF_REMINDER_MARKER));
      return sent.length === 1 ? true : undefined;
    }, 5000);
    await waitForStepRunsIdle(bTaskId);
    expect(tasks.get(parentId)!.pipelineRun!.stopRequestedAt).toBeNull();

    // One-step Retry of the stopped branch clears its own stop.
    await waitFor(() => (tasks.get(parentId)!.pipelineRun!.history.find((h) => h.taskId === bTaskId)?.reminder ? true : undefined));
    const retried = await retryPipelineStep(parentId, { taskId: aTaskId });
    if ("error" in retried) throw new Error(retried.error);
    const aRecord = retried.task.pipelineRun!.history.find((h) => h.taskId === aTaskId)!;
    expect(aRecord.stoppedAt).toBeNull();
    expect(aRecord.attemptStartedAt).toBeNumber();
    await waitForStepRunsIdle(aTaskId);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(parentId, 8000);
});

test("R3-5: a Stop on a HELD step's own panel — the release never gets the grace or a reminder", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines, subagents } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
  const previousGrace = __forTest.setReleaseGraceMs(300);
  try {
    const profile = await makeProfile("r3-held-panel");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
    const pipeline = pipelines.insert({ name: uniqueName("r3-held-panel"), graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
    const created = await createTask({ title: "r3 held panel", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);

    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const step = await waitFor(() => {
      const t = tasks.stepsForParent(parentId)[0];
      return t?.column === "running" && t.runId ? t : undefined;
    });
    const helperId = `agent-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: helperId, taskId: step.id, runId: step.runId, parentKind: "subagent", agentType: "Explore",
      description: "helper", spawnDepth: 1, sourcePath: `/tmp/${helperId}.jsonl`, status: "running",
      startedAt: Date.now(), endedAt: null,
    });
    await waitFor(() => (runs.get(step.runId!)?.status === "succeeded" ? true : undefined), 6000);
    await waitFor(() => (tasks.get(parentId)?.pipelineRun?.history[0]?.responseKind === "handoff-missing" ? true : undefined), 6000);

    expect(await cancelRun(step.runId!)).toBe(true); // the step panel's Stop
    await waitForOutcome(parentId, step.id, "cancelled");
    await tick(800); // well past the grace

    const run = tasks.get(parentId)!.pipelineRun!;
    expect(run.status).toBe("cancelled");
    expect(run.stopRequestedAt).toBeNull();
    expect(run.blocked).toEqual([]);
    const record = run.history[0]!;
    expect(record.stoppedAt).toBeNumber();
    expect(record.responseKind).toBe("handoff-missing");
    expect(record.reminder ?? null).toBeNull();
    expect(await reminderEventsOf(step.id)).toEqual([]);
    expect(runs.listForTask(step.id).length).toBe(1);
  } finally {
    __forTest.setReleaseGraceMs(previousGrace);
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("an automatic continuation that starts on a step stopped from its own panel is cancelled — the step stays stopped", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startLinearAZ("r3-auto-cont-step");
  try {
    __forTest.setListenerEnabled(true);
    await tick();
    await stopLiveRunFromPanel(s.stepTaskId);
    await waitForOutcome(s.parentId, s.stepTaskId, "cancelled");

    await tick();
    const auto = await openLiveRun(s.stepTaskId, await handoffReply("should not count"), "notification");
    await waitFor(() => (runs.get(auto.runId)!.status === "cancelled" ? true : undefined));
    await tick(100);

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.status).toBe("cancelled");
    expect(run.history[0]!.outcome).toBe("cancelled");
    expect(run.history[0]!.stoppedAt).toBeNumber();
    expect(tasks.stepsForParent(s.parentId).length).toBe(1);
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("Stop during the release grace, then Claude's automatic continuation: the continuation is cancelled and the run stays stopped", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startOverlapStep("r3-auto-cont-run");
  const previous = __forTest.setReleaseGraceMs(5_000);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const stopped = await cancelPipelineRun(s.parentId);
    if ("error" in stopped) throw new Error(stopped.error);

    await tick();
    const auto = await openLiveRun(s.stepTaskId, null, "notification");
    await waitFor(() => (runs.get(auto.runId)!.status === "cancelled" ? true : undefined));
    await tick(100);
    await expectStoppedCleanly(s);
    expect(tasks.get(s.parentId)!.pipelineRun!.history[0]!.outcome).toBe("cancelled");
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("a Stop queued behind the lock while the release grace fires still stops the step (no 409) — the timer's re-settle then does nothing", async () => {
  const { __forTest, cancelPipelineRun, withPipelineLock } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("r3-timer-claim");
  const previous = __forTest.setReleaseGraceMs(150);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = withPipelineLock(s.parentId, () => gate);
    const stop = cancelPipelineRun(s.parentId); // queued first
    await tick(400); // the grace timer fires; its re-settle queues behind the Stop
    release();
    await held;
    const result = await stop;
    if ("error" in result) throw new Error(result.error);
    await tick(300);
    await expectStoppedCleanly(s);
    expect(tasks.get(s.parentId)!.pipelineRun!.history[0]!.outcome).toBe("cancelled");
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("a handoff whose next is unknown on a step stopped from its own panel gets no reminder", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines, runs } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const profile = await makeProfile("r3-next-unknown");
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:nope` });
  const B = newStep({ name: "B", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const C = newStep({ name: "C", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:done` });
  const pipeline = pipelines.insert({
    name: uniqueName("r3-next-unknown"),
    graph: {
      steps: [A, B, C],
      edges: [{ id: "e1", from: A.id, to: B.id, label: "" }, { id: "e2", from: A.id, to: C.id, label: "" }],
      startStepId: A.id,
    },
    maxSteps: 25,
  });
  const created = await createTask({ title: "r3 next unknown", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);

  __forTest.setListenerEnabled(false);
  try {
    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const stepTask = await waitFor(() => tasks.stepsForParent(parentId)[0]);
    const first = await waitFor(() => {
      const r = runs.listForTask(stepTask.id)[0];
      return r && r.status !== "running" ? r : undefined;
    });
    __forTest.setListenerEnabled(true);
    await tick();
    await stopLiveRunFromPanel(stepTask.id);
    await waitForOutcome(parentId, stepTask.id, "cancelled");

    // The first run's settle arrives late: its handoff names no real step.
    await __forTest.handleRunStatus(stepTask.id, first.id, "succeeded");
    const run = tasks.get(parentId)!.pipelineRun!;
    expect(run.status).toBe("cancelled");
    expect(run.blocked).toEqual([]);
    expect(run.history[0]!.responseKind).toBe("handoff-invalid");
    expect(run.history[0]!.reminder ?? null).toBeNull();
    expect(await reminderEventsOf(stepTask.id)).toEqual([]);
    expect(tasks.stepsForParent(parentId).length).toBe(1);
  } finally {
    __forTest.setListenerEnabled(true);
  }
});

test("Retry on a stopped run that finds nothing to retry keeps the run stopped (the marker is restored)", async () => {
  const { __forTest, cancelPipelineRun, retryPipelineStep } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startOverlapStep("r3-retry-restore");
  const previous = __forTest.setReleaseGraceMs(5_000);
  let live: LiveRun | null = null;
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const stopped = await cancelPipelineRun(s.parentId);
    if ("error" in stopped) throw new Error(stopped.error);
    const stoppedAt = stopped.task.pipelineRun!.stopRequestedAt;

    // The only execution is live again (unobserved), so Retry skips it.
    __forTest.setListenerEnabled(false);
    await tick();
    live = await openLiveRun(s.stepTaskId, null, "notification");
    const retried = await retryPipelineStep(s.parentId);
    expect("error" in retried).toBe(true);
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBe(stoppedAt);
    expect(run.status).toBe("cancelled");
  } finally {
    await live?.finish();
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
});

test("Restart from a stopped run starts fresh: no marker, new history", async () => {
  const { __forTest, cancelPipelineRun, startPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const s = await startLinearAZ("r3-restart");
  const previous = __forTest.setReleaseGraceMs(5_000);
  try {
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const stopped = await cancelPipelineRun(s.parentId);
    if ("error" in stopped) throw new Error(stopped.error);

    const restarted = await startPipelineRun(tasks.get(s.parentId)!, { restart: true });
    if ("error" in restarted) throw new Error(restarted.error);
    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNull();
    expect(run.history.length).toBe(1);
    expect(run.history[0]!.taskId).not.toBe(s.stepTaskId);
    await waitFor(() => (tasks.get(s.parentId)!.pipelineRun!.history[0]!.responseKind ? true : undefined), 6000);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  await waitUntilIdle(s.parentId, 8000);
});

test("a reminder delivered just as the run is stopped: the post-send recheck cancels the reminder turn and stamps nothing", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const s = await startOverlapStep("r3-post-send-stop");
  let reminderRunId: string | null = null;
  try {
    __forTest.setReminderSend(async () => {
      // The reminder turn starts, unobserved by the listener, and the Stop
      // lands before the runner rechecks (its cancel missed the new turn).
      __forTest.setListenerEnabled(false);
      const turn = await openLiveRun(s.stepTaskId, null, "notification");
      reminderRunId = turn.runId;
      const run = tasks.get(s.parentId)!.pipelineRun!;
      tasks.setPipelineRun(s.parentId, { ...run, stopRequestedAt: Date.now(), status: "cancelled" });
      return { delivered: true, runId: turn.runId };
    });
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");

    await waitFor(() => (reminderRunId && runs.get(reminderRunId)?.status === "cancelled" ? true : undefined));
    const record = tasks.get(s.parentId)!.pipelineRun!.history[0]!;
    expect(record.reminder ?? null).toBeNull();
  } finally {
    __forTest.setReminderSend(null);
    __forTest.setListenerEnabled(true);
  }
});

// ---------------------------------------------------------------------------
// Review round 4: a parked card pulled back to `running` is not a user turn;
// automatic fx resumes never revive a stopped run.
// ---------------------------------------------------------------------------

test("R4-1: a held step stopped from its own panel stays stopped when a background agent pulls its card back — no grace, no reminder on release", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines, subagents } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
  const previousGrace = __forTest.setReleaseGraceMs(300);
  try {
    const profile = await makeProfile("r4-held-pullback");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
    const pipeline = pipelines.insert({ name: uniqueName("r4-held-pullback"), graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
    const created = await createTask({ title: "r4 held pullback", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);

    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const step = await waitFor(() => {
      const t = tasks.stepsForParent(parentId)[0];
      return t?.column === "running" && t.runId ? t : undefined;
    });
    const helperId = `agent-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: helperId, taskId: step.id, runId: step.runId, parentKind: "subagent", agentType: "Explore",
      description: "helper", spawnDepth: 1, sourcePath: `/tmp/${helperId}.jsonl`, status: "running",
      startedAt: Date.now(), endedAt: null,
    });
    await waitFor(() => (runs.get(step.runId!)?.status === "succeeded" ? true : undefined), 6000);
    await waitFor(() => (tasks.get(parentId)?.pipelineRun?.history[0]?.responseKind === "handoff-missing" ? true : undefined), 6000);

    expect(await cancelRun(step.runId!)).toBe(true); // the step panel's Stop
    await waitForOutcome(parentId, step.id, "cancelled");

    // The background agent writes again: `pullBackParkedTask` moves the card
    // back to `running` while its current run is still `succeeded`.
    expect(runs.get(step.runId!)!.status).toBe("succeeded");
    tasks.update(step.id, { column: "running" });
    await __forTest.handleColumnChange(step.id, "running", undefined);
    let record = tasks.get(parentId)!.pipelineRun!.history[0]!;
    expect(record.stoppedAt).toBeNumber();
    expect(record.outcome).toBe("cancelled");

    // The hold releases.
    tasks.update(step.id, { column: "review" });
    await __forTest.handleColumnChange(step.id, "review", undefined);
    await tick(800); // well past the grace

    const run = tasks.get(parentId)!.pipelineRun!;
    expect(run.status).toBe("cancelled");
    record = run.history[0]!;
    expect(record.stoppedAt).toBeNumber();
    expect(record.outcome).toBe("cancelled");
    expect(record.reminder ?? null).toBeNull();
    expect(await reminderEventsOf(step.id)).toEqual([]);
    expect(runs.listForTask(step.id).length).toBe(1);
  } finally {
    __forTest.setReleaseGraceMs(previousGrace);
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

test("a held step's Stop records the run current when Stop was pressed, not a continuation adopted while the record waited for the lock", async () => {
  const { createTask, startTask, cancelRun } = await import("./orchestrator.ts");
  const { tasks, runs, pipelines, subagents } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");
  const { withPipelineLock } = await import("./pipeline-runner.ts");

  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
  try {
    const profile = await makeProfile("held-stop-run-id");
    const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing` });
    const pipeline = pipelines.insert({ name: uniqueName("held-stop-run-id"), graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
    const created = await createTask({ title: "held stop run id", prompt: "goal", workdir: freshWorkdir(), isolation: "none", pipelineId: pipeline.id });
    if ("error" in created) throw new Error(created.error);
    const parentId = created.task.id;
    liveParentIds.push(parentId);

    const started = await startTask(parentId);
    if ("error" in started) throw new Error(started.error);
    const step = await waitFor(() => {
      const t = tasks.stepsForParent(parentId)[0];
      return t?.column === "running" && t.runId ? t : undefined;
    });
    const stoppedRunId = step.runId!;
    const helperId = `agent-${randomUUID()}`;
    subagents.insertIfAbsent({
      id: helperId, taskId: step.id, runId: stoppedRunId, parentKind: "subagent", agentType: "Explore",
      description: "helper", spawnDepth: 1, sourcePath: `/tmp/${helperId}.jsonl`, status: "running",
      startedAt: Date.now(), endedAt: null,
    });
    await waitFor(() => (runs.get(stoppedRunId)?.status === "succeeded" ? true : undefined), 6000);
    await waitFor(() => (tasks.get(parentId)?.pipelineRun?.history[0]?.responseKind === "handoff-missing" ? true : undefined), 6000);

    // Hold the per-parent lock so the runner's record of the Stop has to wait.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = withPipelineLock(parentId, () => gate);
    expect(await cancelRun(stoppedRunId)).toBe(true); // the held step's Stop

    // Meanwhile Claude adopts a continuation: a NEW run becomes current.
    const continuationId = randomUUID();
    runs.insert({
      id: continuationId, taskId: step.id, agent: step.agent, status: "running", startedAt: Date.now(),
      endedAt: null, exitCode: null, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
      cursorSessionId: null, geminiSessionId: null, fxSessionId: null, antigravitySessionId: null,
      origin: "continuation",
    });
    tasks.update(step.id, { runId: continuationId });

    release();
    await held;
    const record = await waitFor(() => {
      const r = tasks.get(parentId)?.pipelineRun?.history[0];
      return r?.stoppedAt != null ? r : undefined;
    });
    expect(record.stoppedRunId).toBe(stoppedRunId);
    runs.update(continuationId, { status: "cancelled", endedAt: Date.now(), exitCode: -1 });
  } finally {
    delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  }
});

/** A linear A → Z run whose A waits out its release grace, stopped with the
 *  pipeline's own Stop. */
async function stopDuringReleaseGrace(label: string): Promise<OverlapStep> {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const s = await startLinearAZ(label);
  await tick();
  await insertReleasedSubagent(s);
  __forTest.setListenerEnabled(true);
  await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
  const stopped = await cancelPipelineRun(s.parentId);
  if ("error" in stopped) throw new Error(stopped.error);
  expect(stopped.task.pipelineRun!.stopRequestedAt).toBeNumber();
  return s;
}

test("R4-1b: a whole-run Stop survives a parked card being pulled back to running", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r4-whole-pullback");
    expect(runs.get(tasks.get(s.stepTaskId)!.runId!)!.status).toBe("succeeded");
    tasks.update(s.stepTaskId, { column: "running" });
    await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNumber();
    expect(run.status).toBe("cancelled");
    expect(run.history[0]!.outcome).toBe("cancelled");

    tasks.update(s.stepTaskId, { column: "review" });
    await __forTest.handleColumnChange(s.stepTaskId, "review", undefined);
    await tick(100);
    expect(tasks.get(s.parentId)!.pipelineRun!.stopRequestedAt).toBeNumber();
    expect(tasks.stepsForParent(s.parentId).length).toBe(1);
    expect(await reminderEventsOf(s.stepTaskId)).toEqual([]);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});

test("R4-2: an fx auto-resume run starting on a stopped run is not a user turn — the run stays stopped", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r4-fx-auto-resume");
    const autoRunId = randomUUID();
    runs.insert({
      id: autoRunId, taskId: s.stepTaskId, agent: tasks.get(s.stepTaskId)!.agent, status: "running",
      startedAt: Date.now(), endedAt: null, exitCode: null, tmuxSession: null, claudeSessionId: null,
      codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
      antigravitySessionId: null, origin: "auto-resume",
    });
    tasks.update(s.stepTaskId, { column: "running", runId: autoRunId });
    await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNumber();
    expect(run.status).toBe("cancelled");
    expect(run.history[0]!.outcome).toBe("cancelled");
    runs.update(autoRunId, { status: "cancelled", endedAt: Date.now(), exitCode: -1 });
    tasks.update(s.stepTaskId, { column: "ready" });
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});

/** Inserts a `failed` user-style run on the stopped step and delivers the
 *  `running` column event for it, `current` deciding whether the task still
 *  points at that run. */
async function runningEventForFailedRun(s: OverlapStep, current: boolean): Promise<string> {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");
  const failedRunId = randomUUID();
  runs.insert({
    id: failedRunId, taskId: s.stepTaskId, agent: tasks.get(s.stepTaskId)!.agent, status: "failed",
    startedAt: Date.now() + 1, endedAt: Date.now() + 2, exitCode: 1, tmuxSession: null, claudeSessionId: null,
    codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    antigravitySessionId: null,
  });
  tasks.update(s.stepTaskId, { column: "running", runId: current ? failedRunId : null });
  await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);
  return failedRunId;
}

test("R4-2c: a failed run the stopped step's task no longer points at does not resume the stop", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r4-failed-stale");
    await runningEventForFailedRun(s, false);

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNumber();
    expect(run.status).toBe("cancelled");
    expect(run.history[0]!.outcome).toBe("cancelled");
    tasks.update(s.stepTaskId, { column: "ready" });
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});

test("R4-2d: a failed run that is still the stopped step's current run resumes the stop", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r4-failed-live");
    await runningEventForFailedRun(s, true);

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNull();
    expect(run.status).toBe("running");
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  // The resumed step stays `running` on purpose, so there is no idle state to
  // wait for; the afterEach sweep deletes the pipeline.
});

test("R4-2b: the pipeline's Stop cancels a pending fx auto-resume on any of its steps", async () => {
  const { __forTest, cancelPipelineRun } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await startLinearAZ("r4-fx-timer");
    await tick();
    await insertReleasedSubagent(s);
    __forTest.setListenerEnabled(true);
    await __forTest.handleRunStatus(s.stepTaskId, s.firstRunId, "succeeded");
    const now = Date.now();
    tasks.setFxRecovery(s.stepTaskId, {
      state: "paused", runId: s.firstRunId, pausedAt: now,
      autoResume: { at: now + 60_000, attempt: 1, max: 3, delaySec: 60 }, autoResumeCount: 0,
    });

    const stopped = await cancelPipelineRun(s.parentId);
    if ("error" in stopped) throw new Error(stopped.error);
    const rec = tasks.get(s.stepTaskId)!.fxRecovery!;
    expect(rec.autoResume).toBeNull();
    expect(rec.autoResumeStopped).toBe("cancelled");
    tasks.setFxRecovery(s.stepTaskId, null);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});

test("R4-3: a terminal-typed continuation's opening status line exists before its running column event goes out", async () => {
  const { subscribeGlobal } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  const { CONTINUATION_STATUS_TEXT } = await import("../shared/types.ts");
  const { __forTest } = await import("./pipeline-runner.ts");

  const s = await startLinearAZ("r4-cont-order");
  const seen: (string | undefined)[] = [];
  const unsubscribe = subscribeGlobal((e) => {
    if (e.kind !== "column" || e.taskId !== s.stepTaskId || e.column !== "running" || !e.runId) return;
    // Synchronously, inside the emit: no microtask has run yet.
    seen.push(runs.events(e.runId).find((ev) => ev.stream === "status" && ev.subagentId == null)?.data);
  });
  try {
    const live = await openLiveRun(s.stepTaskId, null, "user");
    expect(seen).toEqual([CONTINUATION_STATUS_TEXT.user]);
    await live.finish();
  } finally {
    unsubscribe();
    __forTest.setListenerEnabled(true);
  }
});

// ---------------------------------------------------------------------------
// Review round 5: a stopped step decides "new turn since the Stop" by run
// identity (`stoppedRunId`), not by whether its current run is still running.
// ---------------------------------------------------------------------------

/** Insert run `status` for step task `s` (origin null — a turn the user
 *  started from the step's panel) and make it the task's current run. */
async function insertUserRun(s: OverlapStep, status: "running" | "failed"): Promise<string> {
  const { tasks, runs } = await import("./db.ts");
  const runId = randomUUID();
  runs.insert({
    id: runId, taskId: s.stepTaskId, agent: tasks.get(s.stepTaskId)!.agent, status,
    startedAt: Date.now(), endedAt: status === "running" ? null : Date.now(),
    exitCode: status === "running" ? null : 1, tmuxSession: null, claudeSessionId: null,
    codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
    antigravitySessionId: null, origin: null,
  });
  tasks.update(s.stepTaskId, { column: "running", runId });
  return runId;
}

test("R5-1: the pipeline's Stop records the run it applied to on each active execution", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r5-stamp");
    const record = tasks.get(s.parentId)!.pipelineRun!.history[0]!;
    expect(record.stoppedRunId).toBe(tasks.get(s.stepTaskId)!.runId);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});

test("R5-2: a user turn that already ended before its running event got the lock still resumes the stopped run", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r5-ended-user-turn");
    // The user's turn started after the Stop and ended (failed) while its
    // `running` event waited behind the per-parent lock.
    const userRunId = await insertUserRun(s, "failed");
    await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);

    let run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNull();
    expect(run.history[0]!.stoppedAt).toBeNull();
    expect(run.history[0]!.stoppedRunId).toBeNull();
    expect(run.history[0]!.outcome).toBeNull();

    // Its settle follows as an ordinary settle of a resumed step.
    tasks.update(s.stepTaskId, { column: "ready" });
    await __forTest.handleColumnChange(s.stepTaskId, "ready", undefined);
    run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.history[0]!.outcome).toBe("failed");
    expect(run.status).toBe("blocked");
    expect(run.blocked.some((b) => b.taskId === s!.stepTaskId && b.kind === "step-failed")).toBe(true);
    expect(tasks.get(s.stepTaskId)!.runId).toBe(userRunId);
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});

test("R5-3: a running event for the run the Stop applied to never resumes the step, even while its row still reads running", async () => {
  const { __forTest } = await import("./pipeline-runner.ts");
  const { tasks, runs } = await import("./db.ts");

  const previous = __forTest.setReleaseGraceMs(5_000);
  let s: OverlapStep | null = null;
  try {
    s = await stopDuringReleaseGrace("r5-stopped-run-row");
    const stoppedRunId = tasks.get(s.stepTaskId)!.runId!;
    const before = runs.get(stoppedRunId)!;
    // The stopped run's row before its kill lands.
    runs.update(stoppedRunId, { status: "running", endedAt: null });
    tasks.update(s.stepTaskId, { column: "running" });
    try {
      await __forTest.handleColumnChange(s.stepTaskId, "running", undefined);
    } finally {
      runs.update(stoppedRunId, { status: before.status, endedAt: before.endedAt });
    }

    const run = tasks.get(s.parentId)!.pipelineRun!;
    expect(run.stopRequestedAt).toBeNumber();
    expect(run.status).toBe("cancelled");
    expect(run.history[0]!.outcome).toBe("cancelled");
    expect(run.history[0]!.stoppedRunId).toBe(stoppedRunId);
    tasks.update(s.stepTaskId, { column: "review" });
  } finally {
    __forTest.setReleaseGraceMs(previous);
    __forTest.setListenerEnabled(true);
  }
  if (s) await waitUntilIdle(s.parentId);
});
