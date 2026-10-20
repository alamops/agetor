import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestNative } from "./test-native.ts";
import type { TaskNotificationRemoval } from "../shared/os-notification.ts";

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
const recorded: Array<{ title: string; body?: string; subtitle?: string; silent?: boolean; taskId?: string }> = [];
mock.module("electrobun/bun", () => ({
  Utils: {
    showNotification: (opts: { title: string; body?: string; subtitle?: string; silent?: boolean; taskId?: string }) => {
      recorded.push(opts);
    },
    openPath: () => true,
    openFileDialog: async () => [],
  },
  BrowserWindow: class { /* unused in this test */ },
  ApplicationMenu: { setApplicationMenu: () => { /* noop */ } },
  Updater: { /* noop */ },
}));

const removals: TaskNotificationRemoval[] = [];

let server: { stop: () => void; port: number };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer({
    native: makeTestNative({
      showNotification: (o) => { recorded.push(o); },
      removeTaskNotification: (r) => { removals.push(r); },
    }),
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

test("POST /notifications with taskId threads it through to showNotification", async () => {
  recorded.length = 0;
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Done", taskId: "task-123" }),
    headers: auth(),
  });
  expect(res.status).toBe(200);
  expect(recorded.length).toBe(1);
  expect(recorded[0]!.taskId).toBe("task-123");
});

test("POST /notifications with an over-length taskId (>512 chars) is treated as absent", async () => {
  recorded.length = 0;
  const bigId = "x".repeat(513);
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Done", taskId: bigId }),
    headers: auth(),
  });
  expect(res.status).toBe(200);
  expect(recorded.length).toBe(1);
  expect(recorded[0]!.taskId).toBeUndefined();
});

test("POST /notifications with no taskId leaves it undefined", async () => {
  recorded.length = 0;
  const res = await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Done" }),
    headers: auth(),
  });
  expect(res.status).toBe(200);
  expect(recorded.length).toBe(1);
  expect(recorded[0]!.taskId).toBeUndefined();
});

test("POST /notifications threads a valid kind and drops an invalid one", async () => {
  recorded.length = 0;
  await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Waiting", taskId: "task-k", kind: "waiting" }),
    headers: auth(),
  });
  await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Odd", taskId: "task-k", kind: "not-a-kind" }),
    headers: auth(),
  });
  await fetch(url("/notifications"), {
    method: "POST",
    body: JSON.stringify({ title: "Odd", taskId: "task-k", kind: 7 }),
    headers: auth(),
  });
  expect(recorded.map((r) => (r as { kind?: string }).kind)).toEqual(["waiting", undefined, undefined]);
});

/* ── Removal triggers (one notification per task) ─────────────────────── */

async function makeTask(title: string) {
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title,
    prompt: "p",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

/** A pipeline parent plus one hidden step row pointing at it. */
async function makeParentWithStep() {
  const { tasks } = await import("./db.ts");
  const base = await makeTask("notifications: base");
  const parentId = randomUUID();
  const stepId = randomUUID();
  tasks.insert({ ...base, id: parentId, title: "pipeline parent", pipelineId: "pl-notifications" });
  tasks.insert({ ...base, id: stepId, title: "pipeline · step", pipelineParentId: parentId, pipelineStepId: "s1" });
  const cleanup = () => {
    tasks.delete(stepId);
    tasks.delete(parentId);
    tasks.delete(base.id);
  };
  return { parentId, stepId, cleanup };
}

test("DELETE /notifications/:taskId without token returns 401", async () => {
  const res = await fetch(url("/notifications/abc"), { method: "DELETE" });
  expect(res.status).toBe(401);
});

test("DELETE /notifications/:taskId rejects an over-length id", async () => {
  removals.length = 0;
  const res = await fetch(url(`/notifications/${"x".repeat(513)}`), { method: "DELETE", headers: auth() });
  expect(res.status).toBe(400);
  expect(removals).toEqual([]);
});

test("DELETE /notifications/:taskId removes the task's entry", async () => {
  removals.length = 0;
  const res = await fetch(url("/notifications/plain-task"), { method: "DELETE", headers: auth() });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(removals).toEqual([{ taskId: "plain-task" }]);
});

test("DELETE /notifications/:taskId maps a step to its pipeline parent", async () => {
  const { parentId, stepId, cleanup } = await makeParentWithStep();
  try {
    removals.length = 0;
    const res = await fetch(url(`/notifications/${stepId}`), { method: "DELETE", headers: auth() });
    expect(res.status).toBe(200);
    expect(removals).toEqual([{ taskId: parentId }]);
  } finally {
    cleanup();
  }
});

test("POST /tasks/:id/seen removes the entry (a step's goes to its parent); DELETE …/seen does not", async () => {
  const { tasks } = await import("./db.ts");
  const task = await makeTask("notifications: seen");
  const { parentId, stepId, cleanup } = await makeParentWithStep();
  try {
    removals.length = 0;
    expect((await fetch(url(`/tasks/${task.id}/seen`), { method: "POST", headers: auth() })).status).toBe(200);
    expect(removals).toEqual([{ taskId: task.id }]);

    removals.length = 0;
    expect((await fetch(url(`/tasks/${stepId}/seen`), { method: "POST", headers: auth() })).status).toBe(200);
    expect(removals).toEqual([{ taskId: parentId }]);

    removals.length = 0;
    expect((await fetch(url(`/tasks/${task.id}/seen`), { method: "DELETE", headers: auth() })).status).toBe(200);
    expect(removals).toEqual([]);

    removals.length = 0;
    expect((await fetch(url("/tasks/no-such-task/seen"), { method: "POST", headers: auth() })).status).toBe(404);
    expect(removals).toEqual([]);
  } finally {
    cleanup();
    tasks.delete(task.id);
  }
});

test("POST /tasks/:id/archive removes the task's own entry; a refused archive doesn't", async () => {
  const { tasks } = await import("./db.ts");
  const task = await makeTask("notifications: archive");
  try {
    removals.length = 0;
    // Not in Done and no `force` → the done-column gate refuses it.
    const refused = await fetch(url(`/tasks/${task.id}/archive`), { method: "POST", headers: auth(), body: "{}" });
    expect(refused.status).toBe(400);
    expect(removals).toEqual([]);

    const ok = await fetch(url(`/tasks/${task.id}/archive`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ force: true }),
    });
    expect(ok.status).toBe(200);
    expect(removals).toEqual([{ taskId: task.id }]);
  } finally {
    tasks.delete(task.id);
  }
});

test("DELETE /tasks/:id removes the task's own entry", async () => {
  const task = await makeTask("notifications: delete");
  removals.length = 0;
  const res = await fetch(url(`/tasks/${task.id}`), { method: "DELETE", headers: auth() });
  expect(res.status).toBe(204);
  expect(removals).toEqual([{ taskId: task.id }]);
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
