// Route-level tests for the two HTTP surfaces Task A adds
// (docs/plans/new-task-from-git-issue.md): `GET /github/issue-thread`'s
// input validation, and `POST /tasks`'s `issueUrl`/`issueSnapshot` 400 rules
// (server.ts ~lines 1008-1023 and ~3401-3430). Mirrors draft-endpoint.test.ts /
// pull-detail.test.ts's route-level convention: AGETOR_DATA_DIR + a unique
// AGETOR_API_PORT are set at module scope BEFORE db.ts/server.ts are
// dynamically imported in beforeAll (both capture their config at import
// time), and a bearer-token `authed()` helper drives every request.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-issue-thread-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4589";

const BASE = "http://127.0.0.1:4589";

let server: { stop: () => void };
let token: string;
let createdDirs: string[] = [];

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  // Deliberately does NOT rmSync(DATA_DIR, ...): `bun test` shares one process
  // (and one module registry) across every *.test.ts file it's given, so
  // db.ts — imported here dynamically — is a singleton for the whole run.
  // Whichever *.test.ts file's AGETOR_DATA_DIR happened to be set when db.ts
  // was FIRST imported is the one every other file's db.ts import actually
  // shares (see draft-endpoint.test.ts / orchestrator-baseref.test.ts, which
  // follow the same no-cleanup convention for this exact reason) — deleting
  // this directory here would risk yanking the sqlite file out from under a
  // still-open connection a later-loaded test file's `createTask`/`tasks.*`
  // call depends on, surfacing as an opaque SQLITE_IOERR rather than this
  // file's own tests failing.
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
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
