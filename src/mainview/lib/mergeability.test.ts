import { expect, test } from "bun:test";
import { mergeabilityView } from "./mergeability.ts";
import type { GitHubPullMergeability } from "../../shared/types.ts";

function m(overrides: Partial<GitHubPullMergeability>): GitHubPullMergeability {
  return {
    repo: "o/r",
    pullNumber: 1,
    mergeable: true,
    mergeableState: "clean",
    rebaseable: true,
    merged: false,
    draft: false,
    headRef: "feature",
    baseRef: "main",
    headSha: "abc",
    autoMerge: false,
    headRepo: "o/r",
    crossRepo: false,
    ...overrides,
  };
}

test("clean/has_hooks are mergeable with no update-branch", () => {
  expect(mergeabilityView(m({ mergeableState: "clean" }))).toMatchObject({ canMerge: true, showUpdateBranch: false, tone: "ok" });
  expect(mergeabilityView(m({ mergeableState: "has_hooks" }))).toMatchObject({ canMerge: true, showUpdateBranch: false });
});

test("unstable is still mergeable (checks pending/failing but no conflict)", () => {
  expect(mergeabilityView(m({ mergeableState: "unstable" }))).toMatchObject({ canMerge: true, showUpdateBranch: false, tone: "warn" });
});

test("behind offers Update branch and stays mergeable when mergeable is true", () => {
  expect(mergeabilityView(m({ mergeableState: "behind", mergeable: true })))
    .toMatchObject({ canMerge: true, showUpdateBranch: true, tone: "warn" });
});

test("dirty, blocked, and draft all block the merge button", () => {
  expect(mergeabilityView(m({ mergeableState: "dirty" }))).toMatchObject({ canMerge: false, showUpdateBranch: false, tone: "bad" });
  expect(mergeabilityView(m({ mergeableState: "blocked" }))).toMatchObject({ canMerge: false, showUpdateBranch: false, tone: "bad" });
  expect(mergeabilityView(m({ mergeableState: "draft" }))).toMatchObject({ canMerge: false, showUpdateBranch: false, tone: "muted" });
});

test("mergeable === null (still computing) blocks merge; offers Update branch only when behind", () => {
  expect(mergeabilityView(m({ mergeable: null, mergeableState: "unknown" })))
    .toMatchObject({ canMerge: false, showUpdateBranch: false, tone: "muted" });
  expect(mergeabilityView(m({ mergeable: null, mergeableState: "behind" })))
    .toMatchObject({ canMerge: false, showUpdateBranch: true });
});

test("an unknown state falls back to the computed mergeable flag", () => {
  expect(mergeabilityView(m({ mergeableState: "some_new_state", mergeable: true })))
    .toMatchObject({ canMerge: true, showUpdateBranch: false, tone: "muted" });
  expect(mergeabilityView(m({ mergeableState: "some_new_state", mergeable: false })))
    .toMatchObject({ canMerge: false });
});
