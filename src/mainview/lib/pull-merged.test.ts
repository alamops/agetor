import { describe, expect, test } from "bun:test";
import { isMergedPull, mergedPullReplacement } from "./pull-merged.ts";
import type { GitHubListItem } from "../../shared/types.ts";

function item(overrides: Partial<GitHubListItem>): GitHubListItem {
  return {
    kind: "pulls",
    number: 1,
    title: "Add feature",
    state: "open",
    draft: false,
    htmlUrl: "https://github.com/o/r/pull/1",
    author: null,
    assignees: [],
    milestone: null,
    body: "",
    labels: [],
    comments: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    locked: false,
    sourcePath: null,
    ...overrides,
  };
}

describe("isMergedPull", () => {
  test("true for a pulls item with mergedAt set", () => {
    const pr = item({ kind: "pulls", mergedAt: "2026-01-02T00:00:00Z", state: "closed" });
    expect(isMergedPull(pr)).toBe(true);
  });

  test("false for a pulls item with mergedAt null (open or closed-unmerged)", () => {
    const openPr = item({ kind: "pulls", mergedAt: null, state: "open" });
    expect(isMergedPull(openPr)).toBe(false);

    const closedUnmergedPr = item({ kind: "pulls", mergedAt: null, state: "closed" });
    expect(isMergedPull(closedUnmergedPr)).toBe(false);
  });

  test("false for an issues-kind item even with mergedAt set", () => {
    const issue = item({ kind: "issues", mergedAt: "2026-01-02T00:00:00Z", state: "closed" });
    expect(isMergedPull(issue)).toBe(false);
  });

  test("false for a pulls item with mergedAt as an empty string", () => {
    const pr = item({ kind: "pulls", mergedAt: "", state: "closed" });
    expect(isMergedPull(pr)).toBe(false);
  });
});

describe("mergedPullReplacement", () => {
  test("flips state to closed", () => {
    const pr = item({ state: "open" });
    expect(mergedPullReplacement(pr).state).toBe("closed");
  });

  test("stamps mergedAt with the provided ISO when given", () => {
    const pr = item({ state: "open", mergedAt: null });
    const result = mergedPullReplacement(pr, "2026-03-04T05:06:07Z");
    expect(result.mergedAt).toBe("2026-03-04T05:06:07Z");
  });

  test("stamps mergedAt with a freshly-generated ISO when omitted", () => {
    const pr = item({ state: "open", mergedAt: null });
    const before = Date.now();
    const result = mergedPullReplacement(pr);
    const after = Date.now();

    expect(result.mergedAt).not.toBeNull();
    const parsed = new Date(result.mergedAt as string).getTime();
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  test("stamps mergedAt with a freshly-generated ISO when given an empty string", () => {
    const pr = item({ state: "open", mergedAt: null });
    expect(isMergedPull(mergedPullReplacement(pr, ""))).toBe(true);
  });

  test("preserves an existing closedAt", () => {
    const pr = item({ state: "open", closedAt: "2026-01-05T00:00:00Z" });
    const result = mergedPullReplacement(pr, "2026-03-04T05:06:07Z");
    expect(result.closedAt).toBe("2026-01-05T00:00:00Z");
  });

  test("stamps closedAt when it was null, matching the mergedAt stamp", () => {
    const pr = item({ state: "open", closedAt: null });
    const result = mergedPullReplacement(pr, "2026-03-04T05:06:07Z");
    expect(result.closedAt).toBe("2026-03-04T05:06:07Z");
  });

  test("preserves all other fields untouched", () => {
    const pr = item({
      number: 42,
      title: "Add feature",
      htmlUrl: "https://github.com/o/r/pull/42",
      labels: [{ name: "bug", color: "ff0000" }],
      sourcePath: "/repo/path",
    });
    const result = mergedPullReplacement(pr, "2026-03-04T05:06:07Z");

    expect(result.number).toBe(42);
    expect(result.title).toBe("Add feature");
    expect(result.htmlUrl).toBe("https://github.com/o/r/pull/42");
    expect(result.labels).toBe(pr.labels);
    expect(result.sourcePath).toBe("/repo/path");
  });

  test("does not mutate the input item", () => {
    const pr = item({ state: "open", closedAt: null, mergedAt: null });
    const snapshot = { ...pr };
    mergedPullReplacement(pr, "2026-03-04T05:06:07Z");
    expect(pr).toEqual(snapshot);
  });

  test("leaves an issues-kind item unchanged", () => {
    const issue = item({ kind: "issues", state: "open", closedAt: null, mergedAt: null });
    const result = mergedPullReplacement(issue, "2026-03-04T05:06:07Z");
    expect(result).toBe(issue);
    expect(result.state).toBe("open");
    expect(result.mergedAt).toBeNull();
    expect(result.closedAt).toBeNull();
  });
});
