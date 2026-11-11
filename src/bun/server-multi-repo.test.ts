import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Port unique among
// *.test.ts files (see draft-endpoint.test.ts's convention).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-multi-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4621";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const BASE = "http://127.0.0.1:4621";
let server: { stop: () => void } | null = null;
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
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
  const repo = mkdtempSync(path.join(tmpdir(), `agetor-srv-${name}-`));
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

test("POST /tasks accepts two repositories and returns the workspace shape", async () => {
  const { task, a, b } = await createMulti();
  try {
    expect(task.repositories?.map((r) => r.path)).toEqual([a, b]);
    expect(task.branch).toBeNull();
    expect(task.workdir).toContain(task.id);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("POST /tasks rejects malformed repository payloads with 400", async () => {
  const a = await makeRepo("a");
  try {
    for (const repositories of [
      "nope",
      [{ baseRef: "main" }],
      [{ path: "" }],
      [{ path: "relative/path" }],
      [{ path: a, baseRef: 7 }],
    ]) {
      const res = await call("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t", prompt: "p", agent: "claude-code", workdir: a, isolation: "worktree", repositories }),
      });
      expect(res.status).toBe(400);
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test("GET /projects/branches hides a multi task's pinned repository branches", async () => {
  // Review R-M1 companion: the managed set read only `t.branch`, which is null
  // for a multi row by design, so every branch agetor minted for it cluttered
  // the base-ref picker in its repositories.
  const { task, a, b } = await createMulti();
  try {
    const pinned = task.repositories![0]!.branch!;
    await git(["branch", pinned], a);
    const res = await call(`/projects/branches?path=${encodeURIComponent(a)}`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string }>;
    expect(list.map((row) => row.name)).toContain("main");
    expect(list.map((row) => row.name)).not.toContain(pinned);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("PATCH /tasks/:id rejects the repository set", async () => {
  const { task, a, b } = await createMulti();
  try {
    const res = await call(`/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ repositories: [{ path: a }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("fixed at creation");
    const { tasks } = await import("./db.ts");
    expect(tasks.get(task.id)?.repositories).toHaveLength(2);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("PATCH /tasks/:id rejects valid JSON that isn't an object with 400", async () => {
  // Review nit: `"hi"`, `42`, `null` and `[]` parse fine, then `filterPatch`'s
  // non-object guard turned them into an empty patch and answered 200 — a
  // second flavor of the false-success the malformed-body check closed.
  const { task, a, b } = await createMulti();
  try {
    for (const body of ['"hi"', "42", "null", "[]", "true"]) {
      const res = await call(`/tasks/${task.id}`, { method: "PATCH", body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("must be an object");
    }
    const { tasks } = await import("./db.ts");
    expect(tasks.get(task.id)?.title).toBe(task.title);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("PATCH /tasks/:id rejects a malformed JSON body with 400", async () => {
  // Round-9 nit: `req.json().catch(() => ({}))` turned junk into an empty
  // patch and answered 200, so a client bug looked like a successful edit.
  const { task, a, b } = await createMulti();
  try {
    const res = await call(`/tasks/${task.id}`, {
      method: "PATCH",
      body: '{"title": "unterminated',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid JSON body");

    // An absent body is still a harmless no-op, not a 400.
    const empty = await call(`/tasks/${task.id}`, { method: "PATCH" });
    expect(empty.status).toBe(200);
    const { tasks } = await import("./db.ts");
    expect(tasks.get(task.id)?.title).toBe(task.title);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("GET /tasks/:id/diff routes by repo and 400s an unknown one", async () => {
  const { task, a, b } = await createMulti();
  try {
    const names = task.repositories!.map((r) => r.name);
    const okRes = await call(`/tasks/${task.id}/diff?repo=${encodeURIComponent(names[1]!)}`);
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).repo).toBe(names[1]);
    const bad = await call(`/tasks/${task.id}/diff?repo=nope`);
    expect(bad.status).toBe(400);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("GET /tasks/:id/git-status returns every repository in one response", async () => {
  const { task, a, b } = await createMulti();
  try {
    const res = await call(`/tasks/${task.id}/git-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repositories?: { name: string; path: string; ignored: boolean }[];
      name?: string;
    };
    expect(body.repositories).toHaveLength(2);
    expect(body.repositories?.map((r) => r.name)).toEqual(task.repositories?.map((r) => r.name));
    expect(body.repositories?.every((r) => r.ignored === false)).toBe(true);
    // Top-level mirrors the first repository for old clients.
    expect(body.name).toBe(task.repositories?.[0]?.name);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("GET /projects/repo-root resolves a subdirectory to its git root", async () => {
  const a = await makeRepo("root");
  const sub = path.join(a, "nested", "dir");
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sub, { recursive: true });
    const res = await call(`/projects/repo-root?path=${encodeURIComponent(sub)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).root).toBe(await (async () => {
      const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: a, stdout: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    })());
    const notRepo = await call(`/projects/repo-root?path=${encodeURIComponent(tmpdir())}`);
    // tmpdir may itself be inside a repo on some machines; only assert the
    // missing-parameter 400 which is deterministic.
    expect(notRepo.status === 200 || notRepo.status === 400).toBe(true);
    expect((await call("/projects/repo-root")).status).toBe(400);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test("POST /tasks/:id/terminals rejects an unknown repo selector", async () => {
  const { task, a, b } = await createMulti();
  try {
    const res = await call(`/tasks/${task.id}/terminals`, {
      method: "POST",
      body: JSON.stringify({ repo: "nope" }),
    });
    expect(res.status).toBe(400);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
