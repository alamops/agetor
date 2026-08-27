import { expect, test, beforeAll } from "bun:test";
import { __githubInternals, getGitHubIssueThread, githubRepoFromRemoteForTest } from "./github.ts";
import { makeGitHubRepo, mockGitHubFetch } from "./github-test-util.ts";
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
  normalizeRelease,
  normalizeTag,
  normalizeCommitStatus,
  normalizeWorkflowRun,
  normalizeWorkflow,
  parseProjectsV2,
  parseProjectFields,
  parseProjectItems,
  projectsScopeErrorMessage,
  addedProjectItemIdFromGraphql,
  discussionsDisabledErrorMessage,
  parseDiscussions,
  parseDiscussionCategories,
  parseDiscussionDetail,
  createdDiscussionFromGraphql,
  addedDiscussionCommentIdFromGraphql,
  privateRepoHint,
} = __githubInternals;

const REPO = { owner: "o", name: "r", remoteHost: "github.com" };

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
  expect(githubRepoFromRemoteForTest("git@github.com:openai/codex.GIT")).toBe("openai/codex");
  expect(githubRepoFromRemoteForTest("ssh://git@github.com/openai/codex.git")).toBe("openai/codex");
});

test("githubRepoFromRemoteForTest ignores non-GitHub remotes", () => {
  expect(githubRepoFromRemoteForTest("git@gitlab.com:openai/codex.git")).toBeNull();
  expect(githubRepoFromRemoteForTest("git@gitlab-work.com:openai/codex.git")).toBeNull();
  expect(githubRepoFromRemoteForTest("/Users/me/repos/codex")).toBeNull();
  expect(githubRepoFromRemoteForTest("")).toBeNull();
});

test("githubRepoFromRemoteForTest resolves custom ssh host aliases containing github", () => {
  expect(githubRepoFromRemoteForTest("git@github-acme.com:acme/widgets.git")).toBe("acme/widgets");
  expect(githubRepoFromRemoteForTest("git@github-work:openai/codex.git")).toBe("openai/codex");
  expect(githubRepoFromRemoteForTest("github-work:openai/codex")).toBe("openai/codex");
  expect(githubRepoFromRemoteForTest("ssh://git@github-work/openai/codex.git")).toBe("openai/codex");
  expect(githubRepoFromRemoteForTest("https://github-mirror.example.com/openai/codex.git")).toBe("openai/codex");
});

test("canonicalGitHost maps alias hosts to provider hosts", () => {
  const { canonicalGitHost } = __githubInternals;
  expect(canonicalGitHost("github.com")).toBe("github.com");
  expect(canonicalGitHost("GitHub-Alamops.com")).toBe("github.com");
  expect(canonicalGitHost("gitlab-work.io")).toBe("gitlab.com");
  expect(canonicalGitHost("bitbucket-work.org")).toBe("bitbucket.org");
  expect(canonicalGitHost("git.internal.corp")).toBe("git.internal.corp");
});

test("parseGitRemote extracts host/owner/name across url syntaxes", () => {
  const { parseGitRemote } = __githubInternals;
  expect(parseGitRemote("git@bitbucket-work.org:acme/app.git")).toEqual({
    host: "bitbucket.org",
    rawHost: "bitbucket-work.org",
    owner: "acme",
    name: "app",
  });
  expect(parseGitRemote("https://gitlab.com/group/project")).toEqual({
    host: "gitlab.com",
    rawHost: "gitlab.com",
    owner: "group",
    name: "project",
  });
  expect(parseGitRemote("../relative/path")).toBeNull();
  expect(parseGitRemote("/absolute/path/repo.git")).toBeNull();
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
    state: "unknown",
    headRef: "feature",
    baseRef: "main",
    headSha: "abc123",
    autoMerge: false,
    headRepo: null,
    crossRepo: true,
  });

  // mergeable still computing → null; missing mergeable_state → "unknown"; missing head/base → empty strings
  const partial = normalizeMergeability(REPO, 8, { mergeable: null, merged: false });
  expect(partial).toMatchObject({ mergeable: null, mergeableState: "unknown", rebaseable: null, headRef: "", baseRef: "", headSha: "", autoMerge: false, headRepo: null, crossRepo: true });

  // head.repo.full_name matching the base repo → same-repo PR, not cross-repo
  const sameRepo = normalizeMergeability(REPO, 11, {
    mergeable: true,
    merged: false,
    head: { ref: "feature", sha: "abc123", repo: { full_name: "o/r" } },
    base: { ref: "main", sha: "def456" },
  });
  expect(sameRepo).toMatchObject({ headRepo: "o/r", crossRepo: false });

  // head.repo.full_name differing from the base repo → fork PR, cross-repo
  const forkRepo = normalizeMergeability(REPO, 12, {
    mergeable: true,
    merged: false,
    head: { ref: "feature", sha: "abc123", repo: { full_name: "someone-else/r" } },
    base: { ref: "main", sha: "def456" },
  });
  expect(forkRepo).toMatchObject({ headRepo: "someone-else/r", crossRepo: true });

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

test("normalizeRelease maps snake_case fields, defaults missing ones, and drops entries without id/tag_name", () => {
  expect(
    normalizeRelease({
      id: 1,
      tag_name: "v1.0.0",
      name: "First release",
      body: "Notes",
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
      created_at: "2025-12-31T00:00:00Z",
      html_url: "https://github.com/o/r/releases/tag/v1.0.0",
      target_commitish: "main",
    }),
  ).toEqual({
    id: 1,
    tagName: "v1.0.0",
    name: "First release",
    body: "Notes",
    draft: false,
    prerelease: false,
    publishedAt: "2026-01-01T00:00:00Z",
    createdAt: "2025-12-31T00:00:00Z",
    htmlUrl: "https://github.com/o/r/releases/tag/v1.0.0",
    targetCommitish: "main",
  });
  // missing optional fields default; unpublished draft → publishedAt null
  expect(normalizeRelease({ id: 2, tag_name: "v0.1.0" })).toEqual({
    id: 2,
    tagName: "v0.1.0",
    name: "",
    body: "",
    draft: false,
    prerelease: false,
    publishedAt: null,
    createdAt: "",
    htmlUrl: "",
    targetCommitish: "",
  });
  // no id / no tag_name → null
  expect(normalizeRelease({ tag_name: "v1" })).toBeNull();
  expect(normalizeRelease({ id: 3 })).toBeNull();
  expect(normalizeRelease(null)).toBeNull();
});

test("normalizeTag requires both a name and a resolvable commit sha", () => {
  expect(normalizeTag({ name: "v1.0.0", commit: { sha: "abc123" } })).toEqual({
    name: "v1.0.0",
    commitSha: "abc123",
  });
  // no commit object, or commit without a sha → null
  expect(normalizeTag({ name: "v1.0.0" })).toBeNull();
  expect(normalizeTag({ name: "v1.0.0", commit: {} })).toBeNull();
  // no name → null
  expect(normalizeTag({ commit: { sha: "abc123" } })).toBeNull();
  expect(normalizeTag(null)).toBeNull();
});

test("normalizeCommitStatus maps state/statuses, defaults total to the surviving count, and drops malformed contexts", () => {
  expect(
    normalizeCommitStatus({
      state: "success",
      total_count: 2,
      statuses: [
        { context: "ci/build", state: "success", description: "Build passed", target_url: "https://ci.example.com/1" },
        { context: "ci/lint", state: "pending", description: null, target_url: null },
      ],
    }),
  ).toEqual({
    state: "success",
    total: 2,
    statuses: [
      { context: "ci/build", state: "success", description: "Build passed", targetUrl: "https://ci.example.com/1" },
      { context: "ci/lint", state: "pending", description: null, targetUrl: null },
    ],
  });
  // no statuses at all → empty, total 0
  expect(normalizeCommitStatus({ state: "pending", total_count: 0, statuses: [] })).toEqual({
    state: "pending",
    total: 0,
    statuses: [],
  });
  // unrecognized top-level state degrades to "", not rejected outright
  expect(normalizeCommitStatus({ state: "bogus", statuses: [] })).toEqual({ state: "", total: 0, statuses: [] });
  // missing total_count falls back to the surviving (non-malformed) statuses count
  expect(
    normalizeCommitStatus({
      state: "failure",
      statuses: [{ context: "ci/build", state: "failure" }, { state: "success" }, null],
    }),
  ).toEqual({
    state: "failure",
    total: 1,
    statuses: [{ context: "ci/build", state: "failure", description: null, targetUrl: null }],
  });
  expect(normalizeCommitStatus(null)).toBeNull();
});

test("normalizeWorkflowRun maps snake_case fields, defaults missing ones, and requires a numeric id", () => {
  expect(
    normalizeWorkflowRun({
      id: 101,
      name: "CI",
      display_title: "Fix the thing",
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "main",
      run_number: 42,
      html_url: "https://github.com/o/r/actions/runs/101",
      created_at: "2026-01-01T00:00:00Z",
      workflow_id: 7,
    }),
  ).toEqual({
    id: 101,
    name: "CI",
    displayTitle: "Fix the thing",
    status: "completed",
    conclusion: "success",
    event: "push",
    headBranch: "main",
    runNumber: 42,
    htmlUrl: "https://github.com/o/r/actions/runs/101",
    createdAt: "2026-01-01T00:00:00Z",
    workflowId: 7,
  });
  // missing `name` falls back to display_title; other optional fields default
  expect(normalizeWorkflowRun({ id: 2, display_title: "Untitled run" })).toEqual({
    id: 2,
    name: "Untitled run",
    displayTitle: "Untitled run",
    status: "unknown",
    conclusion: null,
    event: "",
    headBranch: "",
    runNumber: 0,
    htmlUrl: "",
    createdAt: "",
    workflowId: 0,
  });
  // no id → null
  expect(normalizeWorkflowRun({ name: "CI" })).toBeNull();
  expect(normalizeWorkflowRun(null)).toBeNull();
});

test("normalizeWorkflow requires id/path/name and defaults an unrecognized state to empty", () => {
  expect(
    normalizeWorkflow({ id: 9, name: "CI", path: ".github/workflows/ci.yml", state: "active" }),
  ).toEqual({ id: 9, name: "CI", path: ".github/workflows/ci.yml", state: "active" });
  expect(normalizeWorkflow({ id: 9, name: "CI", path: ".github/workflows/ci.yml" })).toEqual({
    id: 9,
    name: "CI",
    path: ".github/workflows/ci.yml",
    state: "",
  });
  // missing id / path / name → null
  expect(normalizeWorkflow({ name: "CI", path: "x.yml" })).toBeNull();
  expect(normalizeWorkflow({ id: 1, name: "CI" })).toBeNull();
  expect(normalizeWorkflow({ id: 1, path: "x.yml" })).toBeNull();
  expect(normalizeWorkflow(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// Projects v2 (F21/G11)
// ---------------------------------------------------------------------------

test("parseProjectsV2 digs repository.projectsV2.nodes out of a GraphQL response, [] on anything unexpected", () => {
  const happy = {
    data: {
      repository: {
        projectsV2: {
          nodes: [
            { id: "PVT_1", number: 1, title: "Roadmap", url: "https://github.com/orgs/acme/projects/1" },
            { id: "PVT_2", number: 2, title: "Bugs", url: "https://github.com/orgs/acme/projects/2" },
          ],
        },
      },
    },
  };
  expect(parseProjectsV2(happy)).toEqual([
    { id: "PVT_1", number: 1, title: "Roadmap", url: "https://github.com/orgs/acme/projects/1" },
    { id: "PVT_2", number: 2, title: "Bugs", url: "https://github.com/orgs/acme/projects/2" },
  ]);

  // A malformed node (missing fields) is dropped, valid siblings survive.
  const partiallyMalformed = {
    data: { repository: { projectsV2: { nodes: [{ id: "PVT_1" }, { id: "PVT_2", number: 2, title: "Bugs", url: "https://x/2" }] } } },
  };
  expect(parseProjectsV2(partiallyMalformed)).toEqual([{ id: "PVT_2", number: 2, title: "Bugs", url: "https://x/2" }]);

  expect(parseProjectsV2(null)).toEqual([]);
  expect(parseProjectsV2({})).toEqual([]);
  expect(parseProjectsV2({ data: {} })).toEqual([]);
  expect(parseProjectsV2({ data: { repository: null } })).toEqual([]);
  expect(parseProjectsV2({ data: { repository: { projectsV2: { nodes: "not an array" } } } })).toEqual([]);
});

test("parseProjectFields keeps only ProjectV2SingleSelectField nodes, with their options", () => {
  const happy = {
    data: {
      node: {
        fields: {
          nodes: [
            {
              __typename: "ProjectV2SingleSelectField",
              id: "PVTSSF_status",
              name: "Status",
              options: [{ id: "opt_todo", name: "Todo" }, { id: "opt_done", name: "Done" }],
            },
            // A non-select field only carries the ProjectV2FieldCommon fragment
            // (id/name, no options) — dropped, not mapped with empty options.
            { __typename: "ProjectV2Field", id: "PVTF_priority", name: "Priority" },
            { __typename: "ProjectV2IterationField", id: "PVTIF_sprint", name: "Sprint" },
          ],
        },
      },
    },
  };
  expect(parseProjectFields(happy)).toEqual([
    { id: "PVTSSF_status", name: "Status", options: [{ id: "opt_todo", name: "Todo" }, { id: "opt_done", name: "Done" }] },
  ]);

  // A single-select field with no configured options → included, options: [].
  const noOptions = {
    data: { node: { fields: { nodes: [{ __typename: "ProjectV2SingleSelectField", id: "PVTSSF_empty", name: "Empty", options: [] }] } } },
  };
  expect(parseProjectFields(noOptions)).toEqual([{ id: "PVTSSF_empty", name: "Empty", options: [] }]);

  expect(parseProjectFields(null)).toEqual([]);
  expect(parseProjectFields({})).toEqual([]);
  expect(parseProjectFields({ data: { node: null } })).toEqual([]);
  expect(parseProjectFields({ data: { node: { fields: { nodes: "not an array" } } } })).toEqual([]);
});

test("parseProjectItems discriminates content by __typename and resolves the matching status field value", () => {
  const statusFieldId = "PVTSSF_status";
  const happy = {
    data: {
      node: {
        items: {
          nodes: [
            {
              id: "PVTI_1",
              content: { __typename: "Issue", number: 12, title: "Fix bug" },
              fieldValues: {
                nodes: [
                  { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "opt_todo", name: "Todo", field: { id: statusFieldId } },
                ],
              },
            },
            {
              id: "PVTI_2",
              content: { __typename: "PullRequest", number: 7, title: "Add feature" },
              fieldValues: { nodes: [] },
            },
            {
              id: "PVTI_3",
              content: { __typename: "DraftIssue", title: "Investigate flake" },
              fieldValues: { nodes: [] },
            },
            {
              id: "PVTI_4",
              content: { __typename: "SomethingFutureContentKind" },
              fieldValues: { nodes: [] },
            },
            {
              // A field value for a DIFFERENT field shouldn't be mistaken for Status.
              id: "PVTI_5",
              content: { __typename: "Issue", number: 20, title: "Other field set" },
              fieldValues: {
                nodes: [
                  { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "opt_x", name: "X", field: { id: "PVTSSF_other" } },
                ],
              },
            },
          ],
        },
      },
    },
  };
  expect(parseProjectItems(happy, statusFieldId)).toEqual([
    { itemId: "PVTI_1", contentType: "Issue", number: 12, title: "Fix bug", statusOptionId: "opt_todo", statusOptionName: "Todo" },
    { itemId: "PVTI_2", contentType: "PullRequest", number: 7, title: "Add feature", statusOptionId: null, statusOptionName: null },
    { itemId: "PVTI_3", contentType: "DraftIssue", number: null, title: "Investigate flake", statusOptionId: null, statusOptionName: null },
    { itemId: "PVTI_4", contentType: "other", number: null, title: "", statusOptionId: null, statusOptionName: null },
    { itemId: "PVTI_5", contentType: "Issue", number: 20, title: "Other field set", statusOptionId: null, statusOptionName: null },
  ]);

  // null statusFieldId (project has no Status field) → every item's status is null.
  expect(parseProjectItems(happy, null)[0]).toEqual({
    itemId: "PVTI_1",
    contentType: "Issue",
    number: 12,
    title: "Fix bug",
    statusOptionId: null,
    statusOptionName: null,
  });

  expect(parseProjectItems(null, statusFieldId)).toEqual([]);
  expect(parseProjectItems({}, statusFieldId)).toEqual([]);
  expect(parseProjectItems({ data: { node: null } }, statusFieldId)).toEqual([]);
  expect(parseProjectItems({ data: { node: { items: { nodes: "not an array" } } } }, statusFieldId)).toEqual([]);
  // A node missing `id` is dropped rather than crashing the whole parse.
  expect(parseProjectItems({ data: { node: { items: { nodes: [{ content: { __typename: "Issue", number: 1, title: "x" } }] } } } }, null)).toEqual([]);
});

test("projectsScopeErrorMessage prepends the required-scope hint only when the error mentions scope", () => {
  expect(projectsScopeErrorMessage("Your token has not been granted the required scopes to execute this query."))
    .toContain("`project` scope");
  expect(projectsScopeErrorMessage("Resource not accessible — token scope insufficient"))
    .toContain("`project` scope");
  // Unrelated errors pass through untouched.
  expect(projectsScopeErrorMessage("Could not resolve to a ProjectV2 with the id.")).toBe(
    "Could not resolve to a ProjectV2 with the id.",
  );
});

test("addedProjectItemIdFromGraphql digs data.addProjectV2ItemById.item.id out of the mutation response", () => {
  expect(addedProjectItemIdFromGraphql({ data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } } })).toBe("PVTI_new");
  expect(addedProjectItemIdFromGraphql(null)).toBeNull();
  expect(addedProjectItemIdFromGraphql({})).toBeNull();
  expect(addedProjectItemIdFromGraphql({ data: { addProjectV2ItemById: null } })).toBeNull();
  expect(addedProjectItemIdFromGraphql({ data: { addProjectV2ItemById: { item: {} } } })).toBeNull();
});

test("discussionsDisabledErrorMessage maps a disabled-Discussions GraphQL error to a friendly message", () => {
  expect(discussionsDisabledErrorMessage("Discussions are not enabled for this repository."))
    .toBe("Discussions aren't enabled for this repository.");
  expect(discussionsDisabledErrorMessage("Discussion comments are disabled for this repository."))
    .toBe("Discussions aren't enabled for this repository.");
  // Unrelated errors pass through untouched.
  expect(discussionsDisabledErrorMessage("Could not resolve to a Discussion with the number 9.")).toBe(
    "Could not resolve to a Discussion with the number 9.",
  );
  expect(discussionsDisabledErrorMessage("Your token has not been granted the required scopes to execute this query.")).toBe(
    "Your token has not been granted the required scopes to execute this query.",
  );
});

test("parseDiscussions digs repository.discussions.nodes out of a GraphQL response, deriving `answered`", () => {
  const happy = {
    data: {
      repository: {
        discussions: {
          nodes: [
            {
              id: "D_1",
              number: 3,
              title: "How do I configure X?",
              url: "https://github.com/o/r/discussions/3",
              createdAt: "2026-01-01T00:00:00Z",
              isAnswered: true,
              category: { name: "Q&A" },
              author: { login: "alice" },
            },
            {
              id: "D_2",
              number: 4,
              title: "Feature idea",
              url: "https://github.com/o/r/discussions/4",
              createdAt: "2026-01-02T00:00:00Z",
              isAnswered: false,
              answerChosenAt: "2026-01-03T00:00:00Z", // defensive: answered even without isAnswered
              category: { name: "Ideas" },
              author: null, // deleted account
            },
            {
              id: "D_3",
              number: 5,
              title: "Unanswered",
              url: "https://github.com/o/r/discussions/5",
              createdAt: "2026-01-04T00:00:00Z",
              isAnswered: false,
              category: { name: "Q&A" },
              author: { login: "bob" },
            },
          ],
        },
      },
    },
  };
  expect(parseDiscussions(happy)).toEqual([
    { id: "D_1", number: 3, title: "How do I configure X?", url: "https://github.com/o/r/discussions/3", category: "Q&A", author: "alice", createdAt: "2026-01-01T00:00:00Z", answered: true },
    { id: "D_2", number: 4, title: "Feature idea", url: "https://github.com/o/r/discussions/4", category: "Ideas", author: null, createdAt: "2026-01-02T00:00:00Z", answered: true },
    { id: "D_3", number: 5, title: "Unanswered", url: "https://github.com/o/r/discussions/5", category: "Q&A", author: "bob", createdAt: "2026-01-04T00:00:00Z", answered: false },
  ]);

  // A node missing id/number/title is dropped rather than crashing the whole parse.
  const partiallyMalformed = {
    data: { repository: { discussions: { nodes: [{ id: "D_1", number: 1, title: "ok" }, { number: 2, title: "no id" }] } } },
  };
  expect(parseDiscussions(partiallyMalformed)).toEqual([
    { id: "D_1", number: 1, title: "ok", url: "", category: "", author: null, createdAt: "", answered: false },
  ]);

  expect(parseDiscussions(null)).toEqual([]);
  expect(parseDiscussions({})).toEqual([]);
  expect(parseDiscussions({ data: {} })).toEqual([]);
  expect(parseDiscussions({ data: { repository: null } })).toEqual([]);
  expect(parseDiscussions({ data: { repository: { discussions: { nodes: "not an array" } } } })).toEqual([]);
});

test("parseDiscussionCategories digs repository.discussionCategories.nodes out of a GraphQL response", () => {
  const happy = {
    data: {
      repository: {
        discussionCategories: {
          nodes: [{ id: "DIC_1", name: "Q&A" }, { id: "DIC_2", name: "Ideas" }],
        },
      },
    },
  };
  expect(parseDiscussionCategories(happy)).toEqual([{ id: "DIC_1", name: "Q&A" }, { id: "DIC_2", name: "Ideas" }]);

  expect(parseDiscussionCategories({ data: { repository: { discussionCategories: { nodes: [{ id: "DIC_1" }, { name: "no id" }] } } } }))
    .toEqual([]);
  expect(parseDiscussionCategories(null)).toEqual([]);
  expect(parseDiscussionCategories({})).toEqual([]);
  expect(parseDiscussionCategories({ data: { repository: null } })).toEqual([]);
  expect(parseDiscussionCategories({ data: { repository: { discussionCategories: { nodes: "not an array" } } } })).toEqual([]);
});

test("parseDiscussionDetail digs repository.discussion out of a GraphQL response, with its comments and answerable flag", () => {
  const happy = {
    data: {
      repository: {
        discussion: {
          id: "D_1",
          title: "How do I configure X?",
          body: "Some **markdown** body.",
          category: { isAnswerable: true },
          comments: {
            nodes: [
              { id: "DC_1", body: "Try this.", createdAt: "2026-01-01T00:00:00Z", isAnswer: true, author: { login: "alice" } },
              { id: "DC_2", body: "Thanks!", createdAt: "2026-01-02T00:00:00Z", isAnswer: false, author: null },
            ],
          },
        },
      },
    },
  };
  expect(parseDiscussionDetail(happy)).toEqual({
    id: "D_1",
    title: "How do I configure X?",
    body: "Some **markdown** body.",
    answerable: true,
    comments: [
      { id: "DC_1", body: "Try this.", author: "alice", createdAt: "2026-01-01T00:00:00Z", isAnswer: true },
      { id: "DC_2", body: "Thanks!", author: null, createdAt: "2026-01-02T00:00:00Z", isAnswer: false },
    ],
  });

  // Non-answerable category (e.g. "Announcements") and no comments.
  expect(parseDiscussionDetail({
    data: { repository: { discussion: { id: "D_2", title: "Heads up", body: "", category: { isAnswerable: false }, comments: { nodes: [] } } } },
  })).toEqual({ id: "D_2", title: "Heads up", body: "", answerable: false, comments: [] });

  // A malformed comment is dropped rather than failing the whole detail.
  expect(parseDiscussionDetail({
    data: {
      repository: {
        discussion: {
          id: "D_3",
          title: "x",
          comments: { nodes: [{ id: "DC_1", body: "ok" }, { body: "no id" }] },
        },
      },
    },
  })).toEqual({
    id: "D_3",
    title: "x",
    body: "",
    answerable: false,
    comments: [{ id: "DC_1", body: "ok", author: null, createdAt: "", isAnswer: false }],
  });

  expect(parseDiscussionDetail(null)).toBeNull();
  expect(parseDiscussionDetail({})).toBeNull();
  expect(parseDiscussionDetail({ data: { repository: null } })).toBeNull();
  expect(parseDiscussionDetail({ data: { repository: { discussion: null } } })).toBeNull();
  expect(parseDiscussionDetail({ data: { repository: { discussion: { title: "no id" } } } })).toBeNull();
});

test("createdDiscussionFromGraphql digs data.createDiscussion.discussion.{number,url} out of the mutation response", () => {
  expect(createdDiscussionFromGraphql({ data: { createDiscussion: { discussion: { number: 7, url: "https://github.com/o/r/discussions/7" } } } }))
    .toEqual({ number: 7, url: "https://github.com/o/r/discussions/7" });
  expect(createdDiscussionFromGraphql(null)).toBeNull();
  expect(createdDiscussionFromGraphql({})).toBeNull();
  expect(createdDiscussionFromGraphql({ data: { createDiscussion: null } })).toBeNull();
  expect(createdDiscussionFromGraphql({ data: { createDiscussion: { discussion: {} } } })).toBeNull();
});

test("addedDiscussionCommentIdFromGraphql digs data.addDiscussionComment.comment.id out of the mutation response", () => {
  expect(addedDiscussionCommentIdFromGraphql({ data: { addDiscussionComment: { comment: { id: "DC_new" } } } })).toBe("DC_new");
  expect(addedDiscussionCommentIdFromGraphql(null)).toBeNull();
  expect(addedDiscussionCommentIdFromGraphql({})).toBeNull();
  expect(addedDiscussionCommentIdFromGraphql({ data: { addDiscussionComment: null } })).toBeNull();
  expect(addedDiscussionCommentIdFromGraphql({ data: { addDiscussionComment: { comment: {} } } })).toBeNull();
});

test("privateRepoHint on a 404 with no token points at Settings for the remote host", () => {
  const msg = privateRepoHint(404, "Not Found", REPO, false);
  expect(msg).toContain("o/r");
  expect(msg).toContain("private");
  expect(msg).toContain(REPO.remoteHost);
  expect(msg).toContain("Settings");
});

test("privateRepoHint on a 404 with a token mentions the configured token can't access it", () => {
  const msg = privateRepoHint(404, "Not Found", REPO, true);
  expect(msg).toContain("o/r");
  expect(msg).toContain(REPO.remoteHost);
  expect(msg).toContain("Settings");
  expect(msg).toContain("cannot access it");
});

test("privateRepoHint uses the repo's own remoteHost (alias), not github.com, in the Settings pointer", () => {
  const aliasRepo = { owner: "o", name: "r", remoteHost: "github-work.com" };
  const msg = privateRepoHint(404, "Not Found", aliasRepo, false);
  expect(msg).toContain("github-work.com");
});

test("privateRepoHint returns the input message unchanged for non-404 statuses", () => {
  expect(privateRepoHint(500, "Internal Server Error", REPO, false)).toBe("Internal Server Error");
  expect(privateRepoHint(403, "rate limited", REPO, true)).toBe("rate limited");
  expect(privateRepoHint(401, "bad credentials", REPO, false)).toBe("bad credentials");
});

test("parseGitRemote preserves rawHost for a github ssh host alias while canonicalizing host", () => {
  const { parseGitRemote } = __githubInternals;
  expect(parseGitRemote("git@github-work.com:o/r.git")).toEqual({
    host: "github.com",
    rawHost: "github-work.com",
    owner: "o",
    name: "r",
  });
});

// remoteHostsForDirs moved to git-provider.ts, reimplemented over
// providerRepoForDir (docs/plans/consolidate-git-host-discovery.md) — its
// test moved with it, to git-provider.test.ts.

// ---------------------------------------------------------------------------
// getGitHubIssueThread (docs/plans/new-task-from-git-issue.md, Task A) —
// network-level tests against a mocked fetch, mirroring the fetcher-level
// section of pull-detail.test.ts. Complements github-network.test.ts's own
// convention of forcing a deterministic GITHUB_TOKEN so githubToken() never
// shells out to `gh`.
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.GITHUB_TOKEN = "test-token";
});

function githubIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Something is broken",
    state: "open",
    html_url: "https://github.com/acme/widgets/issues/7",
    draft: false,
    user: { login: "octocat" },
    assignees: [],
    milestone: null,
    body: "steps to reproduce",
    labels: [],
    comments: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    locked: false,
    ...overrides,
  };
}

function githubComment(id: number): Record<string, unknown> {
  return {
    id,
    html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${id}`,
    body: `comment ${id}`,
    user: { login: "octocat" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

test("getGitHubIssueThread happy path normalizes the issue, follows Link pagination across two pages, and reports truncated:false", async () => {
  const dir = await makeGitHubRepo("acme", "widgets");
  const page1 = Array.from({ length: 100 }, (_, i) => githubComment(i + 1));
  const page2 = Array.from({ length: 50 }, (_, i) => githubComment(i + 101));
  const mock = mockGitHubFetch([
    // End-anchored so this never swallows the /comments sub-path requests
    // below (a plain substring match would, since it's their URL prefix).
    { match: /\/repos\/acme\/widgets\/issues\/7$/, json: githubIssue() },
    {
      match: "/repos/acme/widgets/issues/7/comments?per_page=100",
      json: page1,
      // Deliberately omits `per_page=100` from the next-page URL (mirroring
      // github-network.test.ts's listGitHubLabels pagination fixture) so this
      // route's own match string can't accidentally swallow the page-2 request.
      headers: { link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?page=2>; rel="next"' },
    },
    { match: "comments?page=2", json: page2 },
  ]);
  try {
    const res = await getGitHubIssueThread({ dir, number: 7 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repo).toBe("acme/widgets");
    expect(res.item.kind).toBe("issues");
    expect(res.item.number).toBe(7);
    expect(res.item.sourcePath).toBe(dir);
    expect(res.comments).toHaveLength(150);
    expect(res.comments.map((c) => c.id)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(res.truncated).toBe(false);
    // The adapter never resolves gh/glab availability itself — the facade
    // (git-host.ts's issueThread) fills refetchCommand in.
    expect(res.refetchCommand).toBeNull();
    expect(mock.calls).toHaveLength(3); // 1 issue fetch + 2 comment pages
  } finally {
    mock.restore();
  }
});

test("getGitHubIssueThread stops at the 5-page cap, fetching exactly 500 comments and reporting truncated:true", async () => {
  const dir = await makeGitHubRepo("acme", "bigthread");
  const routes: Parameters<typeof mockGitHubFetch>[0] = [
    { match: /\/repos\/acme\/bigthread\/issues\/9$/, json: githubIssue({ number: 9, html_url: "https://github.com/acme/bigthread/issues/9" }) },
    {
      match: "/repos/acme/bigthread/issues/9/comments?per_page=100",
      json: Array.from({ length: 100 }, (_, i) => githubComment(i + 1)),
      headers: { link: '<https://api.github.com/repos/acme/bigthread/issues/9/comments?page=2>; rel="next"' },
    },
    ...[2, 3, 4].map((page) => ({
      match: `comments?page=${page}`,
      json: Array.from({ length: 100 }, (_, i) => githubComment((page - 1) * 100 + i + 1)),
      headers: { link: `<https://api.github.com/repos/acme/bigthread/issues/9/comments?page=${page + 1}>; rel="next"` },
    })),
    // Page 5 is the LAST page the fetch is allowed to make
    // (ISSUE_THREAD_MAX_PAGES=5) — its own response still advertises a page 6
    // via rel="next" (a real 501+ comment thread would), which is what proves
    // truncated:true even though a 6th page is never actually requested.
    // Deliberately no route for page 6 — if the loop fetched it anyway,
    // mockGitHubFetch would throw "no route for ..." and fail this test loudly.
    {
      match: "comments?page=5",
      json: Array.from({ length: 100 }, (_, i) => githubComment(400 + i + 1)),
      headers: { link: "<https://api.github.com/repos/acme/bigthread/issues/9/comments?page=6>; rel=\"next\"" },
    },
  ];
  const mock = mockGitHubFetch(routes);
  try {
    const res = await getGitHubIssueThread({ dir, number: 9 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.comments).toHaveLength(500);
    expect(res.comments.map((c) => c.id)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(res.truncated).toBe(true);
    expect(mock.calls).toHaveLength(6); // 1 issue fetch + 5 comment pages, capped
  } finally {
    mock.restore();
  }
});

test("getGitHubIssueThread rejects a payload that carries a pull_request key, mentioning it's a pull request", async () => {
  const dir = await makeGitHubRepo("acme", "widgets2");
  const mock = mockGitHubFetch([
    {
      match: "/repos/acme/widgets2/issues/12",
      json: githubIssue({ number: 12, html_url: "https://github.com/acme/widgets2/pull/12", pull_request: { url: "x" } }),
    },
  ]);
  try {
    const res = await getGitHubIssueThread({ dir, number: 12 });
    expect(res).toEqual({ ok: false, error: "#12 is a pull request, not an issue" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("pull request");
    // Never got to the comments fetch.
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("getGitHubIssueThread maps a non-2xx GitHub response to {ok:false, error} the same plain way getGitHubPullDetail does", async () => {
  const dir = await makeGitHubRepo("acme", "widgets3");
  const mock = mockGitHubFetch([
    { match: "/repos/acme/widgets3/issues/404", status: 404, json: { message: "Not Found" } },
  ]);
  try {
    const res = await getGitHubIssueThread({ dir, number: 404 });
    expect(res).toEqual({ ok: false, error: "Not Found" });
  } finally {
    mock.restore();
  }
});

test("getGitHubIssueThread rejects a non-positive/non-integer number before any fetch", async () => {
  const dir = await makeGitHubRepo("acme", "widgets4");
  const mock = mockGitHubFetch([]); // any fetch call would throw — proves none happens

  for (const bad of [0, -1, 1.5]) {
    const res = await getGitHubIssueThread({ dir, number: bad });
    expect(res).toEqual({ ok: false, error: "issue number must be positive" });
  }
  expect(mock.calls).toHaveLength(0);
  mock.restore();
});
