import { describe, expect, test } from "bun:test";
import {
  MANY_REPOSITORIES,
  collapseToProject,
  dedupeSelections,
  issueProjectPath,
  pinPrimaryRepository,
  repositoryFileScopes,
  selectionName,
  selectionNames,
  taskProjectPath,
  tooManyRepositories,
} from "./repo-selection.ts";

describe("dedupeSelections", () => {
  test("keeps the first entry per git root", () => {
    expect(
      dedupeSelections([
        { path: "/repo/packages/a", root: "/repo" },
        { path: "/repo/packages/b", root: "/repo" },
        { path: "/other", root: "/other" },
      ]).map((e) => e.path),
    ).toEqual(["/repo/packages/a", "/other"]);
  });

  test("keeps every entry whose root is unknown", () => {
    expect(
      dedupeSelections([
        { path: "/a", root: null },
        { path: "/b", root: null },
        { path: "/c", root: "/c" },
      ]).map((e) => e.path),
    ).toEqual(["/a", "/b", "/c"]);
  });

  test("preserves order and does not mutate the input", () => {
    const input = [
      { path: "/b", root: "/b" },
      { path: "/a", root: "/a" },
    ];
    expect(dedupeSelections(input).map((e) => e.path)).toEqual(["/b", "/a"]);
    expect(input.map((e) => e.path)).toEqual(["/b", "/a"]);
  });
});

describe("selection names", () => {
  test("uses sanitized basenames, uniquified on collision", () => {
    expect(selectionNames([{ path: "/x/App One" }, { path: "/y/app-one" }])).toEqual(["app-one", "app-one-2"]);
  });
  test("selectionName is the unsuffixed basename", () => {
    expect(selectionName({ path: "/x/Backend" })).toBe("backend");
  });
});

describe("warning threshold", () => {
  test("warns only above the documented limit", () => {
    expect(tooManyRepositories(MANY_REPOSITORIES)).toBe(false);
    expect(tooManyRepositories(MANY_REPOSITORIES + 1)).toBe(true);
  });
});

describe("repositoryFileScopes", () => {
  test("one named scope per repository, pinned at base when isolated", () => {
    const repos = [
      { path: "/src/frontend", baseRef: "abc123" },
      { path: "/src/backend", baseRef: "" },
    ];
    expect(repositoryFileScopes(repos, true)).toEqual([
      { name: "frontend", dir: "/src/frontend", ref: "abc123" },
      { name: "backend", dir: "/src/backend", ref: "HEAD" },
    ]);
    expect(repositoryFileScopes(repos, false)).toEqual([
      { name: "frontend", dir: "/src/frontend", ref: null },
      { name: "backend", dir: "/src/backend", ref: null },
    ]);
  });

  test("colliding basenames get the same unique suffixes the workspace uses", () => {
    expect(repositoryFileScopes([
      { path: "/a/api" },
      { path: "/b/api" },
    ], true)).toEqual([
      { name: "api", dir: "/a/api", ref: "HEAD" },
      { name: "api-2", dir: "/b/api", ref: "HEAD" },
    ]);
  });
});

describe("taskProjectPath", () => {
  test("single-repository tasks keep the task workdir", () => {
    expect(taskProjectPath({ workdir: "/repo", repositories: [{ path: "/repo" }] })).toBe("/repo");
    expect(taskProjectPath({ workdir: "/repo" })).toBe("/repo");
  });

  test("multi tasks use the first repository, never the workspace root", () => {
    expect(taskProjectPath({
      workdir: "/data/worktrees/t1",
      repositories: [{ path: "/repos/frontend" }, { path: "/repos/backend" }],
    })).toBe("/repos/frontend");
  });
});

describe("issueProjectPath", () => {
  test("single-repository tasks keep the task workdir", () => {
    expect(issueProjectPath({ workdir: "/repo", repositories: [{ path: "/repo" }] })).toBe("/repo");
    expect(issueProjectPath({ workdir: "/repo" })).toBe("/repo");
  });

  test("multi tasks use the issue's repository, never the workspace root", () => {
    const task = {
      workdir: "/data/worktrees/t1",
      issueRepoPath: "/repos/backend",
      repositories: [{ path: "/repos/frontend" }, { path: "/repos/backend" }],
    };
    expect(issueProjectPath(task)).toBe("/repos/backend");
    // The selected tab is irrelevant when the issue repo is recorded.
    expect(issueProjectPath(task, { path: "/repos/frontend" })).toBe("/repos/backend");
  });

  test("falls back to the selected tab, then the first repository, for a row without issueRepoPath", () => {
    const task = {
      workdir: "/data/worktrees/t1",
      repositories: [{ path: "/repos/frontend" }, { path: "/repos/backend" }],
    };
    expect(issueProjectPath(task, { path: "/repos/backend" })).toBe("/repos/backend");
    // The workspace root is not a git repository, so it must never be the
    // fallback for a multi task (the issue-thread fetch would 400).
    expect(issueProjectPath(task)).toBe("/repos/frontend");
  });
});

describe("collapseToProject", () => {
  test("collapses a selection to the chosen project", () => {
    const prev = [
      { path: "/a", root: "/a" },
      { path: "/b", root: "/b" },
    ];
    expect(collapseToProject("/b", prev)).toEqual([{ path: "/b", root: "/b" }]);
    expect(collapseToProject("/c", prev)).toEqual([{ path: "/c", root: null }]);
    expect(collapseToProject("", prev)).toEqual([]);
  });
});

describe("pinPrimaryRepository", () => {
  test("keeps the fixed primary first and appends the dialog's extras", () => {
    expect(pinPrimaryRepository("/repos/issue", [
      { path: "/repos/issue", root: "/repos/issue" },
      { path: "/repos/api", root: "/repos/api" },
    ])).toEqual([
      { path: "/repos/issue", root: "/repos/issue" },
      { path: "/repos/api", root: "/repos/api" },
    ]);
  });

  test("preserves a base ref chosen for the primary in the dialog round", () => {
    // Review S1: rebuilding the issue entry from only its path silently
    // dropped the user's pinned base, so the issue's repo always used HEAD.
    const next = [
      { path: "/repos/issue", root: "/repos/issue", baseRef: "release/1.2" },
      { path: "/repos/api", root: "/repos/api", baseRef: "main" },
    ];
    expect(pinPrimaryRepository("/repos/issue", next, [])).toEqual([
      { path: "/repos/issue", root: "/repos/issue", baseRef: "release/1.2" },
      { path: "/repos/api", root: "/repos/api", baseRef: "main" },
    ]);
  });

  test("falls back to the previously stored base ref when the dialog omits it", () => {
    const previous = [{ path: "/repos/issue", root: "/repos/issue", baseRef: "develop" }];
    expect(pinPrimaryRepository("/repos/issue", [{ path: "/repos/api", root: "/repos/api" }], previous)).toEqual([
      { path: "/repos/issue", root: "/repos/issue", baseRef: "develop" },
      { path: "/repos/api", root: "/repos/api" },
    ]);
  });

  test("never duplicates the primary when the dialog also returns it", () => {
    const out = pinPrimaryRepository("/repos/issue", [
      { path: "/repos/api", root: "/repos/api" },
      { path: "/repos/issue", root: "/repos/issue" },
    ]);
    expect(out.map((e) => e.path)).toEqual(["/repos/issue", "/repos/api"]);
  });

  test("collapses a same-root sibling added while the primary was selected", () => {
    // Review S2: the issue dialog let its fixed primary be unchecked, then
    // re-added it without the dialog's git-root dedupe — a subdirectory of the
    // issue repo made the client show two repositories while the server
    // deduped to one and created a single-repository task.
    const out = pinPrimaryRepository("/repos/issue", [
      { path: "/repos/issue", root: "/repos/issue" },
      { path: "/repos/issue/packages/app", root: "/repos/issue" },
      { path: "/repos/api", root: "/repos/api" },
    ]);
    expect(out.map((e) => e.path)).toEqual(["/repos/issue", "/repos/api"]);
  });
});
