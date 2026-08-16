import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task } from "../shared/types.ts";
import { makeGitHubRepo, mockGitHubFetch, type FetchMock } from "./github-test-util.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import. Set both the
// data dir and an isolated API port BEFORE any sibling test file in the same
// process imports server.ts / db.ts. Port is unique among *.test.ts files
// (see the comment convention in draft-endpoint.test.ts / server-keepalive.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pr-url-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4491";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:4491${p}`;
let fetchMock: FetchMock | null = null;
const savedGithubToken = process.env.GITHUB_TOKEN;
// mockGitHubFetch replaces `globalThis.fetch` wholesale (it has no way to
// distinguish "call to our own local API" from "call to the GitHub API" —
// that's the server route's own outbound fetch it's meant to intercept). So
// the real fetch is captured here, before any test installs the mock, and
// used for every request this file makes to its own local server.
const realFetch = fetch.bind(globalThis);

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
  // Mirrors git-host.test.ts's convention — a real GITHUB_TOKEN so
  // githubToken() never falls through to a `gh auth token` shellout.
  process.env.GITHUB_TOKEN = "gh-test-token";
});

afterAll(() => {
  server?.stop?.();
  fetchMock?.restore();
  if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedGithubToken;
});

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

function fakeTask(overrides: Partial<Task> & { workdir: string }): Task {
  return {
    id: randomUUID(),
    title: "PR url task",
    prompt: "p",
    column: "review",
    agent: "claude-code",
    isolation: "none",
    taskType: "task",
    branch: "feature/x",
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false, maxMode: false,
    references: [],
    backlog: [], plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/* ── Case 6: db round-trip for tasks.prUrl (migration 030 + column mapping) ── */

test("db round-trip: tasks.update persists prUrl and tasks.get re-reads it", async () => {
  const { tasks } = await import("./db.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pr-url-db-"));
  const inserted = tasks.insert(fakeTask({ workdir: dir, prUrl: null }));
  expect(inserted.prUrl).toBeNull();

  const updated = tasks.update(inserted.id, { prUrl: "https://github.com/o/r/pull/1" });
  expect(updated?.prUrl).toBe("https://github.com/o/r/pull/1");

  // Re-read via a fresh `get` (not just the `update` return value) so the
  // round-trip actually exercises the `pr_url` column read path in `toTask`.
  const reread = tasks.get(inserted.id);
  expect(reread?.prUrl).toBe("https://github.com/o/r/pull/1");
});

/* ── Cases 7-9: POST /github/pull-create with/without taskId ────────────── */

function mockPullCreateRoute(htmlUrl: string): FetchMock {
  return mockGitHubFetch([
    {
      method: "POST",
      match: /\/pulls$/,
      status: 201,
      json: {
        number: 42,
        title: "My PR",
        state: "open",
        html_url: htmlUrl,
        draft: false,
        user: null,
        assignees: [],
        milestone: null,
        body: "",
        labels: [],
        comments: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        closed_at: null,
        merged_at: null,
        locked: false,
      },
    },
  ]);
}

test("POST /github/pull-create with a valid taskId persists the created PR's htmlUrl onto the task", async () => {
  const { tasks } = await import("./db.ts");
  const repoDir = await makeGitHubRepo("o", "r");
  const task = tasks.insert(fakeTask({ workdir: repoDir, prUrl: null }));

  fetchMock = mockPullCreateRoute("https://github.com/o/r/pull/42");
  try {
    const res = await realFetch(url("/github/pull-create"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        path: repoDir,
        title: "My PR",
        head: "feature/x",
        base: "main",
        taskId: task.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.item.htmlUrl).toBe("https://github.com/o/r/pull/42");
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }

  const reread = tasks.get(task.id);
  expect(reread?.prUrl).toBe("https://github.com/o/r/pull/42");
});

test("POST /github/pull-create with an unknown taskId still succeeds (200/ok) without crashing", async () => {
  const repoDir = await makeGitHubRepo("o", "r2");

  fetchMock = mockPullCreateRoute("https://github.com/o/r2/pull/7");
  try {
    const res = await realFetch(url("/github/pull-create"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        path: repoDir,
        title: "My PR",
        head: "feature/x",
        base: "main",
        taskId: "does-not-exist",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.item.htmlUrl).toBe("https://github.com/o/r2/pull/7");
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }
});

test("POST /github/pull-create with no taskId leaves every task's prUrl untouched", async () => {
  const { tasks } = await import("./db.ts");
  const repoDir = await makeGitHubRepo("o", "r3");
  // A pre-existing task in the same dir must not be affected by a request
  // that doesn't name it.
  const bystander = tasks.insert(fakeTask({ workdir: repoDir, prUrl: null }));

  fetchMock = mockPullCreateRoute("https://github.com/o/r3/pull/9");
  try {
    const res = await realFetch(url("/github/pull-create"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        path: repoDir,
        title: "My PR",
        head: "feature/x",
        base: "main",
        // no taskId
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }

  const reread = tasks.get(bystander.id);
  expect(reread?.prUrl).toBeNull();
});

/* ── Case 10: GET /tasks/:id/git-status — remoteSynced + non-git workdir ─── */

test("GET /tasks/:id/git-status reports hasUpstream+remoteSynced for a synced pushed repo", async () => {
  const { tasks } = await import("./db.ts");
  const bare = mkdtempSync(path.join(tmpdir(), "agetor-pr-url-gs-bare-"));
  await git(["init", "--bare", "-b", "main"], bare);

  const repo = mkdtempSync(path.join(tmpdir(), "agetor-pr-url-gs-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  await git(["remote", "add", "origin", bare], repo);
  await git(["push", "-u", "origin", "main"], repo);

  const task = tasks.insert(fakeTask({ workdir: repo, isolation: "none" }));

  const res = await realFetch(url(`/tasks/${task.id}/git-status`), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ignored).toBe(false);
  expect(body.hasUpstream).toBe(true);
  expect(body.remoteSynced).toBe(true);
});

test("GET /tasks/:id/git-status reports ignored+no-upstream for a non-git workdir", async () => {
  const { tasks } = await import("./db.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pr-url-gs-nongit-"));
  const task = tasks.insert(fakeTask({ workdir: dir, isolation: "none" }));

  const res = await realFetch(url(`/tasks/${task.id}/git-status`), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    hasChanges: false, ahead: 0, ignored: true, hasUpstream: false, remoteSynced: false,
    branch: null, isDefaultBranch: false,
  });
});

test("pull-create guards: archived task, mismatched workdir, and existing prUrl are never stamped", async () => {
  const { tasks } = await import("./db.ts");
  const repoDir = await makeGitHubRepo("o", "rg");
  const otherDir = await makeGitHubRepo("o", "rg2");

  const archived = tasks.insert(fakeTask({ workdir: repoDir, prUrl: null }));
  tasks.update(archived.id, { archivedAt: Date.now() });
  const elsewhere = tasks.insert(fakeTask({ workdir: otherDir, prUrl: null }));
  const already = tasks.insert(
    fakeTask({ workdir: repoDir, prUrl: "https://github.com/o/rg/pull/1" }),
  );

  for (const t of [archived, elsewhere, already]) {
    fetchMock = mockPullCreateRoute("https://github.com/o/rg/pull/99");
    try {
      const res = await realFetch(url("/github/pull-create"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          path: repoDir,
          title: "Guarded",
          head: "feature/g",
          base: "main",
          taskId: t.id,
        }),
      });
      // Creation itself still succeeds — persistence is silently skipped.
      expect(res.status).toBe(200);
    } finally {
      fetchMock.restore();
      fetchMock = null;
    }
  }

  expect(tasks.get(archived.id)?.prUrl).toBeNull();
  expect(tasks.get(elsewhere.id)?.prUrl).toBeNull();
  expect(tasks.get(already.id)?.prUrl).toBe("https://github.com/o/rg/pull/1");
});
