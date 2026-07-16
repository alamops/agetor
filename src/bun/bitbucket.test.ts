// Pure-function unit tests for `src/bun/bitbucket.ts`, exercised entirely
// through `__bitbucketInternals` (no network, no filesystem). Complements
// bitbucket-network.test.ts, which drives the exported functions end-to-end
// through a mocked `fetch`.
import { test, expect } from "bun:test";
import { __bitbucketInternals } from "./bitbucket.ts";
import { makeBitbucketRepo } from "./bitbucket-test-util.ts";

const {
  repoBasePath,
  resolveUrl,
  apiErrorMessage,
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

test("apiErrorMessage gives a 401 an actionable credentials hint, wrapping the underlying message", () => {
  const msg = apiErrorMessage({ error: { message: "Invalid credentials" } }, 401, "Unauthorized");
  expect(msg).toContain("Invalid credentials");
  expect(msg).toContain("configure credentials in Settings");
  expect(msg).toContain("Basic auth: email:api_token");
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
