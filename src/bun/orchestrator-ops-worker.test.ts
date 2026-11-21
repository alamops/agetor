/**
 * The orchestrator's named atomic ops (`db-core/ops/orchestrator-ops.ts`)
 * against a REAL database worker thread, the way production runs them: the
 * arguments and results cross the thread as structured clones, and each op is
 * one transaction in the worker. Like db-rpc-worker.test.ts, this file opens
 * its own temp database in the worker and imports neither db.ts nor anything
 * that opens a connection on the main thread.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeRun, makeTask } from "./db-rpc-test-util.ts";
import { createCoreWorker } from "./worker-entry.ts";
import type { Run, Task } from "../shared/types.ts";

const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-orch-ops-worker-data-"));
process.env.AGETOR_DATA_DIR = dataDir;

const savedEnv = {
  AGETOR_DB_MODE: process.env.AGETOR_DB_MODE,
  AGETOR_CORE_WORKER_ENTRY: process.env.AGETOR_CORE_WORKER_ENTRY,
};
process.env.AGETOR_DB_MODE = "worker";
process.env.AGETOR_CORE_WORKER_ENTRY = path.join(import.meta.dir, "core-worker.ts");

type RpcModule = typeof import("./db-rpc.ts");
let rpcm: RpcModule;
let rpc: ReturnType<RpcModule["createDbRpc"]>;
const tmpDir = mkdtempSync(path.join(tmpdir(), "agetor-orch-ops-worker-"));

beforeAll(async () => {
  rpcm = await import("./db-rpc.ts");
  rpc = rpcm.createDbRpc({
    mode: "worker",
    dbPath: path.join(tmpDir, "agetor.sqlite"),
    workerFactory: (p) => createCoreWorker("db", { dbPath: p }),
  });
  await rpc.dbReady();
});

afterAll(async () => {
  await rpc.closeDb({ timeoutMs: 1000 }).catch(() => {});
  rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function insertTask(overrides: Partial<Task> = {}): Promise<Task> {
  const task = makeTask(overrides);
  await rpc.call("tasks", "insert", [task]);
  return task;
}
async function insertRun(taskId: string, overrides: Partial<Run> = {}): Promise<Run> {
  const run = makeRun(taskId, overrides);
  await rpc.call("runs", "insert", [run]);
  return run;
}
const getTask = async (id: string) => (await rpc.call("tasks", "get", [id])) as Task | null;
const getRun = async (id: string) => (await rpc.call("runs", "get", [id])) as Run | null;

describe("orchestrator.setColumn", () => {
  test("returns the column it replaced, read in the same transaction", async () => {
    const task = await insertTask({ column: "review" });
    expect(await rpc.op("orchestrator.setColumn", [task.id, "done", null])).toEqual({ prev: "review", applied: true });
    expect((await getTask(task.id))?.column).toBe("done");
  });

  test("a guard that no longer holds leaves the row alone", async () => {
    const task = await insertTask({ column: "running" });
    const old = await insertRun(task.id, { status: "succeeded" });
    const next = await insertRun(task.id, { status: "running" });
    await rpc.call("tasks", "update", [task.id, { runId: next.id }]);
    // A release decided while `old` was current must not move the card now.
    const result = await rpc.op("orchestrator.setColumn", [task.id, "review", { runId: old.id, columnIn: ["running"] }]);
    expect(result).toEqual({ prev: "running", applied: false });
    expect((await getTask(task.id))?.column).toBe("running");
  });

  test("the hold guard checks the current run's status and the running subagents", async () => {
    const task = await insertTask({ column: "running" });
    const run = await insertRun(task.id, { status: "succeeded" });
    await rpc.call("tasks", "update", [task.id, { runId: run.id }]);
    await rpc.call("subagents", "insertIfAbsent", [{
      id: `sa-${randomUUID()}`, taskId: task.id, runId: run.id, parentKind: "subagent", agentType: null,
      description: null, spawnDepth: 1, sourcePath: "", status: "running", startedAt: Date.now(), endedAt: null,
    }]);
    const guard = { columnIn: ["running" as const], runId: run.id, runStatus: "succeeded" as const, noRunningSubagents: true, notArchived: true };
    expect((await rpc.op("orchestrator.setColumn", [task.id, "review", guard])).applied).toBe(false);
    await rpc.call("subagents", "settleRunningForRun", [run.id, "completed", Date.now()]);
    expect((await rpc.op("orchestrator.setColumn", [task.id, "review", guard])).applied).toBe(true);
    expect((await getTask(task.id))?.column).toBe("review");
  });

  test("an unknown task reports prev null and writes nothing", async () => {
    expect(await rpc.op("orchestrator.setColumn", [randomUUID(), "done", null])).toEqual({ prev: null, applied: false });
  });
});

describe("run writes", () => {
  test("persistRunStart points the task at the new run and inserts it, all or nothing, and returns the prior column", async () => {
    const task = await insertTask({ column: "review" });
    const run = makeRun(task.id);
    const prev = await rpc.op("orchestrator.persistRunStart", [{
      taskId: task.id,
      taskPatch: { column: "running", runId: run.id, branch: "agetor/x", worktreePath: null },
      checkout: undefined,
      run,
    }]);
    expect(prev).toBe("review");
    const after = await getTask(task.id);
    expect(after?.column).toBe("running");
    expect(after?.runId).toBe(run.id);
    expect((await getRun(run.id))?.status).toBe("running");

    // A run id that already exists fails the insert: the task patch rolls back.
    const other = await insertTask({ column: "ready" });
    await expect(rpc.op("orchestrator.persistRunStart", [{
      taskId: other.id,
      taskPatch: { column: "running", runId: run.id },
      run: { ...run, taskId: other.id },
    }])).rejects.toThrow();
    expect((await getTask(other.id))?.column).toBe("ready");
  });

  test("insertRunAndPoint inserts the successor and points the task at it", async () => {
    const task = await insertTask({ column: "blocked" });
    const run = makeRun(task.id, { origin: "continuation" });
    expect(await rpc.op("orchestrator.insertRunAndPoint", [run])).toBe("blocked");
    expect((await getTask(task.id))?.runId).toBe(run.id);
    expect((await getTask(task.id))?.column).toBe("running");
  });

  test("orphanRuns orphans each run with its line and sends only a still-running card to ready", async () => {
    const running = await insertTask({ column: "running" });
    const moved = await insertTask({ column: "review" });
    const a = await insertRun(running.id);
    const b = await insertRun(moved.id);
    await rpc.call("tasks", "update", [running.id, { runId: a.id }]);
    await rpc.call("tasks", "update", [moved.id, { runId: b.id }]);
    const listed = await rpc.op("orchestrator.runningRuns", []);
    expect(listed.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    await rpc.op("orchestrator.orphanRuns", [[{ id: a.id, task_id: running.id, copilot: false }, { id: b.id, task_id: moved.id, copilot: false }], Date.now()]);
    expect((await getRun(a.id))?.status).toBe("orphaned");
    expect((await getRun(b.id))?.status).toBe("orphaned");
    expect((await getTask(running.id))?.column).toBe("ready");
    expect((await getTask(running.id))?.runId).toBeNull();
    expect((await getTask(moved.id))?.column).toBe("review");
    const events = (await rpc.call("runs", "events", [a.id])) as { data: string }[];
    expect(events.map((e) => e.data)).toEqual(["orphaned — agetor restarted while this run was active"]);
  });
});

describe("snapshot and stamp reads", () => {
  test("taskSnapshot reads the task, its harness and its hold in one hop", async () => {
    const task = await insertTask({ column: "running" });
    const run = await insertRun(task.id, { status: "succeeded" });
    await rpc.call("tasks", "update", [task.id, { runId: run.id }]);
    let snap = await rpc.op("orchestrator.taskSnapshot", [task.id]);
    expect(snap.task?.id).toBe(task.id);
    expect(snap.harness?.kind).toBe("claude-code");
    expect(snap.held).toBe(false);
    await rpc.call("subagents", "insertIfAbsent", [{
      id: `sa-${randomUUID()}`, taskId: task.id, runId: run.id, parentKind: "subagent", agentType: null,
      description: null, spawnDepth: 1, sourcePath: "", status: "running", startedAt: Date.now(), endedAt: null,
    }]);
    snap = await rpc.op("orchestrator.taskSnapshot", [task.id]);
    expect(snap.held).toBe(true);
    expect(snap.runningSubagents).toBe(true);
    expect(await rpc.op("orchestrator.taskSnapshot", [randomUUID()])).toEqual({ task: null, harness: null, held: false, runningSubagents: false });
  });

  test("pipelineStamp names a step's parent and its title, and nothing for an ordinary task", async () => {
    const parent = await insertTask({ title: "the pipeline", pipelineId: "pl" });
    const step = await insertTask({ title: "a step", pipelineParentId: parent.id, pipelineStepId: "s1" });
    expect(await rpc.op("orchestrator.pipelineStamp", [step.id, null])).toEqual({ parentId: parent.id, parentTitle: "the pipeline" });
    expect(await rpc.op("orchestrator.pipelineStamp", [parent.id, null])).toBeNull();
  });
});

describe("read-modify-writes in one transaction", () => {
  test("stashBatch skips a text the tray held before, keeps both copies inside one batch, and keeps nothing for an archived task", async () => {
    const task = await insertTask({ backlog: [{ id: "b1", text: "held before", references: [], createdAt: 1 }] });
    expect(await rpc.op("orchestrator.stashBatch", [task.id, ["held before", "new", "new"]])).toBe(2);
    expect((await getTask(task.id))?.backlog.map((b) => b.text)).toEqual(["new", "new", "held before"]);
    const archived = await insertTask({ archivedAt: Date.now() });
    expect(await rpc.op("orchestrator.stashBatch", [archived.id, ["x"]])).toBe(0);
  });

  test("restashText adds once, and skips a gone task", async () => {
    const task = await insertTask();
    expect(await rpc.op("orchestrator.restashText", [task.id, "again"])).toBe("saved");
    expect(await rpc.op("orchestrator.restashText", [task.id, "again"])).toBe("saved");
    expect((await getTask(task.id))?.backlog.map((b) => b.text)).toEqual(["again"]);
    expect(await rpc.op("orchestrator.restashText", [randomUUID(), "x"])).toBe("skipped");
  });

  test("applyPlanChange records an ExitPlanMode plan and resolves it on the same row", async () => {
    const task = await insertTask();
    const run = await insertRun(task.id);
    expect(await rpc.op("orchestrator.applyPlanChange", [task.id, { kind: "exit-plan-mode", toolCallId: "tc-1", runId: run.id, content: "the plan", now: 1 }])).toBe(true);
    let plans = (await getTask(task.id))!.plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe("pending");
    expect(await rpc.op("orchestrator.applyPlanChange", [task.id, { kind: "resolve-claude", toolUseId: "tc-1", resultText: "User has approved your plan.", now: 2 }])).toBe(true);
    plans = (await getTask(task.id))!.plans;
    expect(plans[0]!.status).not.toBe("pending");
    // The same detected plan twice changes nothing the second time.
    expect(await rpc.op("orchestrator.applyPlanChange", [task.id, { kind: "detected", toolCallId: "tc-2", runId: run.id, name: null, content: "p2", now: 3 }])).toBe(true);
    expect(await rpc.op("orchestrator.applyPlanChange", [task.id, { kind: "detected", toolCallId: "tc-2", runId: run.id, name: null, content: "p2", now: 3 }])).toBe(false);
  });

  test("setTodoProgress writes only a changed summary", async () => {
    const task = await insertTask();
    expect(await rpc.op("orchestrator.setTodoProgress", [task.id, { completed: 1, total: 3 }])).toBe(true);
    expect(await rpc.op("orchestrator.setTodoProgress", [task.id, { completed: 1, total: 3 }])).toBe(false);
    expect(await rpc.op("orchestrator.setTodoProgress", [task.id, null])).toBe(true);
  });

  test("fxRecoveryCas writes only while the stored state is the one decided from", async () => {
    const task = await insertTask();
    const paused = { state: "paused", runId: "r1", pausedAt: 1, autoResume: { at: 5, attempt: 1, max: 3, delaySec: 30 }, autoResumeCount: 0 } as unknown as Task["fxRecovery"];
    expect(await rpc.op("orchestrator.fxRecoveryCas", [task.id, "null", paused])).toBe(true);
    // Both flows decide from the state as read back (the shape the callers hold).
    const stored = (await getTask(task.id))!.fxRecovery!;
    const fired = { ...stored, autoResume: null, autoResumeCount: 1 };
    // The firing claims the schedule…
    expect(await rpc.op("orchestrator.fxRecoveryCas", [task.id, JSON.stringify(stored), fired])).toBe(true);
    // …so a Cancel decided from the same old state loses, and the row is the firing's.
    const cancelled = { ...stored, autoResume: null, autoResumeStopped: "cancelled" as const };
    expect(await rpc.op("orchestrator.fxRecoveryCas", [task.id, JSON.stringify(stored), cancelled])).toBe(false);
    expect((await getTask(task.id))?.fxRecovery?.autoResumeCount).toBe(1);
    expect((await getTask(task.id))?.fxRecovery?.autoResumeStopped).toBeUndefined();
  });

  test("removeRepository drops the entry from the task and from every step that has it", async () => {
    const repos = [
      { name: "api", path: "/r/api", branch: "agetor/a", baseRef: null, worktreePath: null },
      { name: "web", path: "/r/web", branch: "agetor/w", baseRef: null, worktreePath: null },
    ];
    const parent = await insertTask({ pipelineId: "pl", issueRepoPath: "/r/web" } as Partial<Task>);
    await rpc.call("tasks", "setRepositories", [parent.id, repos]);
    const step = await insertTask({ pipelineParentId: parent.id, pipelineStepId: "s1" });
    await rpc.call("tasks", "setRepositories", [step.id, repos]);
    await rpc.op("orchestrator.removeRepository", [parent.id, "web", "/r/web"]);
    expect((await getTask(parent.id))?.repositories?.map((r) => r.name)).toEqual(["api"]);
    expect((await getTask(step.id))?.repositories?.map((r) => r.name)).toEqual(["api"]);
  });
});
