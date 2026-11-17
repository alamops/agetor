// Branch list / lookup / default-branch and already-exists handling in gitlab.ts
// (docs/plans/create-all-prs-title-and-base.md T2).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { __clearApiHostCacheForTest } from "./git-provider.ts";
import { cleanupSshStubs, mockGitLabFetch, sampleRepo, writeSshStub } from "./gitlab-test-util.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { createGitLabPull, getGitLabBranch, getGitLabDefaultBranch, listGitLabBranches } from "./gitlab.ts";

const REPO = sampleRepo();
const ORIGINAL_SSH_BIN = process.env.AGETOR_SSH_BIN;
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ORIGINAL_TOKEN = process.env.GITLAB_TOKEN;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-gitlab-branches-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  process.env.GITLAB_TOKEN = "test-token";
});
afterAll(() => {
  rmTestDataDir(dataDir);
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_TOKEN === undefined) delete process.env.GITLAB_TOKEN;
  else process.env.GITLAB_TOKEN = ORIGINAL_TOKEN;
});
beforeEach(() => {
  __clearApiHostCacheForTest();
  process.env.AGETOR_SSH_BIN = writeSshStub('#!/bin/sh\necho "hostname $3"\n');
});
afterEach(() => {
  __clearApiHostCacheForTest();
  cleanupSshStubs();
  if (ORIGINAL_SSH_BIN === undefined) delete process.env.AGETOR_SSH_BIN;
  else process.env.AGETOR_SSH_BIN = ORIGINAL_SSH_BIN;
});

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ name: `b${from + i}`, commit: { id: `id${from + i}` } }));

test("listGitLabBranches pages with per_page=100 and reads commit.id", async () => {
  const mock = mockGitLabFetch([
    { match: "repository/branches?per_page=100&page=1", json: rows(1, 100) },
    { match: "repository/branches?per_page=100&page=2", json: rows(101, 110) },
  ]);
  try {
    const res = await listGitLabBranches(REPO);
    expect(res.ok && res.branches).toHaveLength(110);
    expect(res.ok && res.truncated).toBe(false);
    expect(res.ok && res.branches[0]).toEqual({ name: "b1", sha: "id1" });
    expect(mock.calls[0]!.url).toContain("/api/v4/projects/acme%2Fapp/repository/branches?per_page=100&page=1");
  } finally {
    mock.restore();
  }
});

test("listGitLabBranches truncates at maxPages", async () => {
  const mock = mockGitLabFetch([{ match: "repository/branches", json: rows(1, 100) }]);
  try {
    const res = await listGitLabBranches(REPO, { maxPages: 1 });
    expect(res.ok && res.truncated).toBe(true);
  } finally {
    mock.restore();
  }
});

test("getGitLabBranch URL-encodes the whole name and maps a branch 404 to null", async () => {
  let mock = mockGitLabFetch([
    { match: "repository/branches/release%2F1.2", json: { name: "release/1.2", commit: { id: "abc" } } },
  ]);
  try {
    expect(await getGitLabBranch(REPO, "release/1.2")).toEqual({ ok: true, branch: { name: "release/1.2", sha: "abc" } });
  } finally {
    mock.restore();
  }
  mock = mockGitLabFetch([{ match: "repository/branches/zz", status: 404, json: { message: "404 Branch Not Found" } }]);
  try {
    expect(await getGitLabBranch(REPO, "zz")).toEqual({ ok: true, branch: null });
  } finally {
    mock.restore();
  }
  mock = mockGitLabFetch([{ match: "repository/branches/zz", status: 404, json: { message: "404 Project Not Found" } }]);
  try {
    expect((await getGitLabBranch(REPO, "zz")).ok).toBe(false);
  } finally {
    mock.restore();
  }
});

test("getGitLabDefaultBranch has no guessed fallback", async () => {
  let mock = mockGitLabFetch([{ match: "/api/v4/projects/acme%2Fapp", json: { default_branch: "trunk" } }]);
  try {
    expect(await getGitLabDefaultBranch(REPO)).toEqual({ ok: true, name: "trunk" });
  } finally {
    mock.restore();
  }
  mock = mockGitLabFetch([{ match: "/api/v4/projects/acme%2Fapp", json: { id: 1 } }]);
  try {
    expect((await getGitLabDefaultBranch(REPO)).ok).toBe(false);
  } finally {
    mock.restore();
  }
});

test("createGitLabPull maps a 409 'already exists … !12' to already-exists with the MR URL", async () => {
  const mock = mockGitLabFetch([
    { method: "GET", match: "/api/v4/projects/acme%2Fapp", json: { id: 77 } },
    {
      method: "POST",
      match: "/merge_requests",
      status: 409,
      json: { message: ["Another open merge request already exists for this source branch: !12"] },
    },
  ]);
  try {
    const res = await createGitLabPull(REPO, { title: "t", head: "f", base: "main" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("already-exists");
    expect(res.existingUrl).toBe("https://gitlab.com/acme/app/-/merge_requests/12");
  } finally {
    mock.restore();
  }
});

test("another 409 stays an ordinary failure", async () => {
  const mock = mockGitLabFetch([
    { method: "GET", match: "/api/v4/projects/acme%2Fapp", json: { id: 77 } },
    { method: "POST", match: "/merge_requests", status: 409, json: { message: "Branch conflict" } },
  ]);
  try {
    const res = await createGitLabPull(REPO, { title: "t", head: "f", base: "main" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBeUndefined();
  } finally {
    mock.restore();
  }
});
