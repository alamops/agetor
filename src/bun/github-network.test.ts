// Network-level tests for github.ts, exercising the real request/response path
// (URL, method, headers, body, pagination, error mapping) via the fetch-mock
// harness in github-test-util.ts. Complements github.test.ts, which unit-tests
// the pure helpers in isolation.
import { test, expect, beforeAll } from "bun:test";
import { makeGitHubRepo, mockGitHubFetch } from "./github-test-util.ts";
import { getGitHubViewer, listGitHubAssignees, listGitHubLabels, listGitHubMilestones } from "./github.ts";

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
