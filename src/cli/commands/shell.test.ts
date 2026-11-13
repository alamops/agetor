import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import type { AgetorClient } from "../api-client.ts";
import type { Task } from "../../shared/types.ts";
import { makeTask } from "../test-fixtures.ts";

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
  isTTY: false,
  c: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    blue: (s: string) => s,
  },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: () => {},
  printJson: () => {},
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdShell, resolveShellTarget } = await import("./shell.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdShell>[1];

function fakeClient(task: Task): AgetorClient {
  return {
    listTasks: async () => [task],
  } as unknown as AgetorClient;
}

beforeEach(() => {
  outputs.length = 0;
});

test("the documented `shell <task-id> --print` form resolves the task id", async () => {
  // Regression: the `--repo` value skip used `repoIdx + 1` even when `--repo`
  // was absent (repoIdx = -1), which skipped positional index 0 — the task id.
  currentClient = fakeClient(makeTask({ worktreePath: "/wt/task-1", isolation: "worktree" }));
  await cmdShell(["abcdefgh", "--print"], flags);
  expect(outputs).toEqual(["/wt/task-1"]);
});

test("a bare positional resolves too and reaches the TTY check", async () => {
  // A real directory, so the TTY refusal (not "directory no longer exists")
  // is what proves the positional resolved.
  currentClient = fakeClient(makeTask({ worktreePath: process.cwd(), isolation: "worktree" }));
  await expect(cmdShell(["abcdefgh"], flags)).rejects.toThrow(/interactive terminal/);
});

test("-p before the task id still resolves the positional", async () => {
  currentClient = fakeClient(makeTask({ worktreePath: "/wt/task-1", isolation: "worktree" }));
  await cmdShell(["-p", "abcdefgh"], flags);
  expect(outputs).toEqual(["/wt/task-1"]);
});

test("--repo before the task id selects that repository's worktree", async () => {
  currentClient = fakeClient(makeTask({
    workdir: "/wt/task-1",
    worktreePath: "/wt/task-1",
    branch: null,
    repositories: [
      { path: "/src/frontend", name: "frontend", branch: "feature/x", branchSource: "created", worktreePath: "/wt/task-1/frontend", baseRef: "a", checkoutBranch: "feature/x", prUrl: null },
      { path: "/src/backend", name: "backend", branch: "feature/x", branchSource: "created", worktreePath: "/wt/task-1/backend", baseRef: "b", checkoutBranch: "feature/x", prUrl: null },
    ],
  }));
  await cmdShell(["--repo", "backend", "abcdefgh", "--print"], flags);
  expect(outputs).toEqual(["/wt/task-1/backend"]);
});

test("an unknown --repo names the repositories the task actually has", async () => {
  currentClient = fakeClient(makeTask({
    worktreePath: "/wt/task-1",
    repositories: [
      { path: "/src/frontend", name: "frontend", branch: "feature/x", branchSource: "created", worktreePath: "/wt/task-1/frontend", baseRef: "a", checkoutBranch: "feature/x", prUrl: null },
      { path: "/src/backend", name: "backend", branch: "feature/x", branchSource: "created", worktreePath: "/wt/task-1/backend", baseRef: "b", checkoutBranch: "feature/x", prUrl: null },
    ],
  }));
  await expect(cmdShell(["abcdefgh", "--repo", "infra", "--print"], flags)).rejects.toThrow(
    /no repository "infra" on this task \(have: frontend, backend\)/,
  );
});

test("a multi task whose worktrees were never created says so instead of 'directory no longer exists'", async () => {
  currentClient = fakeClient(makeTask({
    workdir: "/nonexistent/agetor-workspace/task-1",
    worktreePath: null,
    branch: null,
    repositories: [
      { path: "/src/frontend", name: "frontend", branch: "feature/x", branchSource: "created", worktreePath: null, baseRef: "a", checkoutBranch: null, prUrl: null },
      { path: "/src/backend", name: "backend", branch: "feature/x", branchSource: "created", worktreePath: null, baseRef: "b", checkoutBranch: null, prUrl: null },
    ],
  }));
  let message = "";
  try {
    await cmdShell(["abcdefgh"], flags);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).toContain("has no worktrees yet — start the task first");
  expect(message).not.toContain("directory no longer exists");
});

test("a missing positional is still a usage error", async () => {
  currentClient = fakeClient(makeTask({}));
  await expect(cmdShell(["--print"], flags)).rejects.toThrow(/usage: agetor shell/);
});

test("--repo works on a single-repository task too, like diff --repo (review N2)", async () => {
  // A single row stores no `repositories`; its one entry is derived.
  currentClient = fakeClient(makeTask({
    workdir: "/src/widgets",
    worktreePath: "/wt/task-1",
    isolation: "worktree",
    branch: "agetor/abc-fix",
  }));
  await cmdShell(["abcdefgh", "--repo", "widgets", "--print"], flags);
  expect(outputs).toEqual(["/wt/task-1"]);
});

test("--repo on a multi task names that repository's branch, not the null task branch (review N2)", () => {
  const task = makeTask({
    workdir: "/wt/task-1",
    worktreePath: "/wt/task-1",
    branch: null,
    repositories: [
      { path: "/src/frontend", name: "frontend", branch: "feature/x", branchSource: "created", worktreePath: "/wt/task-1/frontend", baseRef: "a", checkoutBranch: "feature/x", prUrl: null },
      { path: "/src/backend", name: "backend", branch: "feature/y", branchSource: "created", worktreePath: "/wt/task-1/backend", baseRef: "b", checkoutBranch: "feature/y", prUrl: null },
    ],
  });
  expect(resolveShellTarget(task, "backend")).toEqual({ dir: "/wt/task-1/backend", branch: "feature/y" });
  // Without --repo it is the workspace root and the (null) task branch.
  expect(resolveShellTarget(task, null)).toEqual({ dir: "/wt/task-1", branch: null });
});

test("a not-yet-started multi task left with one repository names the real state too (round 15)", async () => {
  currentClient = fakeClient(makeTask({
    workdir: "/nonexistent/agetor-workspace/task-1",
    worktreePath: null,
    branch: null,
    multiRepo: true,
    repositories: [
      { path: "/src/backend", name: "backend", branch: null, branchSource: "created", worktreePath: null, baseRef: "b", checkoutBranch: null, prUrl: null },
    ],
  }));
  await expect(cmdShell(["abcdefgh"], flags)).rejects.toThrow(/has no worktrees yet — start the task first/);
});

test("--repo on a multi task left with one repository opens that repository", async () => {
  const task = makeTask({
    workdir: "/ws/task-1",
    worktreePath: "/ws/task-1",
    branch: null,
    multiRepo: true,
    repositories: [
      { path: "/src/backend", name: "backend", branch: "feature/x", branchSource: "created", worktreePath: "/ws/task-1/backend", baseRef: "b", checkoutBranch: null, prUrl: null },
    ],
  });
  expect(resolveShellTarget(task, "backend")).toEqual({ dir: "/ws/task-1/backend", branch: "feature/x" });
});
