import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { RunEvent } from "../shared/types.ts";
import { FX_USAGE_STATUS_PREFIX, PERMISSION_MODE_STATUS_PREFIX } from "../shared/types.ts";

/**
 * `formatEvent`/`shouldSkipEvent` (in commands/logs.ts) aren't exported —
 * only `cmdLogs` is. Rather than exercise the SSE-follow path (which would
 * need to mock `../sse.ts` the way Dashboard.test.tsx does), this suite
 * drives `cmdLogs`'s `--rebuild` branch, which calls
 * `client.rebuildEvents(...)` once and formats the result synchronously —
 * no SSE involved, so only `./context.ts` (for `getClient`) and `./output.ts`
 * (to capture `out()`) need mocking.
 *
 * Both mocked modules are snapshotted before mocking and restored in
 * `afterAll` — `mock.module` overwrites the module record in place (Bun's
 * documented behavior for already-loaded modules), and other test files in
 * the same `bun test` process import these same modules.
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

const { cmdLogs } = await import("./commands/logs.ts");

function makeClient(events: RunEvent[]): AgetorClient {
  return {
    listTasks: async () => [{ id: "t1", title: "T" }],
    getRuns: async () => [{ id: "run1" }],
    rebuildEvents: async () => ({ events }),
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdLogs>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdLogs>[1];

test("logs --rebuild: an fx_permission interaction gets the fx-specific line", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "interaction",
    data: JSON.stringify({ kind: "fx_permission" }), ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("! fx is requesting permission — agetor answer t1");
});

test("logs --rebuild: a non-fx interaction gets the generic '(kind)' line", async () => {
  outputs.length = 0;
  const e: RunEvent = {
    runId: "run1", taskId: "t1", stream: "interaction",
    data: JSON.stringify({ kind: "ask_questions" }), ts: 1,
  };
  currentClient = makeClient([e]);
  await cmdLogs(["t1", "--rebuild"], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("! needs answer (ask_questions) — agetor answer t1");
});

test("logs --rebuild: internal-only status sentinels (fx-usage, permission-mode) are suppressed", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    { runId: "run1", taskId: "t1", stream: "status", data: `${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`, ts: 1 },
    { runId: "run1", taskId: "t1", stream: "status", data: `${PERMISSION_MODE_STATUS_PREFIX}auto`, ts: 2 },
    { runId: "run1", taskId: "t1", stream: "status", data: "plain status text", ts: 3 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], flags);
  // Only the plain status line survives the human-readable render.
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("plain status text");
  expect(outputs.join("\n")).not.toContain(FX_USAGE_STATUS_PREFIX);
  expect(outputs.join("\n")).not.toContain(PERMISSION_MODE_STATUS_PREFIX);
});

test("logs --rebuild --json: sentinel status events are still emitted raw for programmatic consumers", async () => {
  outputs.length = 0;
  const events: RunEvent[] = [
    { runId: "run1", taskId: "t1", stream: "status", data: `${FX_USAGE_STATUS_PREFIX}{"used":1,"size":2}`, ts: 1 },
  ];
  currentClient = makeClient(events);
  await cmdLogs(["t1", "--rebuild"], jsonFlags);
  expect(outputs).toHaveLength(1);
  expect(JSON.parse(outputs[0]!)).toEqual(events[0]);
});
