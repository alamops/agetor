import { test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// docs/plans/formatted-handoff.md U2: the runner reads a step's final message
// through the shared code-aware handoff locator (a `<handoff>` mentioned in
// inline code never counts; a block wrapped wholly in a fence is missing) and
// writes handoff files whose names the shared builder/parser agree on.
//
// db.ts captures AGETOR_DATA_DIR at first import — set it (and the fake-driver
// env) before any dynamic import touches db.ts/orchestrator.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-handoff-locator-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

// Without the runner subscribed, step settles never propagate and every run
// hangs in `running` (CLAUDE.md item 19).
beforeAll(async () => {
  const { initPipelineRunner } = await import("./pipeline-runner.ts");
  initPipelineRunner();
});

let liveParentIds: string[] = [];

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 8000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Wait until the pipeline is idle: the run isn't `running` and no step task
 *  is — a fake-driver timer left ticking could fire during a later file. */
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
  return `handoff-locator-${label}-${randomUUID()}`;
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

/** Create + start a pipeline of the given `[suffix, …]` steps chained in order,
 *  and wait for the run to reach `done`. */
async function runChain(label: string, suffixes: string[]) {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, pipelines } = await import("./db.ts");
  const { newStep } = await import("../shared/pipeline.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER } = await import("./agents.ts");

  const profile = await makeProfile(label);
  const steps = suffixes.map((suffix, i) =>
    newStep({
      name: `Step${i + 1}`,
      agentProfileId: profile.id,
      instructions: `Do it. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}`,
    }),
  );
  const edges = steps.slice(1).map((s, i) => ({ id: `e${i + 1}`, from: steps[i]!.id, to: s.id, label: "" }));
  const pipeline = pipelines.insert({
    name: uniqueName(`${label}-pipeline`),
    graph: { steps, edges, startStepId: steps[0]!.id },
    maxSteps: 25,
  });
  const created = await createTask({
    title: `${label} run`,
    prompt: "goal",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-handoff-locator-wd-")),
    isolation: "none",
    pipelineId: pipeline.id,
  });
  if ("error" in created) throw new Error(created.error);
  const parentId = created.task.id;
  liveParentIds.push(parentId);
  const started = await startTask(parentId);
  if ("error" in started) throw new Error(started.error);

  // Poll the parent's pipelineRun, not step columns: a column write can land
  // before the runner has processed the settle.
  const done = await waitFor(() => {
    const t = tasks.get(parentId);
    return t?.pipelineRun?.status === "done" ? t : undefined;
  });
  return { parentId, steps, run: done.pipelineRun! };
}

async function reminderEventsFor(parentId: string): Promise<number> {
  const { tasks, runs } = await import("./db.ts");
  const { isHandoffReminderMarker } = await import("../shared/pipeline.ts");
  return tasks
    .stepsForParent(parentId)
    .flatMap((s) => runs.listForTask(s.id))
    .flatMap((r) => runs.events(r.id))
    .filter((e) => e.stream === "user" && isHandoffReminderMarker(e.data.split("\n", 1)[0] ?? "")).length;
}

test(":mention — a `<handoff>` quoted in inline code before the real block advances with no reminder", async () => {
  const { parentId, steps, run } = await runChain("mention", ["mention"]);

  expect(run.blocked.length).toBe(0);
  const record = run.history.find((h) => h.stepId === steps[0]!.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder ?? null).toBeNull();
  expect(await reminderEventsFor(parentId)).toBe(0);

  await waitUntilIdle(parentId);
});

test(":fenced-then-done — a block wrapped in a fence is handoff-missing: one reminder, then done", async () => {
  const { parentId, steps, run } = await runChain("fenced", ["fenced-then-done"]);

  expect(run.blocked.length).toBe(0);
  const record = run.history.find((h) => h.stepId === steps[0]!.id);
  expect(record?.outcome).toBe("succeeded");
  expect(record?.responseKind).toBe("handoff");
  expect(record?.reminder?.reason).toBe("handoff-missing");
  expect(await reminderEventsFor(parentId)).toBe(1);

  await waitUntilIdle(parentId);
});

test("handoff files written for the next step have names parseHandoffFilePath accepts", async () => {
  const { parseHandoffFilePath } = await import("../shared/pipeline.ts");
  const { pipelineRunsDir } = await import("./pipeline-runner.ts");
  const { parentId, run } = await runChain("filenames", ["mention", "done"]);

  expect(run.history.length).toBe(2);
  const dir = pipelineRunsDir(parentId);
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const parsed = parseHandoffFilePath(path.join(dir, f), parentId);
    expect(parsed).not.toBeNull();
    // Step 1's handoff was handed to step 2 (seq 2) as "from 1".
    expect(parsed).toEqual({ generation: (run.startedAt ?? 0).toString(36), seq: 2, fromSeq: 1 });
  }

  await waitUntilIdle(parentId);
});

test("the scan mode follows the run's harness: a fence split across two delta events hides the block only for a message-level harness", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  const { __forTest } = await import("./pipeline-runner.ts");
  const { HANDOFF_TAG } = await import("../shared/pipeline.ts");

  const created = await createTask({
    title: "scan-mode",
    prompt: "goal",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-handoff-locator-wd-")),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;

  // A delta-streaming harness cuts one message at arbitrary points: here the
  // closing fence of an example lands at the start of the next event, so a
  // per-event code-aware scan would read it as a NEW fence opener and hide
  // the real block after it.
  const handoff = JSON.stringify({
    schemaVersion: 1,
    purpose: "p",
    summary: "s",
    reason: "r",
    next: null,
    artifacts: [],
    openQuestions: [],
  });
  const segments = ["Example:\n```\nnpm test\n", `\`\`\`\nDone.\n<${HANDOFF_TAG}>\n${handoff}\n</${HANDOFF_TAG}>`];

  const kindFor = (agent: string) => {
    const runId = randomUUID();
    const now = Date.now();
    runs.insert({
      id: runId,
      taskId,
      agent,
      status: "succeeded",
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });
    for (const s of segments) runs.appendEvent(runId, "assistant", s);
    return __forTest.parsedRunResponse(runId).kind;
  };

  try {
    // gemini/antigravity: legacy scan, no Markdown state per event — advances.
    expect(kindFor("gemini")).toBe("handoff");
    expect(kindFor("antigravity")).toBe("handoff");
    // A message-level harness reads each event as Markdown on its own (the
    // documented trade-off): the second event's leading ``` opens a fence.
    expect(kindFor("claude-code")).toBe("handoff-missing");
  } finally {
    const { deleteTask } = await import("./orchestrator.ts");
    await deleteTask(taskId).catch(() => {});
  }
});
