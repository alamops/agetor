// `GET /github/pull-targets` and the `/github/pull-create` error passthrough
// (docs/plans/create-all-prs-title-and-base.md T13).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeGitHubRepo, mockGitHubFetch, type FetchMock } from "./github-test-util.ts";

// Top-level, before any sibling file imports server.ts / db.ts; the port is unique among *.test.ts files.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pull-targets-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4777";

let server: { stop: () => void } | null = null;
let token: string;
const url = (p: string) => `http://127.0.0.1:4777${p}`;
let fetchMock: FetchMock | null = null;
const savedGithubToken = process.env.GITHUB_TOKEN;
// mockGitHubFetch replaces `globalThis.fetch` wholesale, so the real one is kept for our own server.
const realFetch = fetch.bind(globalThis);

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
  process.env.GITHUB_TOKEN = "gh-test-token";
});

afterAll(() => {
  server?.stop?.();
  fetchMock?.restore();
  if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedGithubToken;
});

const get = (p: string) => realFetch(url(p), { headers: { authorization: `Bearer ${token}` } });

const branchRows = [
  { name: "main", commit: { sha: "a".repeat(40) } },
  { name: "develop", commit: { sha: "b".repeat(40) } },
  { name: "feature/x", commit: { sha: "c".repeat(40) } },
];

test("answers the repository's identity, default branch, branches and head facts", async () => {
  const dir = await makeGitHubRepo("acme", "widgets");
  fetchMock = mockGitHubFetch([
    { match: "/branches?per_page=100", json: branchRows },
    { match: "https://api.github.com/repos/acme/widgets", json: { default_branch: "main" } },
  ]);
  try {
    const q = new URLSearchParams({ path: dir, head: "feature/x", storedBase: "develop", liveHead: "feature/x" });
    q.append("head", "feature/missing");
    const res = await get(`/github/pull-targets?${q}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      provider: "github",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
      branches: ["main", "develop", "feature/x"],
      branchesTruncated: false,
      branchesError: null,
      heads: [
        { name: "feature/x", onRemote: true },
        { name: "feature/missing", onRemote: false },
      ],
    });
    expect(body.storedBase).toMatchObject({ name: "develop", onRemote: true });
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }
});

test("input errors: missing path, too many heads, bad names and a bad sha are 400", async () => {
  expect((await get("/github/pull-targets")).status).toBe(400);

  const many = new URLSearchParams({ path: "/tmp" });
  for (let i = 0; i < 21; i++) many.append("head", `b${i}`);
  expect((await get(`/github/pull-targets?${many}`)).status).toBe(400);

  const bad = await get(`/github/pull-targets?${new URLSearchParams({ path: "/tmp", head: "a..b" })}`);
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain('head "a..b"');

  const dash = await get(`/github/pull-targets?${new URLSearchParams({ path: "/tmp", storedBase: "--evil" })}`);
  expect(dash.status).toBe(400);
  expect((await dash.json()).error).toContain("storedBase");

  const live = await get(`/github/pull-targets?${new URLSearchParams({ path: "/tmp", liveHead: "a b" })}`);
  expect(live.status).toBe(400);

  const sha = await get(`/github/pull-targets?${new URLSearchParams({ path: "/tmp", storedBaseSha: "--output=x" })}`);
  expect(sha.status).toBe(400);
  expect((await sha.json()).error).toContain("storedBaseSha");
});

test("a project with no supported remote is a 400", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pull-targets-nogit-"));
  const res = await get(`/github/pull-targets?${new URLSearchParams({ path: dir })}`);
  expect(res.status).toBe(400);
});

test("a forge outage degrades to branchesError instead of failing the request", async () => {
  const dir = await makeGitHubRepo("acme", "outage");
  fetchMock = mockGitHubFetch([
    { match: "/branches?per_page=100", status: 500, json: { message: "boom" } },
    { match: "https://api.github.com/repos/acme/outage", json: { default_branch: "trunk" } },
  ]);
  try {
    const res = await get(`/github/pull-targets?${new URLSearchParams({ path: dir, head: "feature/x" })}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branchesError).toBe("boom");
    expect(body.heads).toEqual([{ name: "feature/x", onRemote: null }]);
    expect(body.defaultBranch).toBe("trunk");
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }
});

test("branches=none skips the branch listing and looks each name up on its own", async () => {
  const dir = await makeGitHubRepo("acme", "chip");
  fetchMock = mockGitHubFetch([
    // No route for the list: a listing request would throw and surface as branchesError.
    { match: /\/branches\/feature\/x$/, json: { name: "feature/x", commit: { sha: "c".repeat(40) } } },
    { match: "https://api.github.com/repos/acme/chip", json: { default_branch: "main" } },
  ]);
  try {
    const q = new URLSearchParams({ path: dir, head: "feature/x", branches: "none" });
    const res = await get(`/github/pull-targets?${q}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branches).toEqual([]);
    expect(body.branchesError).toBeNull();
    expect(body.heads).toEqual([{ name: "feature/x", onRemote: true }]);
    expect(fetchMock.calls.some((c) => c.url.includes("/branches?per_page"))).toBe(false);
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }
});

test("pull-create passes a forge's already-exists classification through as code and existingUrl", async () => {
  const dir = await makeGitHubRepo("acme", "dupe");
  fetchMock = mockGitHubFetch([
    {
      method: "POST",
      match: /\/pulls$/,
      status: 422,
      json: { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:feature/x." }] },
    },
    { method: "GET", match: "/pulls?head=", json: [{ html_url: "https://github.com/acme/dupe/pull/3" }] },
  ]);
  try {
    const res = await realFetch(url("/github/pull-create"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: dir, title: "T", head: "feature/x", base: "main" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("already-exists");
    expect(body.existingUrl).toBe("https://github.com/acme/dupe/pull/3");
    expect(body.error).toContain("already exists");
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }
});

test("an ordinary pull-create failure carries no code", async () => {
  const dir = await makeGitHubRepo("acme", "plain");
  fetchMock = mockGitHubFetch([
    { method: "POST", match: /\/pulls$/, status: 500, json: { message: "boom" } },
  ]);
  try {
    const res = await realFetch(url("/github/pull-create"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: dir, title: "T", head: "feature/x", base: "main" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "boom" });
  } finally {
    fetchMock.restore();
    fetchMock = null;
  }
});
