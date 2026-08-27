// Tests for the new backend single-PR fetch: the three provider fetchers
// (getGitHubPullDetail in github.ts, getGitLabPullDetail in gitlab.ts,
// getBitbucketPullDetail in bitbucket.ts), the git-host `pullDetail` facade
// dispatch, and the `GET /github/pull-detail` server route.
//
// Layering follows the sibling test files' own split:
//  - Fetcher-level tests call each provider's `get*PullDetail` directly
//    against a mocked `globalThis.fetch` (mockGitHubFetch, github-test-util.ts
//    — host-agnostic, reused as-is for GitLab/Bitbucket too, same convention
//    as git-host.test.ts and gitlab/bitbucket-test-util.ts's own re-exports).
//  - Facade-level tests call `pullDetail` from git-host.ts, mirroring
//    git-host.test.ts's existing dispatch tests (which cover every other
//    facade function except pullDetail — this file closes that gap).
//  - Route-level tests hit the real `GET /github/pull-detail` endpoint
//    through a live server, following pull-create-task-url.test.ts's
//    pattern: AGETOR_DATA_DIR + a unique AGETOR_API_PORT are set at module
//    scope BEFORE db.ts/server.ts are dynamically imported in beforeAll
//    (both capture their config at import time), and a `realFetch` captured
//    before any mock is installed is used for requests to our own server
//    (mockGitHubFetch replaces globalThis.fetch wholesale and can't tell our
//    own server apart from the GitHub/GitLab/Bitbucket API it's meant to
//    intercept).
import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeGitHubRepo, mockGitHubFetch, type FetchMock } from "./github-test-util.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { sampleRepo, gitlabMergeRequest } from "./gitlab-test-util.ts";
import { makeBitbucketRepo } from "./bitbucket-test-util.ts";
import { getGitHubPullDetail } from "./github.ts";
import { getGitLabPullDetail } from "./gitlab.ts";
import { getBitbucketPullDetail } from "./bitbucket.ts";
import { pullDetail } from "./git-host.ts";

// Route-level fixtures: AGETOR_DATA_DIR + a port unique among every other
// *.test.ts file's AGETOR_API_PORT (see the convention comment in
// draft-endpoint.test.ts / db-events-paging.test.ts / pull-create-task-url.test.ts).
const ROUTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pull-detail-route-"));
process.env.AGETOR_DATA_DIR = ROUTE_DATA_DIR;
process.env.AGETOR_API_PORT = "4497";

let server: { stop: () => void } | null = null;
let apiToken = "";
const routeUrl = (p: string) => `http://127.0.0.1:4497${p}`;
const realFetch = fetch.bind(globalThis);

// Fetcher/facade-level tests go through github-tokens.ts / GitLab token env /
// bitbucketCreds (git-provider.ts), which read AGETOR_DATA_DIR lazily at call
// time (see git-host.test.ts's own comment on this) — reset it to a fresh
// mkdtemp dir per test so a real stored token on the machine running these
// tests can never leak in, and force GITHUB_TOKEN/GITLAB_TOKEN so
// githubToken()/gitlabToken() never fall through to a real `gh`/`glab` CLI
// shellout.
const ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_EMAIL"] as const;
let savedEnv: Record<string, string | undefined> = {};
let perTestDataDir = "";
let fetchMock: FetchMock | null = null;
let createdDirs: string[] = [];

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  apiToken = API_TOKEN;
});

beforeEach(() => {
  perTestDataDir = mkdtempSync(path.join(tmpdir(), "agetor-pull-detail-"));
  process.env.AGETOR_DATA_DIR = perTestDataDir;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GITHUB_TOKEN = "gh-test-token";
  process.env.GITLAB_TOKEN = "glab-test-token";
});

afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
  rmSync(perTestDataDir, { recursive: true, force: true });
  process.env.AGETOR_DATA_DIR = ROUTE_DATA_DIR;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs = [];
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(ROUTE_DATA_DIR);
});

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

/** A throwaway git repo whose remote is NOT github/gitlab/bitbucket — used to
 *  exercise `pullDetail`'s NO_REMOTE_ERROR path, mirroring git-host.test.ts's
 *  own "providerInfoForDir errors on an unsupported git remote" test. */
async function makeUnsupportedRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pull-detail-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", "git@example.com:acme/app.git"], dir);
  return dir;
}

async function makeGitLabRepoDir(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pull-detail-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", "https://gitlab.com/acme/app.git"], dir);
  return dir;
}

function bitbucketPull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4,
    title: "Add widget",
    state: "OPEN",
    draft: false,
    links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/4" } },
    author: { nickname: "alice", links: {} },
    description: "body text",
    comment_count: 1,
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function githubPull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Add feature",
    state: "open",
    html_url: "https://github.com/acme/widgets/pull/7",
    draft: false,
    user: { login: "octocat" },
    assignees: [],
    milestone: null,
    body: "body text",
    labels: [],
    comments: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    locked: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GitHub fetcher: getGitHubPullDetail
// ---------------------------------------------------------------------------

test("getGitHubPullDetail happy path normalizes the item and stamps sourcePath with dir", async () => {
  const dir = await makeGitHubRepo("acme", "widgets");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([
    { match: "https://api.github.com/repos/acme/widgets/pulls/7", json: githubPull() },
  ]);

  const res = await getGitHubPullDetail({ dir, number: 7 });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.item.number).toBe(7);
  expect(res.item.kind).toBe("pulls");
  expect(res.item.htmlUrl).toBe("https://github.com/acme/widgets/pull/7");
  expect(res.item.sourcePath).toBe(dir);
  expect(fetchMock.calls).toHaveLength(1);
  expect(fetchMock.calls[0]!.method).toBe("GET");
});

test("getGitHubPullDetail maps a non-2xx GitHub response through privateRepoHint", async () => {
  const dir = await makeGitHubRepo("acme", "widgets2");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([
    { match: "/repos/acme/widgets2/pulls/9", status: 404, json: { message: "Not Found" } },
  ]);

  const res = await getGitHubPullDetail({ dir, number: 9 });
  // GITHUB_TOKEN is forced to "gh-test-token" in beforeEach above, so the
  // hadToken branch of privateRepoHint's message is the one that fires.
  expect(res).toEqual({
    ok: false,
    error: "acme/widgets2 was not found on GitHub — if the repo is private, add a token for github.com in "
      + "Settings → Git host tokens (the configured token cannot access it — check it belongs to the right account)",
  });
});

test("getGitHubPullDetail rejects a non-positive/non-integer number before any fetch", async () => {
  const dir = await makeGitHubRepo("acme", "widgets3");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([]); // any fetch call would throw — proves none happens

  for (const bad of [0, -1, 1.5]) {
    const res = await getGitHubPullDetail({ dir, number: bad });
    expect(res).toEqual({ ok: false, error: "pull request number must be positive" });
  }
  expect(fetchMock.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// GitLab fetcher: getGitLabPullDetail
// ---------------------------------------------------------------------------

test("getGitLabPullDetail happy path normalizes the merge request", async () => {
  const repo = sampleRepo();
  fetchMock = mockGitHubFetch([
    {
      match: /gitlab\.com\/api\/v4\/projects\/acme%2Fapp\/merge_requests\/12$/,
      json: gitlabMergeRequest({
        iid: 12,
        title: "Fix bug",
        web_url: "https://gitlab.com/acme/app/-/merge_requests/12",
      }),
    },
  ]);

  const res = await getGitLabPullDetail(repo, 12);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.item.number).toBe(12);
  expect(res.item.kind).toBe("pulls");
  expect(res.item.htmlUrl).toBe("https://gitlab.com/acme/app/-/merge_requests/12");
  // The adapter never resolves a working directory (see gitlab.ts's module
  // doc comment) — sourcePath is always null here; the facade stitches it on.
  expect(res.item.sourcePath).toBeNull();
});

test("getGitLabPullDetail rejects an invalid merge request number before any fetch", async () => {
  const repo = sampleRepo();
  fetchMock = mockGitHubFetch([]);

  for (const bad of [0, -3, 2.5]) {
    const res = await getGitLabPullDetail(repo, bad);
    expect(res).toEqual({ ok: false, error: "merge request number must be positive" });
  }
  expect(fetchMock.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Bitbucket fetcher: getBitbucketPullDetail
// ---------------------------------------------------------------------------

test("getBitbucketPullDetail happy path normalizes the pull request", async () => {
  const repo = makeBitbucketRepo("acme", "app");
  fetchMock = mockGitHubFetch([
    { match: /api\.bitbucket\.org\/2\.0\/repositories\/acme\/app\/pullrequests\/4$/, json: bitbucketPull() },
  ]);

  const res = await getBitbucketPullDetail(repo, 4);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.item.number).toBe(4);
  expect(res.item.kind).toBe("pulls");
  expect(res.item.htmlUrl).toBe("https://bitbucket.org/acme/app/pull-requests/4");
  expect(res.item.sourcePath).toBeNull();
});

test("getBitbucketPullDetail rejects an invalid pull request number before the creds lookup (no fetch)", async () => {
  const repo = makeBitbucketRepo("acme", "app2");
  fetchMock = mockGitHubFetch([]); // proves bitbucketCreds() is never reached, let alone a fetch

  for (const bad of [0, -2, 3.5]) {
    const res = await getBitbucketPullDetail(repo, bad);
    expect(res).toEqual({ ok: false, error: "pull request number must be positive" });
  }
  expect(fetchMock.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// git-host facade: pullDetail dispatch
// ---------------------------------------------------------------------------

test("pullDetail on a dir with no supported git remote returns the facade's NO_REMOTE_ERROR", async () => {
  const dir = await makeUnsupportedRepo();
  const res = await pullDetail({ dir, number: 1 });
  expect(res).toEqual({
    ok: false,
    error: "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)",
  });
});

test("pullDetail dispatches a gitlab repo to the GitLab API and stitches sourcePath onto the item", async () => {
  const dir = await makeGitLabRepoDir();
  fetchMock = mockGitHubFetch([
    {
      match: /gitlab\.com\/api\/v4\/projects\/acme%2Fapp\/merge_requests\/3$/,
      json: gitlabMergeRequest({ iid: 3 }),
    },
  ]);

  const res = await pullDetail({ dir, number: 3 });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.item.number).toBe(3);
  expect(res.item.sourcePath).toBe(dir);
});

// ---------------------------------------------------------------------------
// Route: GET /github/pull-detail
// ---------------------------------------------------------------------------

test("GET /github/pull-detail without a path returns 400 'path required'", async () => {
  const res = await realFetch(routeUrl("/github/pull-detail?number=1"), {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "path required" });
});

test("GET /github/pull-detail with a missing/non-numeric number returns 400", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pull-detail-route-num-"));
  createdDirs.push(dir);

  // number omitted entirely
  const missing = await realFetch(routeUrl(`/github/pull-detail?path=${encodeURIComponent(dir)}`), {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: "valid pull request number required" });

  // number non-numeric
  const nonNumeric = await realFetch(
    routeUrl(`/github/pull-detail?path=${encodeURIComponent(dir)}&number=abc`),
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  expect(nonNumeric.status).toBe(400);
  expect(await nonNumeric.json()).toEqual({ error: "valid pull request number required" });
});

test("GET /github/pull-detail happy path passes through the fetcher's normalized item", async () => {
  const dir = await makeGitHubRepo("acme", "routewidgets");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([
    {
      match: "https://api.github.com/repos/acme/routewidgets/pulls/11",
      json: githubPull({ number: 11, html_url: "https://github.com/acme/routewidgets/pull/11" }),
    },
  ]);

  const res = await realFetch(
    routeUrl(`/github/pull-detail?path=${encodeURIComponent(dir)}&number=11`),
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.item.number).toBe(11);
  expect(body.item.htmlUrl).toBe("https://github.com/acme/routewidgets/pull/11");
});
