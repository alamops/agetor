// The git-host facade's remote-branch reads (`listBranches`, `branchInfo`,
// `remoteDefaultBranch`) and `pullCreate`'s already-exists passthrough, driven
// from a real project directory: `providerRepoForDir` resolves the remote with
// a real `git remote` walk, and each call must land on THAT provider's API
// (docs/plans/create-all-prs-title-and-base.md T2/T9). The adapters themselves
// are covered by {github,gitlab,bitbucket}-branches.test.ts; this file pins the
// dispatch `pullTargets` and `POST /github/pull-create` go through.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockGitHubFetch, type FetchMock, type MockRoute } from "./github-test-util.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// git-host.ts reaches db.ts through the forge adapters: set the data dir at the
// top level and import dynamically (CLAUDE.md, Persistence → Tests). Tokens come
// from the env tier, forced so no call falls through to a `gh`/`glab` shellout.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-git-host-branches-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
const { branchInfo, listBranches, pullCreate, remoteDefaultBranch } = await import("./git-host.ts");
const { __clearApiHostCacheForTest } = await import("./git-provider.ts");

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "BITBUCKET_EMAIL",
] as const;
const saved: Record<string, string | undefined> = {};
let fetchMock: FetchMock | null = null;
const createdDirs: string[] = [];

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GITHUB_TOKEN = "gh-test-token";
  delete process.env.GH_TOKEN;
  process.env.GITLAB_TOKEN = "glab-test-token";
  process.env.BITBUCKET_TOKEN = "bb-test-token";
  delete process.env.BITBUCKET_EMAIL;
});

beforeEach(() => __clearApiHostCacheForTest());

afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
  __clearApiHostCacheForTest();
});

afterAll(() => {
  rmTestDataDir(DATA_DIR);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${await new Response(proc.stderr).text()}`);
}

async function repoWithOrigin(url: string | null): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-host-branches-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  if (url) await git(["remote", "add", "origin", url], dir);
  return dir;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

interface ProviderCase {
  provider: string;
  remote: string;
  /** Exact (anchored) routes on this provider's API only: a call dispatched to another provider finds no route and throws. */
  routes: MockRoute[];
  apiHost: string;
}

const CASES: ProviderCase[] = [
  {
    provider: "github",
    remote: "https://github.com/acme/app.git",
    apiHost: "api.github.com",
    routes: [
      {
        match: new RegExp(`^${esc("https://api.github.com/repos/acme/app/branches?per_page=100&page=1")}$`),
        json: [
          { name: "main", commit: { sha: "a1" } },
          { name: "feature/x", commit: { sha: "b2" } },
        ],
      },
      {
        match: new RegExp(`^${esc("https://api.github.com/repos/acme/app/branches/feature/x")}$`),
        json: { name: "feature/x", commit: { sha: "b2" } },
      },
      {
        match: new RegExp(`^${esc("https://api.github.com/repos/acme/app/branches/gone")}$`),
        status: 404,
        json: { message: "Branch not found" },
      },
      { match: new RegExp(`^${esc("https://api.github.com/repos/acme/app")}$`), json: { default_branch: "trunk" } },
    ],
  },
  {
    provider: "gitlab",
    remote: "https://gitlab.com/acme/app.git",
    apiHost: "gitlab.com/api/v4",
    routes: [
      {
        match: new RegExp(`^${esc("https://gitlab.com/api/v4/projects/acme%2Fapp/repository/branches?per_page=100&page=1")}$`),
        json: [
          { name: "main", commit: { id: "a1" } },
          { name: "feature/x", commit: { id: "b2" } },
        ],
      },
      {
        match: new RegExp(`^${esc("https://gitlab.com/api/v4/projects/acme%2Fapp/repository/branches/feature%2Fx")}$`),
        json: { name: "feature/x", commit: { id: "b2" } },
      },
      {
        match: new RegExp(`^${esc("https://gitlab.com/api/v4/projects/acme%2Fapp/repository/branches/gone")}$`),
        status: 404,
        json: { message: "404 Branch Not Found" },
      },
      { match: new RegExp(`^${esc("https://gitlab.com/api/v4/projects/acme%2Fapp")}$`), json: { default_branch: "trunk" } },
    ],
  },
  {
    provider: "bitbucket",
    remote: "https://bitbucket.org/acme/app.git",
    apiHost: "api.bitbucket.org/2.0",
    routes: [
      {
        match: /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/acme\/app\/refs\/branches\?pagelen=100/,
        json: {
          values: [
            { name: "main", target: { hash: "a1" } },
            { name: "feature/x", target: { hash: "b2" } },
          ],
        },
      },
      {
        match: new RegExp(`^${esc("https://api.bitbucket.org/2.0/repositories/acme/app/refs/branches/feature/x")}$`),
        json: { name: "feature/x", target: { hash: "b2" } },
      },
      {
        match: new RegExp(`^${esc("https://api.bitbucket.org/2.0/repositories/acme/app/refs/branches/gone")}$`),
        status: 404,
        json: { type: "error", error: { message: "Branch gone not found" } },
      },
      {
        match: new RegExp(`^${esc("https://api.bitbucket.org/2.0/repositories/acme/app")}$`),
        json: { mainbranch: { name: "trunk" } },
      },
    ],
  },
];

for (const c of CASES) {
  test(`${c.provider}: listBranches, branchInfo and remoteDefaultBranch dispatch to the project's own forge`, async () => {
    const dir = await repoWithOrigin(c.remote);
    fetchMock = mockGitHubFetch(c.routes);

    const list = await listBranches({ dir });
    expect(list).toEqual({
      ok: true,
      branches: [
        { name: "main", sha: "a1" },
        { name: "feature/x", sha: "b2" },
      ],
      truncated: false,
    });

    expect(await branchInfo({ dir, name: "feature/x" })).toEqual({ ok: true, branch: { name: "feature/x", sha: "b2" } });
    // The forge has no such branch: an answer, not an error.
    expect(await branchInfo({ dir, name: "gone" })).toEqual({ ok: true, branch: null });

    expect(await remoteDefaultBranch({ dir })).toEqual({ ok: true, name: "trunk" });

    expect(fetchMock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of fetchMock.calls) expect(call.url).toContain(c.apiHost);
  });
}

test("every facade read refuses a project with no supported remote, without calling any forge", async () => {
  const unsupported = await repoWithOrigin("git@example.com:x/y.git");
  const noRemote = await repoWithOrigin(null);
  fetchMock = mockGitHubFetch([]);
  for (const dir of [unsupported, noRemote]) {
    for (const res of [
      await listBranches({ dir }),
      await branchInfo({ dir, name: "main" }),
      await remoteDefaultBranch({ dir }),
      await pullCreate({ dir, title: "t", head: "feature/x", base: "main" }),
    ]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("supported git remote");
    }
  }
  expect(fetchMock.calls).toEqual([]);
});

test("pullCreate passes a GitLab 'already exists' answer through as code and existingUrl", async () => {
  const dir = await repoWithOrigin("https://gitlab.com/acme/app.git");
  fetchMock = mockGitHubFetch([
    { method: "GET", match: /\/api\/v4\/projects\/acme%2Fapp$/, json: { id: 77 } },
    {
      method: "POST",
      match: "/merge_requests",
      status: 409,
      json: { message: ["Another open merge request already exists for this source branch: !12"] },
    },
  ]);
  const res = await pullCreate({ dir, title: "t", head: "feature/x", base: "develop" });
  expect(res).toMatchObject({
    ok: false,
    code: "already-exists",
    existingUrl: "https://gitlab.com/acme/app/-/merge_requests/12",
  });
});

test("pullCreate passes a Bitbucket duplicate-PR answer through as code and existingUrl", async () => {
  const dir = await repoWithOrigin("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests",
      status: 400,
      json: { type: "error", error: { message: "There is already an open pull request for this source and destination." } },
    },
    {
      method: "GET",
      match: "/pullrequests?pagelen=1",
      json: { values: [{ links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/4" } } }] },
    },
  ]);
  const res = await pullCreate({ dir, title: "t", head: "feature/x", base: "develop" });
  expect(res).toMatchObject({
    ok: false,
    code: "already-exists",
    existingUrl: "https://bitbucket.org/acme/app/pull-requests/4",
  });
});
