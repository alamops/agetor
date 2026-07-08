import { expect, test } from "bun:test";
import { __githubInternals, githubRepoFromRemoteForTest } from "./github.ts";
import type { GitHubListItem } from "../shared/types.ts";

const {
  matchesFilters,
  normalizeLineComment,
  normalizeCheckRun,
  reviewValidationError,
  buildIssueUpdatePatch,
  normalizeMergeability,
  draftFromGraphql,
  graphqlErrorMessage,
  sanitizeReviewComments,
  commentUrl,
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
  });

  // mergeable still computing → null; missing mergeable_state → "unknown"; missing head/base → empty strings
  const partial = normalizeMergeability(REPO, 8, { mergeable: null, merged: false });
  expect(partial).toMatchObject({ mergeable: null, mergeableState: "unknown", rebaseable: null, headRef: "", baseRef: "", headSha: "" });

  expect(normalizeMergeability(REPO, 9, null)).toBeNull();
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

test("commentUrl maps kind to the right endpoint segment", () => {
  expect(commentUrl(REPO, "issue", 42)).toBe("https://api.github.com/repos/o/r/issues/comments/42");
  expect(commentUrl(REPO, "review", 42)).toBe("https://api.github.com/repos/o/r/pulls/comments/42");
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
