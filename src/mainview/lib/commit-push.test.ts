import { test, expect } from "bun:test";
import { prHeadBranch, shouldOfferCommitPush, shouldOfferOpenPr, type TaskGitStatus } from "./commit-push.ts";

function status(overrides: Partial<TaskGitStatus>): TaskGitStatus {
  return {
    hasChanges: false, ahead: 0, ignored: false, hasUpstream: false, remoteSynced: false,
    branch: null, isDefaultBranch: false,
    ...overrides,
  };
}

test("shouldOfferCommitPush: null status → false", () => {
  expect(shouldOfferCommitPush(null)).toBe(false);
});

test("shouldOfferCommitPush: ignored wins even with hasChanges/ahead", () => {
  expect(shouldOfferCommitPush(status({ ignored: true, hasChanges: true, ahead: 3 }))).toBe(false);
  expect(shouldOfferCommitPush(status({ ignored: true }))).toBe(false);
});

test("shouldOfferCommitPush: hasChanges alone offers the chip", () => {
  expect(shouldOfferCommitPush(status({ hasChanges: true, ahead: 0 }))).toBe(true);
});

test("shouldOfferCommitPush: ahead alone (clean tree) offers the chip", () => {
  expect(shouldOfferCommitPush(status({ hasChanges: false, ahead: 1 }))).toBe(true);
});

test("shouldOfferCommitPush: both hasChanges and ahead offer the chip", () => {
  expect(shouldOfferCommitPush(status({ hasChanges: true, ahead: 2 }))).toBe(true);
});

test("shouldOfferCommitPush: clean tree and nothing ahead → false", () => {
  expect(shouldOfferCommitPush(status({ hasChanges: false, ahead: 0 }))).toBe(false);
});

test("shouldOfferOpenPr: null status → false", () => {
  expect(shouldOfferOpenPr(null)).toBe(false);
});

test("shouldOfferOpenPr: ignored → false even with remoteSynced true", () => {
  expect(shouldOfferOpenPr(status({ ignored: true, remoteSynced: true }))).toBe(false);
});

test("shouldOfferOpenPr: remoteSynced true (and not ignored) → true", () => {
  expect(shouldOfferOpenPr(status({ remoteSynced: true }))).toBe(true);
});

test("shouldOfferOpenPr: remoteSynced false → false", () => {
  expect(shouldOfferOpenPr(status({ remoteSynced: false }))).toBe(false);
});

test("shouldOfferOpenPr: default status (nothing pushed yet) → false", () => {
  expect(shouldOfferOpenPr(status({}))).toBe(false);
});

// ── prHeadBranch ─────────────────────────────────────────────────────────
// The regression this exists for: an `isolation: "none"` task has a NULL
// `task.branch` even when its workdir sits on a real pushed feature branch,
// so gating the "Create PR" chip on `task.branch != null` hid it entirely.

test("prHeadBranch: worktree branch wins verbatim, ignoring live git state", () => {
  expect(prHeadBranch("agetor/abc123-thing", status({ branch: "main", isDefaultBranch: true })))
    .toBe("agetor/abc123-thing");
  // Even with no status polled in yet — the managed branch is authoritative.
  expect(prHeadBranch("agetor/abc123-thing", null)).toBe("agetor/abc123-thing");
});

test("prHeadBranch: isolation:none on a non-default branch falls back to live HEAD", () => {
  expect(prHeadBranch(null, status({ branch: "feat/thing", isDefaultBranch: false })))
    .toBe("feat/thing");
});

test("prHeadBranch: isolation:none on the default branch → null (base == head)", () => {
  expect(prHeadBranch(null, status({ branch: "main", isDefaultBranch: true }))).toBeNull();
});

test("prHeadBranch: no status, ignored dir, or detached HEAD → null", () => {
  expect(prHeadBranch(null, null)).toBeNull();
  expect(prHeadBranch(null, status({ ignored: true, branch: "feat/thing" }))).toBeNull();
  expect(prHeadBranch(null, status({ branch: null }))).toBeNull();
});

test("prHeadBranch: empty-string task branch is treated as absent, not as a head", () => {
  expect(prHeadBranch("", status({ branch: "feat/thing" }))).toBe("feat/thing");
});

test("shouldOfferOpenPr: hasChanges/ahead never affect the result either way", () => {
  expect(
    shouldOfferOpenPr(status({ remoteSynced: true, hasChanges: true, ahead: 5 })),
  ).toBe(true);
  expect(
    shouldOfferOpenPr(status({ remoteSynced: false, hasChanges: false, ahead: 0 })),
  ).toBe(false);
  expect(
    shouldOfferOpenPr(status({ remoteSynced: true, hasChanges: false, ahead: 0 })),
  ).toBe(true);
});
