import { expect, test } from "bun:test";
import { __githubInternals, githubRepoFromRemoteForTest } from "./github.ts";
import type { GitHubListItem } from "../shared/types.ts";

const {
  matchesFilters,
  normalizeItem,
  normalizeLineComment,
  normalizeCheckRun,
  reviewValidationError,
  buildIssueUpdatePatch,
  normalizeMergeability,
  normalizePullCommit,
  parseLinkedIssues,
  draftFromGraphql,
  graphqlErrorMessage,
  sanitizeReviewComments,
  commentUrl,
  parseReviewThreads,
  reviewThreadsHasNextPage,
  buildSearchQuery,
  normalizeColor,
  normalizeRepoLabel,
  normalizeRepoMilestone,
  normalizeDueOn,
  reactionSubjectPath,
  aggregateReactions,
  parseSuggestion,
  suggestionCommentRange,
  spliceSuggestionLines,
  normalizeSubIssue,
  parseTargetRepo,
  pinnedFromGraphqlMutation,
  pinnedFromGraphqlQuery,
  targetRepoIdFromGraphql,
  transferredIssueFromGraphql,
  subIssuesApiError,
  parseRateLimit,
  normalizeNotification,
  notificationHtmlUrl,
} = __githubInternals;

const REPO = { owner: "o", name: "r" };

function makeItem(overrides: Partial<GitHubListItem> = {}): GitHubListItem {
  return {
    kind: "pulls",
    number: 1,
    title: "Add feature",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/o/r/pull/1",
    author: { login: "alice", avatarUrl: null, htmlUrl: null },
    assignees: [{ login: "bob", avatarUrl: null, htmlUrl: null }],
    milestone: { number: 3, title: "v1" },
    body: "body text",
    labels: [{ name: "bug", color: "ff0000" }],
    comments: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: null,
    ...overrides,
  };
}

test("githubRepoFromRemoteForTest parses GitHub https remotes", () => {
  expect(githubRepoFromRemoteForTest("https://github.com/openai/codex.git")).toBe("openai/codex");
  expect(githubRepoFromRemoteForTest("https://github.com/openai/codex")).toBe("openai/codex");
});

test("githubRepoFromRemoteForTest parses GitHub ssh remotes", () => {
  expect(githubRepoFromRemoteForTest("git@github.com:openai/codex.git")).toBe("openai/codex");
  expect(githubRepoFromRemoteForTest("ssh://git@github.com/openai/codex.git")).toBe("openai/codex");
});

test("githubRepoFromRemoteForTest ignores non-GitHub remotes", () => {
  expect(githubRepoFromRemoteForTest("git@gitlab.com:openai/codex.git")).toBeNull();
  expect(githubRepoFromRemoteForTest("")).toBeNull();
});

test("matchesFilters matches on assignee login (case-insensitive), rejects non-assignees", () => {
  const item = makeItem();
  expect(matchesFilters(item, "", [], "bob")).toBe(true);
  expect(matchesFilters(item, "", [], "BOB")).toBe(true);
  expect(matchesFilters(item, "", [], "carol")).toBe(false);
  // Empty assignee filter is a no-op.
  expect(matchesFilters(item, "", [], "")).toBe(true);
});

test("matchesFilters query hay includes assignee and milestone", () => {
  const item = makeItem();
  expect(matchesFilters(item, "bob", [], "")).toBe(true); // assignee login
  expect(matchesFilters(item, "v1", [], "")).toBe(true); // milestone title
  expect(matchesFilters(item, "nonsense", [], "")).toBe(false);
});

test("matchesFilters requires every label to be present", () => {
  const item = makeItem({ labels: [{ name: "bug", color: null }, { name: "p1", color: null }] });
  expect(matchesFilters(item, "", ["bug"], "")).toBe(true);
  expect(matchesFilters(item, "", ["bug", "p1"], "")).toBe(true);
  expect(matchesFilters(item, "", ["bug", "missing"], "")).toBe(false);
});

test("normalizeLineComment reads line, falls back to original_line, rejects bad shapes", () => {
  const base = { id: 5, html_url: "https://x", body: "note", user: null, side: "RIGHT" };
  expect(normalizeLineComment({ ...base, path: "a.ts", line: 12 })).toMatchObject({ line: 12, side: "RIGHT", path: "a.ts" });
  // line missing → falls back to original_line
  expect(normalizeLineComment({ ...base, path: "a.ts", original_line: 7 })).toMatchObject({ line: 7 });
  // no line at all → null
  expect(normalizeLineComment({ ...base, path: "a.ts" })).toBeNull();
  // bad side → null
  expect(normalizeLineComment({ ...base, side: "MIDDLE", path: "a.ts", line: 1 })).toBeNull();
  // missing path → null
  expect(normalizeLineComment({ ...base, line: 1 })).toBeNull();
});

test("normalizeCheckRun defaults status and rejects runs without id/name", () => {
  expect(normalizeCheckRun({ id: 1, name: "build", status: "completed", conclusion: "success" }))
    .toMatchObject({ id: 1, name: "build", status: "completed", conclusion: "success" });
  // missing status → defaults to "unknown", null conclusion preserved
  expect(normalizeCheckRun({ id: 2, name: "lint" })).toMatchObject({ status: "unknown", conclusion: null });
  expect(normalizeCheckRun({ name: "no-id" })).toBeNull();
  expect(normalizeCheckRun({ id: 3 })).toBeNull();
});

test("reviewValidationError requires a body for COMMENT and REQUEST_CHANGES but not APPROVE", () => {
  expect(reviewValidationError("APPROVE", "")).toBeNull();
  expect(reviewValidationError("APPROVE", "lgtm")).toBeNull();
  expect(reviewValidationError("COMMENT", "")).toBe("a review comment requires a body");
  expect(reviewValidationError("COMMENT", "   ")).toBe("a review comment requires a body");
  expect(reviewValidationError("COMMENT", "note")).toBeNull();
  expect(reviewValidationError("REQUEST_CHANGES", "")).toBe("request changes requires a comment");
  expect(reviewValidationError("REQUEST_CHANGES", "fix this")).toBeNull();
  // @ts-expect-error — exercising the server-cast path with an invalid event
  expect(reviewValidationError("MERGE", "x")).toBe("unsupported review event");
});

test("buildIssueUpdatePatch trims fields and rejects an empty patch or blank title", () => {
  // trims labels/assignees, drops blanks
  const built = buildIssueUpdatePatch({ labels: [" bug ", "", "p1"], assignees: ["alice", " "] });
  expect(built).toEqual({ ok: true, patch: { labels: ["bug", "p1"], assignees: ["alice"] } });

  // title is trimmed; empty title after trim is rejected with a kind-aware noun
  expect(buildIssueUpdatePatch({ kind: "pulls", title: "  " }))
    .toEqual({ ok: false, error: "pull request title cannot be empty" });
  expect(buildIssueUpdatePatch({ title: " Fix bug " }))
    .toEqual({ ok: true, patch: { title: "Fix bug" } });

  // body="" is a real change (clears description); milestone:null is a real change (clears it)
  expect(buildIssueUpdatePatch({ body: "" })).toEqual({ ok: true, patch: { body: "" } });
  expect(buildIssueUpdatePatch({ milestone: null })).toEqual({ ok: true, patch: { milestone: null } });

  // no fields at all → error
  expect(buildIssueUpdatePatch({ kind: "issues" }))
    .toEqual({ ok: false, error: "issue update requires title, body, state, labels, assignees, or milestone" });
});

test("normalizeMergeability reads mergeable/state and refs, defaulting the unknowns", () => {
  const full = normalizeMergeability(REPO, 7, {
    mergeable: true,
    mergeable_state: "clean",
    rebaseable: true,
    merged: false,
    draft: false,
    head: { ref: "feature", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
  });
  expect(full).toEqual({
    repo: "o/r",
    pullNumber: 7,
    mergeable: true,
    mergeableState: "clean",
    rebaseable: true,
    merged: false,
    draft: false,
    headRef: "feature",
    baseRef: "main",
    headSha: "abc123",
    autoMerge: false,
  });

  // mergeable still computing → null; missing mergeable_state → "unknown"; missing head/base → empty strings
  const partial = normalizeMergeability(REPO, 8, { mergeable: null, merged: false });
  expect(partial).toMatchObject({ mergeable: null, mergeableState: "unknown", rebaseable: null, headRef: "", baseRef: "", headSha: "", autoMerge: false });

  // auto_merge is a non-null object once enabled
  const autoMergeOn = normalizeMergeability(REPO, 10, { mergeable: true, merged: false, auto_merge: { enabled_by: { login: "bob" }, merge_method: "squash" } });
  expect(autoMergeOn).toMatchObject({ autoMerge: true });

  expect(normalizeMergeability(REPO, 9, null)).toBeNull();
});

test("normalizePullCommit splits the headline, prefers the top-level author, rejects malformed shapes", () => {
  const withAuthor = normalizePullCommit({
    sha: "abc123",
    html_url: "https://github.com/o/r/commit/abc123",
    commit: { message: "Fix bug\n\nLonger body here", author: { date: "2026-01-01T00:00:00Z" } },
    author: { login: "alice", avatar_url: null, html_url: null },
  });
  expect(withAuthor).toEqual({
    sha: "abc123",
    messageHeadline: "Fix bug",
    author: { login: "alice", avatarUrl: null, htmlUrl: null },
    authoredDate: "2026-01-01T00:00:00Z",
    htmlUrl: "https://github.com/o/r/commit/abc123",
  });

  // no top-level GitHub-user author (e.g. an unlinked git commit) → null, not the raw git author
  const noAuthor = normalizePullCommit({
    sha: "def456",
    commit: { message: "Single line", author: { date: "2026-01-02T00:00:00Z", name: "Bob", email: "bob@x.com" } },
    author: null,
  });
  expect(noAuthor).toMatchObject({ sha: "def456", messageHeadline: "Single line", author: null });

  // missing sha / missing commit.message → null
  expect(normalizePullCommit({ commit: { message: "x" } })).toBeNull();
  expect(normalizePullCommit({ sha: "abc" })).toBeNull();
  expect(normalizePullCommit(null)).toBeNull();
});

test("parseLinkedIssues digs closingIssuesReferences nodes out of a GraphQL response, [] on anything unexpected", () => {
  const happy = {
    data: {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              { number: 12, title: "Bug A", url: "https://github.com/o/r/issues/12", state: "OPEN" },
              { number: 34, title: "Bug B", url: "https://github.com/o/r/issues/34", state: "CLOSED" },
            ],
          },
        },
      },
    },
  };
  expect(parseLinkedIssues(happy)).toEqual([
    { number: 12, title: "Bug A", url: "https://github.com/o/r/issues/12", state: "OPEN" },
    { number: 34, title: "Bug B", url: "https://github.com/o/r/issues/34", state: "CLOSED" },
  ]);

  // malformed node (missing fields) is dropped, not thrown
  const partiallyMalformed = {
    data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [
      { number: 1, title: "ok", url: "https://x/1", state: "OPEN" },
      { number: 2, title: "missing url" },
    ] } } } },
  };
  expect(parseLinkedIssues(partiallyMalformed)).toEqual([{ number: 1, title: "ok", url: "https://x/1", state: "OPEN" }]);

  expect(parseLinkedIssues(null)).toEqual([]);
  expect(parseLinkedIssues({})).toEqual([]);
  expect(parseLinkedIssues({ data: {} })).toEqual([]);
  expect(parseLinkedIssues({ data: { repository: null } })).toEqual([]);
  expect(parseLinkedIssues({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: "not an array" } } } } })).toEqual([]);
});

test("draftFromGraphql digs isDraft out of the mutation payload, else null", () => {
  const ready = { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
  expect(draftFromGraphql(ready, "markPullRequestReadyForReview")).toBe(false);
  const toDraft = { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } };
  expect(draftFromGraphql(toDraft, "convertPullRequestToDraft")).toBe(true);
  // wrong field, missing nesting, or junk → null (caller falls back to requested state)
  expect(draftFromGraphql(ready, "convertPullRequestToDraft")).toBeNull();
  expect(draftFromGraphql({ data: {} }, "markPullRequestReadyForReview")).toBeNull();
  expect(draftFromGraphql({ errors: [{ message: "nope" }] }, "markPullRequestReadyForReview")).toBeNull();
  expect(draftFromGraphql(null, "markPullRequestReadyForReview")).toBeNull();
});

test("sanitizeReviewComments keeps well-formed inline comments and trims, drops the rest", () => {
  const out = sanitizeReviewComments([
    { path: " a.ts ", line: 12, side: "RIGHT", body: " looks off " },
    { path: "b.ts", line: 3, side: "LEFT", body: "old line" },
    { path: "", line: 5, side: "RIGHT", body: "no path" },
    { path: "c.ts", line: 0, side: "RIGHT", body: "bad line" },
    { path: "d.ts", line: 2, side: "MIDDLE" as unknown as "LEFT", body: "bad side" },
    { path: "e.ts", line: 4, side: "RIGHT", body: "   " },
  ]);
  expect(out).toEqual([
    { path: "a.ts", line: 12, side: "RIGHT", body: "looks off" },
    { path: "b.ts", line: 3, side: "LEFT", body: "old line" },
  ]);
  expect(sanitizeReviewComments(undefined)).toEqual([]);
  expect(sanitizeReviewComments([])).toEqual([]);
});

test("parseReviewThreads extracts id, resolution, and root comment databaseId; drops malformed", () => {
  const json = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { id: "T1", isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 100 }] } },
              { id: "T2", isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 200 }] } },
              { id: "T3", comments: { nodes: [] } }, // no root comment → dropped
              { isResolved: false, comments: { nodes: [{ databaseId: 300 }] } }, // no thread id → dropped
            ],
          },
        },
      },
    },
  };
  expect(parseReviewThreads(json)).toEqual([
    { threadId: "T1", rootCommentId: 100, isResolved: true, isOutdated: false },
    { threadId: "T2", rootCommentId: 200, isResolved: false, isOutdated: true },
  ]);
  expect(parseReviewThreads(null)).toEqual([]);
  expect(parseReviewThreads({ data: {} })).toEqual([]);
});

test("reviewThreadsHasNextPage reads pageInfo.hasNextPage, defaulting false", () => {
  const page = (hasNextPage: boolean) => ({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage } } } } },
  });
  expect(reviewThreadsHasNextPage(page(true))).toBe(true);
  expect(reviewThreadsHasNextPage(page(false))).toBe(false);
  expect(reviewThreadsHasNextPage({ data: { repository: { pullRequest: {} } } })).toBe(false);
  expect(reviewThreadsHasNextPage(null)).toBe(false);
});

test("buildSearchQuery composes repo/kind/state + involvement + label/assignee qualifiers", () => {
  const base = { dir: "/x", kind: "pulls" as const, state: "open" as const };
  expect(buildSearchQuery("o/r", { ...base, createdByMe: true }))
    .toBe("repo:o/r is:pr is:open author:@me");
  expect(buildSearchQuery("o/r", { ...base, assignedToMe: true, reviewRequested: true }))
    .toBe("repo:o/r is:pr is:open assignee:@me review-requested:@me");
  // review-requested is PR-only; a label with a space is quoted; "all" state omits is:
  expect(buildSearchQuery("o/r", { dir: "/x", kind: "issues", state: "all", labels: ["needs review", "bug"], reviewRequested: true, assignedToMe: true }))
    .toBe('repo:o/r is:issue label:"needs review" label:"bug" assignee:@me');
  // a free-text assignee is used when assignedToMe is off
  expect(buildSearchQuery("o/r", { ...base, assignee: "alice" }))
    .toBe("repo:o/r is:pr is:open assignee:alice");
  // raw user qualifiers ride along, after the composed scope
  expect(buildSearchQuery("o/r", { ...base, createdByMe: true, searchQuery: "label:bug sort:updated" }))
    .toBe("repo:o/r is:pr is:open author:@me label:bug sort:updated");
  // a user-typed repo: is stripped so the prepended project scope stays authoritative
  expect(buildSearchQuery("o/r", { ...base, searchQuery: "repo:evil/x is:merged" }))
    .toBe("repo:o/r is:pr is:open is:merged");
});

test("normalizeColor strips a leading # and lowercases, undefined passes through", () => {
  expect(normalizeColor("#FF8800")).toBe("ff8800");
  expect(normalizeColor("00AAff")).toBe("00aaff");
  expect(normalizeColor("  #abcdef  ")).toBe("abcdef");
  expect(normalizeColor(undefined)).toBeUndefined();
  expect(normalizeColor("")).toBe("");
});

test("normalizeRepoLabel defaults color/description and drops nameless entries", () => {
  expect(normalizeRepoLabel({ name: "bug", color: "d73a4a", description: "a defect" }))
    .toEqual({ name: "bug", color: "d73a4a", description: "a defect" });
  // missing color/description default to ""
  expect(normalizeRepoLabel({ name: "wip" })).toEqual({ name: "wip", color: "", description: "" });
  // no name / junk → null
  expect(normalizeRepoLabel({ color: "fff" })).toBeNull();
  expect(normalizeRepoLabel(null)).toBeNull();
});

test("normalizeRepoMilestone maps snake_case, defaults, and drops invalid entries", () => {
  expect(
    normalizeRepoMilestone({
      number: 3,
      title: "v1.0",
      state: "closed",
      description: "first release",
      due_on: "2026-07-08T00:00:00Z",
      open_issues: 2,
      closed_issues: 5,
      html_url: "https://github.com/o/r/milestone/3",
    }),
  ).toEqual({
    number: 3,
    title: "v1.0",
    state: "closed",
    description: "first release",
    dueOn: "2026-07-08T00:00:00Z",
    openIssues: 2,
    closedIssues: 5,
    htmlUrl: "https://github.com/o/r/milestone/3",
  });
  // missing fields default; unknown state → "open"
  expect(normalizeRepoMilestone({ number: 1, title: "backlog" })).toEqual({
    number: 1,
    title: "backlog",
    state: "open",
    description: "",
    dueOn: null,
    openIssues: 0,
    closedIssues: 0,
    htmlUrl: "",
  });
  // no number/title → null
  expect(normalizeRepoMilestone({ title: "x" })).toBeNull();
  expect(normalizeRepoMilestone({ number: 2 })).toBeNull();
  expect(normalizeRepoMilestone(null)).toBeNull();
});

test("normalizeDueOn widens a bare date to noon UTC, passes through ISO, and blanks to undefined", () => {
  // Noon (not midnight) UTC so GitHub's Pacific-tz date conversion doesn't roll back a day.
  expect(normalizeDueOn("2026-07-08")).toBe("2026-07-08T12:00:00Z");
  expect(normalizeDueOn("2026-07-08T09:30:00Z")).toBe("2026-07-08T09:30:00Z");
  expect(normalizeDueOn("  2026-07-08  ")).toBe("2026-07-08T12:00:00Z");
  expect(normalizeDueOn("")).toBeUndefined();
  expect(normalizeDueOn("   ")).toBeUndefined();
  expect(normalizeDueOn(null)).toBeUndefined();
  expect(normalizeDueOn(undefined)).toBeUndefined();
});

test("commentUrl maps kind to the right endpoint segment", () => {
  expect(commentUrl(REPO, "issue", 42)).toBe("https://api.github.com/repos/o/r/issues/comments/42");
  expect(commentUrl(REPO, "review", 42)).toBe("https://api.github.com/repos/o/r/pulls/comments/42");
});

test("reactionSubjectPath maps each subject kind to the right endpoint", () => {
  expect(reactionSubjectPath(REPO, { type: "issue", id: 7 })).toBe("https://api.github.com/repos/o/r/issues/7/reactions");
  expect(reactionSubjectPath(REPO, { type: "issueComment", id: 42 })).toBe("https://api.github.com/repos/o/r/issues/comments/42/reactions");
  expect(reactionSubjectPath(REPO, { type: "reviewComment", id: 42 })).toBe("https://api.github.com/repos/o/r/pulls/comments/42/reactions");
});

test("aggregateReactions counts by content, tags the viewer's own reaction id, and drops unknown content", () => {
  const raw = [
    { id: 1, content: "+1", user: { login: "alice" } },
    { id: 2, content: "+1", user: { login: "bob" } },
    { id: 3, content: "heart", user: { login: "alice" } },
    { id: 4, content: "party-parrot", user: { login: "alice" } }, // unknown content — dropped
  ];
  expect(aggregateReactions(raw, "alice")).toEqual([
    { content: "+1", count: 2, viewerReactionId: 1 },
    { content: "heart", count: 1, viewerReactionId: 3 },
  ]);
  // case-insensitive login match
  expect(aggregateReactions(raw, "ALICE")).toEqual([
    { content: "+1", count: 2, viewerReactionId: 1 },
    { content: "heart", count: 1, viewerReactionId: 3 },
  ]);
  // no match for this viewer → every viewerReactionId is null
  expect(aggregateReactions(raw, "carol")).toEqual([
    { content: "+1", count: 2, viewerReactionId: null },
    { content: "heart", count: 1, viewerReactionId: null },
  ]);
  // empty viewer (unauthenticated) → counts still work, no viewer id
  expect(aggregateReactions(raw, "")).toEqual([
    { content: "+1", count: 2, viewerReactionId: null },
    { content: "heart", count: 1, viewerReactionId: null },
  ]);
  // no reactions at all → empty list
  expect(aggregateReactions([], "alice")).toEqual([]);
  // malformed entries are skipped, not thrown
  expect(aggregateReactions([null, { content: 5 }, { content: "eyes" }], "alice")).toEqual([
    { content: "eyes", count: 1, viewerReactionId: null },
  ]);
});

test("aggregateReactions sorts by the fixed content order regardless of input order", () => {
  const raw = [
    { id: 1, content: "eyes", user: null },
    { id: 2, content: "+1", user: null },
    { id: 3, content: "rocket", user: null },
  ];
  expect(aggregateReactions(raw, "").map((r) => r.content)).toEqual(["+1", "rocket", "eyes"]);
});

test("parseSuggestion extracts the first ```suggestion fence body, null when absent", () => {
  expect(parseSuggestion("```suggestion\nconst x = 1;\n```")).toEqual({ suggestion: "const x = 1;" });
  // multi-line suggestion body, preserved verbatim (minus the one trailing newline before the fence)
  expect(parseSuggestion("```suggestion\nline one\nline two\n```")).toEqual({ suggestion: "line one\nline two" });
  // surrounding prose is ignored — only the fenced body is returned
  expect(parseSuggestion("Nit: fix this.\n\n```suggestion\nfixed text\n```\n\nThanks!")).toEqual({ suggestion: "fixed text" });
  // only the first fence counts when there happen to be two
  expect(parseSuggestion("```suggestion\nfirst\n```\n```suggestion\nsecond\n```")).toEqual({ suggestion: "first" });
  // CRLF fence: the trailing \r\n before the closing fence is fully stripped
  expect(parseSuggestion("```suggestion\r\nconst x = 1;\r\n```")).toEqual({ suggestion: "const x = 1;" });
  // empty body = GitHub's "delete this line" convention → { suggestion: "" }
  expect(parseSuggestion("```suggestion\n```")).toEqual({ suggestion: "" });
  // a plain code fence (no "suggestion" info string) doesn't count
  expect(parseSuggestion("```ts\nconst x = 1;\n```")).toBeNull();
  // a bare ```suggestion with no newline after it is not an appliable suggestion
  expect(parseSuggestion("```suggestion")).toBeNull();
  expect(parseSuggestion("just a regular comment")).toBeNull();
  expect(parseSuggestion("")).toBeNull();
});

test("suggestionCommentRange requires a present line + RIGHT side, refusing outdated/LEFT comments", () => {
  expect(suggestionCommentRange({ path: "a.ts", line: 12, side: "RIGHT", body: "```suggestion\nx\n```" }))
    .toEqual({ ok: true, path: "a.ts", startLine: 12, endLine: 12, body: "```suggestion\nx\n```" });
  // multi-line comment: start_line..line
  expect(suggestionCommentRange({ path: "a.ts", start_line: 10, line: 12, side: "RIGHT", body: "x" }))
    .toEqual({ ok: true, path: "a.ts", startLine: 10, endLine: 12, body: "x" });
  // side falls back to original_side when side is absent but a RIGHT position holds
  expect(suggestionCommentRange({ path: "a.ts", line: 5, original_side: "RIGHT", body: "x" }))
    .toMatchObject({ ok: true, startLine: 5, endLine: 5 });
  // line null/absent (outdated — GitHub would only fill original_line) → refuse, do NOT use original_line
  expect(suggestionCommentRange({ path: "a.ts", line: null, side: "RIGHT", original_line: 7, body: "x" }))
    .toEqual({ ok: false, error: "This suggestion is on an outdated diff and can't be applied automatically." });
  expect(suggestionCommentRange({ path: "a.ts", side: "RIGHT", original_line: 7, body: "x" }))
    .toEqual({ ok: false, error: "This suggestion is on an outdated diff and can't be applied automatically." });
  // LEFT-side comment (base-file line, doesn't map to head) → refuse
  expect(suggestionCommentRange({ path: "a.ts", line: 4, side: "LEFT", body: "x" }))
    .toEqual({ ok: false, error: "Suggestions can only be applied to added or unchanged lines." });
  // missing path/body, or an inverted range → malformed
  expect(suggestionCommentRange({ path: "a.ts", line: 3, side: "RIGHT" }))
    .toEqual({ ok: false, error: "GitHub returned an unexpected review comment response" });
  expect(suggestionCommentRange({ path: "a.ts", start_line: 9, line: 3, side: "RIGHT", body: "x" }))
    .toEqual({ ok: false, error: "GitHub returned an unexpected review comment response" });
  expect(suggestionCommentRange(null)).toEqual({ ok: false, error: "GitHub returned an unexpected review comment response" });
});

test("spliceSuggestionLines replaces the inclusive range, preserves EOL/trailing newline, deletes on empty", () => {
  const lf = "line1\nline2\nline3\n";
  // one line → one line
  expect(spliceSuggestionLines(lf, 2, 2, "LINE2")).toBe("line1\nLINE2\nline3\n");
  // one line → multi-line
  expect(spliceSuggestionLines(lf, 2, 2, "a\nb")).toBe("line1\na\nb\nline3\n");
  // multi-line → one line
  expect(spliceSuggestionLines(lf, 1, 2, "merged")).toBe("merged\nline3\n");
  // no trailing newline preserved
  expect(spliceSuggestionLines("a\nb\nc", 2, 2, "B")).toBe("a\nB\nc");
  // CRLF file: inserted line matches the file's CRLF terminator
  expect(spliceSuggestionLines("a\r\nb\r\nc\r\n", 2, 2, "B")).toBe("a\r\nB\r\nc\r\n");
  // endLine == last line
  expect(spliceSuggestionLines(lf, 3, 3, "LAST")).toBe("line1\nline2\nLAST\n");
  // empty suggestion deletes the range (inserts zero lines)
  expect(spliceSuggestionLines(lf, 2, 2, "")).toBe("line1\nline3\n");
  // out of range → null (never a throw)
  expect(spliceSuggestionLines(lf, 40, 40, "x")).toBeNull();
  expect(spliceSuggestionLines(lf, 2, 1, "x")).toBeNull();
  expect(spliceSuggestionLines(lf, 0, 0, "x")).toBeNull();
});

test("graphqlErrorMessage returns the first error message, else null", () => {
  expect(graphqlErrorMessage({ errors: [{ message: "already a draft" }, { message: "second" }] })).toBe("already a draft");
  // errors present but no string message → generic fallback
  expect(graphqlErrorMessage({ errors: [{ code: 42 }] })).toBe("GitHub rejected the request");
  // no errors / success payload / junk → null (caller proceeds)
  expect(graphqlErrorMessage({ data: { x: 1 } })).toBeNull();
  expect(graphqlErrorMessage({ errors: [] })).toBeNull();
  expect(graphqlErrorMessage(null)).toBeNull();
});

test("normalizeItem reads the REST `locked` field, defaulting to false when absent", () => {
  const base = { number: 1, title: "t", state: "open", html_url: "https://x" };
  expect(normalizeItem("issues", { ...base, locked: true })).toMatchObject({ locked: true });
  expect(normalizeItem("issues", { ...base, locked: false })).toMatchObject({ locked: false });
  // list paths that omit `locked` altogether → defaults false, doesn't reject the item
  expect(normalizeItem("issues", base)).toMatchObject({ locked: false });
  // non-boolean `locked` → treated as absent
  expect(normalizeItem("issues", { ...base, locked: "yes" })).toMatchObject({ locked: false });
});

test("normalizeSubIssue keeps id (not just number) and rejects malformed shapes", () => {
  const raw = { id: 555, number: 3, title: "child", state: "open", html_url: "https://x/3" };
  expect(normalizeSubIssue(raw)).toEqual({ id: 555, number: 3, title: "child", state: "open", htmlUrl: "https://x/3" });
  // missing id → null (the shape the remove flow depends on)
  expect(normalizeSubIssue({ number: 3, title: "child", state: "open", html_url: "https://x/3" })).toBeNull();
  // bad state → null
  expect(normalizeSubIssue({ ...raw, state: "merged" })).toBeNull();
  // missing title/html_url → null
  expect(normalizeSubIssue({ id: 1, number: 2, state: "open" })).toBeNull();
  expect(normalizeSubIssue(null)).toBeNull();
});

test("parseTargetRepo accepts owner/name, rejects malformed input", () => {
  expect(parseTargetRepo("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
  expect(parseTargetRepo("  acme/widgets  ")).toEqual({ owner: "acme", name: "widgets" });
  expect(parseTargetRepo("acme")).toBeNull();
  expect(parseTargetRepo("acme/widgets/extra")).toBeNull();
  expect(parseTargetRepo("acme/")).toBeNull();
  expect(parseTargetRepo("/widgets")).toBeNull();
  expect(parseTargetRepo("")).toBeNull();
  expect(parseTargetRepo("acme widgets/x")).toBeNull();
});

test("pinnedFromGraphqlMutation reads data.<field>.issue.isPinned", () => {
  expect(pinnedFromGraphqlMutation({ data: { pinIssue: { issue: { isPinned: true } } } }, "pinIssue")).toBe(true);
  expect(pinnedFromGraphqlMutation({ data: { unpinIssue: { issue: { isPinned: false } } } }, "unpinIssue")).toBe(false);
  expect(pinnedFromGraphqlMutation({ data: { pinIssue: { issue: {} } } }, "pinIssue")).toBeNull();
  expect(pinnedFromGraphqlMutation(null, "pinIssue")).toBeNull();
});

test("pinnedFromGraphqlQuery reads data.repository.issue.isPinned", () => {
  expect(pinnedFromGraphqlQuery({ data: { repository: { issue: { isPinned: true } } } })).toBe(true);
  expect(pinnedFromGraphqlQuery({ data: { repository: { issue: null } } })).toBeNull();
  expect(pinnedFromGraphqlQuery({ data: {} })).toBeNull();
});

test("targetRepoIdFromGraphql reads data.repository.id, null when repo not found", () => {
  expect(targetRepoIdFromGraphql({ data: { repository: { id: "R_kw123" } } })).toBe("R_kw123");
  // GitHub returns `repository: null` for a nonexistent/inaccessible repo
  expect(targetRepoIdFromGraphql({ data: { repository: null } })).toBeNull();
  expect(targetRepoIdFromGraphql(null)).toBeNull();
});

test("transferredIssueFromGraphql reads data.transferIssue.issue.{number,url}", () => {
  expect(transferredIssueFromGraphql({ data: { transferIssue: { issue: { number: 9, url: "https://x/9" } } } }))
    .toEqual({ number: 9, url: "https://x/9" });
  expect(transferredIssueFromGraphql({ data: { transferIssue: { issue: {} } } })).toBeNull();
  expect(transferredIssueFromGraphql(null)).toBeNull();
});

test("subIssuesApiError maps 404/410 to a feature-gated friendly message, else falls back to the message field", () => {
  expect(subIssuesApiError({ message: "Not Found" }, 404, "Not Found"))
    .toBe("Sub-issues aren't available here — the feature may not be enabled for this repository, or the issue doesn't exist.");
  expect(subIssuesApiError({ message: "Gone" }, 410, "Gone"))
    .toBe("Sub-issues aren't available here — the feature may not be enabled for this repository, or the issue doesn't exist.");
  expect(subIssuesApiError({ message: "Validation Failed" }, 422, "Unprocessable Entity")).toBe("Validation Failed");
  expect(subIssuesApiError(null, 500, "Internal Server Error")).toBe("500 Internal Server Error");
});

test("parseRateLimit reads remaining/limit/resource when all three headers are present", () => {
  const headers = new Headers({
    "x-ratelimit-remaining": "27",
    "x-ratelimit-limit": "30",
    "x-ratelimit-resource": "search",
  });
  expect(parseRateLimit(headers)).toEqual({ remaining: 27, limit: 30, resource: "search" });
});

test("parseRateLimit returns null when the headers are absent", () => {
  expect(parseRateLimit(new Headers())).toBeNull();
});

test("parseRateLimit returns null when only some of the three headers are present", () => {
  expect(parseRateLimit(new Headers({ "x-ratelimit-remaining": "27" }))).toBeNull();
  expect(parseRateLimit(new Headers({ "x-ratelimit-remaining": "27", "x-ratelimit-limit": "30" }))).toBeNull();
});

test("parseRateLimit returns null on a non-numeric remaining/limit value", () => {
  const headers = new Headers({
    "x-ratelimit-remaining": "not-a-number",
    "x-ratelimit-limit": "30",
    "x-ratelimit-resource": "core",
  });
  expect(parseRateLimit(headers)).toBeNull();
});

test("normalizeNotification maps id/unread/reason/subject/repository fields", () => {
  expect(
    normalizeNotification({
      id: "1",
      unread: true,
      reason: "mention",
      updated_at: "2026-07-01T00:00:00Z",
      subject: {
        title: "Fix the thing",
        url: "https://api.github.com/repos/o/r/issues/9",
        type: "Issue",
        latest_comment_url: "https://api.github.com/repos/o/r/issues/comments/5",
      },
      repository: { full_name: "o/r" },
    }),
  ).toEqual({
    id: "1",
    unread: true,
    reason: "mention",
    updatedAt: "2026-07-01T00:00:00Z",
    title: "Fix the thing",
    subjectType: "Issue",
    subjectUrl: "https://api.github.com/repos/o/r/issues/9",
    htmlUrl: "https://github.com/o/r/issues/9",
    latestCommentUrl: "https://api.github.com/repos/o/r/issues/comments/5",
    repo: "o/r",
  });
});

test("notificationHtmlUrl converts REST subject URLs to browsable HTML URLs", () => {
  expect(notificationHtmlUrl("https://api.github.com/repos/o/r/issues/9")).toBe("https://github.com/o/r/issues/9");
  expect(notificationHtmlUrl("https://api.github.com/repos/o/r/pulls/12")).toBe("https://github.com/o/r/pull/12");
  expect(notificationHtmlUrl("https://api.github.com/repos/o/r/commits/abc123")).toBe("https://github.com/o/r/commit/abc123");
  // unrecognized / null → null
  expect(notificationHtmlUrl(null)).toBeNull();
  expect(notificationHtmlUrl("https://example.com/x")).toBeNull();
});

test("normalizeNotification defaults missing optional fields and drops entries without id/subject", () => {
  expect(normalizeNotification({ id: "2", subject: {} })).toEqual({
    id: "2",
    unread: false,
    reason: "",
    updatedAt: "",
    title: "",
    subjectType: "",
    subjectUrl: null,
    htmlUrl: null,
    latestCommentUrl: null,
    repo: "",
  });
  expect(normalizeNotification({ unread: true, subject: { title: "x" } })).toBeNull();
  expect(normalizeNotification({ id: "3" })).toBeNull();
  expect(normalizeNotification(null)).toBeNull();
});
