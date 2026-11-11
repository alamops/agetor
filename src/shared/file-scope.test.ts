import { describe, expect, test } from "bun:test";
import { discoveryParamsForTask, discoveryScopesForTask, fileScopeForTask, fileScopesForTask } from "./file-scope.ts";
import type { Task, TaskRepository } from "./types.ts";

const repo = (over: Partial<TaskRepository>): TaskRepository => ({
  path: "/repos/app",
  name: "app",
  branch: "feature/auth",
  branchSource: "created",
  worktreePath: "/wt/t1/app",
  baseRef: "abc123",
  checkoutBranch: "feature/auth",
  prUrl: null,
  ...over,
});

const task = (over: Partial<Task>): Task =>
  ({
    id: "t1",
    title: "x",
    prompt: "p",
    column: "backlog",
    agent: "claude-code",
    workdir: "/repos/app",
    isolation: "worktree",
    taskType: "feature",
    branch: "feature/auth",
    branchSource: "created",
    worktreePath: "/wt/t1",
    baseRef: "abc123",
    prUrl: null,
    ...over,
  }) as Task;

describe("fileScopeForTask (unchanged contract)", () => {
  test("materialized worktree wins", () => {
    expect(fileScopeForTask(task({}))).toEqual({ dir: "/wt/t1" });
  });

  test("pre-run isolated task uses workdir at baseRef", () => {
    expect(fileScopeForTask(task({ worktreePath: null, baseRef: "main" }))).toEqual({
      dir: "/repos/app",
      ref: "main",
    });
  });

  test("isolation none uses the workdir with no ref", () => {
    expect(fileScopeForTask(task({ isolation: "none", worktreePath: null }))).toEqual({
      dir: "/repos/app",
    });
  });
});

describe("fileScopesForTask", () => {
  test("single-repo returns one untagged scope, identical to fileScopeForTask", () => {
    expect(fileScopesForTask(task({}))).toEqual([{ name: null, dir: "/wt/t1" }]);
    expect(fileScopesForTask(task({ repositories: [] }))).toEqual([
      { name: null, ...fileScopeForTask(task({})) },
    ]);
  });

  test("multi-repo returns one tagged scope per repository", () => {
    const t = task({
      repositories: [
        repo({ name: "frontend", worktreePath: "/wt/t1/frontend" }),
        repo({ name: "backend", worktreePath: "/wt/t1/backend", path: "/repos/backend" }),
      ],
    });
    expect(fileScopesForTask(t)).toEqual([
      { name: "frontend", dir: "/wt/t1/frontend" },
      { name: "backend", dir: "/wt/t1/backend" },
    ]);
  });

  test("pre-materialization multi scopes point at each source repo and pinned ref", () => {
    const t = task({
      worktreePath: "/wt/t1",
      workdir: "/wt/t1",
      repositories: [
        repo({ name: "frontend", path: "/src/frontend", worktreePath: null, baseRef: "aaa" }),
        repo({ name: "backend", path: "/src/backend", worktreePath: null, baseRef: null }),
      ],
    });
    expect(fileScopesForTask(t)).toEqual([
      { name: "frontend", dir: "/src/frontend", ref: "aaa" },
      { name: "backend", dir: "/src/backend", ref: "HEAD" },
    ]);
  });

  test("discoveryParamsForTask stays the single-repo mapping", () => {
    expect(discoveryParamsForTask(task({}))).toEqual({ workdir: "/wt/t1", branch: null });
  });

  test("discoveryScopesForTask stays byte-identical for a single repository", () => {
    expect(discoveryScopesForTask(task({}))).toEqual([{ workdir: "/wt/t1", branch: null }]);
  });

  test("discoveryScopesForTask unions every repository, never the non-git workspace", () => {
    const t = task({
      workdir: "/wt/t1",
      worktreePath: "/wt/t1",
      repositories: [
        repo({ name: "frontend", path: "/src/frontend", worktreePath: "/wt/t1/frontend" }),
        repo({ name: "backend", path: "/src/backend", worktreePath: null, baseRef: "bbb" }),
      ],
    });
    expect(discoveryScopesForTask(t)).toEqual([
      { workdir: "/wt/t1/frontend", branch: null },
      { workdir: "/src/backend", branch: "bbb" },
    ]);
  });
});
