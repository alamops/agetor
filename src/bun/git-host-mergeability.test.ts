import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pullMergeability } from "./git-host.ts";
import { makeGitHubRepo, mockGitHubFetch, type FetchMock } from "./github-test-util.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Facade-level dispatch tests for `pullMergeability` (src/bun/git-host.ts),
// mirroring git-host.test.ts's idiom exactly: a real throwaway git repo per
// provider (so `providerRepoForDir` resolves off an actual `git remote`, the
// same way the route in server.ts would see it) plus `mockGitHubFetch`
// (host-agnostic despite the name — see github-test-util.ts) stubbed onto
// `globalThis.fetch`. Deep per-provider mapping matrices already live in
// github.test.ts/gitlab-network.test.ts/bitbucket.test.ts; this file only
// pins that the facade calls the right adapter for the right remote and
// preserves the adapter's response shape end to end.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_EMAIL"] as const;
let dataDir: string;
let savedEnv: Record<string, string | undefined> = {};
let createdDirs: string[] = [];
let fetchMock: FetchMock | null = null;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-git-host-mergeability-"));
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
  rmTestDataDir(dataDir);
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

/** Local temp-repo builder for gitlab/bitbucket remotes — no shared
 *  gitlab/bitbucket-test-util.ts equivalent exists because gitlab.ts/
 *  bitbucket.ts's own adapters take an already-resolved `ProviderRepoInfo`
 *  and never touch git themselves (see those test-util files' doc comments).
 *  The facade, by contrast, resolves the remote itself via
 *  `providerRepoForDir`, so it needs a real `git remote` on disk — this
 *  mirrors git-host.test.ts's own `makeRepo` helper. */
async function makeRepo(remoteUrl: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-git-host-mergeability-repo-"));
  createdDirs.push(dir);
  await git(["init", "-b", "main"], dir);
  await git(["remote", "add", "origin", remoteUrl], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// No remote
// ---------------------------------------------------------------------------

test("pullMergeability on a repo with no supported git remote returns the facade's NO_REMOTE_ERROR", async () => {
  const dir = await makeRepo("git@example.com:acme/app.git");
  const res = await pullMergeability({ dir, number: 1 });
  expect(res).toEqual({
    ok: false,
    error: "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)",
  });
});

// ---------------------------------------------------------------------------
// GitHub dispatch (also pins getGitHubPullMergeability's in-request retry —
// previously untested at the network level)
// ---------------------------------------------------------------------------

test("pullMergeability on a github repo dispatches to GitHub, retries once on mergeable:null, and maps a dirty verdict", async () => {
  const dir = await makeGitHubRepo("o", "r");
  createdDirs.push(dir);

  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("api.github.com/repos/o/r/pulls/9")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    calls++;
    const body = calls === 1
      ? {
        state: "open",
        merged: false,
        draft: false,
        mergeable: null,
        mergeable_state: "unknown",
        head: { ref: "feature", sha: "sha1", repo: { full_name: "o/r" } },
        base: { ref: "main", repo: { full_name: "o/r" } },
      }
      : {
        state: "open",
        merged: false,
        draft: false,
        mergeable: false,
        mergeable_state: "dirty",
        head: { ref: "feature", sha: "sha2", repo: { full_name: "o/r" } },
        base: { ref: "main", repo: { full_name: "o/r" } },
      };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const res = await pullMergeability({ dir, number: 9 });
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("dirty");
    expect(res.mergeable).toBe(false);
    expect(res.state).toBe("open");
    expect(res.headRef).toBe("feature");
    expect(res.baseRef).toBe("main");
  } finally {
    globalThis.fetch = original;
  }
}, 10_000);

// ---------------------------------------------------------------------------
// GitLab dispatch
// ---------------------------------------------------------------------------

test("pullMergeability on a gitlab repo dispatches to GitLab and maps a dirty verdict", async () => {
  const dir = await makeRepo("https://gitlab.com/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: /gitlab\.com\/api\/v4\/projects\/acme%2Fapp\/merge_requests\/5$/,
      json: {
        iid: 5,
        state: "opened",
        draft: false,
        detailed_merge_status: "conflict",
        source_branch: "feature",
        target_branch: "main",
        source_project_id: 1,
        target_project_id: 1,
        diff_refs: { head_sha: "sha1" },
      },
    },
  ]);

  const res = await pullMergeability({ dir, number: 5 });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  expect(res.mergeableState).toBe("dirty");
  expect(res.mergeable).toBe(false);
  expect(res.state).toBe("open");
  expect(res.headRef).toBe("feature");
  expect(res.baseRef).toBe("main");

  const call = fetchMock.calls.find((c) => c.url.includes("merge_requests/5"));
  expect(call?.url).toContain("/projects/acme%2Fapp/merge_requests/5");
});

// ---------------------------------------------------------------------------
// Bitbucket dispatch
// ---------------------------------------------------------------------------

test("pullMergeability on a bitbucket repo dispatches to Bitbucket, scans the diffstat, and maps a dirty verdict", async () => {
  const dir = await makeRepo("https://bitbucket.org/acme/app.git");
  fetchMock = mockGitHubFetch([
    {
      match: /\/pullrequests\/7\/diffstat/,
      json: {
        values: [{ status: "merge conflict", old: null, new: { path: "src/foo.ts" } }],
      },
    },
    {
      match: /\/pullrequests\/7$/,
      json: {
        state: "OPEN",
        draft: false,
        source: {
          branch: { name: "feature" },
          commit: { hash: "sha1" },
          repository: { full_name: "acme/app" },
        },
        destination: {
          branch: { name: "main" },
          repository: { full_name: "acme/app" },
        },
      },
    },
  ]);

  const res = await pullMergeability({ dir, number: 7 });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  expect(res.mergeableState).toBe("dirty");
  expect(res.mergeable).toBe(false);
  expect(res.state).toBe("open");
  expect(res.headRef).toBe("feature");
  expect(res.baseRef).toBe("main");

  const detailCall = fetchMock.calls.find((c) => /\/pullrequests\/7$/.test(c.url));
  expect(detailCall?.url).toContain("/2.0/repositories/acme/app/pullrequests/7");
  const diffstatCall = fetchMock.calls.find((c) => c.url.includes("diffstat"));
  expect(diffstatCall?.url).toContain("/pullrequests/7/diffstat");
});
