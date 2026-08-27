// Route-level tests for the two HTTP surfaces Task A adds
// (docs/plans/new-task-from-git-issue.md): `GET /github/issue-thread`'s
// input validation, and `POST /tasks`'s `issueUrl`/`issueSnapshot` 400 rules
// (server.ts ~lines 1008-1023 and ~3401-3430). Mirrors draft-endpoint.test.ts /
// pull-detail.test.ts's route-level convention: AGETOR_DATA_DIR + a unique
// AGETOR_API_PORT are set at module scope BEFORE db.ts/server.ts are
// dynamically imported in beforeAll (both capture their config at import
// time), and a bearer-token `authed()` helper drives every request.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeGitHubRepo, mockGitHubFetch } from "./github-test-util.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4589";

const BASE = "http://127.0.0.1:4589";

let server: { stop: () => void };
let token: string;
let createdDirs: string[] = [];

// Forced (and restored) so `githubToken()` — hit by the new includeComments
// tests below, which reach getGitHubIssueThread for real — never falls
// through to a `gh auth token` CLI shellout; mirrors pull-detail.test.ts's
// own convention for the same reason.
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

beforeAll(async () => {
  process.env.GITHUB_TOKEN = "gh-test-token";
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
  // Uses rmTestDataDir instead of a bare rmSync(DATA_DIR, ...): see that
  // helper's doc comment (test-data-dir.ts) for why an unconditional rm here
  // would risk yanking the shared db.ts singleton's sqlite file out from
  // under a still-open connection another *.test.ts file depends on.
  rmTestDataDir(DATA_DIR);
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

// Captured before any test can install `mockGitHubFetch` (which swaps
// `globalThis.fetch`) — the includeComments tests below mock the outbound
// GitHub call the server makes, and `call()` still needs a real fetch to
// reach the local test server itself. Mirrors pull-detail.test.ts's own
// `realFetch` convention for the identical reason.
const realFetch = fetch.bind(globalThis);

const call = (p: string, init: RequestInit = {}) =>
  realFetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A throwaway git repo with no remote at all — used to prove the
 *  `POST /tasks` route passes `issueUrl` through to `createTask` verbatim
 *  rather than validating it itself. */
async function makeRepoWithNoRemote(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// GET /github/issue-thread — input validation
// ---------------------------------------------------------------------------

test("GET /github/issue-thread without a path returns 400 'path required'", async () => {
  const res = await call("/github/issue-thread?number=1");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "path required" });
});

test("GET /github/issue-thread with a missing number returns 400 'valid issue number required'", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-num-"));
  createdDirs.push(dir);
  const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}`);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "valid issue number required" });
});

test("GET /github/issue-thread with a non-integer number returns 400", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-num2-"));
  createdDirs.push(dir);
  const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}&number=abc`);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "valid issue number required" });
});

test("GET /github/issue-thread with number=0 returns 400 (must be positive)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-num3-"));
  createdDirs.push(dir);
  const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}&number=0`);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "valid issue number required" });
});

test("GET /github/issue-thread with a non-integer decimal number returns 400", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-num4-"));
  createdDirs.push(dir);
  const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}&number=1.5`);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "valid issue number required" });
});

// ---------------------------------------------------------------------------
// GET /github/issue-thread — includeComments query param
// ---------------------------------------------------------------------------

function issueJson(): Record<string, unknown> {
  return {
    number: 7,
    title: "Something is broken",
    state: "open",
    html_url: "https://github.com/acme/widgets/issues/7",
    draft: false,
    user: { login: "octocat" },
    assignees: [],
    milestone: null,
    body: "steps to reproduce",
    labels: [],
    comments: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    locked: false,
  };
}

test("GET /github/issue-thread with includeComments=false skips the comments fetch and returns an empty thread", async () => {
  const dir = await makeGitHubRepo("acme", "widgets");
  createdDirs.push(dir);
  const mock = mockGitHubFetch([
    { match: /\/repos\/acme\/widgets\/issues\/7$/, json: issueJson() },
    // Deliberately no route for the /comments endpoint — if it were fetched
    // anyway, mockGitHubFetch would throw "no route for ..." and fail loudly.
  ]);
  try {
    const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}&number=7&includeComments=false`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(mock.calls).toHaveLength(1); // issue fetch only
  } finally {
    mock.restore();
  }
});

test("GET /github/issue-thread with includeComments=0 is also treated as false", async () => {
  const dir = await makeGitHubRepo("acme", "widgets0");
  createdDirs.push(dir);
  const mock = mockGitHubFetch([
    { match: /\/repos\/acme\/widgets0\/issues\/7$/, json: { ...issueJson(), html_url: "https://github.com/acme/widgets0/issues/7" } },
  ]);
  try {
    const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}&number=7&includeComments=0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("GET /github/issue-thread without includeComments defaults to true and fetches the comments page", async () => {
  const dir = await makeGitHubRepo("acme", "widgetstrue");
  createdDirs.push(dir);
  const mock = mockGitHubFetch([
    { match: /\/repos\/acme\/widgetstrue\/issues\/7$/, json: { ...issueJson(), html_url: "https://github.com/acme/widgetstrue/issues/7" } },
    { match: "/repos/acme/widgetstrue/issues/7/comments", json: [{ id: 1, html_url: "https://github.com/acme/widgetstrue/issues/7#issuecomment-1", body: "hi", user: { login: "octocat" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] },
  ]);
  try {
    const res = await call(`/github/issue-thread?path=${encodeURIComponent(dir)}&number=7`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(mock.calls).toHaveLength(2); // issue fetch + comments page
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// POST /tasks — issueUrl / issueSnapshot 400 rules
// ---------------------------------------------------------------------------

test("POST /tasks 400s when issueSnapshot is present without issueUrl", async () => {
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "t", prompt: "p", issueSnapshot: "# snap" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "issueSnapshot requires issueUrl" });
});

test("POST /tasks 400s when issueSnapshot exceeds 2,000,000 characters", async () => {
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "t",
      prompt: "p",
      issueUrl: "https://github.com/o/r/issues/1",
      issueSnapshot: "a".repeat(2_000_001),
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "issueSnapshot is too large" });
});

test("POST /tasks does not 400 at exactly the 2,000,000 character issueSnapshot boundary (only over-cap rejects)", async () => {
  const dir = await makeRepoWithNoRemote();
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "t",
      prompt: "p",
      workdir: dir,
      issueUrl: "https://github.com/o/r/issues/1",
      issueSnapshot: "a".repeat(2_000_000),
    }),
  });
  // Passes the size check and reaches createTask, which then rejects on the
  // no-remote workdir below — proving the boundary itself isn't the 400.
  const body = await res.json();
  expect(body.error).not.toBe("issueSnapshot is too large");
});

test("POST /tasks 400s when issueUrl is not a string", async () => {
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "t", prompt: "p", issueUrl: 12345 }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "issueUrl must be a string" });
});

test("POST /tasks with a valid issueUrl for a workdir with no remote 400s with the orchestrator's own error text (proves passthrough)", async () => {
  const dir = await makeRepoWithNoRemote();
  const res = await call("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "t",
      prompt: "p",
      workdir: dir,
      isolation: "none",
      issueUrl: "https://github.com/o/r/issues/1",
    }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  // createTask's own wording (orchestrator.ts): "<workdir> has no github
  // remote for that issue" — the route doesn't re-validate or reword it.
  expect(body.error).toContain(dir);
  expect(body.error).toContain("github");
  expect(body.error).toContain("no");
});

// ---------------------------------------------------------------------------
// rmTestDataDir (test-data-dir.ts) — its coverage lives here rather than in a
// dedicated file. Uses a synthetic `agetor.sqlite` marker in a throwaway dir
// rather than asserting on DATA_DIR above: db.ts's module-level open happens
// exactly once for the whole `bun test` process, in whichever *.test.ts
// file's AGETOR_DATA_DIR happened to be active at that moment (see
// rmTestDataDir's own doc comment) — that's reliably THIS file's DATA_DIR
// when it runs alone or alongside just pull-detail.test.ts, but NOT
// guaranteed when the full suite runs together (some alphabetically-earlier
// file that also imports db.ts, e.g. draft-endpoint.test.ts, can win the
// race instead) — so asserting against the real DATA_DIR here is racy across
// the full suite. A synthetic marker file exercises the same guard logic
// deterministically regardless of load order.
// ---------------------------------------------------------------------------

test("rmTestDataDir refuses a dir holding a sqlite file, removes a dir that doesn't", () => {
  const withSqlite = mkdtempSync(path.join(tmpdir(), "agetor-test-data-dir-live-"));
  writeFileSync(path.join(withSqlite, "agetor.sqlite"), "");
  expect(rmTestDataDir(withSqlite)).toBe(false);
  expect(existsSync(withSqlite)).toBe(true); // refused, not removed
  rmSync(withSqlite, { recursive: true, force: true }); // this test's own cleanup

  const empty = mkdtempSync(path.join(tmpdir(), "agetor-test-data-dir-empty-"));
  expect(rmTestDataDir(empty)).toBe(true);
  expect(existsSync(empty)).toBe(false);
});
