// Network-level tests for bitbucket.ts, exercising the real request/response
// path (URL, method, headers, body, pagination, error mapping) via the
// fetch-mock harness in bitbucket-test-util.ts. Complements bitbucket.test.ts,
// which unit-tests the pure helpers in isolation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { makeBitbucketPrJson, makeBitbucketRepo, mockGitHubFetch } from "./bitbucket-test-util.ts";
import type { MockRoute } from "./bitbucket-test-util.ts";
import {
  closeBitbucketPull,
  createBitbucketComment,
  createBitbucketIssue,
  createBitbucketPull,
  createBitbucketPullLineComment,
  getBitbucketPullDefaults,
  getBitbucketPullDiff,
  getBitbucketPullMergeability,
  getBitbucketViewer,
  listBitbucketComments,
  listBitbucketItems,
  listBitbucketPullReviewComments,
  mergeBitbucketPull,
  normalizeBitbucketMergeability,
  replyBitbucketLineComment,
  reopenBitbucketPull,
  reviewBitbucketPull,
  updateBitbucketIssue,
} from "./bitbucket.ts";

const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ORIGINAL_TOKEN = process.env.BITBUCKET_TOKEN;
const ORIGINAL_EMAIL = process.env.BITBUCKET_EMAIL;
let dataDir: string;

beforeAll(() => {
  // Hermetic AGETOR_DATA_DIR so `bitbucketCreds`'s stored-token lookup
  // (`tokenForHost` → `~/.agetor/github-tokens.json`) never touches a real
  // store — mirrors github-tokens.test.ts's mkdtemp convention.
  dataDir = mkdtempSync(path.join(tmpdir(), "agetor-bb-tokens-"));
  process.env.AGETOR_DATA_DIR = dataDir;
  // Deterministic bearer token so bitbucketCreds() doesn't need a stored
  // credential to resolve. Individual basic-auth tests set BITBUCKET_EMAIL
  // themselves and restore it afterward.
  process.env.BITBUCKET_TOKEN = "test-token";
  delete process.env.BITBUCKET_EMAIL;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BITBUCKET_TOKEN;
  else process.env.BITBUCKET_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_EMAIL === undefined) delete process.env.BITBUCKET_EMAIL;
  else process.env.BITBUCKET_EMAIL = ORIGINAL_EMAIL;
});

const REPO = makeBitbucketRepo("acme", "app");

// ---------------------------------------------------------------------------
// listBitbucketItems
// ---------------------------------------------------------------------------

test("listBitbucketItems hits the pull requests endpoint with pagelen and repeats state= for closed", async () => {
  const mock = mockGitHubFetch([{ match: "/pullrequests", json: { values: [] } }]);
  try {
    const res = await listBitbucketItems(REPO, { kind: "pulls", state: "closed" });
    expect(res.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    const url = new URL(mock.calls[0]!.url);
    expect(url.pathname).toBe("/2.0/repositories/acme/app/pullrequests");
    expect(url.searchParams.getAll("state")).toEqual(["MERGED", "DECLINED", "SUPERSEDED"]);
    expect(url.searchParams.get("pagelen")).toBe("30");
  } finally {
    mock.restore();
  }
});

test("listBitbucketItems only sets q= when filters are present", async () => {
  const mock = mockGitHubFetch([{ match: "/pullrequests", json: { values: [] } }]);
  try {
    await listBitbucketItems(REPO, { kind: "pulls", state: "open" });
    expect(new URL(mock.calls[0]!.url).searchParams.has("q")).toBe(false);

    await listBitbucketItems(REPO, { kind: "pulls", state: "open", query: "bug" });
    expect(new URL(mock.calls[1]!.url).searchParams.get("q")).toBe('(title ~ "bug" OR description ~ "bug")');
  } finally {
    mock.restore();
  }
});

test("listBitbucketItems maps sort/direction to Bitbucket's sort= param", async () => {
  const mock = mockGitHubFetch([{ match: "/pullrequests", json: { values: [] } }]);
  try {
    await listBitbucketItems(REPO, { kind: "pulls", state: "open" });
    expect(new URL(mock.calls[0]!.url).searchParams.get("sort")).toBe("-updated_on");

    await listBitbucketItems(REPO, { kind: "pulls", state: "open", sort: "created", direction: "asc" });
    expect(new URL(mock.calls[1]!.url).searchParams.get("sort")).toBe("created_on");
  } finally {
    mock.restore();
  }
});

test("listBitbucketItems resolves the viewer uuid via GET /2.0/user only when createdByMe/assignedToMe/reviewRequested is set", async () => {
  const mockPlain = mockGitHubFetch([{ match: "/pullrequests", json: { values: [] } }]);
  try {
    await listBitbucketItems(REPO, { kind: "pulls", state: "open" });
    expect(mockPlain.calls.some((c) => c.url.includes("/2.0/user"))).toBe(false);
  } finally {
    mockPlain.restore();
  }

  const mockMe = mockGitHubFetch([
    { match: "/2.0/user", json: { uuid: "{me-uuid}" } },
    { match: "/pullrequests", json: { values: [] } },
  ]);
  try {
    await listBitbucketItems(REPO, { kind: "pulls", state: "open", createdByMe: true });
    expect(mockMe.calls).toHaveLength(2);
    expect(mockMe.calls[0]!.url).toContain("/2.0/user");
    expect(new URL(mockMe.calls[1]!.url).searchParams.get("q")).toBe('author.uuid="{me-uuid}"');
  } finally {
    mockMe.restore();
  }
});

test("listBitbucketItems (issues) maps a 404 to the issue-tracker-disabled friendly error", async () => {
  const mock = mockGitHubFetch([{ match: "/issues", status: 404, json: { error: { message: "Not Found" } } }]);
  try {
    const res = await listBitbucketItems(REPO, { kind: "issues", state: "open" });
    expect(res).toEqual({ ok: false, error: "issue tracker is not enabled for this repository" });
  } finally {
    mock.restore();
  }
});

test("listBitbucketItems maps a 401 to a friendly error mentioning credential configuration", async () => {
  const mock = mockGitHubFetch([
    { match: "/pullrequests", status: 401, json: { error: { message: "Access token expired" } } },
  ]);
  try {
    const res = await listBitbucketItems(REPO, { kind: "pulls", state: "open" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("configure credentials in Settings");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

test("bearer-token credentials send Authorization: Bearer <token>", async () => {
  const mock = mockGitHubFetch([{ match: "/2.0/user", json: { nickname: "octo" } }]);
  try {
    const res = await getBitbucketViewer(REPO);
    expect(res).toEqual({ ok: true, login: "octo" });
    expect(mock.calls[0]!.headers.authorization).toBe("Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("email:token credentials send Authorization: Basic base64(email:token)", async () => {
  process.env.BITBUCKET_TOKEN = "apitoken123";
  process.env.BITBUCKET_EMAIL = "user@example.com";
  const mock = mockGitHubFetch([{ match: "/2.0/user", json: { nickname: "octo" } }]);
  try {
    await getBitbucketViewer(REPO);
    const expected = `Basic ${Buffer.from("user@example.com:apitoken123").toString("base64")}`;
    expect(mock.calls[0]!.headers.authorization).toBe(expected);
  } finally {
    mock.restore();
    process.env.BITBUCKET_TOKEN = "test-token";
    delete process.env.BITBUCKET_EMAIL;
  }
});

// ---------------------------------------------------------------------------
// getBitbucketPullDefaults / createBitbucketPull
// ---------------------------------------------------------------------------

test("getBitbucketPullDefaults reads base from mainbranch.name and always reports head as empty", async () => {
  const mock = mockGitHubFetch([
    { match: "/2.0/repositories/acme/app", json: { mainbranch: { name: "develop" } } },
  ]);
  try {
    const res = await getBitbucketPullDefaults(REPO);
    expect(res).toEqual({ ok: true, repo: "acme/app", head: "", base: "develop" });
  } finally {
    mock.restore();
  }
});

test("createBitbucketPull POSTs title/description nested under source.branch/destination.branch", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests",
      json: {
        id: 11,
        title: "New PR",
        state: "OPEN",
        description: "desc",
        created_on: "2026-01-01T00:00:00Z",
        updated_on: "2026-01-01T00:00:00Z",
        links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/11" } },
      },
    },
  ]);
  try {
    const res = await createBitbucketPull(REPO, { title: "New PR", body: "desc", base: "main", head: "feature" });
    expect(res.ok).toBe(true);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toEqual({
      title: "New PR",
      description: "desc",
      source: { branch: { name: "feature" } },
      destination: { branch: { name: "main" } },
      draft: false,
    });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// getBitbucketPullDiff
// ---------------------------------------------------------------------------

test("getBitbucketPullDiff fetches the /diff endpoint as raw text and parses it into files", async () => {
  const diffText = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index abc123..def456 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-old line",
    "+new line",
    "",
  ].join("\n");
  const mock = mockGitHubFetch([
    { match: "/pullrequests/7/diff", text: diffText },
  ]);
  try {
    const res = await getBitbucketPullDiff(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.path).toBe("src/a.ts");
    expect(res.files[0]!.status).toBe("modified");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Comments — pagination follows body `next`, cap, exclude inline/deleted
// ---------------------------------------------------------------------------

test("listBitbucketComments excludes inline and soft-deleted comments", async () => {
  const mock = mockGitHubFetch([
    {
      match: "/pullrequests/7/comments",
      json: {
        values: [
          { id: 1, content: { raw: "top-level" }, links: { html: { href: "https://x/1" } } },
          { id: 2, content: { raw: "inline" }, inline: { path: "a.ts", to: 1 }, links: { html: { href: "https://x/2" } } },
          { id: 3, content: { raw: "" }, deleted: true, links: { html: { href: "https://x/3" } } },
        ],
      },
    },
  ]);
  try {
    const res = await listBitbucketComments(REPO, 7, "pulls");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.comments.map((c) => c.id)).toEqual([1]);
  } finally {
    mock.restore();
  }
});

test("listBitbucketComments follows the body `next` URL across pages and stops at the page cap", async () => {
  const base = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7/comments";
  const page = (id: number, next?: string) => ({
    values: [{ id, content: { raw: `c${id}` }, links: { html: { href: `https://x/${id}` } } }],
    ...(next ? { next } : {}),
  });
  const mock = mockGitHubFetch([
    { match: new RegExp(`^${base}\\?pagelen=30$`), json: page(1, `${base}?pagelen=30&page=2`) },
    { match: /page=2$/, json: page(2, `${base}?pagelen=30&page=3`) },
    { match: /page=3$/, json: page(3, `${base}?pagelen=30&page=4`) },
    { match: /page=4$/, json: page(4, `${base}?pagelen=30&page=5`) },
    { match: /page=5$/, json: page(5, `${base}?pagelen=30&page=6`) },
    // Deliberately no route for page=6 — if the walk didn't stop at the cap
    // (BITBUCKET_MAX_EXTRA_PAGES=4 beyond the first page), this would throw
    // "no route for ..." and fail the test loudly.
  ]);
  try {
    const res = await listBitbucketComments(REPO, 7, "pulls");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.comments.map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(mock.calls).toHaveLength(5); // 1 first page + 4 extra pages, capped
  } finally {
    mock.restore();
  }
});

test("createBitbucketComment POSTs {content:{raw}}", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests/7/comments",
      json: { id: 99, content: { raw: "hello" }, links: { html: { href: "https://x/99" } } },
    },
  ]);
  try {
    const res = await createBitbucketComment(REPO, 7, "pulls", "hello");
    expect(res.ok).toBe(true);
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ content: { raw: "hello" } });
  } finally {
    mock.restore();
  }
});

test("createBitbucketPullLineComment POSTs inline.to for RIGHT and inline.from for LEFT", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests/7/comments",
      json: { id: 100, content: { raw: "nit" }, inline: { path: "a.ts", to: 5 }, links: { html: { href: "https://x/100" } } },
    },
  ]);
  try {
    await createBitbucketPullLineComment(REPO, 7, { path: "a.ts", line: 5, side: "RIGHT", body: "nit" });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ content: { raw: "nit" }, inline: { path: "a.ts", to: 5 } });
  } finally {
    mock.restore();
  }
});

test("createBitbucketPullLineComment POSTs inline.from for a LEFT-side comment", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests/7/comments",
      json: { id: 101, content: { raw: "nit" }, inline: { path: "a.ts", from: 3 }, links: { html: { href: "https://x/101" } } },
    },
  ]);
  try {
    await createBitbucketPullLineComment(REPO, 7, { path: "a.ts", line: 3, side: "LEFT", body: "nit" });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ content: { raw: "nit" }, inline: { path: "a.ts", from: 3 } });
  } finally {
    mock.restore();
  }
});

test("replyBitbucketLineComment POSTs parent.id alongside the reply body", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests/7/comments",
      json: { id: 102, content: { raw: "reply" }, inline: { path: "a.ts", to: 5 }, links: { html: { href: "https://x/102" } } },
    },
  ]);
  try {
    await replyBitbucketLineComment(REPO, 7, 100, "reply");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ content: { raw: "reply" }, parent: { id: 100 } });
  } finally {
    mock.restore();
  }
});

test("listBitbucketPullReviewComments keeps ONLY inline comments and follows the `next` link", async () => {
  const base = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7/comments";
  const mock = mockGitHubFetch([
    {
      match: new RegExp(`^${base}\\?pagelen=30$`),
      json: {
        values: [
          { id: 1, content: { raw: "top-level" }, links: { html: { href: "https://x/1" } } },
          { id: 2, content: { raw: "inline1" }, inline: { path: "a.ts", to: 1 }, links: { html: { href: "https://x/2" } } },
        ],
        next: `${base}?pagelen=30&page=2`,
      },
    },
    {
      match: /page=2$/,
      json: {
        values: [
          { id: 3, content: { raw: "inline2" }, inline: { path: "a.ts", to: 2 }, links: { html: { href: "https://x/3" } } },
        ],
      },
    },
  ]);
  try {
    const res = await listBitbucketPullReviewComments(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.comments.map((c) => c.id)).toEqual([2, 3]);
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// merge / close / reopen / review
// ---------------------------------------------------------------------------

test("mergeBitbucketPull maps 'rebase' to merge_strategy: fast_forward", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests/7/merge",
      json: { merge_commit: { hash: "abc123" } },
    },
  ]);
  try {
    const res = await mergeBitbucketPull(REPO, 7, "rebase");
    expect(res).toEqual({ ok: true, merged: true, sha: "abc123", message: "Pull request merged." });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ merge_strategy: "fast_forward" });
  } finally {
    mock.restore();
  }
});

test("closeBitbucketPull POSTs /decline", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/pullrequests/7/decline",
      json: {
        id: 7,
        title: "PR",
        state: "DECLINED",
        links: { html: { href: "https://x/7" } },
      },
    },
  ]);
  try {
    const res = await closeBitbucketPull(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.message).toBe("Pull request declined.");
    expect(mock.calls[0]!.method).toBe("POST");
  } finally {
    mock.restore();
  }
});

test("reopenBitbucketPull always errors 'cannot be reopened' with NO network call", async () => {
  const mock = mockGitHubFetch([]);
  try {
    const res = await reopenBitbucketPull(REPO, 7);
    expect(res).toEqual({ ok: false, error: "declined pull requests cannot be reopened on Bitbucket" });
    expect(mock.calls).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("reviewBitbucketPull APPROVE POSTs /approve and, with a body, also posts a comment", async () => {
  const mock = mockGitHubFetch([
    { method: "POST", match: "/pullrequests/7/approve", json: {} },
    {
      method: "POST",
      match: "/pullrequests/7/comments",
      json: { id: 5, content: { raw: "LGTM" }, links: { html: { href: "https://x/5" } } },
    },
  ]);
  try {
    const res = await reviewBitbucketPull(REPO, 7, "APPROVE", "LGTM");
    expect(res).toEqual({ ok: true, message: "Pull request approved." });
    expect(mock.calls.some((c) => c.method === "POST" && c.url.includes("/approve"))).toBe(true);
    const commentCall = mock.calls.find((c) => c.url.includes("/comments"));
    expect(commentCall).toBeDefined();
    expect(JSON.parse(commentCall!.body!)).toEqual({ content: { raw: "LGTM" } });
  } finally {
    mock.restore();
  }
});

test("reviewBitbucketPull REQUEST_CHANGES POSTs /request-changes", async () => {
  const mock = mockGitHubFetch([
    { method: "POST", match: "/pullrequests/7/request-changes", json: {} },
  ]);
  try {
    const res = await reviewBitbucketPull(REPO, 7, "REQUEST_CHANGES");
    expect(res).toEqual({ ok: true, message: "Changes requested." });
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// normalizeBitbucketMergeability — pure field mapping (no network)
// ---------------------------------------------------------------------------

test("normalizeBitbucketMergeability: non-OPEN state ignores conflictScan and always reports mergeable:null/unknown", () => {
  const res = normalizeBitbucketMergeability(REPO, 7, makeBitbucketPrJson({ state: "MERGED" }), "dirty");
  expect(res.mergeable).toBeNull();
  expect(res.mergeableState).toBe("unknown");
  expect(res.merged).toBe(true);
  expect(res.state).toBe("merged");
});

test("normalizeBitbucketMergeability: DECLINED and SUPERSEDED both normalize state to 'closed'", () => {
  expect(normalizeBitbucketMergeability(REPO, 7, makeBitbucketPrJson({ state: "DECLINED" }), "unknown").state).toBe("closed");
  expect(normalizeBitbucketMergeability(REPO, 7, makeBitbucketPrJson({ state: "SUPERSEDED" }), "unknown").state).toBe("closed");
});

// ---------------------------------------------------------------------------
// getBitbucketPullMergeability / diffstat conflict scan
// ---------------------------------------------------------------------------

test("getBitbucketPullMergeability: a merge-conflict entry on diffstat page 1 short-circuits — no page 2 fetch — and reports dirty", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN" });
  const base = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7/diffstat";
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    {
      match: /\/diffstat\?pagelen=100$/,
      json: { values: [{ status: "merge conflict" }], next: `${base}?pagelen=100&page=2` },
    },
    // Deliberately no route for page=2 — if the scan didn't short-circuit on
    // finding the conflict, this would throw "no route for ..." and fail loudly.
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBe(false);
    expect(res.mergeableState).toBe("dirty");
    expect(res.state).toBe("open");
    expect(mock.calls).toHaveLength(2); // PR detail + diffstat page 1 only
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: OPEN PR + all-clean single diffstat page (no next) → clean, with headRef/baseRef from source/destination", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN", sourceBranch: "feature-x", destBranch: "develop" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, json: { values: [{ status: "modified" }] } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBe(true);
    expect(res.mergeableState).toBe("clean");
    expect(res.state).toBe("open");
    expect(res.headRef).toBe("feature-x");
    expect(res.baseRef).toBe("develop");
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: page 1 clean + next, page 2 has the conflict → dirty, both pages fetched", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN" });
  const base = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7/diffstat";
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    {
      match: /\/diffstat\?pagelen=100$/,
      json: { values: [{ status: "modified" }], next: `${base}?pagelen=100&page=2` },
    },
    { match: /page=2$/, json: { values: [{ status: "merge conflict" }] } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBe(false);
    expect(res.mergeableState).toBe("dirty");
    expect(mock.calls).toHaveLength(3); // PR + diffstat page 1 + diffstat page 2
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: diffstat entry status 'local deleted' → dirty (delete/modify conflict)", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, json: { values: [{ status: "local deleted" }] } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBe(false);
    expect(res.mergeableState).toBe("dirty");
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: diffstat entry status 'remote deleted' → dirty (delete/modify conflict)", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, json: { values: [{ status: "remote deleted" }] } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBe(false);
    expect(res.mergeableState).toBe("dirty");
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: diffstat page cap exhausted while pages keep returning next → unknown, never clean on partial data", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN" });
  const base = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/7/diffstat";
  // BITBUCKET_DIFFSTAT_PAGE_CAP is 10 — mock exactly that many diffstat pages
  // (the first, unparameterized page plus page=2..page=10), every one clean
  // but still carrying a further `next`, so the scan hits the cap with pages
  // still outstanding instead of reaching a natural end (page 11 is never
  // fetched — no route is registered for it).
  const routes: MockRoute[] = [
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, json: { values: [{ status: "modified" }], next: `${base}?pagelen=100&page=2` } },
  ];
  for (let page = 2; page <= 10; page++) {
    routes.push({
      match: new RegExp(`page=${page}$`),
      json: { values: [{ status: "modified" }], next: `${base}?pagelen=100&page=${page + 1}` },
    });
  }
  const mock = mockGitHubFetch(routes);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBeNull();
    expect(res.mergeableState).toBe("unknown");
    expect(mock.calls).toHaveLength(11); // PR + 10 diffstat pages (the cap)
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: diffstat fetch failure (500) → unknown, but still ok:true with PR fields mapped", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN", sourceBranch: "feature-y" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, status: 500, json: { error: { message: "Internal Server Error" } } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBeNull();
    expect(res.mergeableState).toBe("unknown");
    expect(res.state).toBe("open");
    expect(res.headRef).toBe("feature-y");
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: hostile off-origin `next` stops paging — unknown, not clean — and the hostile origin is never fetched", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    {
      match: /\/diffstat\?pagelen=100$/,
      json: { values: [{ status: "modified" }], next: "http://attacker.example/x" },
    },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.mergeable).toBeNull();
    expect(res.mergeableState).toBe("unknown");
    expect(mock.calls.some((c) => c.url.includes("attacker.example"))).toBe(false);
    expect(mock.calls).toHaveLength(2); // PR + diffstat page 1 only
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: MERGED PR → merged:true, state:'merged', mergeable unknown, no diffstat fetch at all", async () => {
  const prJson = makeBitbucketPrJson({ state: "MERGED" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    // Deliberately no diffstat route — a merged PR has nothing left to
    // conflict against, so fetching diffstat here would throw "no route" and
    // fail this test loudly.
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.merged).toBe(true);
    expect(res.state).toBe("merged");
    expect(res.mergeable).toBeNull();
    expect(res.mergeableState).toBe("unknown");
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: fork PR (source.repository differs from destination) → crossRepo:true", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN", sourceRepoFullName: "someone-else/app", destRepoFullName: "acme/app" });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, json: { values: [] } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.crossRepo).toBe(true);
  } finally {
    mock.restore();
  }
});

test("getBitbucketPullMergeability: missing source.repository → crossRepo:true (fails closed)", async () => {
  const prJson = makeBitbucketPrJson({ state: "OPEN", sourceRepoFullName: null });
  const mock = mockGitHubFetch([
    { match: /\/pullrequests\/7$/, json: prJson },
    { match: /\/diffstat\?pagelen=100$/, json: { values: [] } },
  ]);
  try {
    const res = await getBitbucketPullMergeability(REPO, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.crossRepo).toBe(true);
    expect(res.headRepo).toBeNull();
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// create/update issue bodies
// ---------------------------------------------------------------------------

test("createBitbucketIssue POSTs title + content.raw only when a body is given", async () => {
  const mock = mockGitHubFetch([
    {
      method: "POST",
      match: "/issues",
      json: { id: 3, title: "Bug", state: "new", content: {}, links: { html: { href: "https://x/3" } } },
    },
  ]);
  try {
    await createBitbucketIssue(REPO, { title: "Bug", body: "steps" });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ title: "Bug", content: { raw: "steps" } });

    await createBitbucketIssue(REPO, { title: "Bug2" });
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ title: "Bug2" });
  } finally {
    mock.restore();
  }
});

test("updateBitbucketIssue maps state:'closed' to 'resolved' and state:'open' passes through", async () => {
  const mock = mockGitHubFetch([
    {
      method: "PUT",
      match: "/issues/3",
      json: { id: 3, title: "Bug", state: "resolved", content: {}, links: { html: { href: "https://x/3" } } },
    },
  ]);
  try {
    await updateBitbucketIssue(REPO, 3, { state: "closed" });
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ state: "resolved" });

    await updateBitbucketIssue(REPO, 3, { state: "open" });
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ state: "open" });
  } finally {
    mock.restore();
  }
});
