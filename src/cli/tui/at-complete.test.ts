import { test, expect } from "bun:test";
import { buildFileEntries } from "../../shared/at-file-filter.ts";
import type { Task } from "../../shared/types.ts";
import { acceptSuggestion, fileScopeForTask, suggestAtEntries } from "./at-complete.ts";

// ── fileScopeForTask ─────────────────────────────────────────────────────

type ScopeTask = Pick<Task, "workdir" | "worktreePath" | "isolation" | "baseRef" | "branchSource" | "branch">;

function scopeTask(over: Partial<ScopeTask>): ScopeTask {
  return {
    workdir: "/repo",
    worktreePath: null,
    isolation: "none",
    baseRef: null,
    branchSource: "created",
    branch: null,
    ...over,
  };
}

test("fileScopeForTask: a materialized worktree wins over everything else", () => {
  expect(
    fileScopeForTask(
      scopeTask({ worktreePath: "/wt/abc", isolation: "worktree", baseRef: "main", branch: "agetor/x" }),
    ),
  ).toEqual({ dir: "/wt/abc" });
});

test("fileScopeForTask: isolated task with no worktree yet uses workdir @ baseRef", () => {
  expect(fileScopeForTask(scopeTask({ isolation: "worktree", baseRef: "main" }))).toEqual({
    dir: "/repo",
    ref: "main",
  });
});

test("fileScopeForTask: isolated task with no baseRef falls back to HEAD", () => {
  expect(fileScopeForTask(scopeTask({ isolation: "worktree", baseRef: null }))).toEqual({
    dir: "/repo",
    ref: "HEAD",
  });
});

test("fileScopeForTask: existing-branch task (e.g. a PR head) uses the branch, not baseRef", () => {
  expect(
    fileScopeForTask(
      scopeTask({
        isolation: "worktree",
        branchSource: "existing",
        branch: "feature/pr-head",
        baseRef: "main",
      }),
    ),
  ).toEqual({ dir: "/repo", ref: "feature/pr-head" });
});

test("fileScopeForTask: existing branchSource but no branch string falls back to baseRef", () => {
  expect(
    fileScopeForTask(scopeTask({ isolation: "worktree", branchSource: "existing", branch: null, baseRef: "main" })),
  ).toEqual({ dir: "/repo", ref: "main" });
});

test("fileScopeForTask: isolation off is just the plain workdir, no ref", () => {
  expect(fileScopeForTask(scopeTask({ isolation: "none", baseRef: "main" }))).toEqual({ dir: "/repo" });
});

// ── suggestAtEntries ─────────────────────────────────────────────────────

const entries = buildFileEntries([
  "README.md",
  "src/bun/db.ts",
  "src/bun/server.ts",
  "src/mainview/app.tsx",
  "docs/my notes.md",
]);

test("suggestAtEntries: no @ in the text returns null", () => {
  expect(suggestAtEntries(entries, "hello world")).toBeNull();
});

test("suggestAtEntries: a bare @ with no query yet suggests the root listing", () => {
  const result = suggestAtEntries(entries, "look at @");
  expect(result).not.toBeNull();
  expect(result!.slice).toEqual({ start: 8, end: 9, query: "" });
  expect(result!.entries.length).toBeGreaterThan(0);
});

test("suggestAtEntries: @sr narrows to src-prefixed matches", () => {
  const result = suggestAtEntries(entries, "check @sr");
  expect(result).not.toBeNull();
  expect(result!.slice.query).toBe("sr");
  expect(result!.entries.some((e) => e.path.startsWith("src"))).toBe(true);
});

test("suggestAtEntries: caps at 5 suggestions even with a broad match", () => {
  const many = buildFileEntries(Array.from({ length: 20 }, (_, i) => `file${i}.ts`));
  const result = suggestAtEntries(many, "@file");
  expect(result!.entries.length).toBe(5);
});

test("suggestAtEntries: a finished token (whitespace after it) has no active query", () => {
  expect(suggestAtEntries(entries, "@README.md done")).toBeNull();
});

test("suggestAtEntries: a quoted in-progress token is active", () => {
  const result = suggestAtEntries(entries, 'open @"docs/my ');
  expect(result).not.toBeNull();
  expect(result!.slice.query).toBe("docs/my ");
});

// ── acceptSuggestion ─────────────────────────────────────────────────────

test("acceptSuggestion: a file commits and closes with a trailing space", () => {
  const text = "please read @READ";
  const slice = { start: 12 }; // index of "@"
  const next = acceptSuggestion(text, slice, { path: "README.md", isDirectory: false });
  expect(next).toBe("please read @README.md ");
});

test("acceptSuggestion: a directory descends and keeps the query alive (no trailing space)", () => {
  const text = "check @sr";
  const slice = { start: 6 };
  const next = acceptSuggestion(text, slice, { path: "src/", isDirectory: true });
  expect(next).toBe("check @src/");
  // The rewritten text must still carry an active (unfinished) @-query so a
  // follow-up keystroke keeps narrowing.
  expect(suggestAtEntries(entries, next)).not.toBeNull();
});

test("acceptSuggestion: descending into a spaced directory opens a quoted-in-progress token", () => {
  const text = "look in @doc";
  const slice = { start: 8 };
  const next = acceptSuggestion(text, slice, { path: "docs/my dir/", isDirectory: true });
  expect(next).toBe('look in @"docs/my dir/');
  // No closing quote yet — the quoted-form active-query scan still succeeds.
  const result = suggestAtEntries(entries, next);
  expect(result).not.toBeNull();
  expect(result!.slice.query).toBe("docs/my dir/");
});

test("acceptSuggestion: descending twice never piles up trailing slashes", () => {
  const once = acceptSuggestion("@sr", { start: 0 }, { path: "src/", isDirectory: true });
  expect(once).toBe("@src/");
  const twice = acceptSuggestion(once, { start: 0 }, { path: "src/bun/", isDirectory: true });
  expect(twice).toBe("@src/bun/");
});
