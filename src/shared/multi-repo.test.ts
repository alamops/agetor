import { describe, expect, test } from "bun:test";
import {
  formatRepositoriesPrompt,
  isMultiRepoTask,
  repoNameForPath,
  repositoriesForTask,
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

  test("resumes the stem's sequence instead of nesting a second suffix", () => {
    // Before the fix this produced "app-2-2": a base that already ended in a
    // number was suffixed again instead of continuing "app-3".
    expect(uniqueRepoSlugs(["/a/app", "/b/app", "/c/app-2"])).toEqual(["app", "app-2", "app-3"]);
    expect(uniqueRepoSlugs(["/a/app", "/b/app", "/c/app", "/d/app-2"])).toEqual([
      "app",
      "app-2",
      "app-3",
      "app-4",
    ]);
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
      prs: [],
      baseBranch: null,
    });
  });

  test("a one-entry array with no multiRepo flag (an older core) is treated as single-repo", () => {
    const derived = repositoriesForTask(
      task({ repositories: [repo({ path: "/other", name: "other" })] }),
    );
    expect(derived).toHaveLength(1);
    expect(derived[0]!.path).toBe("/repos/app");
  });

  test("a one-repository multi task returns its stored entry, not a derived one", () => {
    const only = repo({ path: "/other", name: "other" });
    expect(repositoriesForTask(task({ multiRepo: true, repositories: [only] }))).toEqual([only]);
  });

  test("multiRepo: false derives from the scalars even with two entries", () => {
    const derived = repositoriesForTask(
      task({ multiRepo: false, repositories: [repo({ name: "a" }), repo({ name: "b" })] }),
    );
    expect(derived.map((r) => r.path)).toEqual(["/repos/app"]);
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

  test("the server-computed multiRepo flag wins over the count", () => {
    expect(isMultiRepoTask({ multiRepo: true, repositories: [repo({})] })).toBe(true);
    expect(isMultiRepoTask({ multiRepo: false, repositories: [repo({}), repo({ name: "b" })] })).toBe(false);
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

describe("repositoriesForTask derived entry", () => {
  test("carries prs, baseBranch and a derived prUrl for a single-repo task", () => {
    const pr = { url: "https://x/1", head: "feature/auth", base: "develop", number: 1, createdAt: 1 };
    const [entry] = repositoriesForTask(task({ prs: [pr], baseBranch: "develop" }));
    expect(entry!.prs).toEqual([pr]);
    expect(entry!.baseBranch).toBe("develop");
    expect(entry!.prUrl).toBe("https://x/1");
  });
  test("an older core's JSON (prUrl only) still yields its PR", () => {
    const [entry] = repositoriesForTask(task({ prUrl: "https://x/legacy" }));
    expect(entry!.prs).toEqual([{ url: "https://x/legacy", head: null, base: null, number: null, createdAt: 0 }]);
    expect(entry!.prUrl).toBe("https://x/legacy");
  });
  test("a multi task's stored entries come back unchanged", () => {
    const stored = [repo({ name: "a" }), repo({ name: "b" })];
    expect(repositoriesForTask(task({ repositories: stored }))).toBe(stored);
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

  test("multi prompt carries each stored base and asks for Repository, Base, then the link", () => {
    const text = commitPushPrompt({
      branch: null,
      taskType: "task",
      repositories: [
        repo({ name: "frontend", branch: "feature/auth", baseBranch: "develop" }),
        repo({ name: "backend", branch: "feature/auth-2" }),
      ],
    });
    expect(text).toContain("- frontend: branch 'feature/auth', base 'develop'\n- backend: branch 'feature/auth-2'\n");
    expect(text.indexOf('"Repository: <name>"')).toBeLessThan(text.indexOf('"Base: <branch>"'));
    expect(text.indexOf('"Base: <branch>"')).toBeLessThan(text.indexOf("full link to open a pull request"));
    expect(text).toContain("compare/<base>...<head>?quick_pull=1");
    expect(text).toContain("always targets the default branch");
    expect(text).toContain("repeat the block for each pull request");
    expect(text.toLowerCase()).not.toContain("agetor");
  });

  test("a one-repository multi task keeps the per-repository prompt", () => {
    const text = commitPushPrompt({
      branch: null,
      taskType: "task",
      multiRepo: true,
      repositories: [repo({ name: "frontend", branch: "feature/auth" })],
    });
    expect(text).toContain("Repositories:\n- frontend: branch 'feature/auth'");
    expect(text).toContain("Repository: <name>");
  });

  test("multiRepo: false stays single with a one-entry derived set", () => {
    const base = commitPushPrompt({ branch: "fix/x", taskType: "bug" });
    expect(commitPushPrompt({ branch: "fix/x", taskType: "bug", multiRepo: false, repositories: [repo({})] })).toBe(base);
  });
});
