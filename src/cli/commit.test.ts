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
