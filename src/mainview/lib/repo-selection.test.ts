import { describe, expect, test } from "bun:test";
import {
  MANY_REPOSITORIES,
  dedupeSelections,
  issueProjectPath,
  projectDisplayName,
  projectRowLabels,
  projectSelectionLabel,
  repositoryFileScopes,
  selectionName,
  selectionNames,
  taskProjectPath,
  tooManyRepositories,
  updateSelectionBaseRef,
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

describe("project selection label", () => {
  test("zero selection prompts, one shows the project's name, 2+ shows the count", () => {
    expect(projectSelectionLabel([])).toBe("Select projects…");
    expect(projectSelectionLabel([{ path: "/repos/frontend", root: "/repos/frontend" }])).toBe("frontend");
    expect(
      projectSelectionLabel([
        { path: "/repos/frontend", root: "/repos/frontend" },
        { path: "/repos/backend", root: "/repos/backend" },
      ]),
    ).toBe("2 projects selected");
  });

  test("the count is post-dedupe: subdirectories of one repository read as one project", () => {
    expect(
      projectSelectionLabel([
        { path: "/repo/packages/a", root: "/repo" },
        { path: "/repo/packages/b", root: "/repo" },
      ]),
    ).toBe("a");
  });

  test("the count grows with every distinct project (3+ reads as a count)", () => {
    expect(
      projectSelectionLabel([
        { path: "/r/a", root: "/r/a" },
        { path: "/r/b", root: "/r/b" },
        { path: "/r/c", root: "/r/c" },
      ]),
    ).toBe("3 projects selected");
  });

  test("unknown roots are never silently collapsed", () => {
    expect(
      projectSelectionLabel([
        { path: "/a", root: null },
        { path: "/b", root: null },
      ]),
    ).toBe("2 projects selected");
  });
});

describe("projectRowLabels", () => {
  test("uses the raw basename, appending the full path only on a collision", () => {
    expect(projectRowLabels(["/x/App One", "/y/Backend"])).toEqual(["App One", "Backend"]);
    expect(projectRowLabels(["/a/api", "/b/api", "/c/db"])).toEqual([
      "api — /a/api",
      "api — /b/api",
      "db",
    ]);
  });

  test("a trailing slash does not produce an empty name", () => {
    expect(projectDisplayName("/repos/frontend/")).toBe("frontend");
    expect(projectDisplayName("")).toBe("");
  });
});

describe("updateSelectionBaseRef", () => {
  const entries = [
    { path: "/fe", root: "/fe", baseRef: "main" },
    { path: "/be", root: "/be" },
  ];

  test("replaces only the target entry and preserves order, roots and other refs", () => {
    expect(updateSelectionBaseRef(entries, "/be", "release/1.2")).toEqual([
      { path: "/fe", root: "/fe", baseRef: "main" },
      { path: "/be", root: "/be", baseRef: "release/1.2" },
    ]);
    // The input is not mutated.
    expect(entries[1]).toEqual({ path: "/be", root: "/be" });
  });

  test("a blank ref drops the key instead of storing an empty string", () => {
    expect(updateSelectionBaseRef(entries, "/fe", "  ")).toEqual([
      { path: "/fe", root: "/fe" },
      { path: "/be", root: "/be" },
    ]);
  });

  test("an unknown path is a no-op", () => {
    expect(updateSelectionBaseRef(entries, "/gone", "dev")).toEqual(entries);
  });
});

describe("multi task left with one repository (round 15)", () => {
  // The workspace root is never a git repository, whatever the count.
  const task = {
    workdir: "/data/worktrees/t1",
    multiRepo: true,
    issueRepoPath: null,
    repositories: [{ path: "/repos/backend" }],
  };
  test("taskProjectPath answers its remaining repository, not the workspace root", () => {
    expect(taskProjectPath(task)).toBe("/repos/backend");
  });
  test("issueProjectPath falls back to the remaining repository", () => {
    expect(issueProjectPath(task)).toBe("/repos/backend");
  });
  test("a single task's derived entry still answers its workdir", () => {
    expect(taskProjectPath({ workdir: "/repo", multiRepo: false, repositories: [{ path: "/other" }] })).toBe("/repo");
  });
});
