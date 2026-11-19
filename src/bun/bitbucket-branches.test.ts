// Branch list / lookup / default-branch and already-open handling in bitbucket.ts
// (docs/plans/create-all-prs-title-and-base.md T2). The duplicate-PR wording is
// unverified upstream, so its fixture is synthetic.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { makeBitbucketRepo, mockGitHubFetch } from "./bitbucket-test-util.ts";
import { __clearApiHostCacheForTest } from "./git-provider.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import {
  createBitbucketPull,
  getBitbucketBranch,
  getBitbucketDefaultBranch,
  listBitbucketBranches,
} from "./bitbucket.ts";

const REPO = makeBitbucketRepo("acme", "app");
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ORIGINAL_TOKEN = process.env.BITBUCKET_TOKEN;
const ORIGINAL_EMAIL = process.env.BITBUCKET_EMAIL;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-bb-branches-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  process.env.BITBUCKET_TOKEN = "test-token";
  delete process.env.BITBUCKET_EMAIL;
});
afterAll(() => {
  rmTestDataDir(dataDir);
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BITBUCKET_TOKEN;
  else process.env.BITBUCKET_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_EMAIL === undefined) delete process.env.BITBUCKET_EMAIL;
  else process.env.BITBUCKET_EMAIL = ORIGINAL_EMAIL;
});
afterEach(() => __clearApiHostCacheForTest());

const values = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ name: `b${from + i}`, target: { hash: `h${from + i}` } }));

test("listBitbucketBranches follows the body's next link with pagelen=100", async () => {
  const next = "https://api.bitbucket.org/2.0/repositories/acme/app/refs/branches?pagelen=100&page=2";
  const mock = mockGitHubFetch([
    { match: "refs/branches?pagelen=100&page=2", json: { values: values(3, 4) } },
    { match: "refs/branches?pagelen=100", json: { values: values(1, 2), next } },
  ]);
  try {
    const res = await listBitbucketBranches(REPO);
    expect(res.ok && res.branches.map((b) => b.name)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(res.ok && res.truncated).toBe(false);
    expect(res.ok && res.branches[0]).toEqual({ name: "b1", sha: "h1" });
  } finally {
    mock.restore();
  }
});

test("listBitbucketBranches stops at maxPages and marks truncated; never follows an off-origin next but reports the listing truncated", async () => {
  const next = "https://api.bitbucket.org/2.0/repositories/acme/app/refs/branches?pagelen=100&page=2";
  let mock = mockGitHubFetch([{ match: "refs/branches", json: { values: values(1, 2), next } }]);
  try {
    const res = await listBitbucketBranches(REPO, { maxPages: 1 });
    expect(res.ok && res.truncated).toBe(true);
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([
    { match: "refs/branches", json: { values: values(1, 1), next: "https://evil.example/2.0/x" } },
  ]);
  try {
    const res = await listBitbucketBranches(REPO);
    // Incomplete, not complete: pullTargets must fall back to a per-name lookup.
    expect(res.ok && res.truncated).toBe(true);
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("getBitbucketBranch finds a branch, maps a branch 404 to null, errors on a repo 404", async () => {
  let mock = mockGitHubFetch([
    { match: "refs/branches/release/1.2", json: { name: "release/1.2", target: { hash: "abc" } } },
  ]);
  try {
    expect(await getBitbucketBranch(REPO, "release/1.2")).toEqual({
      ok: true,
      branch: { name: "release/1.2", sha: "abc" },
    });
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([
    { match: "refs/branches/zz", status: 404, json: { type: "error", error: { message: "Branch zz not found" } } },
  ]);
  try {
    expect(await getBitbucketBranch(REPO, "zz")).toEqual({ ok: true, branch: null });
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([
    { match: "refs/branches/zz", status: 404, json: { type: "error", error: { message: "Repository acme/app not found" } } },
  ]);
  try {
    expect((await getBitbucketBranch(REPO, "zz")).ok).toBe(false);
  } finally {
    mock.restore();
  }
  // A repository/access 404 that merely mentions a branch is still an error.
  mock = mockGitHubFetch([
    {
      match: "refs/branches/zz",
      status: 404,
      json: { type: "error", error: { message: "You may not have access to this repository or its branches" } },
    },
  ]);
  try {
    expect((await getBitbucketBranch(REPO, "zz")).ok).toBe(false);
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([
    { match: "refs/branches/zz", status: 404, json: { type: "error", error: { message: "No such branch: zz" } } },
  ]);
  try {
    expect(await getBitbucketBranch(REPO, "zz")).toEqual({ ok: true, branch: null });
  } finally {
    mock.restore();
  }
});

test("getBitbucketDefaultBranch reads mainbranch.name with no guessed fallback", async () => {
  let mock = mockGitHubFetch([{ match: "/2.0/repositories/acme/app", json: { mainbranch: { name: "develop" } } }]);
  try {
    expect(await getBitbucketDefaultBranch(REPO)).toEqual({ ok: true, name: "develop" });
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([{ match: "/2.0/repositories/acme/app", json: {} }]);
  try {
    expect((await getBitbucketDefaultBranch(REPO)).ok).toBe(false);
  } finally {
    mock.restore();
  }
});

test("createBitbucketPull maps a duplicate-PR 400 to already-exists with the open PR's URL", async () => {
  const mock = mockGitHubFetch([
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
  try {
    const res = await createBitbucketPull(REPO, { title: "t", head: "f", base: "main" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("already-exists");
    expect(res.existingUrl).toBe("https://bitbucket.org/acme/app/pull-requests/4");
    // The lookup pins this repository, the head and the base: one head may have
    // open PRs into several bases.
    const lookup = mock.calls.find((c) => c.method === "GET")!;
    const q = new URL(lookup.url).searchParams.get("q");
    expect(q).toContain(`source.repository.full_name="${REPO.owner}/${REPO.name}"`);
    expect(q).toContain('source.branch.name="f"');
    expect(q).toContain('destination.branch.name="main"');
    expect(q).toContain('state="OPEN"');
  } finally {
    mock.restore();
  }
});

test("another 400 stays an ordinary failure", async () => {
  const mock = mockGitHubFetch([
    { method: "POST", match: "/pullrequests", status: 400, json: { type: "error", error: { message: "bad" } } },
  ]);
  try {
    const res = await createBitbucketPull(REPO, { title: "t", head: "f", base: "main" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBeUndefined();
  } finally {
    mock.restore();
  }
});
