import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { Task } from "../shared/types.ts";
import { makeTask } from "./test-fixtures.ts";

/**
 * `cmdCancel`/`cmdStart` (commands/lifecycle.ts) reach for a client via
 * `getClient(flags)` and resolve their task-id argument through the real
 * `resolveTask` — same mocking idiom `resume.test.ts`/`show.test.ts` use:
 * mock `./context.ts` (for `getClient`) and `./output.ts` (to capture
 * `out()`), snapshot both before mocking and restore in `afterAll`.
 *
 * Pins the pipeline-parent routing (`docs/plans/pipelines.md` §3 T7,
 * review finding M-CLI2): a pipeline (parent) task never carries its own
 * `runId`, so `agetor cancel <parent>` must go through `cancelPipeline`
 * (never `cancelRun`), and `agetor start <parent>` on an active run must
 * point at `agetor pipeline retry|cancel`, not the generic cancel/answer/
 * send trio.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  c: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: () => {},
  printJson: (data: unknown) => {
    outputs.push(JSON.stringify(data));
  },
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdCancel, cmdStart } = await import("./commands/lifecycle.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdCancel>[1];

function makeClient(tasks: Task[]) {
  const cancelRunCalls: string[] = [];
  const cancelPipelineCalls: string[] = [];
  const startTaskCalls: string[] = [];
  const client = {
    listTasks: async () => tasks,
    cancelRun: async (runId: string) => {
      cancelRunCalls.push(runId);
      return { ok: true };
    },
    cancelPipeline: async (taskId: string) => {
      cancelPipelineCalls.push(taskId);
      return tasks[0]!;
    },
    startTask: async (taskId: string) => {
      startTaskCalls.push(taskId);
      return { runId: "run-1" };
    },
  } as unknown as AgetorClient;
  return { client, cancelRunCalls, cancelPipelineCalls, startTaskCalls };
}

beforeEach(() => {
  outputs.length = 0;
});

// ── cmdCancel ────────────────────────────────────────────────────────────

test("cmdCancel: a pipeline (parent) task routes to cancelPipeline, never cancelRun", async () => {
  const parent = makeTask({ id: "parent-1", pipelineId: "pipe-1", column: "running", runId: null });
  const { client, cancelRunCalls, cancelPipelineCalls } = makeClient([parent]);
  currentClient = client;

  await cmdCancel(["parent-1"], flags);

  expect(cancelPipelineCalls).toEqual(["parent-1"]);
  expect(cancelRunCalls).toEqual([]);
  expect(outputs[0]).toContain("cancel requested for parent-1");
});

test("cmdCancel: a pipeline step task (pipelineParentId set) cancels its own run via cancelRun", async () => {
  const step = makeTask({
    id: "step-task-1",
    pipelineParentId: "parent-1",
    pipelineStepId: "s1",
    column: "running",
    runId: "run-step-1",
  });
  const { client, cancelRunCalls, cancelPipelineCalls } = makeClient([step]);
  currentClient = client;

  await cmdCancel(["step-task-1"], flags);

  expect(cancelRunCalls).toEqual(["run-step-1"]);
  expect(cancelPipelineCalls).toEqual([]);
});

test("cmdCancel: a plain running task cancels via cancelRun", async () => {
  const t = makeTask({ id: "t1", column: "running", runId: "run-9" });
  const { client, cancelRunCalls, cancelPipelineCalls } = makeClient([t]);
  currentClient = client;

  await cmdCancel(["t1"], flags);

  expect(cancelRunCalls).toEqual(["run-9"]);
  expect(cancelPipelineCalls).toEqual([]);
});

test("cmdCancel: a plain task that isn't running throws 'task is not running'", async () => {
  const { client } = makeClient([makeTask({ id: "t1", column: "ready", runId: null })]);
  currentClient = client;
  await expect(cmdCancel(["t1"], flags)).rejects.toThrow(/task is not running/);
});

// ── cmdStart ─────────────────────────────────────────────────────────────

test("cmdStart: a running pipeline (parent) task's error points at `agetor pipeline cancel|retry`, not cancel/answer/send", async () => {
  const parent = makeTask({ id: "parent-1", pipelineId: "pipe-1", column: "running", runId: null });
  const { client, startTaskCalls } = makeClient([parent]);
  currentClient = client;

  await expect(cmdStart(["parent-1"], flags)).rejects.toThrow(
    /pipeline is already running — stop it with 'agetor pipeline cancel parent-1', or retry .* 'agetor pipeline retry parent-1'/,
  );
  expect(startTaskCalls).toEqual([]);
});

test("cmdStart: a blocked pipeline (parent) task reads 'already blocked' and points at the same two subcommands", async () => {
  const parent = makeTask({ id: "parent-1", pipelineId: "pipe-1", column: "blocked", runId: null });
  const { client } = makeClient([parent]);
  currentClient = client;

  await expect(cmdStart(["parent-1"], flags)).rejects.toThrow(/pipeline is already blocked/);
  await expect(cmdStart(["parent-1"], flags)).rejects.toThrow(/agetor pipeline retry parent-1/);
});

test("cmdStart: a not-yet-run pipeline (parent) task starts normally via startTask", async () => {
  const parent = makeTask({ id: "parent-1", pipelineId: "pipe-1", column: "ready", runId: null });
  const { client, startTaskCalls } = makeClient([parent]);
  currentClient = client;

  await cmdStart(["parent-1"], flags);

  expect(startTaskCalls).toEqual(["parent-1"]);
  expect(outputs[0]).toContain("started parent-1");
});

test("cmdStart: a plain running task keeps the generic cancel/answer/send error", async () => {
  const { client } = makeClient([makeTask({ id: "t1", column: "running", runId: "run-9" })]);
  currentClient = client;

  await expect(cmdStart(["t1"], flags)).rejects.toThrow(/agetor cancel t1.*agetor answer t1.*agetor send t1/);
});
