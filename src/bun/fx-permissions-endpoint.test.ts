import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Set both the
// data dir and an isolated API port BEFORE any sibling test in the same
// process imports server.ts / db.ts — same convention as
// approvals-endpoint.test.ts / server-auth.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-fx-permissions-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4412";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:4412${p}`;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

// Every test starts from a clean interactions registry — registerFxPermission
// broadcasts through orchestrator.ts's wireInteractionBroadcast (installed
// when server.ts pulled orchestrator.ts in above), which is harmless
// no-op-for-this-file plumbing; __testing.reset() clears the in-memory Maps
// so cards from one test can't leak into the next.
beforeEach(async () => {
  const { __testing } = await import("./interactions.ts");
  __testing.reset();
});

async function registerCard(overrides: { taskId?: string; mode?: "auto" | "ask" } = {}) {
  const { registerFxPermission } = await import("./interactions.ts");
  const taskId = overrides.taskId ?? `t-fxperm-${randomUUID()}`;
  const { id, req, answer } = registerFxPermission({
    taskId,
    runId: "run-fxperm",
    toolCall: { toolCallId: "call-1", title: "Write file", kind: "edit", rawInput: { path: "/tmp/x.txt" } },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    mode: overrides.mode ?? "ask",
  });
  return { id, req, answer, taskId };
}

test("POST /fx-permissions/:id/answer — unknown id returns ok:false at 200 (nothing to drive)", async () => {
  const res = await fetch(url("/fx-permissions/does-not-exist/answer"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ optionId: "x" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(false);
});

test("POST /fx-permissions/:id/answer — missing optionId (no cancel) returns 400", async () => {
  const { id } = await registerCard();
  const res = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("optionId required");

  // The card must still be pending — a validation failure must not consume it.
  const { findFxPermissionById } = await import("./interactions.ts");
  expect(findFxPermissionById(id)).not.toBeNull();
});

test("POST /fx-permissions/:id/answer — optionId not in the recorded option set returns 400", async () => {
  const { id } = await registerCard();
  const res = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ optionId: "not-a-real-option" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("unknown option");

  const { findFxPermissionById } = await import("./interactions.ts");
  expect(findFxPermissionById(id)).not.toBeNull();
});

test("POST /fx-permissions/:id/answer — a valid optionId resolves the card and the awaited answer", async () => {
  const { id, answer, taskId } = await registerCard();
  const res = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ optionId: "allow-once" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);

  // The registry entry is gone …
  const { findFxPermissionById, listPendingForTask } = await import("./interactions.ts");
  expect(findFxPermissionById(id)).toBeNull();
  expect(listPendingForTask(taskId)).toHaveLength(0);

  // … and the driver's awaited promise resolved with the chosen option.
  await expect(answer).resolves.toEqual({ optionId: "allow-once" });
});

test("POST /fx-permissions/:id/answer — a second answer on the same (now-resolved) id loses the race: ok:false at 200", async () => {
  const { id } = await registerCard();
  const first = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ optionId: "allow-once" }),
  });
  expect(first.status).toBe(200);
  expect((await first.json()).ok).toBe(true);

  const second = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ optionId: "reject-once" }),
  });
  expect(second.status).toBe(200);
  expect((await second.json()).ok).toBe(false);
});

test("POST /fx-permissions/:id/answer — {cancel:true} on a fresh card resolves ok:true and the answer as {cancelled:true}", async () => {
  const { id, answer, taskId } = await registerCard();
  const res = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ cancel: true }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);

  const { findFxPermissionById, listPendingForTask } = await import("./interactions.ts");
  expect(findFxPermissionById(id)).toBeNull();
  expect(listPendingForTask(taskId)).toHaveLength(0);

  await expect(answer).resolves.toEqual({ cancelled: true });
});

test("POST /fx-permissions/:id/answer — unauthenticated request is rejected", async () => {
  const { id } = await registerCard();
  const res = await fetch(url(`/fx-permissions/${id}/answer`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ optionId: "allow-once" }),
  });
  expect(res.status).toBe(401);

  // Unauthenticated request must not have touched the registry.
  const { findFxPermissionById } = await import("./interactions.ts");
  expect(findFxPermissionById(id)).not.toBeNull();
});

test("POST /harnesses with kind=fx is accepted", async () => {
  const res = await fetch(url("/harnesses"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: "fx-new",
      kind: "fx",
      label: "fx (new)",
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.kind).toBe("fx");
  expect(body.id).toBe("fx-new");
});

test("GET /agent-models includes an 'fx' key whose value is an array", async () => {
  const res = await fetch(url("/agent-models"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.fx)).toBe(true);
});
