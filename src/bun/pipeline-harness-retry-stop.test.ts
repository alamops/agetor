// A pipeline step waiting on a harness-stack all-exhausted retry has no live
// run, but work is still scheduled. The pipeline Stop must find it (not 409)
// and cancel the timer; otherwise the retry fires after the user asked for
// silence. The successor run's own `harness-swap` origin must never read as a
// user turn that clears the stop.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineRunState, Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-stack-stop-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Restored in afterAll: `bun test` runs every file in one process (S25).
const ENV_KEYS = ["AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let db: typeof import("./db.ts");
let stacks: typeof import("./harness-stacks.ts");
let failover: typeof import("./harness-failover.ts");
let runner: typeof import("./pipeline-runner.ts");
let restore: () => void;

beforeAll(async () => {
  db = await import("./db.ts");
  stacks = await import("./harness-stacks.ts");
  failover = await import("./harness-failover.ts");
  runner = await import("./pipeline-runner.ts");
  restore = (await import("./test-harness-state.ts")).snapshotHarnessState();
});

afterAll(async () => {
  failover.stopAllAutoRetryTimers();
  restore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

function baseTask(partial: Partial<Task> & Pick<Task, "id" | "title" | "agent" | "workdir">): Task {
  return {
    prompt: "goal",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: "sonnet-4.6",
    effort: "high",
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "blocked",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    ...partial,
  } as Task;
}

function account(label: string): string {
  const id = `pstack-${label}-${randomUUID().slice(0, 8)}`;
  const home = path.join(DATA_DIR, "harnesses", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "{}");
  db.harnesses.insert({ id, kind: "claude-code", label: id, home, env: {} } as never);
  return id;
}

describe("pipeline Stop and a pending harness-stack retry", () => {
  test("cancels the armed retry instead of 409ing, and the run reads cancelled", async () => {
    const a = account("a");
    const b = account("b");
    const stack = stacks.harnessStacks.create({ label: "pipeline-retry", kind: "claude-code", members: [a, b] });

    const pipelineId = randomUUID();
    const parentId = randomUUID();
    const stepId = randomUUID();
    const now = Date.now();
    const parent = db.tasks.insert(
      baseTask({
        id: parentId,
        title: "parent",
        agent: a,
        workdir: path.join(DATA_DIR, "work", "parent"),
        column: "running",
        pipelineId,
      } as never),
    );
    db.tasks.insert(
      baseTask({
        id: stepId,
        title: "step",
        agent: a,
        workdir: path.join(DATA_DIR, "work", "step"),
        pipelineParentId: parentId,
        pipelineStepId: "step-1",
      } as never),
    );
    const run: PipelineRunState = {
      pipelineId,
      pipelineName: "parent",
      snapshot: null,
      status: "running",
      active: [{ stepId: "step-1", taskId: stepId, seq: 1 }],
      joins: {},
      blocked: [],
      history: [
        {
          seq: 1,
          stepId: "step-1",
          taskId: stepId,
          startedAt: now,
          endedAt: null,
          outcome: null,
          handoff: null,
          nextStepIds: [],
        },
      ],
      humanSteps: [],
      seqCounter: 1,
      stepCount: 1,
      startedAt: now,
      endedAt: null,
      stopRequestedAt: null,
    };
    db.tasks.setPipelineRun(parent.id, run);

    db.tasks.setHarnessState(stepId, {
      stackId: stack.id,
      position: 0,
      count: 2,
      tried: [a],
      pendingSwap: null,
      allExhausted: {
        at: now,
        attempts: 1,
        max: 3,
        nextAttemptAt: now + 60_000,
        earliestResetAtMs: null,
        reason: "quota",
      },
      lastMove: null,
    });
    failover.armAutoRetry(stepId, now + 60_000);
    expect(runner).toBeTruthy();

    const result = await runner.cancelPipelineRun(parentId);
    expect("error" in result).toBe(false);

    // The retry schedule and its exhausted state are gone; nothing fires.
    expect(db.tasks.get(stepId)!.harnessState!.allExhausted).toBeNull();
    const stopped = db.tasks.get(parentId)!.pipelineRun!;
    expect(stopped.stopRequestedAt).toBeNumber();
    expect(stopped.status).toBe("cancelled");
    expect(stopped.history[0]!.outcome).toBe("cancelled");

    stacks.harnessStacks.delete(stack.id);
  });

  test("a harness-swap successor's running event does not resume a stopped step", async () => {
    const a = account("swap-a");
    const b = account("swap-b");
    const stack = stacks.harnessStacks.create({ label: "pipeline-stop-swap", kind: "claude-code", members: [a, b] });

    const pipelineId = randomUUID();
    const parentId = randomUUID();
    const stepId = randomUUID();
    const oldRunId = randomUUID();
    const newRunId = randomUUID();
    const now = Date.now();
    db.tasks.insert(
      baseTask({
        id: parentId,
        title: "parent",
        agent: a,
        workdir: path.join(DATA_DIR, "work", "parent"),
        column: "running",
        pipelineId,
      } as never),
    );
    db.tasks.insert(
      baseTask({
        id: stepId,
        title: "step",
        agent: b,
        workdir: path.join(DATA_DIR, "work", "step"),
        column: "running",
        runId: newRunId,
        pipelineParentId: parentId,
        pipelineStepId: "step-1",
      } as never),
    );
    db.runs.insert({
      id: newRunId,
      taskId: stepId,
      agent: b,
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
      antigravitySessionId: null,
      origin: "harness-swap",
    } as never);
    // The pipeline was stopped after `oldRunId`; the swap's successor is a new
    // run, but it is the SAME execution continuing — not the user resuming.
    db.tasks.setPipelineRun(parentId, {
      pipelineId,
      pipelineName: "parent",
      snapshot: null,
      status: "cancelled",
      active: [{ stepId: "step-1", taskId: stepId, seq: 1 }],
      joins: {},
      blocked: [],
      history: [
        {
          seq: 1,
          stepId: "step-1",
          taskId: stepId,
          startedAt: now,
          endedAt: null,
          outcome: null,
          handoff: null,
          nextStepIds: [],
          stoppedAt: now,
          stoppedRunId: oldRunId,
        },
      ],
      humanSteps: [],
      seqCounter: 1,
      stepCount: 1,
      startedAt: now,
      endedAt: now,
      stopRequestedAt: now,
    });

    // Awaited directly (not a published event plus a sleep): the assertions
    // below then read the handler's finished decision, so a regression that
    // resumed the step would fail them instead of racing the sleep (S26).
    await runner.__forTest.handleColumnChange(stepId, "running", undefined);

    const after = db.tasks.get(parentId)!.pipelineRun!;
    expect(after.stopRequestedAt).toBe(now);
    expect(after.status).toBe("cancelled");
    expect(after.history[0]!.outcome).toBeNull();
    expect(after.history[0]!.stoppedRunId).toBe(oldRunId);
    stacks.harnessStacks.delete(stack.id);
  });

  test("a Stop on a step's own panel during the swap window settles the step cancelled (Q5)", async () => {
    const FAKE_CLAUDE_LIMIT_PROMPT_MARKER = "__agetor_fake_claude_limit__";
    const orch = await import("./orchestrator.ts");
    const a = account("q5-a");
    const b = account("q5-b");
    const stack = stacks.harnessStacks.create({ label: "pipeline-q5", kind: "claude-code", members: [a, b] });
    const pipelineId = randomUUID();
    const parentId = randomUUID();
    const stepId = randomUUID();
    const now = Date.now();
    const stepDir = path.join(DATA_DIR, "work", `q5-${stepId}`);
    mkdirSync(stepDir, { recursive: true });
    db.tasks.insert(baseTask({ id: parentId, title: "parent", agent: a, workdir: stepDir, column: "running", pipelineId } as never));
    db.tasks.insert(
      baseTask({
        id: stepId,
        title: "step",
        agent: a,
        workdir: stepDir,
        column: "ready",
        prompt: `step work ${FAKE_CLAUDE_LIMIT_PROMPT_MARKER}`,
        pipelineParentId: parentId,
        pipelineStepId: "step-1",
      } as never),
    );
    db.tasks.setPipelineRun(parentId, {
      pipelineId,
      pipelineName: "parent",
      // A settle decides only against a captured graph.
      snapshot: {
        graph: {
          steps: [{
            id: "step-1", name: "step", instructions: "", agentProfileId: null,
            position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any",
          }],
          edges: [],
          startStepId: "step-1",
        } as never,
        maxSteps: 10,
        profiles: {},
        capturedAt: now,
      },
      status: "running",
      active: [{ stepId: "step-1", taskId: stepId, seq: 1 }],
      joins: {},
      blocked: [],
      history: [{ seq: 1, stepId: "step-1", taskId: stepId, startedAt: now, endedAt: null, outcome: null, handoff: null, nextStepIds: [] }],
      humanSteps: [],
      seqCounter: 1,
      stepCount: 1,
      startedAt: now,
      endedAt: null,
      stopRequestedAt: null,
    });
    runner.initPipelineRunner();

    let stopped = 0;
    const prev = orch.__setHarnessSwapSettleHookForTest(async (hooked, runId, phase) => {
      if (hooked !== stepId || phase !== "settle") return;
      orch.__setHarnessSwapSettleHookForTest(null);
      // The step's own panel Stop: no active handle, no successor yet.
      if (await orch.cancelRun(runId)) stopped++;
    });
    try {
      expect(await orch.startTask(stepId)).toHaveProperty("runId");
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && db.tasks.get(parentId)!.pipelineRun!.history[0]!.outcome == null) {
        await Bun.sleep(20);
      }
    } finally {
      orch.__setHarnessSwapSettleHookForTest(prev);
    }
    expect(stopped).toBe(1);
    const runs = db.runs.listForTask(stepId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("cancelled");
    // A user Stop, not a step failure.
    expect(db.tasks.get(parentId)!.pipelineRun!.history[0]!.outcome).toBe("cancelled");
    stacks.harnessStacks.clearLimitState(a);
    stacks.harnessStacks.delete(stack.id);
  }, 20_000);
});
