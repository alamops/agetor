import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR before db.ts/server.ts are ever imported (module-load
// side effect opens the sqlite db at the path AGETOR_DATA_DIR names).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-files-index-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT
// (4593 is free per the sibling files' running tally).
process.env.AGETOR_API_PORT = "4593";

const BASE = "http://127.0.0.1:4593";

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
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

const callNoAuth = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

// Standalone helper: run git in a directory, fire-and-forget (mirrors
// worktree.test.ts's own local `git()` helper — this repo keeps such
// spawning helpers local to each test file rather than sharing one).
async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-files-index-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

test("GET /files/index (live mode, no ref) lists tracked + untracked files", async () => {
  const repo = await makeRepo();
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");

  const res = await call(`/files/index?dir=${encodeURIComponent(repo)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { files: string[]; truncated: boolean };
  expect(body.files).toContain("README.md");
  expect(body.files).toContain("untracked.txt");
  expect(body.truncated).toBe(false);
});

test("GET /files/index (ref mode) lists only the tracked files at that ref", async () => {
  const repo = await makeRepo();
  // Untracked file must not show up in ref mode even though it's on disk.
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");

  const res = await call(`/files/index?dir=${encodeURIComponent(repo)}&ref=HEAD`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { files: string[]; truncated: boolean };
  expect(body.files).toContain("README.md");
  expect(body.files).not.toContain("untracked.txt");
});

test("GET /files/index without dir → 400", async () => {
  const res = await call(`/files/index`);
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test("GET /files/index with a relative dir → 400", async () => {
  const res = await call(`/files/index?dir=${encodeURIComponent("relative/path")}`);
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test("GET /files/index on a non-repo directory → 400 with an error string", async () => {
  const notARepo = mkdtempSync(path.join(tmpdir(), "agetor-files-index-not-a-repo-"));
  const res = await call(`/files/index?dir=${encodeURIComponent(notARepo)}`);
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(typeof parsed.error).toBe("string");
  expect(parsed.error.length).toBeGreaterThan(0);
});

test("GET /files/index with an unknown ref → 400", async () => {
  const repo = await makeRepo();
  const res = await call(`/files/index?dir=${encodeURIComponent(repo)}&ref=does-not-exist-anywhere`);
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toMatch(/unknown ref/);
});

test("GET /files/index without a bearer token → 401", async () => {
  const repo = await makeRepo();
  const res = await callNoAuth(`/files/index?dir=${encodeURIComponent(repo)}`);
  expect(res.status).toBe(401);
});
