import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTestNative } from "./test-native.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-notifications-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from other server-test ports so parallel test runs don't fight.
process.env.AGETOR_API_PORT = "4401";

// Stub electrobun's native bridge before server.ts imports it. Without this
// the test would pop real macOS notifications on every run, and on CI the
// FFI loader would fail outright. Bun's `mock.module` is PROCESS-WIDE, so any
// sibling test running in the same process gets this stub too — exporting
// shims for every common entry on `electrobun/bun` keeps a future test that
// happens to import `BrowserWindow` / `Updater` / `ApplicationMenu` from
// crashing on a missing export.
const recorded: Array<{ title: string; body?: string; subtitle?: string; silent?: boolean }> = [];
mock.module("electrobun/bun", () => ({
  Utils: {
    showNotification: (opts: { title: string; body?: string; subtitle?: string; silent?: boolean }) => {
      recorded.push(opts);
    },
    openPath: () => true,
    openFileDialog: async () => [],
  },
  BrowserWindow: class { /* unused in this test */ },
  ApplicationMenu: { setApplicationMenu: () => { /* noop */ } },
  Updater: { /* noop */ },
}));

let server: { stop: () => void; port: number };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer({
    native: makeTestNative({ showNotification: (o) => { recorded.push(o); } }),
  }) as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4401${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("POST /notifications without token returns 401", async () => {
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "hi" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(401);
});

test("POST /notifications without title returns 400", async () => {
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ body: "no title" }),
    headers: auth(),
  });
  expect(res.status).toBe(400);
});

test("POST /notifications happy path returns ok and invokes showNotification", async () => {
  recorded.length = 0;
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Done", body: "task succeeded", silent: true }),
    headers: auth(),
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toEqual({ ok: true });
  expect(recorded.length).toBe(1);
  expect(recorded[0]).toMatchObject({ title: "Done", body: "task succeeded", silent: true });
});

test("POST /notifications truncates oversized strings", async () => {
  recorded.length = 0;
  const big = "x".repeat(2000);
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: big, body: big }),
    headers: auth(),
  });
  expect(res.status).toBe(200);
  expect(recorded[0]!.title.length).toBe(256);
  expect(recorded[0]!.body!.length).toBe(256);
});

test("GET /events route is auth-gated", async () => {
  const res = await fetch(url("/events"));
  expect(res.status).toBe(401);
});

test("subscribeGlobal receives events emitted via emitGlobal (drives the /events SSE route)", async () => {
  // The route handler in src/bun/server.ts forwards `subscribeGlobal` events
  // to the SSE wire untouched — same JSON-stringify pattern as the existing
  // /runs/:id/events and /tasks/:id/events routes. Verifying the in-process
  // subscriber pipeline exercises everything except the (trivial) frame
  // serialization, matching the convention in task-events.test.ts.
  const { subscribeGlobal, __emitGlobalForTest } = await import("./orchestrator.ts");
  const received: Array<{ kind: string }> = [];
  const unsub = subscribeGlobal((e) => received.push(e));
  __emitGlobalForTest({
    kind: "run-status",
    taskId: "sse-route-test",
    runId: "r1",
    status: "succeeded",
    ts: Date.now(),
  });
  unsub();
  expect(received.length).toBe(1);
  expect(received[0]!.kind).toBe("run-status");
});
