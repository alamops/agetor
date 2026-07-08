import { test, expect } from "bun:test";
import { commitNote } from "./commands/commit.ts";

test("commitNote annotates clean / non-git worktrees and stays empty when dirty", () => {
  // Normal case: uncommitted changes present → no note.
  expect(commitNote({ hasChanges: true, ignored: false })).toBe("");
  // Clean tree → the agent will only push.
  expect(commitNote({ hasChanges: false, ignored: false })).toBe(" (working tree clean — push only)");
  // Not a git repo → ignored wins.
  expect(commitNote({ hasChanges: false, ignored: true })).toBe(" (not a git worktree)");
  expect(commitNote({ hasChanges: true, ignored: true })).toBe(" (not a git worktree)");
  // ignored is optional (defaults to undefined → falsy).
  expect(commitNote({ hasChanges: true })).toBe("");
  expect(commitNote({ hasChanges: false })).toBe(" (working tree clean — push only)");
});
