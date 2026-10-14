import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTestNative } from "./test-native.ts";
import type { Task, TaskTeardownPreview } from "../shared/types.ts";

// `GET /tasks/:id/teardown-preview` (docs/plans/codex-terminal-worktree-error.md
// T7/U5) and the `checkoutBranch` PATCH exclusion.

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-teardown-preview-"));
// Distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4604";
const BASE = "http://127.0.0.1:4604";

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;

async function git(args: string[], cwd: string): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-teardown-preview-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

beforeAll(async () => {
  ({ tasks } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer({ native: makeTestNative() }) as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const authed = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

async function drifted(): Promise<Task> {
  const { createTask } = await import("./orchestrator.ts");
  const { prepareWorkdir } = await import("./worktree.ts");
  const repo = await makeRepo();
  const created = await createTask({ title: "preview", prompt: "p", agent: "claude-code", workdir: repo, isolation: "worktree" });
  if ("error" in created) throw new Error(created.error);
  const prepared = await prepareWorkdir(created.task);
  if ("error" in prepared) throw new Error(prepared.error);
  tasks.update(created.task.id, { branch: prepared.branch, worktreePath: prepared.worktreePath });
  await git(["checkout", "-b", "implement/x"], prepared.worktreePath!);
  return tasks.get(created.task.id)!;
}

test("requires a token", async () => {
  const res = await fetch(`${BASE}/tasks/whatever/teardown-preview`);
  expect(res.status).toBe(401);
});

test("404 for an unknown task", async () => {
  const res = await authed("/tasks/no-such-task/teardown-preview");
  expect(res.status).toBe(404);
});

test("names both branches for a drifted worktree, and never mutates anything", async () => {
  const task = await drifted();
  const res = await authed(`/tasks/${task.id}/teardown-preview`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as TaskTeardownPreview;
  expect(body).toEqual({
    branches: [task.branch!, "implement/x"],
    liveBranch: "implement/x",
    taskBranch: task.branch,
    source: "live",
    excluded: [],
  });
  // Read-only: the GET records nothing (refresh points are writes, never GETs).
  expect(tasks.get(task.id)?.checkoutBranch).toBeNull();
});

test("PATCH /tasks/:id ignores checkoutBranch (server-managed)", async () => {
  const task = await drifted();
  tasks.setCheckoutBranch(task.id, "implement/x");
  const res = await authed(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "renamed", checkoutBranch: "hijacked" }),
  });
  expect(res.status).toBe(200);
  const after = tasks.get(task.id)!;
  expect(after.title).toBe("renamed");
  expect(after.checkoutBranch).toBe("implement/x");
});
