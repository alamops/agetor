import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Port unique among
// *.test.ts files (see draft-endpoint.test.ts's convention) — 4620–4622 are
// claimed by server-db-routes.test.ts's blocking-route arms, so reusing one
// here steals its /test/block-event-loop route and fails that file.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-multi-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4689";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const BASE = "http://127.0.0.1:4689";
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

test("POST /tasks anchors workdir to the repository set over an explicit workdir", async () => {
  // Review round thirteen (Q1): `agetor add --workdir A --repo B` used to send
  // A as the task's workdir, and createTask silently replaced it with the
  // selected repository. The CLI now sends that same anchor, but the route
  // contract — the repository set owns `workdir` — is what makes the payload
  // self-consistent. One kept entry keeps that path; 2+ use the per-task
  // workspace root, never the caller's directory.
  const a = await makeRepo("anchor-a");
  const b = await makeRepo("anchor-b");
  const elsewhere = mkdtempSync(path.join(tmpdir(), "agetor-srv-anchor-"));
  try {
    const single = await call("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "anchor one",
        prompt: "p",
        agent: "claude-code",
        workdir: elsewhere,
        isolation: "worktree",
        repositories: [{ path: a }],
      }),
    });
    expect(single.status).toBe(200);
    const one = (await single.json()) as Task;
    expect(one.workdir).toBe(a);
    expect(one.repositories?.map((r) => r.path)).toEqual([a]);

    const multi = await call("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "anchor two",
        prompt: "p",
        agent: "claude-code",
        workdir: elsewhere,
        isolation: "worktree",
        repositories: [{ path: a }, { path: b }],
      }),
    });
    expect(multi.status).toBe(200);
    const two = (await multi.json()) as Task;
    const { WORKTREES_DIR } = await import("./worktree.ts");
    expect(two.workdir).toBe(path.join(WORKTREES_DIR, two.id));
    expect(two.repositories?.map((r) => r.path)).toEqual([a, b]);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("POST /tasks rebuilds the repository set from path+baseRef and ignores server-managed fields", async () => {
  // Trust boundary: `POST /tasks` is CLI-reachable, so a caller can send the
  // whole Task shape. `createTask` must never adopt a client-supplied
  // worktreePath/checkoutBranch/prUrl/branchSource — those are materialized or
  // stamped by the server, and a forged entry would make the Worktrees page
  // (and teardown) operate on a path the task does not own.
  const a = await makeRepo("trust-a");
  const b = await makeRepo("trust-b");
  try {
    const res = await call("/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "trust",
        prompt: "p",
        agent: "claude-code",
        // Not a git repo, and not in the selected set: must not survive.
        workdir: path.join(tmpdir(), "agetor-srv-not-a-repo"),
        isolation: "worktree",
        worktreePath: "/tmp/evil-workspace",
        checkoutBranch: "evil-checkout",
        prUrl: "https://evil.example/pr/1",
        issueRepoPath: b,
        repositories: [
          {
            path: a,
            baseRef: "main",
            branch: "evil-branch",
            branchSource: "existing",
            worktreePath: "/tmp/evil-a",
            checkoutBranch: "evil-a",
            prUrl: "https://evil.example/a",
          },
          {
            path: b,
            branch: "evil-branch",
            worktreePath: "/tmp/evil-b",
            prUrl: "https://evil.example/b",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const task = (await res.json()) as Task;
    // Multi tasks mirror the workspace only; the scalars stay null.
    expect(task.worktreePath).toBeNull();
    expect(task.prUrl).toBeNull();
    expect(task.checkoutBranch).toBeNull();
    expect(task.issueRepoPath).toBeNull();
    // Every server-managed entry field is rebuilt, never echoed.
    expect(task.repositories?.map((r) => r.worktreePath)).toEqual([null, null]);
    expect(task.repositories?.map((r) => r.checkoutBranch)).toEqual([null, null]);
    expect(task.repositories?.map((r) => r.prUrl)).toEqual([null, null]);
    expect(task.repositories?.map((r) => r.branchSource)).toEqual(["created", "created"]);
    // The generated branch is derived from the title, not the forged override.
    expect(task.repositories?.every((r) => typeof r.branch === "string" && r.branch !== "evil-branch")).toBe(true);
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
    // The blob route takes the same `repo` selector and rejects an unknown one
    // before touching the filesystem (the binary kind gate comes first, so use
    // a path that would be previewable).
    const badBlob = await call(`/tasks/${task.id}/diff/blob?path=logo.png&side=new&repo=nope`);
    expect(badBlob.status).toBe(400);
    expect((await badBlob.json()).error).toContain("unknown repository");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("GET /tasks/:id/git-status returns every repository in one response", async () => {
  const { task, a, b } = await createMulti();
  try {
    // Make the two repositories differ so a handler that answered every entry
    // with repository 0's status (or the workspace root's) would fail: A gets
    // an uncommitted file, B a commit past the base sha createTask pinned.
    // The task is not started, so each entry's dir is its selected path.
    writeFileSync(path.join(a, "dirty.txt"), "uncommitted\n");
    writeFileSync(path.join(b, "more.txt"), "more\n");
    await git(["add", "."], b);
    await git(["commit", "-m", "ahead of base"], b);

    const res = await call(`/tasks/${task.id}/git-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repositories?: { name: string; path: string; ignored: boolean; hasChanges: boolean; ahead: number; branch: string | null }[];
      name?: string;
      path?: string;
      hasChanges?: boolean;
      ahead?: number;
    };
    expect(body.repositories).toHaveLength(2);
    const names = task.repositories!.map((r) => r.name);
    expect(body.repositories?.map((r) => r.name)).toEqual(names);
    expect(body.repositories?.[0]).toMatchObject({ name: names[0], path: a, ignored: false, hasChanges: true, ahead: 0, branch: "main" });
    expect(body.repositories?.[1]).toMatchObject({ name: names[1], path: b, ignored: false, hasChanges: false, ahead: 1, branch: "main" });
    // Top-level mirrors the first repository for old clients.
    expect(body).toMatchObject({ name: names[0], path: a, hasChanges: true, ahead: 0 });
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("GET /projects/repo-root resolves a subdirectory to its git root", async () => {
  const a = await makeRepo("root");
  const sub = path.join(a, "nested", "dir");
  const cleanup: string[] = [];
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sub, { recursive: true });
    const res = await call(`/projects/repo-root?path=${encodeURIComponent(sub)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).root).toBe(await (async () => {
      const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: a, stdout: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    })());
    // A fresh empty directory is not a git repository: `repoRoot` returns
    // null and the handler answers exactly 400 "not a git repository". The
    // precondition pins that the temp dir really sits outside any repo, so a
    // failure here names the environment rather than a wrong status.
    const plain = mkdtempSync(path.join(tmpdir(), "agetor-srv-plain-"));
    cleanup.push(plain);
    const probe = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: plain, stdout: "pipe", stderr: "pipe" });
    expect(await probe.exited).not.toBe(0);
    const notRepo = await call(`/projects/repo-root?path=${encodeURIComponent(plain)}`);
    expect(notRepo.status).toBe(400);
    expect((await notRepo.json()).error).toBe("not a git repository");
    // A path that does not exist takes the same 400.
    const missing = await call(`/projects/repo-root?path=${encodeURIComponent(path.join(plain, "missing"))}`);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("not a git repository");
    const noParam = await call("/projects/repo-root");
    expect(noParam.status).toBe(400);
    expect((await noParam.json()).error).toBe("path required");
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
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
