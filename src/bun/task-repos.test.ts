import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  branchesPinnedByOtherTasks,
  lexicallyInsideRoot,
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
  test("groups branches by workdir and repository path, excluding the task itself", () => {
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
    const map = branchesPinnedByOtherTasks("self", tasks);
    expect(map.get("/a")).toEqual(new Set(["feature/a"]));
    expect(map.get("/b")).toEqual(new Set(["feature/b"]));
    expect(map.get("/wt/other")).toBeUndefined();
  });
});
