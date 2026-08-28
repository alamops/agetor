// Pure-function unit tests for `src/bun/bitbucket.ts`, exercised entirely
// through `__bitbucketInternals` (no network, no filesystem). Complements
// bitbucket-network.test.ts, which drives the exported functions end-to-end
// through a mocked `fetch`.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __clearApiHostCacheForTest } from "./git-provider.ts";
import { __bitbucketInternals, getBitbucketIssueThread } from "./bitbucket.ts";
import { makeBitbucketRepo, mockGitHubFetch } from "./bitbucket-test-util.ts";

const {
  repoBasePath,
  resolveUrl,
  apiErrorMessage,
  bitbucketAccessHint,
  bitbucketViewerAccessHint,
  errorFrom,
  normalizeBitbucketUser,
  normalizeBitbucketPull,
  normalizeBitbucketIssue,
  normalizeBitbucketComment,
  normalizeBitbucketLineComment,
  normalizeBitbucketCheckRun,
  escapeBBQLString,
  prStateParams,
  issueStateBBQL,
  buildPullsBBQL,
  buildIssuesBBQL,
  sortParam,
  bitbucketViewerUuid,
  BITBUCKET_OPEN_ISSUE_STATES,
  BITBUCKET_CHECK_STATE_MAP,
  BITBUCKET_MERGE_STRATEGY,
} = __bitbucketInternals;

// ---------------------------------------------------------------------------
// repoBasePath / resolveUrl
// ---------------------------------------------------------------------------

test("repoBasePath builds /2.0/repositories/{workspace}/{repo_slug}, URL-encoding segments", () => {
  expect(repoBasePath(makeBitbucketRepo("acme", "app"))).toBe("/2.0/repositories/acme/app");
  expect(repoBasePath(makeBitbucketRepo("a c/me", "app"))).toBe("/2.0/repositories/a%20c%2Fme/app");
});

test("resolveUrl passes an absolute URL through and prefixes a relative path with the API base", () => {
  expect(resolveUrl("/2.0/repositories/acme/app")).toBe("https://api.bitbucket.org/2.0/repositories/acme/app");
  expect(resolveUrl("https://api.bitbucket.org/2.0/repositories/acme/app?page=2")).toBe(
    "https://api.bitbucket.org/2.0/repositories/acme/app?page=2",
  );
  expect(resolveUrl("HTTP://example.com/next")).toBe("HTTP://example.com/next");
});

// ---------------------------------------------------------------------------
// apiErrorMessage
// ---------------------------------------------------------------------------

test("apiErrorMessage reads body.error.message when present", () => {
  expect(apiErrorMessage({ type: "error", error: { message: "Repository not found" } }, 404, "Not Found")).toBe(
    "Repository not found",
  );
});

test("apiErrorMessage falls back to `status statusText` for a malformed/absent body", () => {
  expect(apiErrorMessage(null, 500, "Internal Server Error")).toBe("500 Internal Server Error");
  expect(apiErrorMessage({}, 502, "Bad Gateway")).toBe("502 Bad Gateway");
  expect(apiErrorMessage({ error: "not an object" }, 400, "Bad Request")).toBe("400 Bad Request");
});

// The 401 actionable-credentials hint moved out of apiErrorMessage (now a
// pure body/status extractor, matching gitlab.ts's apiError) and into
// bitbucketAccessHint/errorFrom — see bitbucket-network.test.ts for coverage
// of the enriched wording end-to-end.
test("apiErrorMessage extracts the plain body.error.message on a 401, with no enrichment", () => {
  const msg = apiErrorMessage({ error: { message: "Invalid credentials" } }, 401, "Unauthorized");
  expect(msg).toBe("Invalid credentials");
});

// ---------------------------------------------------------------------------
// bitbucketAccessHint — alias-host credential UX (fix-bitbucket-alias-host-
// credentials.md §3/§5). Repo always carries a synthetic alias remoteHost
// ("bitbucket-work.com"), never a real one.
// ---------------------------------------------------------------------------

const ALIAS_REPO = makeBitbucketRepo("acme", "app", "bitbucket-work.com");
const NOT_FOUND_MSG = "You may not have access to this repository or it no longer exists in this workspace.";

test("bitbucketAccessHint on a 404 with no prior credential names the repo, host, Settings section, and credential format, and preserves the original message", () => {
  const hint = bitbucketAccessHint(404, NOT_FOUND_MSG, ALIAS_REPO, false);
  expect(hint).toContain("acme/app");
  expect(hint).toContain(NOT_FOUND_MSG);
  expect(hint).toContain("bitbucket-work.com");
  expect(hint).toContain("Settings → Git host tokens");
  expect(hint).toContain("email:api_token");
});

test("bitbucketAccessHint on a 404 with a stored (but ineffective) credential additionally calls out a current API token vs a retired app password", () => {
  const hint = bitbucketAccessHint(404, NOT_FOUND_MSG, ALIAS_REPO, true);
  expect(hint).toContain("acme/app");
  expect(hint).toContain(NOT_FOUND_MSG);
  expect(hint).toContain("bitbucket-work.com");
  expect(hint).toContain("Settings → Git host tokens");
  expect(hint).toContain("email:api_token");
  expect(hint).toContain("current API token, not a retired app password");
});

test("bitbucketAccessHint on a 403 with no prior credential is enriched the same way as an unauthenticated 404", () => {
  const hint = bitbucketAccessHint(403, NOT_FOUND_MSG, ALIAS_REPO, false);
  expect(hint).toContain("acme/app");
  expect(hint).toContain(NOT_FOUND_MSG);
  expect(hint).toContain("bitbucket-work.com");
  expect(hint).toContain("Settings → Git host tokens");
  expect(hint).toContain("email:api_token");
});

test("bitbucketAccessHint on an authenticated 403 preserves the real message first — e.g. a branch-restriction merge error — and appends a scope-check pointer to Settings", () => {
  const branchRestrictionMsg = "Branch restrictions: at least 2 approvals are required to merge this pull request.";
  const hint = bitbucketAccessHint(403, branchRestrictionMsg, ALIAS_REPO, true);
  expect(hint.startsWith(branchRestrictionMsg)).toBe(true);
  expect(hint).toContain("bitbucket-work.com");
  expect(hint).toContain("Settings → Git host tokens");
  expect(hint).toContain("lacks the required Bitbucket scopes");
});

test("bitbucketAccessHint on an authenticated 403 carries the Settings marker phrase the webview panel detects, unlike the pre-fix pass-through", () => {
  const hint = bitbucketAccessHint(403, "some other authenticated 403 message", ALIAS_REPO, true);
  expect(hint).toContain(`Settings → Git host tokens`);
});

test("bitbucketAccessHint on a 401 without a stored credential says to add one", () => {
  const hint = bitbucketAccessHint(401, "Unauthorized", ALIAS_REPO, false);
  expect(hint).toContain("bitbucket-work.com");
  expect(hint).toContain("Settings → Git host tokens");
  expect(hint).toContain("email:api_token");
  expect(hint).toContain("add a credential");
  expect(hint).not.toContain("was rejected; replace it");
});

test("bitbucketAccessHint on a 401 with a stored credential says it was rejected and to replace it", () => {
  const hint = bitbucketAccessHint(401, "Unauthorized", ALIAS_REPO, true);
  expect(hint).toContain("bitbucket-work.com");
  expect(hint).toContain("Settings → Git host tokens");
  expect(hint).toContain("was rejected; replace it");
  expect(hint).not.toContain("add a credential for");
});

test("bitbucketAccessHint leaves a non-auth status (e.g. 500) unchanged, regardless of hadCreds", () => {
  expect(bitbucketAccessHint(500, "Internal Server Error", ALIAS_REPO, false)).toBe("Internal Server Error");
  expect(bitbucketAccessHint(500, "Internal Server Error", ALIAS_REPO, true)).toBe("Internal Server Error");
});

test("errorFrom threads a Response's status/statusText plus the parsed body into bitbucketAccessHint", () => {
  const res = new Response(null, { status: 404, statusText: "Not Found" });
  const hint = errorFrom(res, { type: "error", error: { message: NOT_FOUND_MSG } }, ALIAS_REPO, false);
  expect(hint).toBe(bitbucketAccessHint(404, NOT_FOUND_MSG, ALIAS_REPO, false));
});

// ---------------------------------------------------------------------------
// bitbucketViewerAccessHint — account-flavored wording for /2.0/user
// failures, never owner/repo (fix-bitbucket-alias-host-credentials.md §3).
// ---------------------------------------------------------------------------

test("bitbucketViewerAccessHint on a 403/404 talks about the account, names the host, and never mentions owner/repo", () => {
  for (const status of [403, 404]) {
    const hint = bitbucketViewerAccessHint(status, "Unauthorized", ALIAS_REPO, false);
    expect(hint).toContain("your Bitbucket account could not be read");
    expect(hint).toContain("bitbucket-work.com");
    expect(hint).toContain("Settings → Git host tokens");
    expect(hint).not.toContain("acme/app");
    expect(hint).not.toContain("was not found on Bitbucket");
  }
});

test("bitbucketViewerAccessHint on a 401 delegates to the same auth wording as bitbucketAccessHint, for both hadCreds values", () => {
  expect(bitbucketViewerAccessHint(401, "Unauthorized", ALIAS_REPO, false)).toBe(
    bitbucketAccessHint(401, "Unauthorized", ALIAS_REPO, false),
  );
  expect(bitbucketViewerAccessHint(401, "Unauthorized", ALIAS_REPO, true)).toBe(
    bitbucketAccessHint(401, "Unauthorized", ALIAS_REPO, true),
  );
});

test("bitbucketViewerAccessHint leaves a non-auth status unchanged", () => {
  expect(bitbucketViewerAccessHint(500, "boom", ALIAS_REPO, false)).toBe("boom");
});

// ---------------------------------------------------------------------------
// escapeBBQLString — recent fix: backslashes doubled BEFORE quotes escaped
// ---------------------------------------------------------------------------

test("escapeBBQLString doubles a trailing backslash without touching a closing BBQL quote", () => {
  expect(escapeBBQLString("foo\\")).toBe("foo\\\\");
});

test("escapeBBQLString escapes a bare double quote", () => {
  expect(escapeBBQLString('"')).toBe('\\"');
});

test("escapeBBQLString doubles backslashes BEFORE escaping quotes (order matters)", () => {
  // If quotes were escaped first, this input's escaped `\"` would itself get
  // its backslash doubled again, corrupting the escape. Doubling backslashes
  // first is what keeps a trailing `\` from swallowing the closing `"`.
  expect(escapeBBQLString('a"b\\')).toBe('a\\"b\\\\');
  expect(escapeBBQLString('a\\"b')).toBe('a\\\\\\"b');
});

test("escapeBBQLString leaves a plain string untouched", () => {
  expect(escapeBBQLString("plain query")).toBe("plain query");
});

// ---------------------------------------------------------------------------
// normalizeBitbucketUser
// ---------------------------------------------------------------------------

test("normalizeBitbucketUser prefers nickname over display_name for login", () => {
  const user = normalizeBitbucketUser({
    nickname: "octocat",
    display_name: "The Octocat",
    links: { avatar: { href: "https://x/avatar.png" }, html: { href: "https://x/octocat" } },
  });
  expect(user).toEqual({ login: "octocat", avatarUrl: "https://x/avatar.png", htmlUrl: "https://x/octocat" });
});

test("normalizeBitbucketUser falls back to display_name when nickname is absent/empty", () => {
  expect(normalizeBitbucketUser({ display_name: "Jane Doe" })).toEqual({
    login: "Jane Doe",
    avatarUrl: null,
    htmlUrl: null,
  });
  expect(normalizeBitbucketUser({ nickname: "", display_name: "Jane Doe" })).toEqual({
    login: "Jane Doe",
    avatarUrl: null,
    htmlUrl: null,
  });
});

test("normalizeBitbucketUser returns null with neither nickname nor display_name, or a non-object input", () => {
  expect(normalizeBitbucketUser({})).toBeNull();
  expect(normalizeBitbucketUser(null)).toBeNull();
  expect(normalizeBitbucketUser("nope")).toBeNull();
});

// ---------------------------------------------------------------------------
// normalizeBitbucketPull
// ---------------------------------------------------------------------------

function bbPull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    title: "Add feature",
    state: "OPEN",
    description: "body text",
    comment_count: 3,
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-02T00:00:00Z",
    links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/7" } },
    author: { nickname: "octocat" },
    ...overrides,
  };
}

test("normalizeBitbucketPull maps OPEN state, defaults draft to false, and carries sourcePath", () => {
  const item = normalizeBitbucketPull(bbPull(), "/repo/a");
  expect(item).toEqual({
    kind: "pulls",
    number: 7,
    title: "Add feature",
    state: "open",
    draft: false,
    htmlUrl: "https://bitbucket.org/acme/app/pull-requests/7",
    author: { login: "octocat", avatarUrl: null, htmlUrl: null },
    assignees: [],
    milestone: null,
    body: "body text",
    labels: [],
    comments: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: "/repo/a",
  });
});

test("normalizeBitbucketPull respects an explicit draft:true", () => {
  const item = normalizeBitbucketPull(bbPull({ draft: true }), null);
  expect(item?.draft).toBe(true);
});

test("normalizeBitbucketPull approximates mergedAt/closedAt from updated_on for a MERGED pull", () => {
  const item = normalizeBitbucketPull(bbPull({ state: "MERGED" }), null);
  expect(item?.state).toBe("closed");
  expect(item?.mergedAt).toBe("2026-01-02T00:00:00Z");
  expect(item?.closedAt).toBe("2026-01-02T00:00:00Z");
});

test.each(["DECLINED", "SUPERSEDED"])("normalizeBitbucketPull maps %s to closed with no mergedAt", (state) => {
  const item = normalizeBitbucketPull(bbPull({ state }), null);
  expect(item?.state).toBe("closed");
  expect(item?.mergedAt).toBeNull();
  expect(item?.closedAt).toBe("2026-01-02T00:00:00Z");
});

test("normalizeBitbucketPull returns null when required fields are missing", () => {
  expect(normalizeBitbucketPull({ id: 1 }, null)).toBeNull(); // no title
  expect(normalizeBitbucketPull({ title: "x" }, null)).toBeNull(); // no id
  expect(normalizeBitbucketPull(bbPull({ links: {} }), null)).toBeNull(); // no html url
  expect(normalizeBitbucketPull(null, null)).toBeNull();
});

// ---------------------------------------------------------------------------
// normalizeBitbucketIssue
// ---------------------------------------------------------------------------

function bbIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9,
    title: "Bug report",
    state: "new",
    content: { raw: "steps to reproduce" },
    comment_count: 1,
    created_on: "2026-02-01T00:00:00Z",
    updated_on: "2026-02-02T00:00:00Z",
    links: { html: { href: "https://bitbucket.org/acme/app/issues/9" } },
    reporter: { nickname: "reporter1" },
    assignee: { nickname: "assignee1" },
    ...overrides,
  };
}

test("normalizeBitbucketIssue maps content.raw to body and reporter to author", () => {
  const item = normalizeBitbucketIssue(bbIssue(), null);
  expect(item).toMatchObject({
    kind: "issues",
    number: 9,
    title: "Bug report",
    body: "steps to reproduce",
    author: { login: "reporter1", avatarUrl: null, htmlUrl: null },
    assignees: [{ login: "assignee1", avatarUrl: null, htmlUrl: null }],
    mergedAt: null,
    draft: false,
    labels: [],
  });
});

test.each(["new", "open"])("normalizeBitbucketIssue treats state=%s as open", (state) => {
  expect(normalizeBitbucketIssue(bbIssue({ state }), null)?.state).toBe("open");
});

test.each(["resolved", "closed", "duplicate", "invalid", "wontfix", "on hold"])(
  "normalizeBitbucketIssue treats state=%s as closed",
  (state) => {
    const item = normalizeBitbucketIssue(bbIssue({ state }), null);
    expect(item?.state).toBe("closed");
    expect(item?.closedAt).toBe("2026-02-02T00:00:00Z");
  },
);

test("normalizeBitbucketIssue has no assignees when the issue is unassigned", () => {
  const item = normalizeBitbucketIssue(bbIssue({ assignee: null }), null);
  expect(item?.assignees).toEqual([]);
});

test("normalizeBitbucketIssue returns null when id/title/html url is missing", () => {
  expect(normalizeBitbucketIssue({ title: "x" }, null)).toBeNull();
  expect(normalizeBitbucketIssue(bbIssue({ links: {} }), null)).toBeNull();
});

// ---------------------------------------------------------------------------
// normalizeBitbucketComment / normalizeBitbucketLineComment
// ---------------------------------------------------------------------------

function bbComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 55,
    content: { raw: "a comment" },
    created_on: "2026-03-01T00:00:00Z",
    updated_on: "2026-03-01T00:00:00Z",
    links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/7#comment-55" } },
    user: { nickname: "octocat" },
    ...overrides,
  };
}

test("normalizeBitbucketComment maps content.raw to body", () => {
  expect(normalizeBitbucketComment(bbComment())).toEqual({
    id: 55,
    body: "a comment",
    htmlUrl: "https://bitbucket.org/acme/app/pull-requests/7#comment-55",
    author: { login: "octocat", avatarUrl: null, htmlUrl: null },
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  });
});

test("normalizeBitbucketComment returns null without a numeric id or an html url", () => {
  expect(normalizeBitbucketComment({ content: { raw: "x" } })).toBeNull();
  expect(normalizeBitbucketComment(bbComment({ links: {} }))).toBeNull();
});

test("normalizeBitbucketLineComment maps inline.to to side RIGHT", () => {
  const comment = normalizeBitbucketLineComment(bbComment({ inline: { path: "src/a.ts", to: 5 } }));
  expect(comment).toMatchObject({ path: "src/a.ts", line: 5, side: "RIGHT" });
});

test("normalizeBitbucketLineComment maps inline.from to side LEFT", () => {
  const comment = normalizeBitbucketLineComment(bbComment({ inline: { path: "src/a.ts", from: 3 } }));
  expect(comment).toMatchObject({ path: "src/a.ts", line: 3, side: "LEFT" });
});

test("normalizeBitbucketLineComment prefers `to` over `from` when both are present", () => {
  const comment = normalizeBitbucketLineComment(bbComment({ inline: { path: "src/a.ts", to: 5, from: 3 } }));
  expect(comment).toMatchObject({ line: 5, side: "RIGHT" });
});

test("normalizeBitbucketLineComment returns null for a non-inline (top-level) comment", () => {
  expect(normalizeBitbucketLineComment(bbComment())).toBeNull();
});

test("normalizeBitbucketLineComment returns null when inline has no path", () => {
  expect(normalizeBitbucketLineComment(bbComment({ inline: { to: 5 } }))).toBeNull();
});

// ---------------------------------------------------------------------------
// normalizeBitbucketCheckRun / BITBUCKET_CHECK_STATE_MAP
// ---------------------------------------------------------------------------

test("BITBUCKET_CHECK_STATE_MAP maps every Bitbucket build-status state to the GitHub check-run vocabulary", () => {
  expect(BITBUCKET_CHECK_STATE_MAP).toEqual({
    INPROGRESS: { status: "in_progress", conclusion: null },
    SUCCESSFUL: { status: "completed", conclusion: "success" },
    FAILED: { status: "completed", conclusion: "failure" },
    STOPPED: { status: "completed", conclusion: "cancelled" },
  });
});

test("normalizeBitbucketCheckRun maps state and uses a 1-based page-local index as id", () => {
  const raw = { name: "ci/build", state: "SUCCESSFUL", url: "https://ci/1", created_on: "2026-01-01T00:00:00Z", updated_on: "2026-01-01T00:05:00Z" };
  expect(normalizeBitbucketCheckRun(raw, 0)).toEqual({
    id: 1,
    name: "ci/build",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://ci/1",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:05:00Z",
  });
  expect(normalizeBitbucketCheckRun(raw, 4)?.id).toBe(5);
});

test("normalizeBitbucketCheckRun falls back to `key` for name and to unknown/null for an unrecognized state", () => {
  const raw = { key: "ci-build-key", state: "SOMETHING_NEW" };
  expect(normalizeBitbucketCheckRun(raw, 0)).toMatchObject({ name: "ci-build-key", status: "unknown", conclusion: null });
});

test("normalizeBitbucketCheckRun leaves completedAt null for an in-progress run even though updated_on is present", () => {
  const raw = { name: "ci/build", state: "INPROGRESS", updated_on: "2026-01-01T00:05:00Z" };
  expect(normalizeBitbucketCheckRun(raw, 0)).toMatchObject({ status: "in_progress", conclusion: null, completedAt: null });
});

test("normalizeBitbucketCheckRun returns null without a name or a key", () => {
  expect(normalizeBitbucketCheckRun({ state: "SUCCESSFUL" }, 0)).toBeNull();
});

// ---------------------------------------------------------------------------
// escaping / BBQL builders
// ---------------------------------------------------------------------------

test("prStateParams maps open/closed/all to Bitbucket's repeatable state values", () => {
  expect(prStateParams("open")).toEqual(["OPEN"]);
  expect(prStateParams("closed")).toEqual(["MERGED", "DECLINED", "SUPERSEDED"]);
  expect(prStateParams("all")).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
});

test("issueStateBBQL: open→new/open, closed→every non-open state, all→null", () => {
  expect(issueStateBBQL("open")).toBe('(state="new" OR state="open")');
  expect(issueStateBBQL("closed")).toBe(
    '(state="resolved" OR state="closed" OR state="duplicate" OR state="invalid" OR state="wontfix" OR state="on hold")',
  );
  expect(issueStateBBQL("all")).toBeNull();
});

test("buildPullsBBQL: a free-text query produces a title/description OR clause", () => {
  expect(buildPullsBBQL({ query: "fix bug", state: "open" }, null)).toBe(
    '(title ~ "fix bug" OR description ~ "fix bug")',
  );
});

test("buildPullsBBQL: createdByMe adds author.uuid, only when meUuid is resolved", () => {
  expect(buildPullsBBQL({ createdByMe: true, state: "open" }, "{me-uuid}")).toBe('author.uuid="{me-uuid}"');
  expect(buildPullsBBQL({ createdByMe: true, state: "open" }, null)).toBeNull();
});

test("buildPullsBBQL: reviewRequested and assignedToMe both fold into the same reviewers.uuid clause", () => {
  expect(buildPullsBBQL({ reviewRequested: true, state: "open" }, "{me-uuid}")).toBe('reviewers.uuid="{me-uuid}"');
  expect(buildPullsBBQL({ assignedToMe: true, state: "open" }, "{me-uuid}")).toBe('reviewers.uuid="{me-uuid}"');
});

test("buildPullsBBQL ANDs every active clause together", () => {
  expect(buildPullsBBQL({ query: "q", createdByMe: true, reviewRequested: true, state: "open" }, "{me-uuid}")).toBe(
    '(title ~ "q" OR description ~ "q") AND author.uuid="{me-uuid}" AND reviewers.uuid="{me-uuid}"',
  );
});

test("buildPullsBBQL returns null with no active clauses", () => {
  expect(buildPullsBBQL({ state: "open" }, null)).toBeNull();
  expect(buildPullsBBQL({ state: "open" }, "{me-uuid}")).toBeNull();
});

test("buildIssuesBBQL combines the state clause, free-text query, and assignee.nickname", () => {
  expect(buildIssuesBBQL({ state: "open", query: "q", assignee: "octocat" })).toBe(
    '(state="new" OR state="open") AND (title ~ "q" OR content.raw ~ "q") AND assignee.nickname="octocat"',
  );
});

test("buildIssuesBBQL returns null for state=all with no query/assignee", () => {
  expect(buildIssuesBBQL({ state: "all" })).toBeNull();
});

// ---------------------------------------------------------------------------
// sortParam
// ---------------------------------------------------------------------------

test("sortParam: created + asc/desc", () => {
  expect(sortParam("created", "asc")).toBe("created_on");
  expect(sortParam("created", "desc")).toBe("-created_on");
});

test("sortParam: updated is the default field", () => {
  expect(sortParam("updated", "asc")).toBe("updated_on");
  expect(sortParam(undefined, undefined)).toBe("-updated_on");
});

test("sortParam: comments (no Bitbucket field) degrades to the updated_on field", () => {
  expect(sortParam("comments", "asc")).toBe("updated_on");
  expect(sortParam("comments", "desc")).toBe("-updated_on");
});

// ---------------------------------------------------------------------------
// misc internal tables
// ---------------------------------------------------------------------------

test("BITBUCKET_OPEN_ISSUE_STATES contains exactly new/open", () => {
  expect(BITBUCKET_OPEN_ISSUE_STATES).toEqual(new Set(["new", "open"]));
});

test("BITBUCKET_MERGE_STRATEGY maps the shared merge-method enum to Bitbucket's merge_strategy values", () => {
  expect(BITBUCKET_MERGE_STRATEGY).toEqual({
    merge: "merge_commit",
    squash: "squash",
    rebase: "fast_forward",
  });
});

// ---------------------------------------------------------------------------
// bitbucketViewerUuid — the no-creds short-circuit only (network-mocked
// resolution paths live in bitbucket-network.test.ts)
// ---------------------------------------------------------------------------

test("bitbucketViewerUuid resolves to null without any network call when there are no credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("bitbucketViewerUuid must not fetch without credentials");
  }) as unknown as typeof fetch;
  try {
    expect(await bitbucketViewerUuid(null)).toBeNull();
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// getBitbucketIssueThread (docs/plans/new-task-from-git-issue.md, Task A) —
// network-level tests against a mocked fetch, mirroring
// bitbucket-network.test.ts's own setup (hermetic AGETOR_DATA_DIR +
// BITBUCKET_TOKEN so bitbucketCreds() never touches a real store).
// ---------------------------------------------------------------------------

const ORIGINAL_DATA_DIR = process.env.AGETOR_DATA_DIR;
const ORIGINAL_TOKEN = process.env.BITBUCKET_TOKEN;
const ORIGINAL_EMAIL = process.env.BITBUCKET_EMAIL;
const ORIGINAL_SSH_BIN = process.env.AGETOR_SSH_BIN;
let issueThreadDataDir: string;
let sshStubDirs: string[] = [];

beforeAll(() => {
  issueThreadDataDir = mkdtempSync(path.join(tmpdir(), "agetor-bb-issue-thread-"));
  process.env.AGETOR_DATA_DIR = issueThreadDataDir;
  process.env.BITBUCKET_TOKEN = "test-token";
  delete process.env.BITBUCKET_EMAIL;
});

afterAll(() => {
  rmSync(issueThreadDataDir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BITBUCKET_TOKEN;
  else process.env.BITBUCKET_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_EMAIL === undefined) delete process.env.BITBUCKET_EMAIL;
  else process.env.BITBUCKET_EMAIL = ORIGINAL_EMAIL;
});

// Every exported entry point opens with a `bitbucketServerError` guard
// (docs/plans/per-host-git-api-bases.md) that resolves `repo.remoteHost`
// through `apiHostForRemote` (git-provider.ts, `ssh -G` under the hood) —
// reset the cache + AGETOR_SSH_BIN after every test in this section, mirroring
// bitbucket-network.test.ts's own hygiene.
afterEach(() => {
  __clearApiHostCacheForTest();
  if (ORIGINAL_SSH_BIN === undefined) delete process.env.AGETOR_SSH_BIN;
  else process.env.AGETOR_SSH_BIN = ORIGINAL_SSH_BIN;
  for (const dir of sshStubDirs) rmSync(dir, { recursive: true, force: true });
  sshStubDirs = [];
});

/** Writes an executable stub standing in for `ssh`, mirroring
 *  bitbucket-network.test.ts's own `writeSshStub` — `apiHostForRemote` invokes
 *  it as `<stub> -G -- <host>`, so `$3` is the (lowercased) host argument. */
function writeSshStub(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-bb-issue-thread-ssh-stub-"));
  sshStubDirs.push(dir);
  const binPath = path.join(dir, "ssh");
  writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

function bitbucketIssueJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    title: "Something is broken",
    state: "open",
    links: { html: { href: "https://bitbucket.org/acme/app/issues/7" } },
    reporter: { nickname: "alice", links: {} },
    assignee: null,
    content: { raw: "steps to reproduce" },
    comment_count: 2,
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function bitbucketCommentJson(id: number): Record<string, unknown> {
  return {
    id,
    content: { raw: `comment ${id}` },
    links: { html: { href: `https://bitbucket.org/acme/app/issues/7#comment-${id}` } },
    user: { nickname: "bob", links: {} },
    created_on: "2026-01-01T00:00:00Z",
    updated_on: "2026-01-01T00:00:00Z",
  };
}

test("getBitbucketIssueThread happy path normalizes the issue and its comments", async () => {
  const repo = makeBitbucketRepo("acme", "app");
  const mock = mockGitHubFetch([
    { match: /\/2\.0\/repositories\/acme\/app\/issues\/7$/, json: bitbucketIssueJson() },
    {
      match: "/2.0/repositories/acme/app/issues/7/comments",
      json: { values: [bitbucketCommentJson(1), bitbucketCommentJson(2)] },
    },
  ]);
  try {
    const res = await getBitbucketIssueThread(repo, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repo).toBe("acme/app");
    expect(res.item.kind).toBe("issues");
    expect(res.item.number).toBe(7);
    expect(res.item.htmlUrl).toBe("https://bitbucket.org/acme/app/issues/7");
    expect(res.item.sourcePath).toBeNull();
    expect(res.comments.map((c) => c.id)).toEqual([1, 2]);
    // Bitbucket's comments adapter drains every page itself — no page-count
    // cap the way GitHub/GitLab have, so this is always false.
    expect(res.truncated).toBe(false);
    // The adapter never resolves gh/glab availability — Bitbucket has no
    // re-fetch CLI at all, and the facade never fills one in for it either.
    expect(res.refetchCommand).toBeNull();
  } finally {
    mock.restore();
  }
});

test("getBitbucketIssueThread with includeComments:false skips listBitbucketComments entirely", async () => {
  const repo = makeBitbucketRepo("acme", "app1b");
  const mock = mockGitHubFetch([
    { match: /\/2\.0\/repositories\/acme\/app1b\/issues\/7$/, json: bitbucketIssueJson() },
    // Deliberately no route for the /comments endpoint — if the adapter
    // fetched it anyway, mockGitHubFetch would throw "no route for ..." and
    // fail this test loudly.
  ]);
  try {
    const res = await getBitbucketIssueThread(repo, 7, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.comments).toEqual([]);
    expect(res.truncated).toBe(false);
  } finally {
    mock.restore();
  }
});

test("getBitbucketIssueThread maps a 404 WITH credentials present to the issue-tracker-disabled friendly error", async () => {
  const repo = makeBitbucketRepo("acme", "app2");
  const mock = mockGitHubFetch([
    { match: "/issues/9", status: 404, json: { type: "error", error: { message: "Not Found" } } },
  ]);
  try {
    // REPO carries no per-host stored token, but beforeAll's BITBUCKET_TOKEN
    // env fallback means a credential IS sent here — this is the authed case,
    // matching listBitbucketItems's own issue-tracker-disabled shortcut.
    const res = await getBitbucketIssueThread(repo, 9);
    expect(res).toEqual({ ok: false, error: "issue tracker is not enabled for this repository" });
  } finally {
    mock.restore();
  }
});

test("getBitbucketIssueThread rejects a Bitbucket Server/DC remote host with zero fetch calls — server-host rejection unchanged", async () => {
  process.env.AGETOR_SSH_BIN = writeSshStub('#!/bin/sh\necho "hostname $3"\n');
  const serverRepo = makeBitbucketRepo("acme", "app", "bitbucket.mycompany.com");
  const mock = mockGitHubFetch([]);
  try {
    const res = await getBitbucketIssueThread(serverRepo, 1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toContain("Bitbucket Server / Data Center is not supported");
    expect(mock.calls).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("getBitbucketIssueThread rejects a non-positive/non-integer id before any fetch (before the creds lookup too)", async () => {
  const repo = makeBitbucketRepo("acme", "app3");
  const mock = mockGitHubFetch([]); // any fetch call would throw — proves none happens, not even bitbucketCreds()

  for (const bad of [0, -1, 3.5]) {
    const res = await getBitbucketIssueThread(repo, bad);
    expect(res).toEqual({ ok: false, error: "issue number must be positive" });
  }
  expect(mock.calls).toHaveLength(0);
  mock.restore();
});
