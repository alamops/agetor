import { test, expect } from "bun:test";
import { shouldOfferCommitPush, type TaskGitStatus } from "./commit-push.ts";

function status(overrides: Partial<TaskGitStatus>): TaskGitStatus {
  return { hasChanges: false, ahead: 0, ignored: false, ...overrides };
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
