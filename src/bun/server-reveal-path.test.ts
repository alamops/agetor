import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeTestNative } from "./test-native.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-reveal-path-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4519";

const BASE = "http://127.0.0.1:4519";

const revealed: string[] = [];

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ tasks } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer({
    native: makeTestNative({ revealPath: (p) => { revealed.push(p); return true; } }),
  }) as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/reveal-path`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("requires a token", async () => {
  const res = await fetch(`${BASE}/reveal-path`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/tmp" }),
  });
  expect(res.status).toBe(401);
});

test("rejects missing path", async () => {
  revealed.length = 0;
  const res = await post({});
  expect(res.status).toBe(400);
  expect(revealed).toEqual([]);
});

test("rejects empty / whitespace path", async () => {
  revealed.length = 0;
  const res = await post({ path: "   " });
  expect(res.status).toBe(400);
  expect(revealed).toEqual([]);
});

test("reveals an absolute path that exists — 200 with { revealed: true, path }", async () => {
  revealed.length = 0;
  const filePath = path.join(DATA_DIR, `reveal-target-${randomUUID()}.txt`);
  writeFileSync(filePath, "hello");

  const res = await post({ path: filePath });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ revealed: true, path: filePath });
  expect(revealed).toEqual([filePath]);
});

test("404s on a path that does not exist", async () => {
  revealed.length = 0;
  const missing = path.join(DATA_DIR, `does-not-exist-${randomUUID()}.txt`);
  const res = await post({ path: missing });
  expect(res.status).toBe(404);
  expect(revealed).toEqual([]);
});

test("a relative path without taskId is rejected with 400", async () => {
  revealed.length = 0;
  const res = await post({ path: "relative/file.txt" });
  expect(res.status).toBe(400);
  expect(revealed).toEqual([]);
});

test("a relative path resolves against the task's worktreePath/workdir", async () => {
  revealed.length = 0;
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-reveal-path-wd-"));
  writeFileSync(path.join(workdir, "note.txt"), "hi");

  const taskId = randomUUID();
  tasks.insert({
    id: taskId,
    title: "t",
    prompt: "p",
    agent: "claude-code",
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  });

  try {
    const res = await post({ path: "note.txt", taskId });
    const expected = path.join(workdir, "note.txt");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revealed: true, path: expected });
    expect(revealed).toEqual([expected]);
  } finally {
    const { db } = await import("./db.ts");
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("returns 501 when no native host is wired up (headless)", async () => {
  process.env.AGETOR_API_PORT = "4520";
  const { startApiServer } = await import("./server.ts");
  const headlessServer = startApiServer() as unknown as { stop: () => void };
  try {
    const filePath = path.join(DATA_DIR, `headless-target-${randomUUID()}.txt`);
    writeFileSync(filePath, "hello");
    const res = await fetch("http://127.0.0.1:4520/reveal-path", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    expect(res.status).toBe(501);
  } finally {
    headlessServer.stop();
  }
});
