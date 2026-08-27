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
  pullBlob,
  issueThread,
  refetchCommandFor,
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

// ---------------------------------------------------------------------------
// pullBlob
// ---------------------------------------------------------------------------

test("pullBlob on a gitlab repo dispatches to getGitLabPullBlob and returns the file bytes", async () => {
  const dir = await makeRepo("https://gitlab.com/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: "/api/v4/projects/acme%2Fapp/merge_requests/1",
      json: {
        iid: 1,
        diff_refs: { base_sha: "base123", head_sha: "head456" },
        source_project_id: 10,
        target_project_id: 10,
      },
    },
    {
      match: /\/repository\/files\/.*\/raw\?ref=head456/,
      text: "PNGDATA",
      headers: { "content-type": "application/octet-stream" },
    },
  ]);

  const res = await pullBlob({ dir, number: 1, path: "assets/logo.png", side: "new" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.ref).toBe("head456");
  expect(res.contentType).toBe("image/png");
  expect(new TextDecoder().decode(res.bytes)).toBe("PNGDATA");
  expect(fetchMock.calls.some((c) => c.url.includes("/merge_requests/1"))).toBe(true);
});

// Bitbucket's `getBitbucketPullBlob` is implemented in bitbucket.ts (owned by
// a sibling change) — this dispatch test doesn't assume its exact endpoint
// shape, only that git-host.ts no longer short-circuits to 501 without
// attempting a fetch. A catch-all route means whatever endpoint(s) the
// Bitbucket adapter calls get *some* response instead of mockGitHubFetch
// throwing "no route for ...".
test("pullBlob on a bitbucket repo dispatches to the provider instead of returning 501", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([{ match: /.*/, status: 404, json: { error: { message: "not found" } } }]);

  const res = await pullBlob({ dir, number: 1, path: "assets/logo.png", side: "old" });
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.status).not.toBe(501);
  expect(fetchMock.calls.length).toBeGreaterThan(0);
});

test("pullBlob rejects an unsafe (path-traversal) filePath with 400 before dispatching to any provider — even github", async () => {
  const dir = await makeGitHubRepo("acme", "app");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([]); // a safe dispatch would fetch the Contents API — asserting it never gets there

  const res = await pullBlob({ dir, number: 1, path: "../../etc/passwd", side: "new" });
  expect(res).toEqual({ ok: false, status: 400, error: "invalid path" });
  expect(fetchMock.calls).toHaveLength(0);
});

test("pullBlob rejects an absolute filePath with 400", async () => {
  const dir = await makeGitHubRepo("acme", "app");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([]);

  const res = await pullBlob({ dir, number: 1, path: "/etc/passwd", side: "new" });
  expect(res).toEqual({ ok: false, status: 400, error: "invalid path" });
  expect(fetchMock.calls).toHaveLength(0);
});

test("pullBlob on a repo with no supported git remote returns 400 without a path/provider check", async () => {
  const dir = await makeRepo("git@example.com:acme/app.git");
  fetchMock = mockGitHubFetch([]);

  const res = await pullBlob({ dir, number: 1, path: "assets/logo.png", side: "new" });
  expect(res).toEqual({
    ok: false,
    status: 400,
    error: "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)",
  });
  expect(fetchMock.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// issueThread dispatch (docs/plans/new-task-from-git-issue.md, Task A)
// ---------------------------------------------------------------------------

function githubIssueJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Something is broken",
    state: "open",
    html_url: "https://github.com/acme/app/issues/7",
    draft: false,
    user: { login: "octocat" },
    assignees: [],
    milestone: null,
    body: "steps to reproduce",
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    locked: false,
    ...overrides,
  };
}

test("issueThread dispatches a github repo directly (sourcePath already stamped) with refetchCommand null when gh isn't on PATH", async () => {
  const dir = await makeGitHubRepo("acme", "app");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([
    { match: /\/repos\/acme\/app\/issues\/7$/, json: githubIssueJson() },
    { match: "/repos/acme/app/issues/7/comments", json: [] },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path"; // deny the gh/glab shellouts
  try {
    const res = await issueThread({ dir, number: 7 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.item.number).toBe(7);
    expect(res.item.kind).toBe("issues");
    expect(res.item.sourcePath).toBe(dir);
    expect(res.refetchCommand).toBeNull();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("issueThread with includeComments:false passes it through to the github adapter, skipping the comments fetch", async () => {
  const dir = await makeGitHubRepo("acme", "app1b");
  createdDirs.push(dir);
  fetchMock = mockGitHubFetch([
    { match: /\/repos\/acme\/app1b\/issues\/7$/, json: githubIssueJson({ html_url: "https://github.com/acme/app1b/issues/7" }) },
    // Deliberately no route for the /comments endpoint — if it were fetched
    // anyway, mockGitHubFetch would throw "no route for ..." and fail loudly.
  ]);
  const res = await issueThread({ dir, number: 7, includeComments: false });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.comments).toEqual([]);
  expect(res.truncated).toBe(false);
});

test("issueThread dispatches a gitlab repo and stitches sourcePath onto the item", async () => {
  const dir = await makeRepo("https://gitlab.com/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: /\/projects\/acme%2Fapp\/issues\/5$/,
      json: {
        iid: 5,
        title: "Bug report",
        state: "opened",
        web_url: "https://gitlab.com/acme/app/-/issues/5",
        author: { username: "alice" },
        assignees: [],
        milestone: null,
        description: "body",
        labels: [],
        user_notes_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    },
    { match: "/issues/5/notes", json: [] },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path"; // deny the glab shellout
  try {
    const res = await issueThread({ dir, number: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.item.number).toBe(5);
    expect(res.item.kind).toBe("issues");
    expect(res.item.sourcePath).toBe(dir);
    expect(res.refetchCommand).toBeNull(); // glab not on PATH
  } finally {
    process.env.PATH = originalPath;
  }
});

test("issueThread dispatches a bitbucket repo and stitches sourcePath onto the item; refetchCommand is always null (no Bitbucket CLI)", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: /\/2\.0\/repositories\/acme\/app\/issues\/9$/,
      json: {
        id: 9,
        title: "Something",
        state: "open",
        links: { html: { href: "https://bitbucket.org/acme/app/issues/9" } },
        reporter: { nickname: "alice", links: {} },
        content: { raw: "body" },
        comment_count: 0,
        created_on: "2026-01-01T00:00:00Z",
        updated_on: "2026-01-02T00:00:00Z",
      },
    },
    { match: "/issues/9/comments", json: { values: [] } },
  ]);

  const res = await issueThread({ dir, number: 9 });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.item.number).toBe(9);
  expect(res.item.kind).toBe("issues");
  expect(res.item.sourcePath).toBe(dir);
  expect(res.refetchCommand).toBeNull();
});

test("issueThread on a repo with no supported git remote returns the facade's NO_REMOTE_ERROR", async () => {
  const dir = await makeRepo("git@example.com:acme/app.git");
  const res = await issueThread({ dir, number: 1 });
  expect(res).toEqual({
    ok: false,
    error: "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)",
  });
});

// ---------------------------------------------------------------------------
// refetchCommandFor — pure, no I/O
// ---------------------------------------------------------------------------

test("refetchCommandFor builds a `gh issue view <url> --comments` command for github when gh is available, single-quoting the url", () => {
  expect(
    refetchCommandFor({
      provider: "github",
      htmlUrl: "https://github.com/acme/app/issues/7",
      repo: "acme/app",
      number: 7,
      ghAvailable: true,
      glabAvailable: true,
    }),
  ).toBe("gh issue view 'https://github.com/acme/app/issues/7' --comments");
});

test("refetchCommandFor escapes an embedded single quote in the url as '\\''", () => {
  expect(
    refetchCommandFor({
      provider: "github",
      htmlUrl: "https://github.com/acme/app/issues/7'; rm -rf /",
      repo: "acme/app",
      number: 7,
      ghAvailable: true,
      glabAvailable: true,
    }),
  ).toBe("gh issue view 'https://github.com/acme/app/issues/7'\\''; rm -rf /' --comments");
});

test("refetchCommandFor returns null for github when gh is not available", () => {
  expect(
    refetchCommandFor({
      provider: "github",
      htmlUrl: "https://github.com/acme/app/issues/7",
      repo: "acme/app",
      number: 7,
      ghAvailable: false,
      glabAvailable: true,
    }),
  ).toBeNull();
});

test("refetchCommandFor builds a `glab issue view <n> --comments --repo <owner/name>` command for gitlab when glab is available, single-quoting the repo slug", () => {
  expect(
    refetchCommandFor({
      provider: "gitlab",
      htmlUrl: "https://gitlab.com/acme/app/-/issues/5",
      repo: "acme/app",
      number: 5,
      ghAvailable: true,
      glabAvailable: true,
    }),
  ).toBe("glab issue view 5 --comments --repo 'acme/app'");
});

test("refetchCommandFor keeps a nested GitLab group's repo slug intact when single-quoting it", () => {
  expect(
    refetchCommandFor({
      provider: "gitlab",
      htmlUrl: "https://gitlab.com/group/sub/project/-/issues/5",
      repo: "group/sub/project",
      number: 5,
      ghAvailable: true,
      glabAvailable: true,
    }),
  ).toBe("glab issue view 5 --comments --repo 'group/sub/project'");
});

test("refetchCommandFor returns null for gitlab when glab is not available", () => {
  expect(
    refetchCommandFor({
      provider: "gitlab",
      htmlUrl: "https://gitlab.com/acme/app/-/issues/5",
      repo: "acme/app",
      number: 5,
      ghAvailable: true,
      glabAvailable: false,
    }),
  ).toBeNull();
});

test("refetchCommandFor always returns null for bitbucket, regardless of gh/glab availability", () => {
  expect(
    refetchCommandFor({
      provider: "bitbucket",
      htmlUrl: "https://bitbucket.org/acme/app/issues/9",
      repo: "acme/app",
      number: 9,
      ghAvailable: true,
      glabAvailable: true,
    }),
  ).toBeNull();
  expect(
    refetchCommandFor({
      provider: "bitbucket",
      htmlUrl: "https://bitbucket.org/acme/app/issues/9",
      repo: "acme/app",
      number: 9,
      ghAvailable: false,
      glabAvailable: false,
    }),
  ).toBeNull();
});
