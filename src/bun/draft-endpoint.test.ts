import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-draft-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4433";

const BASE = "http://127.0.0.1:4433";

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
    title: "draft endpoint",
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

test("PUT upserts and returns the full Task with the draft", async () => {
  const id = await newTask();
  try {
    const res = await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({
        text: "unsent message",
        references: [{ path: "/tmp/x", isDirectory: false }],
      }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    expect(task.id).toBe(id);
    expect(task.draft).toEqual({
      text: "unsent message",
      references: [{ path: "/tmp/x", isDirectory: false }],
    });

    // Persists — a fresh read confirms it wasn't just echoed back.
    expect(tasks.get(id)!.draft).toEqual({
      text: "unsent message",
      references: [{ path: "/tmp/x", isDirectory: false }],
    });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("PUT with empty text + empty refs returns Task with draft null", async () => {
  const id = await newTask();
  try {
    // Seed a draft first so we can confirm the empty PUT actually clears it.
    await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ text: "will be cleared", references: [] }),
    });

    const res = await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ text: "   ", references: [] }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    expect(task.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("DELETE clears the draft and returns the Task", async () => {
  const id = await newTask();
  try {
    await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ text: "goodbye soon", references: [] }),
    });
    expect(tasks.get(id)!.draft).not.toBeNull();

    const res = await call(`/tasks/${id}/draft`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    expect(task.draft).toBeNull();
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("PUT to a missing task 404s", async () => {
  const res = await call(`/tasks/does-not-exist/draft`, {
    method: "PUT",
    body: JSON.stringify({ text: "x" }),
  });
  expect(res.status).toBe(404);
});

test("DELETE on a missing task 404s", async () => {
  const res = await call(`/tasks/does-not-exist/draft`, { method: "DELETE" });
  expect(res.status).toBe(404);
});

test("PUT succeeds on an ARCHIVED task — draft writes are deliberately not guarded", async () => {
  const id = await newTask();
  try {
    tasks.update(id, { archivedAt: Date.now() });

    const res = await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ text: "still typable while archived", references: [] }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    expect(task.archivedAt).not.toBeNull();
    expect(task.draft).toEqual({ text: "still typable while archived", references: [] });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("references in the PUT body are sanitized — junk entries dropped", async () => {
  const id = await newTask();
  try {
    const res = await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({
        text: "keep",
        references: [
          { path: "/tmp/good", isDirectory: true },
          { path: "" }, // dropped — empty path
          { isDirectory: false }, // dropped — no path
          "not an object", // dropped
        ],
      }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    expect(task.draft).toEqual({
      text: "keep",
      references: [{ path: "/tmp/good", isDirectory: true }],
    });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("PUT with text over the 256KB cap returns 400", async () => {
  const id = await newTask();
  try {
    const tooLong = "a".repeat(256 * 1024 + 1);
    const res = await call(`/tasks/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ text: tooLong }),
    });
    expect(res.status).toBe(400);
    // Nothing was written.
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("draft routes require a token", async () => {
  const id = await newTask();
  try {
    const res = await fetch(`${BASE}/tasks/${id}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(401);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});
