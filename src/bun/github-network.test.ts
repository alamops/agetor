// Network-level tests for github.ts, exercising the real request/response path
// (URL, method, headers, body, pagination, error mapping) via the fetch-mock
// harness in github-test-util.ts. Complements github.test.ts, which unit-tests
// the pure helpers in isolation.
import { test, expect, beforeAll } from "bun:test";
import { makeGitHubRepo, mockGitHubFetch } from "./github-test-util.ts";
import {
  addGitHubReaction,
  addGitHubSubIssue,
  applyGitHubSuggestion,
  getGitHubIssuePinned,
  getGitHubPullLinkedIssues,
  getGitHubRepoPermissions,
  getGitHubThreadSubscription,
  getGitHubViewer,
  listGitHubAssignees,
  listGitHubItems,
  listGitHubLabels,
  listGitHubMilestones,
  listGitHubNotifications,
  listGitHubPullCommits,
  listGitHubReactions,
  listGitHubSubIssues,
  markAllGitHubNotificationsRead,
  markGitHubNotificationRead,
  removeGitHubReaction,
  removeGitHubSubIssue,
  requestGitHubPullReviewers,
  setGitHubIssueLock,
  setGitHubIssuePinned,
  setGitHubPullAutoMerge,
  setGitHubThreadSubscription,
  transferGitHubIssue,
  unsubscribeGitHubThread,
} from "./github.ts";

let REPO_DIR = "";

beforeAll(async () => {
  // Force a deterministic token so githubToken() doesn't shell out to `gh`.
  process.env.GITHUB_TOKEN = "test-token";
  REPO_DIR = await makeGitHubRepo("acme", "widgets");
});

test("getGitHubViewer hits /user with the bearer token and returns the login", async () => {
  const mock = mockGitHubFetch([{ match: "https://api.github.com/user", json: { login: "octocat" } }]);
  try {
    const res = await getGitHubViewer({ dir: REPO_DIR });
    expect(res).toEqual({ ok: true, login: "octocat" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/user");
    expect(mock.calls[0]!.method).toBe("GET");
    expect(mock.calls[0]!.headers.authorization).toBe("Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("listGitHubLabels resolves the repo from the git remote and follows pagination", async () => {
  const page1 = [{ name: "bug", color: "d73a4a", description: "a defect" }];
  const page2 = [{ name: "wip", color: "", description: "" }];
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/labels?per_page=100",
      json: page1,
      headers: { link: '<https://api.github.com/repos/acme/widgets/labels?page=2>; rel="next"' },
    },
    { match: "labels?page=2", json: page2 },
  ]);
  try {
    const res = await listGitHubLabels({ dir: REPO_DIR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.repo).toBe("acme/widgets");
    expect(res.labels.map((l) => l.name).sort()).toEqual(["bug", "wip"]);
    expect(mock.calls).toHaveLength(2); // followed the `next` link
  } finally {
    mock.restore();
  }
});

test("listGitHubAssignees hits the assignees endpoint and maps logins through normalizeUser", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/assignees",
      json: [
        { login: "octocat", avatar_url: "https://example.com/o.png", html_url: "https://github.com/octocat" },
        { login: "hubot", avatar_url: null, html_url: null },
      ],
    },
  ]);
  try {
    const res = await listGitHubAssignees({ dir: REPO_DIR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.repo).toBe("acme/widgets");
    expect(res.assignees.map((a) => a.login)).toEqual(["hubot", "octocat"]);
    expect(res.assignees.find((a) => a.login === "octocat")).toEqual({
      login: "octocat",
      avatarUrl: "https://example.com/o.png",
      htmlUrl: "https://github.com/octocat",
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/assignees?per_page=100");
  } finally {
    mock.restore();
  }
});

test("listGitHubMilestones maps snake_case fields from the API response", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/milestones",
      json: [
        { number: 1, title: "v1", state: "open", description: "", due_on: null, open_issues: 3, closed_issues: 1, html_url: "u" },
      ],
    },
  ]);
  try {
    const res = await listGitHubMilestones({ dir: REPO_DIR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.milestones).toHaveLength(1);
    expect(res.milestones[0]).toMatchObject({ number: 1, title: "v1", openIssues: 3, closedIssues: 1 });
  } finally {
    mock.restore();
  }
});

test("listGitHubReactions hits the issue reactions endpoint and aggregates by content", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/issues/9/reactions",
      json: [
        { id: 100, content: "+1", user: { login: "octocat" } },
        { id: 101, content: "+1", user: { login: "hubot" } },
        { id: 102, content: "heart", user: { login: "octocat" } },
      ],
    },
  ]);
  try {
    const res = await listGitHubReactions({ dir: REPO_DIR, subject: { type: "issue", id: 9 }, viewer: "octocat" });
    expect(res).toEqual({
      ok: true,
      reactions: [
        { content: "+1", count: 2, viewerReactionId: 100 },
        { content: "heart", count: 1, viewerReactionId: 102 },
      ],
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/issues/9/reactions?per_page=100");
    expect(mock.calls[0]!.method).toBe("GET");
  } finally {
    mock.restore();
  }
});

test("addGitHubReaction POSTs the content to the comment reactions endpoint and returns the new id", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/repos/acme/widgets/issues/comments/55/reactions",
      json: { id: 777, content: "rocket" },
    },
  ]);
  try {
    const res = await addGitHubReaction({
      dir: REPO_DIR,
      subject: { type: "issueComment", id: 55 },
      content: "rocket",
    });
    expect(res).toEqual({ ok: true, reactionId: 777, content: "rocket" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/issues/comments/55/reactions");
    expect(mock.calls[0]!.method).toBe("POST");
    expect(mock.calls[0]!.body).toBe(JSON.stringify({ content: "rocket" }));
    expect(mock.calls[0]!.headers.authorization).toBe("Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("removeGitHubReaction DELETEs the review-comment reaction by id", async () => {
  const mock = mockGitHubFetch([
    {
      method: "DELETE",
      match: "/repos/acme/widgets/pulls/comments/12/reactions/999",
    },
  ]);
  try {
    const res = await removeGitHubReaction({
      dir: REPO_DIR,
      subject: { type: "reviewComment", id: 12 },
      reactionId: 999,
    });
    expect(res).toEqual({ ok: true });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/comments/12/reactions/999");
    expect(mock.calls[0]!.method).toBe("DELETE");
  } finally {
    mock.restore();
  }
});

test("addGitHubReaction maps a non-2xx response to the friendly `message` error", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/reactions",
      status: 422,
      json: { message: "Content cannot be blank" },
    },
  ]);
  try {
    const res = await addGitHubReaction({
      dir: REPO_DIR,
      subject: { type: "issue", id: 1 },
      content: "eyes",
    });
    expect(res).toEqual({ ok: false, error: "Content cannot be blank" });
  } finally {
    mock.restore();
  }
});

test("a non-2xx response is mapped to a friendly error via the `message` field", async () => {
  const mock = mockGitHubFetch([{ match: "/repos/acme/widgets/labels", status: 404, json: { message: "Not Found" } }]);
  try {
    const res = await listGitHubLabels({ dir: REPO_DIR });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("Not Found");
  } finally {
    mock.restore();
  }
});

test("listGitHubPullCommits hits the pull commits endpoint and maps sha/headline/author/date", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/pulls/7/commits?per_page=100",
      json: [
        {
          sha: "abc123",
          html_url: "https://github.com/acme/widgets/commit/abc123",
          commit: { message: "Fix bug\n\nDetails here", author: { date: "2026-01-01T00:00:00Z" } },
          author: { login: "octocat", avatar_url: null, html_url: null },
        },
      ],
    },
  ]);
  try {
    const res = await listGitHubPullCommits({ dir: REPO_DIR, number: 7 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.repo).toBe("acme/widgets");
    expect(res.pullNumber).toBe(7);
    expect(res.commits).toEqual([
      {
        sha: "abc123",
        messageHeadline: "Fix bug",
        author: { login: "octocat", avatarUrl: null, htmlUrl: null },
        authoredDate: "2026-01-01T00:00:00Z",
        htmlUrl: "https://github.com/acme/widgets/commit/abc123",
      },
    ]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/commits?per_page=100");
  } finally {
    mock.restore();
  }
});

test("setGitHubPullAutoMerge enable POSTs enablePullRequestAutoMerge with the uppercased merge method", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/pulls/9", json: { node_id: "PR_kwabc" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { data: { enablePullRequestAutoMerge: { pullRequest: { number: 9 } } } },
    },
  ]);
  try {
    const res = await setGitHubPullAutoMerge({ dir: REPO_DIR, number: 9, enable: true, mergeMethod: "squash" });
    expect(res).toEqual({ ok: true, autoMergeEnabled: true, message: "Auto-merge enabled." });
    const gqlCall = mock.calls.find((c) => c.url === "https://api.github.com/graphql");
    expect(gqlCall).toBeDefined();
    const body = JSON.parse(gqlCall!.body!);
    expect(body.query).toContain("enablePullRequestAutoMerge");
    expect(body.variables).toEqual({ id: "PR_kwabc", method: "SQUASH" });
  } finally {
    mock.restore();
  }
});

test("setGitHubPullAutoMerge disable POSTs disablePullRequestAutoMerge with just the pull request id", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/pulls/9", json: { node_id: "PR_kwabc" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { data: { disablePullRequestAutoMerge: { pullRequest: { number: 9 } } } },
    },
  ]);
  try {
    const res = await setGitHubPullAutoMerge({ dir: REPO_DIR, number: 9, enable: false });
    expect(res).toEqual({ ok: true, autoMergeEnabled: false, message: "Auto-merge disabled." });
    const gqlCall = mock.calls.find((c) => c.url === "https://api.github.com/graphql");
    const body = JSON.parse(gqlCall!.body!);
    expect(body.query).toContain("disablePullRequestAutoMerge");
    expect(body.variables).toEqual({ id: "PR_kwabc" });
  } finally {
    mock.restore();
  }
});

test("setGitHubPullAutoMerge maps a GraphQL errors[] response to a friendly error", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/pulls/9", json: { node_id: "PR_kwabc" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { errors: [{ message: "Pull request Auto merge is not allowed for this repository" }] },
    },
  ]);
  try {
    const res = await setGitHubPullAutoMerge({ dir: REPO_DIR, number: 9, enable: true });
    expect(res).toEqual({ ok: false, error: "Pull request Auto merge is not allowed for this repository" });
  } finally {
    mock.restore();
  }
});

test("requestGitHubPullReviewers POSTs reviewers and team_reviewers together, omitting an empty side", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/repos/acme/widgets/pulls/9/requested_reviewers",
      json: { requested_reviewers: [], requested_teams: [] },
    },
  ]);
  try {
    const res = await requestGitHubPullReviewers({
      dir: REPO_DIR,
      number: 9,
      reviewers: ["alice", " bob "],
      teamReviewers: ["platform-team"],
    });
    expect(res).toEqual({
      ok: true,
      message: "Requested review from alice, bob and team platform-team.",
    });
    expect(mock.calls).toHaveLength(1);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toEqual({ reviewers: ["alice", "bob"], team_reviewers: ["platform-team"] });
  } finally {
    mock.restore();
  }
});

test("requestGitHubPullReviewers omits the reviewers key when only teams are requested", async () => {
  const mock = mockGitHubFetch([
    { method: "POST", match: "/repos/acme/widgets/pulls/9/requested_reviewers", json: {} },
  ]);
  try {
    const res = await requestGitHubPullReviewers({ dir: REPO_DIR, number: 9, reviewers: [], teamReviewers: ["a-team", "b-team"] });
    expect(res).toEqual({ ok: true, message: "Requested review from teams a-team, b-team." });
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toEqual({ team_reviewers: ["a-team", "b-team"] });
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion fetches the comment + PR + file, splices the commented line, and PUTs the new content", async () => {
  const fileContent = "line1\nconst x = 1;\nline3\n";
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/55",
      json: {
        path: "src/a.ts",
        line: 2,
        side: "RIGHT",
        pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/9",
        body: "Nit:\n\n```suggestion\nconst x = 2;\n```",
      },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/9",
      json: { head: { ref: "feature", repo: { full_name: "acme/widgets" } } },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/contents/src/a.ts?ref=feature",
      json: { content: Buffer.from(fileContent, "utf8").toString("base64"), encoding: "base64", sha: "filesha123" },
    },
    {
      method: "PUT",
      match: "/repos/acme/widgets/contents/src/a.ts",
      json: { content: { sha: "newsha456" } },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 55 });
    expect(res).toEqual({ ok: true, message: "Suggestion applied." });
    const putCall = mock.calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    const putBody = JSON.parse(putCall!.body!);
    expect(putBody.message).toBe("Apply suggestion from review comment");
    expect(putBody.sha).toBe("filesha123");
    expect(putBody.branch).toBe("feature");
    expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe("line1\nconst x = 2;\nline3\n");
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion refuses to PUT when the comment has no suggestion fence", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/56",
      json: { path: "src/a.ts", line: 2, side: "RIGHT", body: "just a regular comment, no suggestion" },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 56 });
    expect(res).toEqual({ ok: false, error: "This comment doesn't contain a suggested change." });
    // Never got past the comment fetch — no PR/contents/PUT calls fired.
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion refuses an outdated comment (line null) before any PR/file fetch", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/57",
      // line null + original_line set is exactly how GitHub reports an outdated comment.
      json: { path: "src/a.ts", line: null, side: "RIGHT", original_line: 2, body: "```suggestion\nconst x = 2;\n```" },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 57 });
    expect(res).toEqual({
      ok: false,
      error: "This suggestion is on an outdated diff and can't be applied automatically.",
    });
    // Refused at the comment level — no PR/contents/PUT calls fired.
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion refuses a LEFT-side (base-file) comment before any write", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/58",
      json: { path: "src/a.ts", line: 2, side: "LEFT", body: "```suggestion\nconst x = 2;\n```" },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 58 });
    expect(res).toEqual({ ok: false, error: "Suggestions can only be applied to added or unchanged lines." });
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion refuses to PUT when the file no longer has the commented line (splice out of range)", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/59",
      json: { path: "src/a.ts", line: 40, side: "RIGHT", body: "```suggestion\nconst x = 2;\n```" },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/9",
      json: { head: { ref: "feature", repo: { full_name: "acme/widgets" } } },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/contents/src/a.ts?ref=feature",
      json: { content: Buffer.from("only\nthree\nlines\n", "utf8").toString("base64"), encoding: "base64", sha: "filesha123" },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 59 });
    expect(res).toEqual({
      ok: false,
      error: "This suggestion is outdated — the file no longer matches the commented lines.",
    });
    // Guard fired before any PUT.
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion rejects a comment that belongs to a different pull request", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/60",
      json: {
        path: "src/a.ts",
        line: 2,
        side: "RIGHT",
        pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/12",
        body: "```suggestion\nx\n```",
      },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 60 });
    expect(res).toEqual({ ok: false, error: "This review comment doesn't belong to that pull request." });
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion rejects a file too large for the Contents API (encoding none)", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/61",
      json: { path: "src/big.ts", line: 2, side: "RIGHT", body: "```suggestion\nx\n```" },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/9",
      json: { head: { ref: "feature", repo: { full_name: "acme/widgets" } } },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/contents/src/big.ts?ref=feature",
      json: { content: "", encoding: "none", sha: "filesha123" },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 61 });
    expect(res).toEqual({ ok: false, error: "This file is too large to apply a suggestion via the Contents API." });
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
  } finally {
    mock.restore();
  }
});

test("applyGitHubSuggestion rejects a cross-fork head with a friendly error", async () => {
  const mock = mockGitHubFetch([
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/comments/62",
      json: { path: "src/a.ts", line: 2, side: "RIGHT", body: "```suggestion\nx\n```" },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls/9",
      json: { head: { ref: "feature", repo: { full_name: "someone-else/widgets" } } },
    },
  ]);
  try {
    const res = await applyGitHubSuggestion({ dir: REPO_DIR, number: 9, commentId: 62 });
    expect(res).toEqual({
      ok: false,
      error: "Applying suggestions isn't supported for pull requests from a fork.",
    });
    expect(mock.calls.some((c) => c.url.includes("/contents/"))).toBe(false);
  } finally {
    mock.restore();
  }
});

test("getGitHubPullLinkedIssues parses closingIssuesReferences nodes from the GraphQL response", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: {
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [
                  { number: 12, title: "Bug A", url: "https://github.com/acme/widgets/issues/12", state: "OPEN" },
                ],
              },
            },
          },
        },
      },
    },
  ]);
  try {
    const res = await getGitHubPullLinkedIssues({ dir: REPO_DIR, number: 3 });
    expect(res).toEqual({
      ok: true,
      repo: "acme/widgets",
      pullNumber: 3,
      issues: [{ number: 12, title: "Bug A", url: "https://github.com/acme/widgets/issues/12", state: "OPEN" }],
    });
  } finally {
    mock.restore();
  }
});

test("setGitHubIssueLock locking PUTs the lock endpoint with the lock_reason when given", async () => {
  const mock = mockGitHubFetch([
    { method: "PUT", match: "/repos/acme/widgets/issues/9/lock", status: 204 },
  ]);
  try {
    const res = await setGitHubIssueLock({ dir: REPO_DIR, number: 9, locked: true, lockReason: "spam" });
    expect(res).toEqual({ ok: true, locked: true, message: "Conversation locked." });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("PUT");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ lock_reason: "spam" });
  } finally {
    mock.restore();
  }
});

test("setGitHubIssueLock locking without a recognized reason PUTs an empty body", async () => {
  const mock = mockGitHubFetch([
    { method: "PUT", match: "/repos/acme/widgets/issues/9/lock", status: 204 },
  ]);
  try {
    const res = await setGitHubIssueLock({ dir: REPO_DIR, number: 9, locked: true, lockReason: "not-a-real-reason" });
    expect(res).toEqual({ ok: true, locked: true, message: "Conversation locked." });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({});
  } finally {
    mock.restore();
  }
});

test("setGitHubIssueLock unlocking DELETEs the lock endpoint with no body", async () => {
  const mock = mockGitHubFetch([
    { method: "DELETE", match: "/repos/acme/widgets/issues/9/lock", status: 204 },
  ]);
  try {
    const res = await setGitHubIssueLock({ dir: REPO_DIR, number: 9, locked: false });
    expect(res).toEqual({ ok: true, locked: false, message: "Conversation unlocked." });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("DELETE");
    expect(mock.calls[0]!.body).toBeNull();
  } finally {
    mock.restore();
  }
});

test("setGitHubIssuePinned pins via GraphQL after resolving the issue node id", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/9", json: { node_id: "I_kwabc" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { data: { pinIssue: { issue: { isPinned: true } } } },
    },
  ]);
  try {
    const res = await setGitHubIssuePinned({ dir: REPO_DIR, number: 9, pinned: true });
    expect(res).toEqual({ ok: true, pinned: true, message: "Issue pinned." });
    const gqlCall = mock.calls.find((c) => c.url === "https://api.github.com/graphql");
    const body = JSON.parse(gqlCall!.body!);
    expect(body.query).toContain("pinIssue");
    expect(body.variables).toEqual({ id: "I_kwabc" });
  } finally {
    mock.restore();
  }
});

test("setGitHubIssuePinned unpins via GraphQL", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/9", json: { node_id: "I_kwabc" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { data: { unpinIssue: { issue: { isPinned: false } } } },
    },
  ]);
  try {
    const res = await setGitHubIssuePinned({ dir: REPO_DIR, number: 9, pinned: false });
    expect(res).toEqual({ ok: true, pinned: false, message: "Issue unpinned." });
    const gqlCall = mock.calls.find((c) => c.url === "https://api.github.com/graphql");
    const body = JSON.parse(gqlCall!.body!);
    expect(body.query).toContain("unpinIssue");
  } finally {
    mock.restore();
  }
});

test("setGitHubIssuePinned maps the max-pinned-issues GraphQL error to a friendly message", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/9", json: { node_id: "I_kwabc" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { errors: [{ message: "You have reached the maximum number of pinned issues for this repository" }] },
    },
  ]);
  try {
    const res = await setGitHubIssuePinned({ dir: REPO_DIR, number: 9, pinned: true });
    expect(res).toEqual({
      ok: false,
      error: "This repository already has the maximum of 3 pinned issues — unpin one first.",
    });
  } finally {
    mock.restore();
  }
});

test("getGitHubIssuePinned reads isPinned via a read-only GraphQL query", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { data: { repository: { issue: { isPinned: true } } } },
    },
  ]);
  try {
    const res = await getGitHubIssuePinned({ dir: REPO_DIR, number: 9 });
    expect(res).toEqual({ ok: true, pinned: true });
    expect(mock.calls).toHaveLength(1);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body.variables).toEqual({ owner: "acme", name: "widgets", number: 9 });
  } finally {
    mock.restore();
  }
});

test("listGitHubSubIssues follows pagination and normalizes each child issue", async () => {
  const page1 = [{ id: 1001, number: 5, title: "child A", state: "open", html_url: "https://x/5" }];
  const page2 = [{ id: 1002, number: 6, title: "child B", state: "closed", html_url: "https://x/6" }];
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/issues/9/sub_issues?per_page=100",
      json: page1,
      headers: { link: '<https://api.github.com/repos/acme/widgets/issues/9/sub_issues?page=2>; rel="next"' },
    },
    { match: "sub_issues?page=2", json: page2 },
  ]);
  try {
    const res = await listGitHubSubIssues({ dir: REPO_DIR, number: 9 });
    expect(res).toEqual({
      ok: true,
      repo: "acme/widgets",
      issueNumber: 9,
      subIssues: [
        { id: 1001, number: 5, title: "child A", state: "open", htmlUrl: "https://x/5" },
        { id: 1002, number: 6, title: "child B", state: "closed", htmlUrl: "https://x/6" },
      ],
    });
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("listGitHubSubIssues maps a 404 to the feature-gated friendly error", async () => {
  const mock = mockGitHubFetch([
    { match: "/repos/acme/widgets/issues/9/sub_issues", status: 404, json: { message: "Not Found" } },
  ]);
  try {
    const res = await listGitHubSubIssues({ dir: REPO_DIR, number: 9 });
    expect(res).toEqual({
      ok: false,
      error: "Sub-issues aren't available here — the feature may not be enabled for this repository, or the issue doesn't exist.",
    });
  } finally {
    mock.restore();
  }
});

test("addGitHubSubIssue resolves the child's id by number, then POSTs sub_issue_id", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/5", json: { id: 1001 } },
    {
      method: "POST",
      match: "/repos/acme/widgets/issues/9/sub_issues",
      json: { id: 1001, number: 5, title: "child A", state: "open", html_url: "https://x/5" },
    },
  ]);
  try {
    const res = await addGitHubSubIssue({ dir: REPO_DIR, number: 9, childNumber: 5 });
    expect(res).toEqual({
      ok: true,
      subIssue: { id: 1001, number: 5, title: "child A", state: "open", htmlUrl: "https://x/5" },
      message: "Added #5 as a sub-issue.",
    });
    const postCall = mock.calls.find((c) => c.method === "POST");
    expect(JSON.parse(postCall!.body!)).toEqual({ sub_issue_id: 1001 });
  } finally {
    mock.restore();
  }
});

test("addGitHubSubIssue surfaces a friendly error when the child number doesn't resolve", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/999", status: 404, json: { message: "Not Found" } },
  ]);
  try {
    const res = await addGitHubSubIssue({ dir: REPO_DIR, number: 9, childNumber: 999 });
    expect(res).toEqual({ ok: false, error: "Couldn't resolve #999: Not Found" });
    // Never got to POST sub_issues.
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("addGitHubSubIssue maps a 410 on the add step to the feature-gated friendly error", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/5", json: { id: 1001 } },
    { method: "POST", match: "/repos/acme/widgets/issues/9/sub_issues", status: 410, json: { message: "Gone" } },
  ]);
  try {
    const res = await addGitHubSubIssue({ dir: REPO_DIR, number: 9, childNumber: 5 });
    expect(res).toEqual({
      ok: false,
      error: "Sub-issues aren't available here — the feature may not be enabled for this repository, or the issue doesn't exist.",
    });
  } finally {
    mock.restore();
  }
});

test("removeGitHubSubIssue DELETEs with sub_issue_id in the body", async () => {
  const mock = mockGitHubFetch([
    { method: "DELETE", match: "/repos/acme/widgets/issues/9/sub_issue", json: {} },
  ]);
  try {
    const res = await removeGitHubSubIssue({ dir: REPO_DIR, number: 9, childId: 1001 });
    expect(res).toEqual({ ok: true, message: "Sub-issue removed." });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("DELETE");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ sub_issue_id: 1001 });
  } finally {
    mock.restore();
  }
});

test("transferGitHubIssue resolves source + target node ids, then POSTs transferIssue", async () => {
  // Two sequential GraphQL calls hit the *same* URL with different bodies
  // (repo-id lookup, then the transfer mutation) — `mockGitHubFetch`'s route
  // table only matches on URL, so it can't tell them apart. Drive this one
  // with a hand-rolled fetch stub instead.
  let call = 0;
  const original = globalThis.fetch;
  const calls: { url: string; body: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, body });
    if (url.includes("/repos/acme/widgets/issues/9") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ node_id: "I_source" }), { status: 200 });
    }
    if (url === "https://api.github.com/graphql") {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ data: { repository: { id: "R_target" } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: { transferIssue: { issue: { number: 42, url: "https://github.com/dest/repo/issues/42" } } } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const res = await transferGitHubIssue({ dir: REPO_DIR, number: 9, targetRepo: "dest/repo" });
    expect(res).toEqual({
      ok: true,
      url: "https://github.com/dest/repo/issues/42",
      message: "Issue transferred to dest/repo as #42.",
    });
    const repoIdCall = calls.find((c) => c.url === "https://api.github.com/graphql" && c.body?.includes("repository(owner"));
    expect(JSON.parse(repoIdCall!.body!).variables).toEqual({ owner: "dest", name: "repo" });
    const transferCall = calls.find((c) => c.body?.includes("transferIssue"));
    expect(JSON.parse(transferCall!.body!).variables).toEqual({ id: "I_source", repo: "R_target" });
  } finally {
    globalThis.fetch = original;
  }
});

test("transferGitHubIssue rejects a malformed target repo before any network call", async () => {
  const mock = mockGitHubFetch([]);
  try {
    const res = await transferGitHubIssue({ dir: REPO_DIR, number: 9, targetRepo: "not-a-valid-repo-slug" });
    expect(res).toEqual({ ok: false, error: "target repo must be in the form owner/name" });
    expect(mock.calls).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("transferGitHubIssue surfaces a friendly error when the target repo isn't found", async () => {
  const mock = mockGitHubFetch([
    { method: "GET", match: "/repos/acme/widgets/issues/9", json: { node_id: "I_source" } },
    {
      method: "POST",
      match: "https://api.github.com/graphql",
      json: { data: { repository: null } },
    },
  ]);
  try {
    const res = await transferGitHubIssue({ dir: REPO_DIR, number: 9, targetRepo: "dest/missing" });
    expect(res).toEqual({
      ok: false,
      error: 'Target repository "dest/missing" wasn\'t found or isn\'t accessible.',
    });
  } finally {
    mock.restore();
  }
});

test("getGitHubRepoPermissions hits /repos/:o/:r and reads the permissions object (push:true)", async () => {
  const mock = mockGitHubFetch([
    {
      match: "https://api.github.com/repos/acme/widgets",
      json: { permissions: { push: true, admin: false, maintain: true } },
    },
  ]);
  try {
    const res = await getGitHubRepoPermissions({ dir: REPO_DIR });
    expect(res).toEqual({ ok: true, push: true, admin: false, maintain: true });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets");
    expect(mock.calls[0]!.headers.authorization).toBe("Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("getGitHubRepoPermissions reads push:false for a read-only collaborator", async () => {
  const mock = mockGitHubFetch([
    {
      match: "https://api.github.com/repos/acme/widgets",
      json: { permissions: { push: false, admin: false, maintain: false, pull: true } },
    },
  ]);
  try {
    const res = await getGitHubRepoPermissions({ dir: REPO_DIR });
    expect(res).toEqual({ ok: true, push: false, admin: false, maintain: false });
  } finally {
    mock.restore();
  }
});

test("getGitHubRepoPermissions returns all-false without a network call when unauthenticated", async () => {
  const priorToken = process.env.GITHUB_TOKEN;
  const priorGhToken = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const mock = mockGitHubFetch([]);
  try {
    const res = await getGitHubRepoPermissions({ dir: REPO_DIR });
    expect(res).toEqual({ ok: true, push: false, admin: false, maintain: false });
    expect(mock.calls).toHaveLength(0);
  } finally {
    mock.restore();
    if (priorToken !== undefined) process.env.GITHUB_TOKEN = priorToken;
    if (priorGhToken !== undefined) process.env.GH_TOKEN = priorGhToken;
  }
});

test("listGitHubItems (REST path) puts sort/direction/page in the query string and derives hasMore from the link header", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/issues",
      json: [
        { number: 1, title: "First", state: "open", html_url: "https://github.com/acme/widgets/issues/1" },
      ],
      headers: {
        link: '<https://api.github.com/repos/acme/widgets/issues?page=3>; rel="next"',
        "x-ratelimit-remaining": "4990",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-resource": "core",
      },
    },
  ]);
  try {
    const res = await listGitHubItems({
      dir: REPO_DIR,
      kind: "issues",
      state: "open",
      page: 2,
      sort: "updated",
      direction: "asc",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.page).toBe(2);
    expect(res.hasMore).toBe(true);
    expect(res.rateLimit).toEqual({ remaining: 4990, limit: 5000, resource: "core" });
    const call = mock.calls[0]!;
    const q = new URL(call.url).searchParams;
    expect(q.get("sort")).toBe("updated");
    expect(q.get("direction")).toBe("asc");
    expect(q.get("page")).toBe("2");
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (REST path) hasMore is false when the response has no next link", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/pulls",
      json: [{ number: 1, title: "First", state: "open", html_url: "https://github.com/acme/widgets/pull/1" }],
    },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "pulls", state: "open" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.hasMore).toBe(false);
    expect(res.page).toBe(1);
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (search path) puts sort/order/page in the query string and derives hasMore from total_count", async () => {
  const mock = mockGitHubFetch([
    {
      match: "https://api.github.com/search/issues",
      json: {
        total_count: 250,
        items: [{ number: 1, title: "First", state: "open", html_url: "https://github.com/acme/widgets/issues/1" }],
      },
      headers: {
        "x-ratelimit-remaining": "27",
        "x-ratelimit-limit": "30",
        "x-ratelimit-resource": "search",
      },
    },
  ]);
  try {
    const res = await listGitHubItems({
      dir: REPO_DIR,
      kind: "issues",
      state: "open",
      createdByMe: true,
      page: 1,
      sort: "comments",
      direction: "desc",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.hasMore).toBe(true); // 1*100 = 100 < 250
    expect(res.rateLimit).toEqual({ remaining: 27, limit: 30, resource: "search" });
    const call = mock.calls[0]!;
    const q = new URL(call.url).searchParams;
    expect(q.get("sort")).toBe("comments");
    expect(q.get("order")).toBe("desc");
    expect(q.get("page")).toBe("1");
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (search path) hasMore is false once total_count is exhausted", async () => {
  const mock = mockGitHubFetch([
    {
      match: "https://api.github.com/search/issues",
      json: {
        total_count: 5,
        items: [{ number: 1, title: "First", state: "open", html_url: "https://github.com/acme/widgets/issues/1" }],
      },
    },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "issues", state: "open", createdByMe: true, page: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.hasMore).toBe(false); // 1*100 = 100 >= 5
  } finally {
    mock.restore();
  }
});

test("listGitHubItems returns rateLimit: null when the response has no rate-limit headers", async () => {
  const mock = mockGitHubFetch([
    { match: "/repos/acme/widgets/pulls", json: [] },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "pulls", state: "open" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.rateLimit).toBeNull();
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (REST path, client-side text filter) fans out up to 3 source pages and accumulates matches", async () => {
  // A free-text `query` is refined client-side via matchesFilters, so a match
  // that lives on a later source page must still surface — the single page-1
  // fetch would otherwise show zero. Three source pages are fetched for one UI
  // page; hasMore comes from the LAST source page's link header.
  const mock = mockGitHubFetch([
    {
      match: "&page=1",
      json: [{ number: 1, title: "unrelated", state: "open", html_url: "https://github.com/acme/widgets/pull/1" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=2>; rel="next"' },
    },
    {
      match: "&page=2",
      json: [{ number: 2, title: "foo two", state: "open", html_url: "https://github.com/acme/widgets/pull/2" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=3>; rel="next"' },
    },
    {
      match: "&page=3",
      json: [{ number: 3, title: "foo three", state: "open", html_url: "https://github.com/acme/widgets/pull/3" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=4>; rel="next"' },
    },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "pulls", state: "open", query: "foo" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(mock.calls).toHaveLength(3); // fanned out across 3 source pages
    expect(res.items.map((i) => i.number)).toEqual([2, 3]); // page-1 item filtered out
    expect(res.hasMore).toBe(true); // 3rd source page still had a next link
    expect(res.page).toBe(1);
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (REST path, client filter) stops early and reports hasMore:false when a source page has no next link", async () => {
  const mock = mockGitHubFetch([
    {
      match: "&page=1",
      json: [{ number: 1, title: "foo one", state: "open", html_url: "https://github.com/acme/widgets/pull/1" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=2>; rel="next"' },
    },
    {
      // No link header → the source is exhausted; the 3rd fetch never happens.
      match: "&page=2",
      json: [{ number: 2, title: "foo two", state: "open", html_url: "https://github.com/acme/widgets/pull/2" }],
    },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "pulls", state: "open", query: "foo" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(mock.calls).toHaveLength(2); // stopped at the page with no next link
    expect(res.items.map((i) => i.number)).toEqual([1, 2]);
    expect(res.hasMore).toBe(false);
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (REST path, client filter) load-more advances by 3-source-page blocks", async () => {
  // UI page 2 with client filtering active → source pages 4, 5, 6.
  const mock = mockGitHubFetch([
    {
      match: "&page=4",
      json: [{ number: 4, title: "foo four", state: "open", html_url: "https://github.com/acme/widgets/pull/4" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=5>; rel="next"' },
    },
    {
      match: "&page=5",
      json: [{ number: 5, title: "nope", state: "open", html_url: "https://github.com/acme/widgets/pull/5" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=6>; rel="next"' },
    },
    {
      match: "&page=6",
      json: [{ number: 6, title: "foo six", state: "open", html_url: "https://github.com/acme/widgets/pull/6" }],
    },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "pulls", state: "open", query: "foo", page: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(mock.calls).toHaveLength(3);
    expect(res.items.map((i) => i.number)).toEqual([4, 6]);
    expect(res.hasMore).toBe(false);
    expect(res.page).toBe(2);
  } finally {
    mock.restore();
  }
});

test("listGitHubItems (REST path, no client filter) fetches exactly one source page", async () => {
  // No labels/assignee/text filter → clean single-page + load-more mode.
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/pulls",
      json: [{ number: 1, title: "anything", state: "open", html_url: "https://github.com/acme/widgets/pull/1" }],
      headers: { link: '<https://api.github.com/repos/acme/widgets/pulls?page=2>; rel="next"' },
    },
  ]);
  try {
    const res = await listGitHubItems({ dir: REPO_DIR, kind: "pulls", state: "open" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(mock.calls).toHaveLength(1); // single page despite the next link
    expect(res.hasMore).toBe(true);
  } finally {
    mock.restore();
  }
});

test("listGitHubNotifications hits the repo notifications endpoint with all=false by default and maps fields", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets/notifications",
      json: [
        {
          id: "1",
          unread: true,
          reason: "mention",
          updated_at: "2026-07-01T00:00:00Z",
          subject: {
            title: "Fix it",
            url: "https://api.github.com/repos/acme/widgets/issues/9",
            type: "Issue",
            latest_comment_url: null,
          },
          repository: { full_name: "acme/widgets" },
        },
      ],
    },
  ]);
  try {
    const res = await listGitHubNotifications({ dir: REPO_DIR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.repo).toBe("acme/widgets");
    expect(res.notifications).toEqual([
      {
        id: "1",
        unread: true,
        reason: "mention",
        updatedAt: "2026-07-01T00:00:00Z",
        title: "Fix it",
        subjectType: "Issue",
        subjectUrl: "https://api.github.com/repos/acme/widgets/issues/9",
        htmlUrl: "https://github.com/acme/widgets/issues/9",
        latestCommentUrl: null,
        repo: "acme/widgets",
      },
    ]);
    expect(mock.calls).toHaveLength(1);
    const url = new URL(mock.calls[0]!.url);
    expect(url.pathname).toBe("/repos/acme/widgets/notifications");
    expect(url.searchParams.get("all")).toBe("false");
    expect(url.searchParams.get("per_page")).toBe("50");
  } finally {
    mock.restore();
  }
});

test("listGitHubNotifications passes all=true through to the request when requested", async () => {
  const mock = mockGitHubFetch([{ match: "/repos/acme/widgets/notifications", json: [] }]);
  try {
    const res = await listGitHubNotifications({ dir: REPO_DIR, all: true });
    expect(res.ok).toBe(true);
    const url = new URL(mock.calls[0]!.url);
    expect(url.searchParams.get("all")).toBe("true");
  } finally {
    mock.restore();
  }
});

test("listGitHubNotifications requires a token — errors without a network call when unauthenticated", async () => {
  const priorToken = process.env.GITHUB_TOKEN;
  const priorGhToken = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const mock = mockGitHubFetch([]);
  try {
    const res = await listGitHubNotifications({ dir: REPO_DIR });
    expect(res).toEqual({ ok: false, error: "GitHub authentication required to view notifications" });
    expect(mock.calls).toHaveLength(0);
  } finally {
    mock.restore();
    if (priorToken !== undefined) process.env.GITHUB_TOKEN = priorToken;
    if (priorGhToken !== undefined) process.env.GH_TOKEN = priorGhToken;
  }
});

test("markGitHubNotificationRead PATCHes the thread endpoint and succeeds on a 205 with no body", async () => {
  const mock = mockGitHubFetch([
    { method: "PATCH", match: "https://api.github.com/notifications/threads/42", status: 205 },
  ]);
  try {
    const res = await markGitHubNotificationRead({ dir: REPO_DIR, threadId: "42" });
    expect(res).toEqual({ ok: true });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/notifications/threads/42");
    expect(mock.calls[0]!.method).toBe("PATCH");
  } finally {
    mock.restore();
  }
});

test("markAllGitHubNotificationsRead PUTs the repo notifications endpoint and succeeds on a 202 with no body", async () => {
  const mock = mockGitHubFetch([
    { method: "PUT", match: "https://api.github.com/repos/acme/widgets/notifications", status: 202 },
  ]);
  try {
    const res = await markAllGitHubNotificationsRead({ dir: REPO_DIR });
    expect(res).toEqual({ ok: true, message: "Marked all as read." });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/notifications");
    expect(mock.calls[0]!.method).toBe("PUT");
  } finally {
    mock.restore();
  }
});

test("getGitHubThreadSubscription maps subscribed/ignored from the response", async () => {
  const mock = mockGitHubFetch([
    { match: "https://api.github.com/notifications/threads/42/subscription", json: { subscribed: true, ignored: false } },
  ]);
  try {
    const res = await getGitHubThreadSubscription({ dir: REPO_DIR, threadId: "42" });
    expect(res).toEqual({ ok: true, subscribed: true, ignored: false });
    expect(mock.calls[0]!.method).toBe("GET");
  } finally {
    mock.restore();
  }
});

test("getGitHubThreadSubscription treats a 404 as unsubscribed/unignored, not an error", async () => {
  const mock = mockGitHubFetch([
    { match: "https://api.github.com/notifications/threads/42/subscription", status: 404 },
  ]);
  try {
    const res = await getGitHubThreadSubscription({ dir: REPO_DIR, threadId: "42" });
    expect(res).toEqual({ ok: true, subscribed: false, ignored: false });
  } finally {
    mock.restore();
  }
});

test("setGitHubThreadSubscription PUTs {ignored} to the subscription endpoint", async () => {
  const mock = mockGitHubFetch([
    {
      method: "PUT",
      match: "https://api.github.com/notifications/threads/42/subscription",
      json: { subscribed: true, ignored: true },
    },
  ]);
  try {
    const res = await setGitHubThreadSubscription({ dir: REPO_DIR, threadId: "42", ignored: true });
    expect(res).toEqual({ ok: true, subscribed: true, ignored: true });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("PUT");
    expect(JSON.parse(mock.calls[0]!.body ?? "{}")).toEqual({ ignored: true });
  } finally {
    mock.restore();
  }
});

test("unsubscribeGitHubThread DELETEs the subscription endpoint and succeeds on a 204 with no body", async () => {
  const mock = mockGitHubFetch([
    { method: "DELETE", match: "https://api.github.com/notifications/threads/42/subscription", status: 204 },
  ]);
  try {
    const res = await unsubscribeGitHubThread({ dir: REPO_DIR, threadId: "42" });
    expect(res).toEqual({ ok: true });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("DELETE");
  } finally {
    mock.restore();
  }
});
