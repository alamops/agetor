import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-backlog-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4431";

const BASE = "http://127.0.0.1:4431";

let server: { stop: () => void };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let tasks: typeof import("./db.ts").tasks;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ tasks, db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

async function newTask(): Promise<string> {
  const created = await createTask({
    title: "backlog endpoint",
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test("full CRUD lifecycle over the backlog routes", async () => {
  const id = await newTask();
  try {
    // Add two drafts.
    let res = await call(`/tasks/${id}/backlog`, {
      method: "POST",
      body: JSON.stringify({ text: "one" }),
    });
    expect(res.status).toBe(200);
    let task = (await res.json()) as Task;
    expect(task.backlog.map((m) => m.text)).toEqual(["one"]);

    res = await call(`/tasks/${id}/backlog`, {
      method: "POST",
      body: JSON.stringify({
        text: "two",
        references: [{ path: "/tmp/f", isDirectory: false }],
      }),
    });
    task = (await res.json()) as Task;
    expect(task.backlog.map((m) => m.text)).toEqual(["two", "one"]); // newest first
    const twoId = task.backlog[0]!.id;
    const oneId = task.backlog[1]!.id;

    // Reorder (PUT) → one, two.
    res = await call(`/tasks/${id}/backlog`, {
      method: "PUT",
      body: JSON.stringify({ order: [oneId, twoId] }),
    });
    expect(res.status).toBe(200);
    task = (await res.json()) as Task;
    expect(task.backlog.map((m) => m.text)).toEqual(["one", "two"]);

    // Edit "one" → "one!".
    res = await call(`/tasks/${id}/backlog/${oneId}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "one!" }),
    });
    expect(res.status).toBe(200);
    task = (await res.json()) as Task;
    expect(task.backlog.find((m) => m.id === oneId)!.text).toBe("one!");

    // Delete "two".
    res = await call(`/tasks/${id}/backlog/${twoId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    task = (await res.json()) as Task;
    expect(task.backlog.map((m) => m.id)).toEqual([oneId]);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("POST rejects an empty draft (no text, no refs)", async () => {
  const id = await newTask();
  try {
    const res = await call(`/tasks/${id}/backlog`, {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("PATCH rejects an edit that would empty the item (text-only draft → blank)", async () => {
  const id = await newTask();
  try {
    const add = await call(`/tasks/${id}/backlog`, {
      method: "POST",
      body: JSON.stringify({ text: "keep me" }),
    });
    const itemId = ((await add.json()) as Task).backlog[0]!.id;

    const res = await call(`/tasks/${id}/backlog/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
    // Item is untouched.
    expect(tasks.get(id)!.backlog.find((m) => m.id === itemId)!.text).toBe("keep me");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("POST accepts a references-only draft", async () => {
  const id = await newTask();
  try {
    const res = await call(`/tasks/${id}/backlog`, {
      method: "POST",
      body: JSON.stringify({ text: "", references: [{ path: "/tmp/g", isDirectory: true }] }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    expect(task.backlog[0]!.text).toBe("");
    expect(task.backlog[0]!.references).toEqual([{ path: "/tmp/g", isDirectory: true }]);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("backlog mutations are rejected on an archived task", async () => {
  const id = await newTask();
  try {
    tasks.update(id, { archivedAt: Date.now() });
    const res = await call(`/tasks/${id}/backlog`, {
      method: "POST",
      body: JSON.stringify({ text: "nope" }),
    });
    expect(res.status).toBe(400);
    expect(tasks.get(id)!.backlog).toHaveLength(0);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("POST to a missing task 404s", async () => {
  const res = await call(`/tasks/does-not-exist/backlog`, {
    method: "POST",
    body: JSON.stringify({ text: "x" }),
  });
  expect(res.status).toBe(404);
});

test("backlog routes require a token", async () => {
  const id = await newTask();
  try {
    const res = await fetch(`${BASE}/tasks/${id}/backlog`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(401);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});
