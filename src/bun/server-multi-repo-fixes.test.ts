// Route-level guards for multi-repository tasks (issue #291) added after
// review: the `repositories[]` cap on `POST /tasks`, the `workdir` PATCH
// refusal on a never-started multi row, `POST /tasks/:id/terminals`'s repo
// validation and null-body handling, and the pipeline-step terminal refusal
// when a repository checkout is missing. Contract:
// docs/architecture/multi-repo-tasks.md.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Port unique
// across src/ and e2e/ — grep before reusing.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-multi-fixes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const PORT = 4697;
const BASE = `http://127.0.0.1:${PORT}`;

const ENV_KEYS = [
  "AGETOR_API_PORT",
  "AGETOR_CLAUDE_DRIVER",
  "AGETOR_CLAUDE_BIN",
  "AGETOR_TMUX_BIN",
  "SHELL",
] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

let server: { stop: () => void } | null = null;
let token: string;
const cleanupDirs: string[] = [];

beforeAll(async () => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  process.env.AGETOR_API_PORT = String(PORT);
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  process.env.AGETOR_TMUX_BIN = "/bin/echo";
  // Terminals spawn `$SHELL -l`; keep it cheap and deterministic.
  process.env.SHELL = "/bin/sh";
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(async () => {
  const { tasks } = await import("./db.ts");
  const { killTerminalsForTask } = await import("./terminals.ts");
  for (const t of tasks.list()) killTerminalsForTask(t.id);
  server?.stop?.();
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(name: string): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), `agetor-srv-fix-${name}-`));
  cleanupDirs.push(repo);
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), `${name}\n`);
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

async function createMulti(): Promise<{ task: Task; a: string; b: string }> {
  const a = await makeRepo("a");
  const b = await makeRepo("b");
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "multi",
      prompt: "p",
      agent: "claude-code",
      workdir: a,
      isolation: "worktree",
      repositories: [{ path: a }, { path: b }],
    }),
  });
  expect(res.status).toBe(200);
  return { task: (await res.json()) as Task, a, b };
}

// ── S1: PATCH workdir on a multi row ────────────────────────────────────────

test("PATCH /tasks/:id refuses a workdir change on a never-started multi-repository task", async () => {
  const { task } = await createMulti();
  // Never started: no worktree yet, so the older worktreePath guard can't fire.
  expect(task.worktreePath).toBeNull();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "agetor-srv-fix-elsewhere-"));
  cleanupDirs.push(elsewhere);

  const res = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ workdir: elsewhere }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("multi-repository");
  const { tasks } = await import("./db.ts");
  expect(tasks.get(task.id)!.workdir).toBe(task.workdir);

  // A same-value resend is a no-op and passes.
  const same = await call(`/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ workdir: task.workdir }),
  });
  expect(same.status).toBe(200);
  await same.text();
});

test("PATCH /tasks/:id still lets a never-started single-repository task change its workdir", async () => {
  const a = await makeRepo("single");
  const b = await makeRepo("single-next");
  const created = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "single", prompt: "p", agent: "claude-code", workdir: a, isolation: "worktree" }),
  });
  expect(created.status).toBe(200);
  const task = (await created.json()) as Task;
  const res = await call(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ workdir: b }) });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Task).workdir).toBe(b);
});

// ── N7: POST /tasks/:id/terminals ───────────────────────────────────────────

test("POST /tasks/:id/terminals refuses an unknown repo before preparing any worktree", async () => {
  const { task } = await createMulti();
  const { WORKTREES_DIR } = await import("./worktree.ts");
  const res = await call(`/tasks/${task.id}/terminals`, {
    method: "POST",
    body: JSON.stringify({ repo: "no-such-repo" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('unknown repository "no-such-repo"');
  // Nothing was materialized: no workspace, no per-repository checkout.
  const { tasks } = await import("./db.ts");
  const after = tasks.get(task.id)!;
  expect(after.worktreePath).toBeNull();
  expect(after.repositories?.every((r) => r.worktreePath === null)).toBe(true);
  expect(existsSync(path.join(WORKTREES_DIR, task.id))).toBe(false);
});

test("POST /tasks/:id/terminals treats a null JSON body as an empty one (never 500)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-srv-fix-term-"));
  cleanupDirs.push(dir);
  const created = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "term", prompt: "p", agent: "claude-code", workdir: dir, isolation: "none" }),
  });
  expect(created.status).toBe(200);
  const task = (await created.json()) as Task;
  for (const raw of ["null", "42", '"repo"']) {
    const res = await call(`/tasks/${task.id}/terminals`, { method: "POST", body: raw });
    expect(res.status, `body ${raw}`).toBe(201);
    await res.text();
  }
  const { killTerminalsForTask } = await import("./terminals.ts");
  killTerminalsForTask(task.id);
  // An unknown task with a null body is still a plain 404.
  const missing = await call("/tasks/no-such-task/terminals", { method: "POST", body: "null" });
  expect(missing.status).toBe(404);
  await missing.text();
});

// ── S6: pipeline-step terminal with a missing repository checkout ───────────

test("createTerminal refuses a multi-repository pipeline step whose repository checkout is missing", async () => {
  const a = await makeRepo("step-a");
  const b = await makeRepo("step-b");
  const { tasks } = await import("./db.ts");
  const { createTerminal, countTerminals } = await import("./terminals.ts");
  // The workspace root and one checkout exist; the other checkout is gone.
  const root = mkdtempSync(path.join(tmpdir(), "agetor-srv-fix-step-root-"));
  cleanupDirs.push(root);
  const presentCheckout = path.join(root, "a");
  mkdirSync(presentCheckout);
  const missingCheckout = path.join(root, "b");
  const id = "multi-step-missing-checkout";
  tasks.insert({
    id,
    title: "step",
    prompt: "n/a",
    column: "backlog",
    agent: "codex",
    workdir: root,
    isolation: "worktree",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: root,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    pipelineParentId: "multi-step-parent",
    pipelineStepId: "s1",
    repositories: [
      { path: a, name: "a", branch: "agetor/shared-a", branchSource: "created", worktreePath: presentCheckout, baseRef: null, checkoutBranch: null, prUrl: null },
      { path: b, name: "b", branch: "agetor/shared-b", branchSource: "created", worktreePath: missingCheckout, baseRef: null, checkoutBranch: null, prUrl: null },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Task);

  const r = await createTerminal(id);
  expect(r).toEqual({ error: "step task's worktree is missing — run the pipeline task instead" });
  // The step did not re-materialize the shared checkout on its own.
  expect(existsSync(missingCheckout)).toBe(false);
  expect(countTerminals(id)).toBe(0);
});
