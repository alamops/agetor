import { test, expect } from "bun:test";
import { commitNote } from "./commands/commit.ts";

test("commitNote: ignored (not a git worktree) wins over everything else", () => {
  expect(commitNote({ hasChanges: false, ignored: true })).toBe(" (not a git worktree)");
  // Even a dirty tree or a positive ahead count doesn't override ignored.
  expect(commitNote({ hasChanges: true, ignored: true })).toBe(" (not a git worktree)");
  expect(commitNote({ hasChanges: false, ahead: 3, ignored: true })).toBe(" (not a git worktree)");
});

test("commitNote: dirty tree → empty note regardless of ahead", () => {
  expect(commitNote({ hasChanges: true, ignored: false })).toBe("");
  expect(commitNote({ hasChanges: true, ahead: 0, ignored: false })).toBe("");
  expect(commitNote({ hasChanges: true, ahead: 2, ignored: false })).toBe("");
  // ignored is optional (defaults to undefined → falsy).
  expect(commitNote({ hasChanges: true })).toBe("");
});

test("commitNote: clean tree with ahead > 0 → push-only note", () => {
  expect(commitNote({ hasChanges: false, ahead: 1, ignored: false })).toBe(" (working tree clean — push only)");
  expect(commitNote({ hasChanges: false, ahead: 5 })).toBe(" (working tree clean — push only)");
});

test("commitNote: clean tree with ahead 0 or undefined → nothing to do", () => {
  expect(commitNote({ hasChanges: false, ahead: 0, ignored: false })).toBe(" (nothing to commit or push)");
  // ahead omitted defaults to 0 via `git.ahead ?? 0`.
  expect(commitNote({ hasChanges: false, ignored: false })).toBe(" (nothing to commit or push)");
  expect(commitNote({ hasChanges: false })).toBe(" (nothing to commit or push)");
});

// ── multi-repository tasks (issue #291 review S17) ──
// The top-level fields mirror only the first repository, so a dirty sibling
// used to read as "(nothing to commit or push)".

const clean = { hasChanges: false, ahead: 0, ignored: false };

test("commitNote: a dirty sibling repository means there is work, whatever the first one says", () => {
  expect(commitNote({ ...clean, repositories: [clean, { ...clean, hasChanges: true }] })).toBe("");
});

test("commitNote: every repository clean, one ahead → push-only", () => {
  expect(commitNote({ ...clean, repositories: [clean, { ...clean, ahead: 2 }] })).toBe(" (working tree clean — push only)");
});

test("commitNote: every repository clean and level → nothing to do", () => {
  expect(commitNote({ ...clean, repositories: [clean, clean] })).toBe(" (nothing to commit or push)");
});

test("commitNote: an uninspectable repository beside clean ones can't be called clean", () => {
  expect(commitNote({ ...clean, repositories: [clean, { ...clean, ignored: true }] })).toBe("");
  // ... while every repository uninspectable is the not-a-worktree note.
  expect(
    commitNote({ ...clean, ignored: true, repositories: [{ ...clean, ignored: true }, { ...clean, ignored: true }] }),
  ).toBe(" (not a git worktree)");
  // The first repository unreadable no longer hides a dirty sibling.
  expect(commitNote({ ...clean, ignored: true, repositories: [{ ...clean, ignored: true }, { ...clean, hasChanges: true }] })).toBe("");
});

test("commitNote: a one-repository per-repo array still decides (round 15, multi task left with one repository)", () => {
  // The top-level mirror says dirty, but the per-repository answer is
  // authoritative for a multi task, whatever its count.
  expect(commitNote({ hasChanges: true, repositories: [{ ...clean, ahead: 1 }] })).toBe(" (working tree clean — push only)");
});
