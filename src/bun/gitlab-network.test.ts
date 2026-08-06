// Network-level tests for gitlab.ts (TT2, docs/plans/multi-provider-git-modal.md),
// exercising the real request/response path (URL, headers, body, pagination,
// error mapping) via the fetch-mock harness reused from github-test-util.ts.
// Complements gitlab.test.ts, which unit-tests the pure helpers in isolation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { gitlabMergeRequest, mockGitLabFetch, sampleRepo } from "./gitlab-test-util.ts";
import {
  closeGitLabPull,
  createGitLabComment,
  createGitLabIssue,
  createGitLabPull,
  createGitLabPullLineComment,
  getGitLabPullChecks,
  getGitLabPullDefaults,
  getGitLabPullDiff,
  getGitLabPullMergeability,
  getGitLabViewer,
  listGitLabComments,
  listGitLabItems,
  listGitLabLabels,
  mergeGitLabPull,
  normalizeGitLabMergeability,
  replyGitLabLineComment,
  reopenGitLabPull,
  reviewGitLabPull,
  updateGitLabIssue,
} from "./gitlab.ts";

const REPO = sampleRepo();

// gitlab.ts resolves its token via github-tokens.ts's raw-host-keyed store
// first, falling back to GITLAB_TOKEN env (see git-provider.ts's
// `gitlabToken`) — an AGETOR_DATA_DIR pointed at an empty mkdtemp dir keeps
// the store empty so every test below deterministically falls through to the
// env var instead of shelling out to `glab` or picking up a real credential.
const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ORIGINAL_GITLAB_TOKEN = process.env.GITLAB_TOKEN;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-gitlab-net-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  process.env.GITLAB_TOKEN = "test-token";
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_GITLAB_TOKEN === undefined) delete process.env.GITLAB_TOKEN;
  else process.env.GITLAB_TOKEN = ORIGINAL_GITLAB_TOKEN;
});

// ---------------------------------------------------------------------------
// listGitLabItems
// ---------------------------------------------------------------------------

test("listGitLabItems hits /api/v4/projects/acme%2Fapp/merge_requests with per_page/page/order_by/sort and the PRIVATE-TOKEN header", async () => {
  const mock = mockGitLabFetch([
    { match: "/api/v4/projects/acme%2Fapp/merge_requests", json: [] },
  ]);
  try {
    const res = await listGitLabItems(REPO, { kind: "pulls", state: "open", page: 2, sort: "created", direction: "asc" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.url).toContain("/api/v4/projects/acme%2Fapp/merge_requests");
    const q = new URL(call.url).searchParams;
    expect(q.get("per_page")).toBe("30");
    expect(q.get("page")).toBe("2");
    expect(q.get("order_by")).toBe("created_at");
    expect(q.get("sort")).toBe("asc");
    expect(call.headers["private-token"]).toBe("test-token");
  } finally {
    mock.restore();
  }
});

test("listGitLabItems sets `state` for open and closed(issues), but omits it entirely for state:\"all\"", async () => {
  const openMock = mockGitLabFetch([{ match: "merge_requests", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "pulls", state: "open" });
    expect(new URL(openMock.calls[0]!.url).searchParams.get("state")).toBe("opened");
  } finally {
    openMock.restore();
  }

  const closedIssuesMock = mockGitLabFetch([{ match: "issues", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "issues", state: "closed" });
    expect(new URL(closedIssuesMock.calls[0]!.url).searchParams.get("state")).toBe("closed");
  } finally {
    closedIssuesMock.restore();
  }

  // "all" is a regression-guard: GitLab's issues list endpoint doesn't
  // document `state=all` the way the MR list does, so "all" is expressed by
  // omitting the `state` param entirely on both endpoints.
  const allMock = mockGitLabFetch([{ match: "merge_requests", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "pulls", state: "all" });
    expect(new URL(allMock.calls[0]!.url).searchParams.has("state")).toBe(false);
  } finally {
    allMock.restore();
  }
});

test("listGitLabItems joins labels with a comma and sets assignee_username", async () => {
  const mock = mockGitLabFetch([{ match: "merge_requests", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "pulls", state: "open", labels: ["bug", "p1"], assignee: "bob" });
    const q = new URL(mock.calls[0]!.url).searchParams;
    expect(q.get("labels")).toBe("bug,p1");
    expect(q.get("assignee_username")).toBe("bob");
  } finally {
    mock.restore();
  }
});

test("listGitLabItems scope precedence: createdByMe beats assignedToMe beats reviewRequested", async () => {
  const mock = mockGitLabFetch([{ match: "merge_requests", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "pulls", state: "open", createdByMe: true, assignedToMe: true, reviewRequested: true });
    expect(new URL(mock.calls[0]!.url).searchParams.get("scope")).toBe("created_by_me");
  } finally {
    mock.restore();
  }

  const mock2 = mockGitLabFetch([{ match: "merge_requests", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "pulls", state: "open", assignedToMe: true, reviewRequested: true });
    expect(new URL(mock2.calls[0]!.url).searchParams.get("scope")).toBe("assigned_to_me");
  } finally {
    mock2.restore();
  }

  const mock3 = mockGitLabFetch([{ match: "merge_requests", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "pulls", state: "open", reviewRequested: true });
    expect(new URL(mock3.calls[0]!.url).searchParams.get("scope")).toBe("reviews_for_me");
  } finally {
    mock3.restore();
  }
});

test("listGitLabItems ignores reviewRequested for issues (no reviewer concept there)", async () => {
  const mock = mockGitLabFetch([{ match: "issues", json: [] }]);
  try {
    await listGitLabItems(REPO, { kind: "issues", state: "open", reviewRequested: true });
    expect(new URL(mock.calls[0]!.url).searchParams.has("scope")).toBe(false);
  } finally {
    mock.restore();
  }
});

test("listGitLabItems closed pulls fan out to two requests (closed, then merged), merged + sorted, hasMore false", async () => {
  const mock = mockGitLabFetch([
    {
      match: /state=closed/,
      json: [{ iid: 1, title: "closed one", state: "closed", web_url: "https://x/1", updated_at: "2026-01-01T00:00:00Z" }],
    },
    {
      match: /state=merged/,
      json: [{ iid: 2, title: "merged one", state: "merged", web_url: "https://x/2", updated_at: "2026-01-05T00:00:00Z" }],
    },
  ]);
  try {
    const res = await listGitLabItems(REPO, { kind: "pulls", state: "closed" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(mock.calls).toHaveLength(2);
    expect(res.items.map((i) => i.number)).toEqual([2, 1]); // newest updatedAt first
    expect(res.hasMore).toBe(false);
  } finally {
    mock.restore();
  }
});

test("listGitLabItems closed issues is a single direct state=closed request (no fan-out)", async () => {
  const mock = mockGitLabFetch([
    { match: /state=closed/, json: [{ iid: 1, title: "t", state: "closed", web_url: "https://x/1" }] },
  ]);
  try {
    const res = await listGitLabItems(REPO, { kind: "issues", state: "closed" });
    expect(res.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("listGitLabItems (single-state) hasMore is true when x-next-page/Link indicate another page", async () => {
  const mock = mockGitLabFetch([
    {
      match: "merge_requests",
      json: [{ iid: 1, title: "t", state: "opened", web_url: "https://x/1" }],
      headers: { "x-next-page": "2" },
    },
  ]);
  try {
    const res = await listGitLabItems(REPO, { kind: "pulls", state: "open" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.hasMore).toBe(true);
  } finally {
    mock.restore();
  }
});

test("listGitLabItems (single-state) hasMore is false with no next-page signal", async () => {
  const mock = mockGitLabFetch([
    { match: "merge_requests", json: [{ iid: 1, title: "t", state: "opened", web_url: "https://x/1" }] },
  ]);
  try {
    const res = await listGitLabItems(REPO, { kind: "pulls", state: "open" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.hasMore).toBe(false);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getGitLabPullDefaults / createGitLabPull
// ---------------------------------------------------------------------------

test("getGitLabPullDefaults reads default_branch from the project GET, head is empty (facade fills it in)", async () => {
  const mock = mockGitLabFetch([
    { match: "/api/v4/projects/acme%2Fapp", json: { default_branch: "main" } },
  ]);
  try {
    const res = await getGitLabPullDefaults(REPO);
    expect(res).toEqual({ ok: true, repo: "acme/app", head: "", base: "main" });
  } finally {
    mock.restore();
  }
});

test("createGitLabPull POSTs source_branch/target_branch and prefixes the title on draft", async () => {
  const mock = mockGitLabFetch([
    {
      method: "POST",
      match: "/merge_requests",
      json: { iid: 3, title: "Draft: Add x", state: "opened", web_url: "https://x/3" },
    },
  ]);
  try {
    const res = await createGitLabPull(REPO, { title: "Add x", body: "desc", base: "main", head: "feature", draft: true });
    expect(res.ok).toBe(true);
    const call = mock.calls[0]!;
    const body = JSON.parse(call.body!);
    expect(body).toMatchObject({ title: "Draft: Add x", description: "desc", source_branch: "feature", target_branch: "main" });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getGitLabPullDiff
// ---------------------------------------------------------------------------

test("getGitLabPullDiff hits raw_diffs and parses the plain-text unified diff into files", async () => {
  const diff = [
    "diff --git a/foo.ts b/foo.ts",
    "index 111..222 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const mock = mockGitLabFetch([{ match: "/merge_requests/5/raw_diffs", text: diff }]);
  try {
    const res = await getGitLabPullDiff(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.files.map((f) => f.path)).toEqual(["foo.ts"]);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// listGitLabComments — system note exclusion
// ---------------------------------------------------------------------------

test("listGitLabComments excludes system notes (label/assignee automation) from the result", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/1/notes",
      json: [
        { id: 1, body: "added label ~bug", system: true, author: { username: "bot" } },
        { id: 2, body: "a real comment", system: false, author: { username: "alice" } },
      ],
    },
  ]);
  try {
    const res = await listGitLabComments(REPO, 1, "pulls");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.comments.map((c) => c.id)).toEqual([2]);
  } finally {
    mock.restore();
  }
});

test("createGitLabComment POSTs {body} to the notes endpoint", async () => {
  const mock = mockGitLabFetch([
    { method: "POST", match: "/issues/7/notes", json: { id: 9, body: "hi", author: null } },
  ]);
  try {
    const res = await createGitLabComment(REPO, 7, "issues", "hi");
    expect(res.ok).toBe(true);
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ body: "hi" });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// createGitLabPullLineComment
// ---------------------------------------------------------------------------

test("createGitLabPullLineComment fetches versions first, then POSTs discussions with a full position for RIGHT (new_line)", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/5/versions",
      json: [{ base_commit_sha: "base1", start_commit_sha: "start1", head_commit_sha: "head1" }],
    },
    {
      method: "POST",
      match: "/merge_requests/5/discussions",
      json: { notes: [{ id: 1, body: "nit", position: { new_path: "a.ts", old_path: "a.ts", new_line: 10 } }] },
    },
  ]);
  try {
    const res = await createGitLabPullLineComment(REPO, 5, { path: "a.ts", line: 10, side: "RIGHT", body: "nit" });
    expect(res.ok).toBe(true);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.url).toContain("/merge_requests/5/versions");
    const postBody = JSON.parse(mock.calls[1]!.body!);
    expect(postBody.position).toMatchObject({
      base_sha: "base1",
      start_sha: "start1",
      head_sha: "head1",
      new_line: 10,
    });
    expect(postBody.position.old_line).toBeUndefined();
  } finally {
    mock.restore();
  }
});

test("createGitLabPullLineComment posts old_line (not new_line) for side:LEFT", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/versions",
      json: [{ base_commit_sha: "b", start_commit_sha: "s", head_commit_sha: "h" }],
    },
    {
      method: "POST",
      match: "/discussions",
      json: { notes: [{ id: 1, body: "nit", position: { old_path: "a.ts", old_line: 4 } }] },
    },
  ]);
  try {
    const res = await createGitLabPullLineComment(REPO, 5, { path: "a.ts", line: 4, side: "LEFT", body: "nit" });
    expect(res.ok).toBe(true);
    const postBody = JSON.parse(mock.calls[1]!.body!);
    expect(postBody.position.old_line).toBe(4);
    expect(postBody.position.new_line).toBeUndefined();
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// replyGitLabLineComment
// ---------------------------------------------------------------------------

test("replyGitLabLineComment resolves the discussion id via GET discussions, then POSTs to /discussions/:id/notes", async () => {
  const mock = mockGitLabFetch([
    {
      method: "GET",
      match: "/merge_requests/5/discussions",
      json: [{ id: "disc-abc", notes: [{ id: 42 }] }],
    },
    {
      method: "POST",
      match: "/discussions/disc-abc/notes",
      json: { id: 43, body: "reply", position: { new_path: "a.ts", new_line: 1 } },
    },
  ]);
  try {
    const res = await replyGitLabLineComment(REPO, 5, 42, "reply");
    expect(res.ok).toBe(true);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.url).toContain("/discussions/disc-abc/notes");
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ body: "reply" });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getGitLabPullChecks
// ---------------------------------------------------------------------------

test("getGitLabPullChecks GETs the MR for sha/head_pipeline, then commit statuses, mapped to GitHubCheckRun[]", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/9",
      json: { sha: "deadbeef", head_pipeline: { id: 1, status: "running", web_url: "https://ci/1" } },
    },
    {
      match: "/repository/commits/deadbeef/statuses",
      json: [{ id: 5, name: "build", status: "success", target_url: "https://ci/5" }],
    },
  ]);
  try {
    const res = await getGitLabPullChecks(REPO, 9);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.sha).toBe("deadbeef");
    expect(res.checkRuns).toEqual([
      { id: 5, name: "build", status: "completed", conclusion: "success", htmlUrl: "https://ci/5", startedAt: null, completedAt: null },
    ]);
  } finally {
    mock.restore();
  }
});

test("getGitLabPullChecks falls back to a synthetic pipeline entry when there are no per-job statuses", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/9",
      json: { sha: "deadbeef", head_pipeline: { id: 77, status: "running", web_url: "https://ci/pipe/77" } },
    },
    { match: "/statuses", json: [] },
  ]);
  try {
    const res = await getGitLabPullChecks(REPO, 9);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.checkRuns).toEqual([
      { id: 77, name: "pipeline #77", status: "in_progress", conclusion: null, htmlUrl: "https://ci/pipe/77", startedAt: null, completedAt: null },
    ]);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// mergeGitLabPull
// ---------------------------------------------------------------------------

test("mergeGitLabPull PUTs /merge with squash:true for method:squash", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/merge_requests/5/merge", json: { state: "merged", merge_commit_sha: "abc" } },
  ]);
  try {
    const res = await mergeGitLabPull(REPO, 5, "squash");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.merged).toBe(true);
    expect(res.sha).toBe("abc");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ squash: true });
  } finally {
    mock.restore();
  }
});

test("mergeGitLabPull PUTs /merge with squash:false for method:merge", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/merge_requests/5/merge", json: { state: "merged" } },
  ]);
  try {
    await mergeGitLabPull(REPO, 5, "merge");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ squash: false });
  } finally {
    mock.restore();
  }
});

test("mergeGitLabPull returns a friendly error on 405 (not mergeable)", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/merge", status: 405, json: { message: "405 Method Not Allowed" } },
  ]);
  try {
    const res = await mergeGitLabPull(REPO, 5, "merge");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("cannot be merged right now");
  } finally {
    mock.restore();
  }
});

test("mergeGitLabPull rejects the \"rebase\" method defensively (GitLab has no rebase merge strategy)", async () => {
  const res = await mergeGitLabPull(REPO, 5, "rebase");
  expect(res.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// close / reopen
// ---------------------------------------------------------------------------

test("closeGitLabPull PUTs state_event:close", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/merge_requests/5", json: { iid: 5, title: "t", state: "closed", web_url: "https://x/5" } },
  ]);
  try {
    const res = await closeGitLabPull(REPO, 5);
    expect(res.ok).toBe(true);
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ state_event: "close" });
  } finally {
    mock.restore();
  }
});

test("reopenGitLabPull PUTs state_event:reopen", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/merge_requests/5", json: { iid: 5, title: "t", state: "opened", web_url: "https://x/5" } },
  ]);
  try {
    const res = await reopenGitLabPull(REPO, 5);
    expect(res.ok).toBe(true);
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ state_event: "reopen" });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// reviewGitLabPull
// ---------------------------------------------------------------------------

test("reviewGitLabPull APPROVE POSTs /approve, and posts a note when a body is given", async () => {
  const mock = mockGitLabFetch([
    { method: "POST", match: "/merge_requests/5/approve", json: {} },
    { method: "POST", match: "/merge_requests/5/notes", json: { id: 1, body: "lgtm" } },
  ]);
  try {
    const res = await reviewGitLabPull(REPO, 5, "APPROVE", "lgtm");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.commentPosted).toBe(true);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.url).toContain("/approve");
  } finally {
    mock.restore();
  }
});

test("reviewGitLabPull APPROVE with no body only hits /approve", async () => {
  const mock = mockGitLabFetch([{ method: "POST", match: "/approve", json: {} }]);
  try {
    const res = await reviewGitLabPull(REPO, 5, "APPROVE");
    expect(res.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("reviewGitLabPull REQUEST_CHANGES fails fast with no network call — not supported on GitLab", async () => {
  const mock = mockGitLabFetch([]); // any fetch call would throw (unmatched route)
  try {
    const res = await reviewGitLabPull(REPO, 5, "REQUEST_CHANGES", "please fix");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.toLowerCase()).toContain("not supported on gitlab");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// create / update issue
// ---------------------------------------------------------------------------

test("createGitLabIssue POSTs title/description and joins labels with a comma", async () => {
  const mock = mockGitLabFetch([
    { method: "POST", match: "/issues", json: { iid: 1, title: "Bug", state: "opened", web_url: "https://x/1" } },
  ]);
  try {
    const res = await createGitLabIssue(REPO, { title: "Bug", body: "repro steps", labels: ["bug", "p1"] });
    expect(res.ok).toBe(true);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toMatchObject({ title: "Bug", description: "repro steps", labels: "bug,p1" });
  } finally {
    mock.restore();
  }
});

test("updateGitLabIssue PUTs state_event:close for state:closed and joins labels", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/issues/3", json: { iid: 3, title: "Bug", state: "closed", web_url: "https://x/3" } },
  ]);
  try {
    const res = await updateGitLabIssue(REPO, 3, { state: "closed", labels: ["bug", "p1"] });
    expect(res.ok).toBe(true);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toMatchObject({ state_event: "close", labels: "bug,p1" });
  } finally {
    mock.restore();
  }
});

test("updateGitLabIssue PUTs state_event:reopen for state:open, targeting merge_requests when kind:pulls", async () => {
  const mock = mockGitLabFetch([
    { method: "PUT", match: "/merge_requests/3", json: { iid: 3, title: "t", state: "opened", web_url: "https://x/3" } },
  ]);
  try {
    const res = await updateGitLabIssue(REPO, 3, { kind: "pulls", state: "open" });
    expect(res.ok).toBe(true);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toMatchObject({ state_event: "reopen" });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getGitLabViewer / listGitLabLabels
// ---------------------------------------------------------------------------

test("getGitLabViewer hits /user and maps username to login", async () => {
  const mock = mockGitLabFetch([{ match: "/api/v4/user", json: { username: "octocat" } }]);
  try {
    const res = await getGitLabViewer(REPO);
    expect(res).toEqual({ ok: true, login: "octocat" });
    expect(mock.calls[0]!.headers["private-token"]).toBe("test-token");
  } finally {
    mock.restore();
  }
});

test("listGitLabLabels follows pagination and sorts alphabetically", async () => {
  const mock = mockGitLabFetch([
    {
      match: /labels\?per_page=100$/,
      json: [{ name: "wip", color: "#00ff00", description: "" }],
      headers: { "x-next-page": "2" },
    },
    {
      match: /page=2/,
      json: [{ name: "bug", color: "#ff0000", description: "a defect" }],
    },
  ]);
  try {
    const res = await listGitLabLabels(REPO);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.labels.map((l) => l.name)).toEqual(["bug", "wip"]);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 401 auth hint
// ---------------------------------------------------------------------------

test("a 401 response surfaces the authHint wording pointing at Settings", async () => {
  const mock = mockGitLabFetch([
    { match: "/user", status: 401, json: { message: "401 Unauthorized" } },
  ]);
  try {
    const res = await getGitLabViewer(REPO);
    // getGitLabViewer with a token present still calls the endpoint; on 401
    // the authHint wraps the message with a pointer to Settings.
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("Settings");
    expect(res.error).toContain("Git host tokens");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getGitLabPullMergeability / normalizeGitLabMergeability
// ---------------------------------------------------------------------------

test("getGitLabPullMergeability: detailed_merge_status:conflict -> dirty/mergeable:false, headRef/baseRef from branches, state:open", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/5",
      json: gitlabMergeRequest({
        iid: 5,
        state: "opened",
        detailed_merge_status: "conflict",
        source_branch: "feature",
        target_branch: "main",
        source_project_id: 1,
        target_project_id: 1,
      }),
    },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("dirty");
    expect(res.mergeable).toBe(false);
    expect(res.headRef).toBe("feature");
    expect(res.baseRef).toBe("main");
    expect(res.state).toBe("open");
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: detailed_merge_status:mergeable -> clean/mergeable:true", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: gitlabMergeRequest({ detailed_merge_status: "mergeable" }) },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("clean");
    expect(res.mergeable).toBe(true);
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: detailed_merge_status:unchecked retries (1.2s apart) until the verdict settles", async () => {
  // mockGitLabFetch's route table always returns the first matching route's
  // fixed response, so it can't express "different body on the 2nd call" —
  // stub globalThis.fetch directly here instead, call-count keyed.
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
    calls++;
    const detailed = calls === 1 ? "unchecked" : "conflict";
    return new Response(JSON.stringify(gitlabMergeRequest({ detailed_merge_status: detailed })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("dirty");
  } finally {
    globalThis.fetch = original;
  }
}, 10_000);

test("getGitLabPullMergeability: falls back to has_conflicts:true -> dirty when detailed_merge_status is absent", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: gitlabMergeRequest({ has_conflicts: true }) },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("dirty");
    expect(res.mergeable).toBe(false);
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: falls back to merge_status:can_be_merged -> clean when neither detailed_merge_status nor has_conflicts is present", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: gitlabMergeRequest({ merge_status: "can_be_merged" }) },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("clean");
    expect(res.mergeable).toBe(true);
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: ci_must_pass (an explicit blocking reason) maps to blocked", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: gitlabMergeRequest({ detailed_merge_status: "ci_must_pass", merge_status: "can_be_merged" }) },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("blocked");
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: a genuinely unrecognized detailed_merge_status fails safe to blocked, NOT falling back to merge_status", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/5",
      json: gitlabMergeRequest({ detailed_merge_status: "future_status", merge_status: "can_be_merged", has_conflicts: false }),
    },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeableState).toBe("blocked");
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: source_project_id !== target_project_id -> crossRepo:true, headRepo:null", async () => {
  const mock = mockGitLabFetch([
    {
      match: "/merge_requests/5",
      json: gitlabMergeRequest({ detailed_merge_status: "mergeable", source_project_id: 1, target_project_id: 2 }),
    },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.crossRepo).toBe(true);
    expect(res.headRepo).toBe(null);
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: missing source_project_id/target_project_id fails closed to crossRepo:true", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: gitlabMergeRequest({ detailed_merge_status: "mergeable" }) },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.crossRepo).toBe(true);
    expect(res.headRepo).toBe(null);
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: state:merged -> merged:true, state:'merged'", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: gitlabMergeRequest({ state: "merged", detailed_merge_status: "mergeable" }) },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.merged).toBe(true);
    expect(res.state).toBe("merged");
  } finally {
    mock.restore();
  }
});

test("getGitLabPullMergeability: a malformed (non-object) response body fails with the unexpected-response error", async () => {
  const mock = mockGitLabFetch([
    { match: "/merge_requests/5", json: null },
  ]);
  try {
    const res = await getGitLabPullMergeability(REPO, 5);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("unexpected merge request response");
  } finally {
    mock.restore();
  }
});

test("normalizeGitLabMergeability: draft:true via the `draft` field", () => {
  const result = normalizeGitLabMergeability(REPO, 5, gitlabMergeRequest({ draft: true, detailed_merge_status: "mergeable" }));
  expect(result?.draft).toBe(true);
});

test("normalizeGitLabMergeability: draft:true via `work_in_progress` when `draft` is false", () => {
  const result = normalizeGitLabMergeability(
    REPO,
    5,
    gitlabMergeRequest({ draft: false, work_in_progress: true, detailed_merge_status: "mergeable" }),
  );
  expect(result?.draft).toBe(true);
});

test("normalizeGitLabMergeability: headSha prefers diff_refs.head_sha over the top-level sha", () => {
  const result = normalizeGitLabMergeability(
    REPO,
    5,
    gitlabMergeRequest({ sha: "sha-fallback", diff_refs: { head_sha: "diff-refs-head" } }),
  );
  expect(result?.headSha).toBe("diff-refs-head");
});

test("normalizeGitLabMergeability: headSha falls back to the top-level sha when diff_refs is absent", () => {
  const result = normalizeGitLabMergeability(REPO, 5, gitlabMergeRequest({ sha: "sha-fallback" }));
  expect(result?.headSha).toBe("sha-fallback");
});

test("normalizeGitLabMergeability: autoMerge:true from merge_when_pipeline_succeeds", () => {
  const result = normalizeGitLabMergeability(REPO, 5, gitlabMergeRequest({ merge_when_pipeline_succeeds: true }));
  expect(result?.autoMerge).toBe(true);
});

// ---------------------------------------------------------------------------
// Unmatched-route guard
// ---------------------------------------------------------------------------

test("mockGitLabFetch's unmatched-route guard surfaces as a fetch error — guards every test above against a silently-passing unexpected request", async () => {
  // fetchGitLab (gitlab.ts) wraps every `fetch` call in a try/catch that turns
  // a thrown error into `{ok:false,error:...}` rather than letting it reject —
  // so an unmatched route in any test above would show up as a failed
  // assertion on the *response shape*, not an uncaught rejection. This test
  // pins that behavior down directly: a route table with no match for
  // raw_diffs surfaces mockGitLabFetch's own "no route for" message.
  const mock = mockGitLabFetch([{ match: "/api/v4/user", json: { username: "x" } }]);
  try {
    const res = await getGitLabPullDiff(REPO, 1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("no route for");
  } finally {
    mock.restore();
  }
});
