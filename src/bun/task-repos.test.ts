import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  branchesPinnedByOtherTasks,
  lexicallyInsideRoot,
  pinnedBranchesFor,
  resolveRepositorySet,
} from "./task-repos.ts";

describe("resolveRepositorySet", () => {
  const roots: Record<string, string | null> = {
    "/src/frontend": "/src/frontend",
    "/src/frontend/sub": "/src/frontend",
    "/src/backend": "/src/backend",
    "/src/infra": "/src/infra",
    "/src/not-a-repo": null,
  };
  const resolveRoot = async (p: string) => roots[p] ?? null;

  test("assigns unique names in selection order", async () => {
    const res = await resolveRepositorySet(
      [{ path: "/src/frontend" }, { path: "/src/backend" }, { path: "/src/infra" }],
      { resolveRoot },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repositories.map((r) => r.name)).toEqual(["frontend", "backend", "infra"]);
    expect(res.repositories.every((r) => r.worktreePath === null && r.branch === null)).toBe(true);
    expect(res.repositoriesRoots.get("/src/backend")).toBe("/src/backend");
  });

  test("dedupes paths under one git root, keeping the first selected path", async () => {
    const res = await resolveRepositorySet(
      [{ path: "/src/frontend/sub" }, { path: "/src/frontend" }, { path: "/src/backend" }],
      { resolveRoot },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repositories.map((r) => r.path)).toEqual(["/src/frontend/sub", "/src/backend"]);
    expect(res.repositories.map((r) => r.name)).toEqual(["sub", "backend"]);
  });

  test("collects every bad entry and inserts nothing", async () => {
    const res = await resolveRepositorySet(
      [{ path: "" }, { path: "relative/path" }, { path: "/src/not-a-repo" }],
      { resolveRoot },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(3);
    expect(res.errors[0]).toContain("empty");
    expect(res.errors[1]).toContain("absolute");
    expect(res.errors[2]).toContain("not inside a git repository");
  });

  test("an empty selection resolves to an empty set", async () => {
    const res = await resolveRepositorySet([], { resolveRoot });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repositories).toEqual([]);
  });
});

describe("lexicallyInsideRoot", () => {
  const root = path.join(path.sep, "data", "worktrees", "t1");
  test("accepts the root and descendants", () => {
    expect(lexicallyInsideRoot(root, root)).toBe(true);
    expect(lexicallyInsideRoot(root, path.join(root, "frontend"))).toBe(true);
  });
  test("rejects siblings and escapes", () => {
    expect(lexicallyInsideRoot(root, path.join(root, "..", "t2"))).toBe(false);
    expect(lexicallyInsideRoot(root, path.join(root, "..", ".."))).toBe(false);
    expect(lexicallyInsideRoot(root, path.join(root, "frontend", "..", "..", "x"))).toBe(false);
  });
});

describe("branchesPinnedByOtherTasks", () => {
  test("groups branches by workdir and repository path, excluding the task itself", async () => {
    const tasks = [
      { id: "self", branch: "feature/self", workdir: "/a" },
      {
        id: "other",
        branch: null,
        workdir: "/wt/other",
        repositories: [
          { path: "/a", name: "a", branch: "feature/a" },
          { path: "/b", name: "b", branch: "feature/b" },
        ] as never,
      },
    ];
    const map = await branchesPinnedByOtherTasks("self", tasks);
    expect(map.get("/a")).toEqual(new Set(["feature/a"]));
    expect(map.get("/b")).toEqual(new Set(["feature/b"]));
    expect(map.get("/wt/other")).toBeUndefined();
  });

  test("also keys every pin by its git root, so sibling subdirectories see it", async () => {
    // Review R11-M1: pins are stored against the path the other task SELECTED
    // (`/repo/sub1`), but the caller looks up the path THIS task selected
    // (`/repo/sub2`). Without the shared root key the second task found no pin
    // and attached to the first task's branch and commits.
    const roots: Record<string, string> = {
      "/repo/sub1": "/repo",
      "/repo/sub2": "/repo",
      "/other": "/other",
    };
    const resolveRoot = async (dir: string) => roots[dir] ?? null;
    const tasks = [
      {
        id: "other",
        branch: null,
        workdir: "/wt/other",
        repositories: [
          { path: "/repo/sub1", name: "one", branch: "feature/shared" },
          { path: "/other", name: "other", branch: "feature/other" },
        ] as never,
      },
    ];

    const map = await branchesPinnedByOtherTasks("self", tasks, { resolveRoot });

    // The selected path still answers as before...
    expect(map.get("/repo/sub1")).toEqual(new Set(["feature/shared"]));
    // ...and the shared git root answers even when this task selected a
    // sibling subdirectory of the same repository.
    expect(map.get("/repo")).toEqual(new Set(["feature/shared"]));
    expect(map.get("/other")).toEqual(new Set(["feature/other"]));
  });

  test("a resolver failure keeps the path pins instead of dropping them", async () => {
    const tasks = [
      { id: "other", branch: "feature/x", workdir: "/gone", repositories: undefined },
    ];
    const map = await branchesPinnedByOtherTasks("self", tasks, {
      resolveRoot: async () => {
        throw new Error("not a repo");
      },
    });
    expect(map.get("/gone")).toEqual(new Set(["feature/x"]));
  });
});

describe("pinnedBranchesFor", () => {
  test("unions the selected-path and git-root sets instead of first-match", () => {
    // Two other tasks selected sibling subdirectories of one repository, so
    // their pins land in two path sets plus the shared root set. Looking up
    // one path must still see the branch held by the task in the OTHER
    // subdirectory.
    const pins = new Map<string, Set<string>>([
      ["/repo/sub-a", new Set(["feature/a"])],
      ["/repo/sub-b", new Set(["feature/b"])],
      ["/repo", new Set(["feature/a", "feature/b"])],
    ]);
    expect(pinnedBranchesFor(pins, ["/repo/sub-a", "/repo"])).toEqual(
      new Set(["feature/a", "feature/b"]),
    );
    expect(pinnedBranchesFor(pins, ["/repo/sub-b", "/repo"])).toEqual(
      new Set(["feature/a", "feature/b"]),
    );
    expect(pinnedBranchesFor(pins, ["/elsewhere", null, undefined])).toEqual(new Set());
    expect(pinnedBranchesFor(undefined, ["/repo"])).toEqual(new Set());
  });
});
