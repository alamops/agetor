import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  providerInfoForDir,
  listItems,
  pullDefaults,
  labels,
  pullReopen,
} from "./git-host.ts";
import { makeGitHubRepo } from "./github-test-util.ts";
import { mockGitHubFetch, type FetchMock } from "./github-test-util.ts";

// git-host.ts dispatches through git-provider.ts's providerRepoForDir (a real
// `git remote` shellout against a temp repo) and, for gitlab/bitbucket, through
// gitlabToken/bitbucketCreds (github-tokens.ts), which are lazy-AGETOR_DATA_DIR
// like github-tokens.test.ts. GITHUB_TOKEN/GITLAB_TOKEN are forced in
// beforeEach so githubToken()/gitlabToken() never fall through to a real `gh`/
// `glab` CLI shellout (mirrors github-network.test.ts's convention) —
// bitbucketCreds has no CLI fallback tier, so it's fine to leave unset.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_EMAIL"] as const;
let dataDir: string;
let savedEnv: Record<string, string | undefined> = {};
let createdDirs: string[] = [];
let fetchMock: FetchMock | null = null;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-git-host-tokens-"));
  process.env.AGETOR_DATA_DIR = dataDir;
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
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs = [];
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
});

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(remoteUrl: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-host-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", remoteUrl], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// providerInfoForDir
// ---------------------------------------------------------------------------

test("providerInfoForDir resolves a github repo", async () => {
  const dir = await makeGitHubRepo("acme", "app");
  createdDirs.push(dir);
  expect(await providerInfoForDir(dir)).toEqual({
    ok: true,
    provider: "github",
    owner: "acme",
    name: "app",
    host: "github.com",
    remoteHost: "github.com",
  });
});

test("providerInfoForDir resolves a gitlab repo", async () => {
  const dir = await makeRepo("https://gitlab.com/acme/app.git");
  expect(await providerInfoForDir(dir)).toEqual({
    ok: true,
    provider: "gitlab",
    owner: "acme",
    name: "app",
    host: "gitlab.com",
    remoteHost: "gitlab.com",
  });
});

test("providerInfoForDir resolves a bitbucket repo", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  expect(await providerInfoForDir(dir)).toEqual({
    ok: true,
    provider: "bitbucket",
    owner: "acme",
    name: "app",
    host: "bitbucket.org",
    remoteHost: "bitbucket.org",
  });
});

test("providerInfoForDir resolves an ssh host-alias bitbucket remote — provider bitbucket, host canonicalized, remoteHost preserved as the alias", async () => {
  const dir = await makeRepo("git@bitbucket-work.com:acme/app.git");
  expect(await providerInfoForDir(dir)).toEqual({
    ok: true,
    provider: "bitbucket",
    owner: "acme",
    name: "app",
    host: "bitbucket.org",
    remoteHost: "bitbucket-work.com",
  });
});

test("providerInfoForDir errors on an unsupported git remote", async () => {
  const dir = await makeRepo("git@example.com:acme/app.git");
  expect(await providerInfoForDir(dir)).toEqual({
    ok: false,
    error: "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)",
  });
});

// ---------------------------------------------------------------------------
// Dispatch: listItems
// ---------------------------------------------------------------------------

test("listItems dispatches a gitlab repo to the GitLab API and stitches sourcePath", async () => {
  const dir = await makeRepo("https://gitlab.com/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: "gitlab.com/api/v4/projects/acme%2Fapp/merge_requests",
      json: [
        {
          iid: 5,
          title: "Add feature",
          state: "opened",
          web_url: "https://gitlab.com/acme/app/-/merge_requests/5",
          author: { username: "alice" },
          assignees: [],
          milestone: null,
          description: "body text",
          labels: [],
          user_notes_count: 0,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    },
  ]);

  const res = await listItems({ dir, kind: "pulls", state: "open" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.items).toHaveLength(1);
  expect(res.items[0]).toMatchObject({ number: 5, title: "Add feature", sourcePath: dir });

  const call = fetchMock.calls.find((c) => c.url.includes("merge_requests"));
  expect(call?.url).toContain("/projects/acme%2Fapp/merge_requests");
});

test("listItems dispatches a bitbucket repo to the Bitbucket API and stitches sourcePath", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: "api.bitbucket.org/2.0/repositories/acme/app/pullrequests",
      json: {
        values: [
          {
            id: 7,
            title: "Fix bug",
            state: "OPEN",
            links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/7" } },
            author: { nickname: "bob" },
            description: "desc",
            comment_count: 0,
            created_on: "2026-01-01T00:00:00Z",
            updated_on: "2026-01-02T00:00:00Z",
          },
        ],
      },
    },
  ]);

  const res = await listItems({ dir, kind: "pulls", state: "open" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.items).toHaveLength(1);
  expect(res.items[0]).toMatchObject({ number: 7, title: "Fix bug", sourcePath: dir });

  const call = fetchMock.calls.find((c) => c.url.includes("pullrequests"));
  expect(call?.url).toContain("/2.0/repositories/acme/app/pullrequests");
});

test("listItems dispatches a github repo to the GitHub API (existing behavior preserved)", async () => {
  const dir = await makeGitHubRepo("acme", "app");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([
    {
      match: "api.github.com/repos/acme/app/pulls",
      json: [
        {
          number: 3,
          title: "Add thing",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/app/pull/3",
          user: { login: "alice" },
          assignees: [],
          milestone: null,
          body: "body",
          labels: [],
          comments: 0,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          closed_at: null,
          merged_at: null,
          locked: false,
        },
      ],
    },
  ]);

  const res = await listItems({ dir, kind: "pulls", state: "open" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.items).toHaveLength(1);
  expect(res.items[0]).toMatchObject({ number: 3, title: "Add thing", sourcePath: dir });

  const call = fetchMock.calls.find((c) => c.url.includes("api.github.com"));
  expect(call?.url).toContain("api.github.com/repos/acme/app/pulls");
});

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

test("labels on a bitbucket repo returns an empty list without any fetch", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([]); // any fetch call would throw — asserting none happens

  const res = await labels({ dir });
  expect(res).toEqual({ ok: true, repo: "acme/app", labels: [] });
  expect(fetchMock.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// pullDefaults
// ---------------------------------------------------------------------------

test("pullDefaults on a gitlab repo fills head from the local current branch", async () => {
  const dir = await makeRepo("https://gitlab.com/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: /gitlab\.com\/api\/v4\/projects\/acme%2Fapp$/,
      json: { default_branch: "develop" },
    },
  ]);

  const res = await pullDefaults({ dir });
  expect(res).toEqual({ ok: true, repo: "acme/app", head: "main", base: "develop" });
});

test("pullDefaults on a bitbucket repo fills head from the local current branch", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: /api\.bitbucket\.org\/2\.0\/repositories\/acme\/app$/,
      json: { mainbranch: { name: "trunk" } },
    },
  ]);

  const res = await pullDefaults({ dir });
  expect(res).toEqual({ ok: true, repo: "acme/app", head: "main", base: "trunk" });
});

// ---------------------------------------------------------------------------
// Unsupported-op errors surface through the facade
// ---------------------------------------------------------------------------

test("pullReopen on a bitbucket repo surfaces the 'cannot be reopened' error", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([]); // reopenBitbucketPull never fetches — asserting none happens

  const res = await pullReopen({ dir, number: 1 });
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.error).toContain("cannot be reopened");
  expect(fetchMock.calls).toHaveLength(0);
});
