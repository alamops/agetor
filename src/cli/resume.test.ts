import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { Task } from "../shared/types.ts";

/**
 * `cmdResume` (commands/resume.ts) reaches for a client via `getClient(flags)`
 * and resolves its task-id argument via `resolveTask` — both real, undoctored
 * imports here, exercised against a fake `AgetorClient` — following the same
 * mocking idiom `files.test.ts`/`logs.test.ts` established: mock `./context.ts`
 * (for `getClient`) and `./output.ts` (to capture `out()`), snapshot both
 * before mocking and restore in `afterAll` since `mock.module` overwrites the
 * module record in place and other test files in the same `bun test` process
 * import these same modules.
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
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdResume } = await import("./commands/resume.ts");

function task(id: string): Task {
  return {
    id, title: "T", column: "ready", runId: null,
    pendingInteractionCount: 0, archivedAt: null, hasOpenableRun: false,
  } as unknown as Task;
}

function makeClient(
  tasks: Task[],
  resumeFxRecovery: AgetorClient["resumeFxRecovery"],
): AgetorClient {
  return {
    listTasks: async () => tasks,
    resumeFxRecovery,
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdResume>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdResume>[1];

const TASK_ID = "abcdefgh12345678";

test("resume: missing task-id argument throws the usage error", async () => {
  outputs.length = 0;
  await expect(cmdResume([], flags)).rejects.toThrow(/usage: agetor resume/);
});

test("resume: happy path resolves the task ref, calls resumeFxRecovery with the resolved id, and prints the confirmation line", async () => {
  outputs.length = 0;
  const seenIds: string[] = [];
  currentClient = makeClient([task(TASK_ID)], async (id) => {
    seenIds.push(id);
    return { ok: true, runId: "run12345678" };
  });

  // A unique short-id prefix, not the full id — proves `resolveTask` (not a
  // raw pass-through of the CLI argument) is what feeds `resumeFxRecovery`.
  await cmdResume(["abcdefgh"], flags);

  expect(seenIds).toEqual([TASK_ID]);
  expect(outputs).toEqual([
    `▸ resuming paused fx response for ${TASK_ID.slice(0, 8)} (run ${"run12345678".slice(0, 8)})`,
  ]);
});

test("resume --json: prints the raw response JSON instead of the human-readable line", async () => {
  outputs.length = 0;
  const res = { ok: true as const, runId: "run12345678" };
  currentClient = makeClient([task(TASK_ID)], async () => res);

  await cmdResume([TASK_ID], jsonFlags);

  expect(outputs).toEqual([JSON.stringify(res)]);
});

test("resume: a client rejection (e.g. no paused fx response to resume) propagates unchanged", async () => {
  outputs.length = 0;
  currentClient = makeClient([task(TASK_ID)], async () => {
    throw new Error("no paused fx response to resume");
  });

  await expect(cmdResume([TASK_ID], flags)).rejects.toThrow("no paused fx response to resume");
  // Nothing printed on the way to the rejection.
  expect(outputs).toEqual([]);
});

test("resume: an unresolvable task-id ref throws resolveTask's friendly error, never reaching resumeFxRecovery", async () => {
  outputs.length = 0;
  let called = false;
  currentClient = makeClient([task(TASK_ID)], async () => {
    called = true;
    return { ok: true, runId: "run12345678" };
  });

  await expect(cmdResume(["nope"], flags)).rejects.toThrow(/no task matches/);
  expect(called).toBe(false);
});
