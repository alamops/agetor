// Pure-helper tests for gitlab.ts (TT2, docs/plans/multi-provider-git-modal.md),
// exercised entirely through `__gitlabInternals` — no network, no fetch mock.
// Complements gitlab-network.test.ts, which exercises the exported async
// functions end-to-end (URL/header/pagination shapes) via a mocked fetch.
import { expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __clearApiHostCacheForTest } from "./git-provider.ts";
import { __gitlabInternals, getGitLabIssueThread, listGitLabComments } from "./gitlab.ts";
import { cleanupSshStubs, gitlabIssue, gitlabNote, mockGitLabFetch, sampleRepo, writeSshStub } from "./gitlab-test-util.ts";

const {
  encodeProjectId,
  apiError,
  authHint,
  pageLinks,
  resolveNextPage,
  normalizeUser,
  normalizeLabels,
  normalizeItem,
  noteHtmlUrl,
  normalizeComment,
  normalizeLineComment,
  mapGitLabStatus,
  normalizeCommitStatusAsCheckRun,
  normalizePipelineAsCheckRun,
  normalizeRepoLabel,
  sortItems,
  gitlabStateParams,
} = __gitlabInternals;

const REPO = sampleRepo();

// ---------------------------------------------------------------------------
// encodeProjectId
// ---------------------------------------------------------------------------

test("encodeProjectId percent-encodes the owner/name slash", () => {
  expect(encodeProjectId("acme", "my-app")).toBe("acme%2Fmy-app");
  expect(encodeProjectId("o", "r")).toBe("o%2Fr");
});

// ---------------------------------------------------------------------------
// normalizeItem — merge request + issue normalization
// ---------------------------------------------------------------------------

test("normalizeItem maps an opened MR onto GitHubListItem", () => {
  const item = normalizeItem("pulls", {
    iid: 42,
    title: "Add feature",
    state: "opened",
    draft: true,
    web_url: "https://gitlab.com/acme/app/-/merge_requests/42",
    author: { username: "alice", avatar_url: "https://x/a.png", web_url: "https://gitlab.com/alice" },
    assignees: [{ username: "bob", avatar_url: null, web_url: null }],
    milestone: { iid: 3, title: "v1" },
    description: "the body",
    labels: ["bug", "p1"],
    user_notes_count: 4,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    discussion_locked: false,
  });
  expect(item).toEqual({
    kind: "pulls",
    number: 42,
    title: "Add feature",
    state: "open",
    draft: true,
    htmlUrl: "https://gitlab.com/acme/app/-/merge_requests/42",
    author: { login: "alice", avatarUrl: "https://x/a.png", htmlUrl: "https://gitlab.com/alice" },
    assignees: [{ login: "bob", avatarUrl: null, htmlUrl: null }],
    milestone: { number: 3, title: "v1" },
    body: "the body",
    labels: [{ name: "bug", color: null }, { name: "p1", color: null }],
    comments: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: null,
  });
});

test("normalizeItem folds a merged MR into state:closed with mergedAt set", () => {
  const item = normalizeItem("pulls", {
    iid: 1,
    title: "t",
    state: "merged",
    web_url: "https://x",
    merged_at: "2026-02-01T00:00:00Z",
  });
  expect(item).toMatchObject({ state: "closed", mergedAt: "2026-02-01T00:00:00Z" });
});

test("normalizeItem treats a closed (declined) MR as state:closed with no mergedAt", () => {
  const item = normalizeItem("pulls", {
    iid: 1,
    title: "t",
    state: "closed",
    web_url: "https://x",
    closed_at: "2026-02-01T00:00:00Z",
  });
  expect(item).toMatchObject({ state: "closed", mergedAt: null, closedAt: "2026-02-01T00:00:00Z" });
});

test("normalizeItem treats a transient locked MR as still open", () => {
  const item = normalizeItem("pulls", { iid: 1, title: "t", state: "locked", web_url: "https://x" });
  expect(item).toMatchObject({ state: "open" });
});

test("normalizeItem rejects an unrecognized state", () => {
  expect(normalizeItem("pulls", { iid: 1, title: "t", state: "weird", web_url: "https://x" })).toBeNull();
});

test("normalizeItem rejects missing iid/title/web_url", () => {
  expect(normalizeItem("pulls", { title: "t", state: "opened", web_url: "https://x" })).toBeNull();
  expect(normalizeItem("pulls", { iid: 1, state: "opened", web_url: "https://x" })).toBeNull();
  expect(normalizeItem("pulls", { iid: 1, title: "t", state: "opened" })).toBeNull();
  expect(normalizeItem("pulls", null)).toBeNull();
});

test("normalizeItem maps an issue the same way as an MR (no merged/draft semantics)", () => {
  const item = normalizeItem("issues", {
    iid: 7,
    title: "Bug report",
    state: "opened",
    web_url: "https://gitlab.com/acme/app/-/issues/7",
    description: "steps",
    labels: [],
    user_notes_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  expect(item).toMatchObject({ kind: "issues", number: 7, state: "open", draft: false, body: "steps" });
});

test("normalizeItem defaults draft to false, body to \"\" and labels to [] when absent", () => {
  const item = normalizeItem("pulls", { iid: 1, title: "t", state: "opened", web_url: "https://x" });
  expect(item).toMatchObject({ draft: false, body: "", labels: [], comments: 0, createdAt: "", updatedAt: "" });
});

test("normalizeItem passes sourcePath through (facade stitches it on)", () => {
  const item = normalizeItem("pulls", { iid: 1, title: "t", state: "opened", web_url: "https://x" }, "/some/dir");
  expect(item).toMatchObject({ sourcePath: "/some/dir" });
});

// ---------------------------------------------------------------------------
// normalizeUser / normalizeLabels
// ---------------------------------------------------------------------------

test("normalizeUser maps username→login and web_url→htmlUrl, rejects usernameless shapes", () => {
  expect(normalizeUser({ username: "alice", avatar_url: "u", web_url: "w" })).toEqual({
    login: "alice",
    avatarUrl: "u",
    htmlUrl: "w",
  });
  expect(normalizeUser({ username: "bob" })).toEqual({ login: "bob", avatarUrl: null, htmlUrl: null });
  expect(normalizeUser({ avatar_url: "u" })).toBeNull();
  expect(normalizeUser(null)).toBeNull();
});

test("normalizeLabels accepts a plain string array, synthesizing null color", () => {
  expect(normalizeLabels(["bug", "p1"])).toEqual([
    { name: "bug", color: null },
    { name: "p1", color: null },
  ]);
});

test("normalizeLabels also accepts details-shaped {name,color} objects defensively", () => {
  expect(normalizeLabels([{ name: "bug", color: "#f00" }])).toEqual([{ name: "bug", color: "#f00" }]);
  expect(normalizeLabels([{ name: "wip" }])).toEqual([{ name: "wip", color: null }]);
});

test("normalizeLabels drops malformed entries and non-array input", () => {
  expect(normalizeLabels([1, null, { color: "x" }, "ok"])).toEqual([{ name: "ok", color: null }]);
  expect(normalizeLabels(null)).toEqual([]);
  expect(normalizeLabels(undefined)).toEqual([]);
});

// ---------------------------------------------------------------------------
// noteHtmlUrl / normalizeComment
// ---------------------------------------------------------------------------

test("noteHtmlUrl anchors into the merge_requests page for pulls, issues page for issues", () => {
  expect(noteHtmlUrl(REPO, "pulls", 42, 100)).toBe(
    "https://gitlab.com/acme/app/-/merge_requests/42#note_100",
  );
  expect(noteHtmlUrl(REPO, "issues", 7, 55)).toBe("https://gitlab.com/acme/app/-/issues/7#note_55");
});

test("normalizeComment maps a note onto GitHubComment, deriving htmlUrl from noteHtmlUrl", () => {
  const comment = normalizeComment(
    { id: 100, body: "hi", author: { username: "bob" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    REPO,
    "pulls",
    42,
  );
  expect(comment).toEqual({
    id: 100,
    body: "hi",
    htmlUrl: "https://gitlab.com/acme/app/-/merge_requests/42#note_100",
    author: { login: "bob", avatarUrl: null, htmlUrl: null },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
});

test("normalizeComment rejects a non-numeric/missing id", () => {
  expect(normalizeComment({ body: "hi" }, REPO, "pulls", 1)).toBeNull();
  expect(normalizeComment(null, REPO, "pulls", 1)).toBeNull();
});

// ---------------------------------------------------------------------------
// normalizeLineComment — DiffNote position mapping
// ---------------------------------------------------------------------------

test("normalizeLineComment maps new_line to side:RIGHT", () => {
  const c = normalizeLineComment(
    {
      id: 1,
      body: "nit",
      author: { username: "alice" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      position: { new_path: "src/foo.ts", old_path: "src/foo.ts", new_line: 12, old_line: null },
    },
    REPO,
    42,
  );
  expect(c).toMatchObject({ side: "RIGHT", line: 12, path: "src/foo.ts" });
});

test("normalizeLineComment maps old_line to side:LEFT when new_line is absent", () => {
  const c = normalizeLineComment(
    {
      id: 2,
      body: "nit",
      position: { new_path: null, old_path: "src/foo.ts", new_line: null, old_line: 9 },
    },
    REPO,
    42,
  );
  expect(c).toMatchObject({ side: "LEFT", line: 9, path: "src/foo.ts" });
});

test("normalizeLineComment prefers new_line over old_line when both are present", () => {
  const c = normalizeLineComment(
    { id: 3, body: "x", position: { new_path: "a.ts", old_path: "a.ts", new_line: 5, old_line: 4 } },
    REPO,
    1,
  );
  expect(c).toMatchObject({ side: "RIGHT", line: 5 });
});

test("normalizeLineComment falls back to old_path when new_path is absent (delete-side comment)", () => {
  const c = normalizeLineComment(
    { id: 4, body: "x", position: { new_path: null, old_path: "deleted.ts", new_line: null, old_line: 3 } },
    REPO,
    1,
  );
  expect(c).toMatchObject({ path: "deleted.ts", side: "LEFT", line: 3 });
});

test("normalizeLineComment rejects a note with neither new_line nor old_line", () => {
  expect(
    normalizeLineComment({ id: 5, body: "x", position: { new_path: "a.ts", old_path: "a.ts" } }, REPO, 1),
  ).toBeNull();
});

test("normalizeLineComment rejects missing position or missing id", () => {
  expect(normalizeLineComment({ id: 6, body: "x" }, REPO, 1)).toBeNull();
  expect(normalizeLineComment({ body: "x", position: { new_line: 1 } }, REPO, 1)).toBeNull();
  expect(normalizeLineComment(null, REPO, 1)).toBeNull();
});

test("normalizeLineComment rejects a position with no resolvable path", () => {
  expect(
    normalizeLineComment({ id: 7, body: "x", position: { new_line: 1 } }, REPO, 1),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// mapGitLabStatus — pipeline/commit-status vocabulary → GitHub check-run vocab
// ---------------------------------------------------------------------------

test("mapGitLabStatus maps non-terminal states with null conclusion", () => {
  expect(mapGitLabStatus("pending")).toEqual({ status: "queued", conclusion: null });
  expect(mapGitLabStatus("running")).toEqual({ status: "in_progress", conclusion: null });
});

test("mapGitLabStatus maps terminal states to completed + a conclusion", () => {
  expect(mapGitLabStatus("success")).toEqual({ status: "completed", conclusion: "success" });
  expect(mapGitLabStatus("failed")).toEqual({ status: "completed", conclusion: "failure" });
  expect(mapGitLabStatus("canceled")).toEqual({ status: "completed", conclusion: "cancelled" });
  expect(mapGitLabStatus("skipped")).toEqual({ status: "completed", conclusion: "skipped" });
});

test("mapGitLabStatus rides an unrecognized status through verbatim rather than coercing to unknown", () => {
  expect(mapGitLabStatus("manual")).toEqual({ status: "manual", conclusion: null });
});

test("mapGitLabStatus defaults an empty status string to \"unknown\"", () => {
  expect(mapGitLabStatus("")).toEqual({ status: "unknown", conclusion: null });
});

test("normalizeCommitStatusAsCheckRun maps a commit-status entry through mapGitLabStatus", () => {
  const run = normalizeCommitStatusAsCheckRun({
    id: 9,
    name: "build",
    status: "success",
    target_url: "https://ci/9",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:05:00Z",
  });
  expect(run).toEqual({
    id: 9,
    name: "build",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://ci/9",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:05:00Z",
  });
});

test("normalizeCommitStatusAsCheckRun rejects missing id/name", () => {
  expect(normalizeCommitStatusAsCheckRun({ name: "build" })).toBeNull();
  expect(normalizeCommitStatusAsCheckRun({ id: 1 })).toBeNull();
  expect(normalizeCommitStatusAsCheckRun(null)).toBeNull();
});

test("normalizePipelineAsCheckRun synthesizes a \"pipeline #<id>\" entry", () => {
  const run = normalizePipelineAsCheckRun({ id: 77, status: "running", web_url: "https://ci/pipe/77" });
  expect(run).toEqual({
    id: 77,
    name: "pipeline #77",
    status: "in_progress",
    conclusion: null,
    htmlUrl: "https://ci/pipe/77",
    startedAt: null,
    completedAt: null,
  });
});

test("normalizePipelineAsCheckRun rejects a non-numeric id", () => {
  expect(normalizePipelineAsCheckRun({ status: "running" })).toBeNull();
});

// ---------------------------------------------------------------------------
// normalizeRepoLabel
// ---------------------------------------------------------------------------

test("normalizeRepoLabel strips the leading # from GitLab's hex color", () => {
  expect(normalizeRepoLabel({ name: "bug", color: "#d73a4a", description: "a defect" })).toEqual({
    name: "bug",
    color: "d73a4a",
    description: "a defect",
  });
});

test("normalizeRepoLabel defaults missing color/description and rejects nameless entries", () => {
  expect(normalizeRepoLabel({ name: "wip" })).toEqual({ name: "wip", color: "", description: "" });
  expect(normalizeRepoLabel({ color: "#fff" })).toBeNull();
  expect(normalizeRepoLabel(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// apiError / authHint
// ---------------------------------------------------------------------------

test("apiError prefers a string `message`, then joins an array `message`, then falls back to `error`", () => {
  expect(apiError({ message: "nope" }, 400, "Bad Request")).toBe("nope");
  expect(apiError({ message: ["title is required", "too short"] }, 400, "Bad Request")).toBe(
    "title is required, too short",
  );
  expect(apiError({ error: "invalid_token" }, 401, "Unauthorized")).toBe("invalid_token");
});

test("apiError falls back to the HTTP status line for an unrecognized body shape", () => {
  expect(apiError(null, 500, "Internal Server Error")).toBe("500 Internal Server Error");
  expect(apiError({}, 404, "Not Found")).toBe("404 Not Found");
  expect(apiError("plain text", 502, "Bad Gateway")).toBe("502 Bad Gateway");
});

test("authHint enriches both 401 and 404 with a Settings pointer", () => {
  const msg401 = authHint(401, "Unauthorized", REPO, false);
  expect(msg401).toContain("acme/app");
  expect(msg401).toContain(REPO.remoteHost);
  expect(msg401).toContain("Settings");

  const msg404 = authHint(404, "Not Found", REPO, false);
  expect(msg404).toContain("acme/app");
  expect(msg404).toContain("Settings");
});

test("authHint mentions the configured token can't access it when hadToken is true", () => {
  const msg = authHint(404, "Not Found", REPO, true);
  expect(msg).toContain("cannot access it");
});

test("authHint passes non-401/403/404 statuses through unchanged", () => {
  expect(authHint(500, "boom", REPO, false)).toBe("boom");
  expect(authHint(502, "boom", REPO, true)).toBe("boom");
});

test("authHint enriches 401 with 'requires a token' wording, distinct from 404's 'not found' wording", () => {
  const msg = authHint(401, "Unauthorized", REPO, false);
  expect(msg).toContain("acme/app");
  expect(msg).toContain("requires a token to read this (401)");
  expect(msg).toContain("Settings → Git host tokens");
  expect(msg).not.toContain("was not found on GitLab");
});

test("authHint's 401 wording says the configured token was rejected when hadToken is true", () => {
  const msg = authHint(401, "Unauthorized", REPO, true);
  expect(msg).toContain("the configured token was rejected");
});

test("authHint enriches 403 with 'denied access' wording", () => {
  const msg = authHint(403, "forbidden", REPO, false);
  expect(msg).toContain("acme/app");
  expect(msg).toContain("denied access (403)");
  expect(msg).toContain("Settings → Git host tokens");
});

test("authHint's 403 wording also says the configured token was rejected when hadToken is true", () => {
  const msg = authHint(403, "forbidden", REPO, true);
  expect(msg).toContain("the configured token was rejected");
});

test("authHint falls back to gitlab.com when remoteHost is empty", () => {
  const msg = authHint(404, "Not Found", { ...REPO, remoteHost: "" }, false);
  expect(msg).toContain("gitlab.com");
});

// ---------------------------------------------------------------------------
// pageLinks / resolveNextPage
// ---------------------------------------------------------------------------

test("pageLinks extracts the rel=\"next\" URL from a Link header", () => {
  expect(pageLinks('<https://gitlab.com/api/v4/x?page=2>; rel="next"')).toBe(
    "https://gitlab.com/api/v4/x?page=2",
  );
  expect(
    pageLinks('<https://x/1>; rel="prev", <https://x/2>; rel="next", <https://x/3>; rel="last"'),
  ).toBe("https://x/2");
});

test("pageLinks returns null when there's no next rel or the header is absent", () => {
  expect(pageLinks(null)).toBeNull();
  expect(pageLinks('<https://x/1>; rel="prev"')).toBeNull();
  expect(pageLinks("")).toBeNull();
});

function fakeResponse(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

test("resolveNextPage prefers the Link header over x-next-page", () => {
  const res = fakeResponse({ link: '<https://x/next>; rel="next"', "x-next-page": "9" });
  expect(resolveNextPage(res, "https://x/current?page=1")).toBe("https://x/next");
});

test("resolveNextPage falls back to x-next-page, setting it on the current URL", () => {
  const res = fakeResponse({ "x-next-page": "3" });
  expect(resolveNextPage(res, "https://gitlab.com/api/v4/x?page=2&per_page=30")).toBe(
    "https://gitlab.com/api/v4/x?page=3&per_page=30",
  );
});

test("resolveNextPage returns null when x-next-page is empty or missing (last page)", () => {
  expect(resolveNextPage(fakeResponse({ "x-next-page": "" }), "https://x?page=1")).toBeNull();
  expect(resolveNextPage(fakeResponse({}), "https://x?page=1")).toBeNull();
});

// ---------------------------------------------------------------------------
// sortItems
// ---------------------------------------------------------------------------

function itemWith(overrides: Record<string, unknown>): ReturnType<typeof normalizeItem> {
  return normalizeItem("pulls", {
    iid: 1,
    title: "t",
    state: "opened",
    web_url: "https://x",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    user_notes_count: 0,
    ...overrides,
  });
}

test("sortItems sorts by updatedAt desc by default", () => {
  const older = itemWith({ iid: 1, updated_at: "2026-01-01T00:00:00Z" })!;
  const newer = itemWith({ iid: 2, updated_at: "2026-01-05T00:00:00Z" })!;
  const items = [older, newer];
  sortItems(items, undefined, "desc");
  expect(items.map((i) => i.number)).toEqual([2, 1]);
});

test("sortItems sorts by createdAt when sort:\"created\"", () => {
  const older = itemWith({ iid: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-09T00:00:00Z" })!;
  const newer = itemWith({ iid: 2, created_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" })!;
  const items = [older, newer];
  sortItems(items, "created", "asc");
  expect(items.map((i) => i.number)).toEqual([1, 2]);
});

test("sortItems sorts by comment count when sort:\"comments\"", () => {
  const few = itemWith({ iid: 1, user_notes_count: 1 })!;
  const many = itemWith({ iid: 2, user_notes_count: 9 })!;
  const items = [few, many];
  sortItems(items, "comments", "desc");
  expect(items.map((i) => i.number)).toEqual([2, 1]);
});

// ---------------------------------------------------------------------------
// gitlabStateParams
// ---------------------------------------------------------------------------

test("gitlabStateParams maps open→[opened] for both pulls and issues", () => {
  expect(gitlabStateParams("pulls", "open")).toEqual(["opened"]);
  expect(gitlabStateParams("issues", "open")).toEqual(["opened"]);
});

test("gitlabStateParams maps all→[\"all\"] regardless of kind", () => {
  expect(gitlabStateParams("pulls", "all")).toEqual(["all"]);
  expect(gitlabStateParams("issues", "all")).toEqual(["all"]);
});

test("gitlabStateParams fans closed pulls out to [closed, merged], but issues stay [closed]", () => {
  expect(gitlabStateParams("pulls", "closed")).toEqual(["closed", "merged"]);
  expect(gitlabStateParams("issues", "closed")).toEqual(["closed"]);
});

// ---------------------------------------------------------------------------
// getGitLabIssueThread / listGitLabComments (docs/plans/new-task-from-git-issue.md,
// Task A) — network-level tests against a mocked fetch, mirroring
// gitlab-network.test.ts's own setup (hermetic AGETOR_DATA_DIR + GITLAB_TOKEN,
// an identity ssh stub so gitlabApiBase's host resolution never depends on the
// real ~/.ssh/config, and per-test cache resets).
// ---------------------------------------------------------------------------

const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ORIGINAL_GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const ORIGINAL_SSH_BIN = process.env.AGETOR_SSH_BIN;
let issueThreadDataDir: string;

beforeAll(() => {
  issueThreadDataDir = mkdtempSync(path.join(tmpdir(), "agetor-gitlab-issue-thread-"));
  process.env.AGETOR_DATA_DIR = issueThreadDataDir;
  process.env.GITLAB_TOKEN = "test-token";
});

afterAll(() => {
  rmSync(issueThreadDataDir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_GITLAB_TOKEN === undefined) delete process.env.GITLAB_TOKEN;
  else process.env.GITLAB_TOKEN = ORIGINAL_GITLAB_TOKEN;
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

test("getGitLabIssueThread happy path normalizes the issue, drops a system note, and follows x-next-page pagination", async () => {
  const repo = sampleRepo();
  const mock = mockGitLabFetch([
    // End-anchored so this never swallows the /notes sub-path request below
    // (a plain substring match would, since it's that request's URL prefix).
    { match: /\/projects\/acme%2Fapp\/issues\/5$/, json: gitlabIssue() },
    {
      match: /\/issues\/5\/notes\?sort=asc&order_by=created_at&per_page=100$/,
      json: [
        gitlabNote({ id: 1, body: "added label ~bug", system: true, author: { username: "bot" } }),
        gitlabNote({ id: 2, body: "a real comment", system: false, author: { username: "alice" } }),
      ],
      headers: { "x-next-page": "2" },
    },
    {
      match: "page=2",
      json: [gitlabNote({ id: 3, body: "a later comment", system: false, author: { username: "bob" } })],
      // No x-next-page on the last page — resolveNextPage treats that as the end.
    },
  ]);
  try {
    const res = await getGitLabIssueThread(repo, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repo).toBe("acme/app");
    expect(res.item.kind).toBe("issues");
    expect(res.item.number).toBe(5);
    // The adapter never resolves a working directory (see gitlab.ts's module
    // doc comment) — sourcePath is always null here; the facade stitches it on.
    expect(res.item.sourcePath).toBeNull();
    expect(res.comments.map((c) => c.id)).toEqual([2, 3]); // system note (id:1) dropped
    expect(res.truncated).toBe(false);
    // The adapter never resolves gh/glab availability itself — the facade
    // (git-host.ts's issueThread) fills refetchCommand in.
    expect(res.refetchCommand).toBeNull();
    expect(mock.calls).toHaveLength(3); // 1 issue fetch + 2 note pages
  } finally {
    mock.restore();
  }
});

test("getGitLabIssueThread with includeComments:false skips collectGitLabNotes entirely", async () => {
  const repo = sampleRepo();
  const mock = mockGitLabFetch([
    { match: /\/projects\/acme%2Fapp\/issues\/5$/, json: gitlabIssue() },
    // Deliberately no route for the /notes endpoint — if the adapter fetched
    // it anyway, mockGitLabFetch would throw "no route for ..." and fail
    // this test loudly.
  ]);
  try {
    const res = await getGitLabIssueThread(repo, 5, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.comments).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(mock.calls).toHaveLength(1); // issue fetch only
  } finally {
    mock.restore();
  }
});

test("getGitLabIssueThread rejects a non-positive/non-integer iid before any fetch", async () => {
  const repo = sampleRepo();
  const mock = mockGitLabFetch([]); // any fetch call would throw — proves none happens

  for (const bad of [0, -1, 2.5]) {
    const res = await getGitLabIssueThread(repo, bad);
    expect(res).toEqual({ ok: false, error: "issue number must be positive" });
  }
  expect(mock.calls).toHaveLength(0);
  mock.restore();
});

test("getGitLabIssueThread surfaces the notes fetch's error after a successful issue fetch", async () => {
  const repo = sampleRepo();
  const mock = mockGitLabFetch([
    { match: /\/projects\/acme%2Fapp\/issues\/6$/, json: gitlabIssue({ iid: 6 }) },
    { match: "/issues/6/notes", status: 404, json: { message: "404 Project Not Found" } },
  ]);
  try {
    const res = await getGitLabIssueThread(repo, 6);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    // A 404 is enriched by authHint (Settings pointer) rather than surfacing
    // the raw API message verbatim — same wording apiError/authHint tests
    // above already pin for the pure helper.
    expect(res.error).toContain("acme/app");
    expect(res.error).toContain("Settings");
  } finally {
    mock.restore();
  }
});

test("listGitLabComments (shared by getGitLabIssueThread) excludes system notes and follows x-next-page pagination — pinning the existing behavior", async () => {
  const repo = sampleRepo();
  const mock = mockGitLabFetch([
    {
      match: /\/issues\/8\/notes\?sort=asc&order_by=created_at&per_page=100$/,
      json: [
        gitlabNote({ id: 10, body: "changed milestone", system: true }),
        gitlabNote({ id: 11, body: "first real comment", system: false }),
      ],
      headers: { "x-next-page": "2" },
    },
    {
      match: "page=2",
      json: [gitlabNote({ id: 12, body: "second real comment", system: false })],
    },
  ]);
  try {
    const res = await listGitLabComments(repo, 8, "issues");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.repo).toBe("acme/app");
    expect(res.itemNumber).toBe(8);
    expect(res.comments.map((c) => c.id)).toEqual([11, 12]);
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});
