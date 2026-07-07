import { expect, test } from "bun:test";
import { __githubInternals, githubRepoFromRemoteForTest } from "./github.ts";
import type { GitHubListItem } from "../shared/types.ts";

const { matchesFilters, normalizeLineComment, normalizeCheckRun } = __githubInternals;

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
