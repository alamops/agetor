// Network-level tests for github.ts, exercising the real request/response path
// (URL, method, headers, body, pagination, error mapping) via the fetch-mock
// harness in github-test-util.ts. Complements github.test.ts, which unit-tests
// the pure helpers in isolation.
import { test, expect, beforeAll } from "bun:test";
import { makeGitHubRepo, mockGitHubFetch } from "./github-test-util.ts";
import {
  addGitHubReaction,
  applyGitHubSuggestion,
  getGitHubPullLinkedIssues,
  getGitHubViewer,
  listGitHubAssignees,
  listGitHubLabels,
  listGitHubMilestones,
  listGitHubPullCommits,
  listGitHubReactions,
  removeGitHubReaction,
  requestGitHubPullReviewers,
  setGitHubPullAutoMerge,
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
