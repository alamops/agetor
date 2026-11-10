import { describe, expect, test } from "bun:test";
import {
  formatRepositoriesPrompt,
  isMultiRepoTask,
  repoNameForPath,
  repoNameForSelection,
  repositoriesForTask,
  repositoryAtPath,
  uniqueRepoSlugs,
} from "./multi-repo.ts";
import { commitPushPrompt, type Task, type TaskRepository } from "./types.ts";

const repo = (over: Partial<TaskRepository>): TaskRepository => ({
  path: "/repos/app",
  name: "app",
  branch: "feature/auth",
  branchSource: "created",
  worktreePath: "/data/worktrees/t1/app",
  baseRef: "abc123",
  checkoutBranch: "feature/auth",
  prUrl: null,
  ...over,
});

const task = (over: Partial<Task>): Task =>
  ({
    id: "t1",
    title: "Do the thing",
    prompt: "p",
    column: "backlog",
    agent: "claude-code",
    workdir: "/repos/app",
    isolation: "worktree",
    taskType: "task",
    branch: "feature/auth",
    branchSource: "created",
    worktreePath: "/data/worktrees/t1",
    baseRef: "abc123",
    prUrl: null,
    ...over,
  }) as Task;

describe("repoNameForPath", () => {
  test("sanitizes a basename and lowercases it", () => {
    expect(repoNameForPath("/Users/me/My App!")).toBe("my-app");
    expect(repoNameForPath("/Users/me/api.v2")).toBe("api.v2");
  });

  test("trims trailing slashes", () => {
    expect(repoNameForPath("/Users/me/frontend/")).toBe("frontend");
  });

  test("falls back to repo for an unusable basename", () => {
    expect(repoNameForPath("/")).toBe("repo");
    expect(repoNameForPath("///")).toBe("repo");
    expect(repoNameForPath("/tmp/---")).toBe("repo");
  });

  test("caps a long name at 40 chars", () => {
    expect(repoNameForPath(`/${"a".repeat(80)}`).length).toBe(40);
  });
});

describe("uniqueRepoSlugs", () => {
  test("keeps distinct basenames in input order", () => {
    expect(uniqueRepoSlugs(["/a/frontend", "/b/backend", "/c/infra"])).toEqual([
      "frontend",
      "backend",
      "infra",
    ]);
  });

  test("uniquifies duplicate basenames deterministically", () => {
    expect(uniqueRepoSlugs(["/a/app", "/b/app", "/c/app"])).toEqual(["app", "app-2", "app-3"]);
  });

  test("does not re-use a suffixed name that a later path already owns", () => {
    expect(uniqueRepoSlugs(["/a/app", "/b/app-2", "/c/app"])).toEqual(["app", "app-2", "app-3"]);
  });

  test("is deterministic across runs", () => {
    const input = ["/x/one", "/y/one"];
    expect(uniqueRepoSlugs(input)).toEqual(uniqueRepoSlugs(input));
  });

  test("empty input returns an empty list", () => {
    expect(uniqueRepoSlugs([])).toEqual([]);
  });
});

describe("repositoriesForTask", () => {
  test("multi-repo rows return their stored array verbatim", () => {
    const repos = [repo({ name: "frontend" }), repo({ name: "backend" })];
    expect(repositoriesForTask(task({ repositories: repos })).map((r) => r.name)).toEqual([
      "frontend",
      "backend",
    ]);
  });

  test("single-repo rows derive exactly one entry from the scalars", () => {
    const derived = repositoriesForTask(task({ repositories: [] }));
    expect(derived).toHaveLength(1);
    expect(derived[0]).toEqual({
      path: "/repos/app",
      name: "app",
      branch: "feature/auth",
      branchSource: "created",
      worktreePath: "/data/worktrees/t1",
      baseRef: "abc123",
      checkoutBranch: null,
      prUrl: null,
    });
  });

  test("a one-entry stored array is treated as single-repo", () => {
    const derived = repositoriesForTask(
      task({ repositories: [repo({ path: "/other", name: "other" })] }),
    );
    expect(derived).toHaveLength(1);
    expect(derived[0]!.path).toBe("/repos/app");
  });
});

describe("isMultiRepoTask", () => {
  test("false for undefined, empty and one entry", () => {
    expect(isMultiRepoTask({ repositories: undefined })).toBe(false);
    expect(isMultiRepoTask({ repositories: [] })).toBe(false);
    expect(isMultiRepoTask({ repositories: [repo({})] })).toBe(false);
  });

  test("true for two or more", () => {
    expect(isMultiRepoTask({ repositories: [repo({}), repo({ name: "b" })] })).toBe(true);
  });
});

describe("formatRepositoriesPrompt", () => {
  test("exact block format", () => {
    expect(
      formatRepositoriesPrompt([
        { name: "frontend", path: "/src/frontend", worktreePath: "/wt/t1/frontend", branch: "feature/auth" },
        { name: "backend", path: "/src/backend", worktreePath: null, branch: null },
      ]),
    ).toBe(
      [
        "Repositories:",
        "- frontend: /wt/t1/frontend (branch feature/auth)",
        "- backend: /src/backend (branch none yet)",
      ].join("\n"),
    );
  });

  test("no repos still renders the header", () => {
    expect(formatRepositoriesPrompt([])).toBe("Repositories:");
  });
});

describe("repositoryAtPath / repoNameForSelection", () => {
  test("finds an entry by selected path", () => {
    const repos = [repo({ path: "/a/frontend", name: "frontend" }), repo({ path: "/b/backend", name: "backend" })];
    const t = task({ repositories: repos });
    expect(repositoryAtPath(t, "/b/backend")?.name).toBe("backend");
    expect(repositoryAtPath(t, "/nope")).toBeNull();
    expect(repositoryAtPath(task({}), "/repos/app")).toBeNull();
  });

  test("ignores a selection for a single-repo task", () => {
    expect(repoNameForSelection(task({}), "app")).toBeNull();
  });

  test("accepts a known name for a multi-repo task and rejects unknown ones", () => {
    const t = task({ repositories: [repo({ name: "frontend" }), repo({ name: "backend" })] });
    expect(repoNameForSelection(t, "backend")).toBe("backend");
    expect(repoNameForSelection(t, "infra")).toBeNull();
    expect(repoNameForSelection(t, null)).toBeNull();
  });
});

describe("commitPushPrompt", () => {
  test("single-repo prompt is unchanged and has no Repositories block", () => {
    const text = commitPushPrompt({ branch: "feature/x", taskType: "task" });
    expect(text.startsWith("Commit all changes with a clear commit message")).toBe(true);
    expect(text).not.toContain("Repositories:");
    expect(text).toContain("git push -u origin 'feature/x'");
  });

  test("single-repo prompt is byte-identical whether repositories is absent or one entry", () => {
    const base = commitPushPrompt({ branch: "fix/x", taskType: "bug" });
    expect(
      commitPushPrompt({ branch: "fix/x", taskType: "bug", repositories: [repo({})] }),
    ).toBe(base);
  });

  test("multi prompt lists every repository and asks for a labeled proposal each", () => {
    const text = commitPushPrompt({
      branch: null,
      taskType: "task",
      repositories: [
        repo({ name: "frontend", branch: "feature/auth" }),
        repo({ name: "backend", branch: "feature/auth-2" }),
      ],
    });
    expect(text).toContain("Repositories:\n- frontend: branch 'feature/auth'\n- backend: branch 'feature/auth-2'");
    expect(text).toContain('Repository: <name>');
    expect(text).toContain("four-backtick block");
  });
});
