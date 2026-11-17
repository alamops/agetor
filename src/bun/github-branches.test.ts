// Branch list / lookup / default-branch and already-exists handling in github.ts
// (docs/plans/create-all-prs-title-and-base.md T2). Network is the fetch mock.
import { beforeAll, expect, test } from "bun:test";
import { makeGitHubRepo, mockGitHubFetch } from "./github-test-util.ts";
import {
  createGitHubPull,
  getGitHubBranch,
  getGitHubDefaultBranch,
  listGitHubBranches,
} from "./github.ts";

let DIR = "";

beforeAll(async () => {
  process.env.GITHUB_TOKEN = "test-token";
  DIR = await makeGitHubRepo("acme", "widgets");
});

const branchRows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ name: `b${from + i}`, commit: { sha: `sha${from + i}` } }));

test("listGitHubBranches follows pages until a short page and carries tip shas", async () => {
  const mock = mockGitHubFetch([
    { match: "branches?per_page=100&page=1", json: branchRows(1, 100) },
    { match: "branches?per_page=100&page=2", json: branchRows(101, 130) },
  ]);
  try {
    const res = await listGitHubBranches({ dir: DIR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.branches).toHaveLength(130);
    expect(res.branches[0]).toEqual({ name: "b1", sha: "sha1" });
    expect(res.truncated).toBe(false);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/branches?per_page=100&page=1");
    expect(mock.calls[0]!.headers.authorization).toBe("Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("listGitHubBranches reports truncated when maxPages stops a full last page", async () => {
  const mock = mockGitHubFetch([{ match: "branches?per_page=100", json: branchRows(1, 100) }]);
  try {
    const res = await listGitHubBranches({ dir: DIR, maxPages: 2 });
    expect(res.ok && res.truncated).toBe(true);
    expect(res.ok && res.branches.length).toBe(200);
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("listGitHubBranches maps a 404 to the private-repo hint", async () => {
  const mock = mockGitHubFetch([{ match: "/branches", status: 404, json: { message: "Not Found" } }]);
  try {
    const res = await listGitHubBranches({ dir: DIR });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("was not found on GitHub");
  } finally {
    mock.restore();
  }
});

test("getGitHubBranch returns the branch, null on 'Branch not found', and an error on a plain 404", async () => {
  let mock = mockGitHubFetch([{ match: "/branches/release/1.2", json: { name: "release/1.2", commit: { sha: "abc" } } }]);
  try {
    expect(await getGitHubBranch({ dir: DIR, name: "release/1.2" })).toEqual({
      ok: true,
      branch: { name: "release/1.2", sha: "abc" },
    });
    expect(mock.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/branches/release/1.2");
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([{ match: "/branches/nope", status: 404, json: { message: "Branch not found" } }]);
  try {
    expect(await getGitHubBranch({ dir: DIR, name: "nope" })).toEqual({ ok: true, branch: null });
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([{ match: "/branches/x", status: 404, json: { message: "Not Found" } }]);
  try {
    const res = await getGitHubBranch({ dir: DIR, name: "x" });
    expect(res.ok).toBe(false);
  } finally {
    mock.restore();
  }
});

test("getGitHubBranch encodes each path segment", async () => {
  const mock = mockGitHubFetch([{ match: "/branches/", json: { name: "a b/c#d", commit: { sha: "z" } } }]);
  try {
    await getGitHubBranch({ dir: DIR, name: "a b/c#d" });
    expect(mock.calls[0]!.url).toContain("/branches/a%20b/c%23d");
  } finally {
    mock.restore();
  }
});

test("getGitHubDefaultBranch reads default_branch and errors without one", async () => {
  let mock = mockGitHubFetch([{ match: "/repos/acme/widgets", json: { default_branch: "develop" } }]);
  try {
    expect(await getGitHubDefaultBranch({ dir: DIR })).toEqual({ ok: true, name: "develop" });
  } finally {
    mock.restore();
  }
  mock = mockGitHubFetch([{ match: "/repos/acme/widgets", json: {} }]);
  try {
    expect((await getGitHubDefaultBranch({ dir: DIR })).ok).toBe(false);
  } finally {
    mock.restore();
  }
});

const create = (head = "feature/a") => createGitHubPull({ dir: DIR, title: "T", head, base: "main" });

test("createGitHubPull maps a duplicate-PR 422 to already-exists with the existing URL", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/repos/acme/widgets/pulls",
      status: 422,
      json: {
        message: "Validation Failed",
        errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for acme:feature/a." }],
      },
    },
    {
      method: "GET",
      match: "/repos/acme/widgets/pulls?head=acme%3Afeature%2Fa&state=open&per_page=1",
      json: [{ html_url: "https://github.com/acme/widgets/pull/9" }],
    },
  ]);
  try {
    const res = await create();
    expect(res).toEqual({
      ok: false,
      error: "Validation Failed: A pull request already exists for acme:feature/a.",
      code: "already-exists",
      existingUrl: "https://github.com/acme/widgets/pull/9",
    });
  } finally {
    mock.restore();
  }
});

test("already-exists omits existingUrl when the lookup fails", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pulls",
      status: 422,
      json: { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:x." }] },
    },
    { method: "GET", match: "/pulls?head=", status: 500, json: {} },
  ]);
  try {
    const res = await create("x");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("already-exists");
    expect("existingUrl" in res).toBe(false);
  } finally {
    mock.restore();
  }
});

test("already-exists never passes on a non-http(s) existing URL", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pulls",
      status: 422,
      json: { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:x." }] },
    },
    { method: "GET", match: "/pulls?head=", json: [{ html_url: "javascript:alert(1)" }] },
  ]);
  try {
    const res = await create("x");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("already-exists");
    expect("existingUrl" in res).toBe(false);
  } finally {
    mock.restore();
  }
});

test("another 422 carries errors[].message instead of just 'Validation Failed'", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pulls",
      status: 422,
      json: { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] },
    },
  ]);
  try {
    const res = await create();
    expect(res).toEqual({ ok: false, error: "Validation Failed: base invalid" });
  } finally {
    mock.restore();
  }
});

test("a non-422 failure keeps the plain message", async () => {
  const mock = mockGitHubFetch([{ method: "POST", match: "/pulls", status: 500, json: { message: "boom" } }]);
  try {
    expect(await create()).toEqual({ ok: false, error: "boom" });
  } finally {
    mock.restore();
  }
});
