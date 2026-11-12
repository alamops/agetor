import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import type { AgetorClient } from "../api-client.ts";
import type { Task, TaskDiff } from "../../shared/types.ts";

/**
 * `cmdDiff` reaches for a client via `getClient(flags)` internally, so this
 * suite mocks `../context.ts` and `../output.ts` exactly like `add.test.ts`
 * (`c.*` wrappers become identity, `out`/`printJson` are captured). Both
 * modules are snapshotted first and restored in `afterAll` — `mock.module`
 * overwrites the module record in place for already-loaded modules, and sibling
 * test files in the same `bun test` process share it.
 */

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const json: unknown[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
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
  printJson: (value: unknown) => {
    json.push(value);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdDiff } = await import("./diff.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdDiff>[1];

function repo(name: string) {
  return {
    path: `/src/${name}`,
    name,
    branch: "feature/auth",
    branchSource: "created" as const,
    worktreePath: `/wt/t1/${name}`,
    baseRef: null,
    checkoutBranch: null,
    prUrl: null,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "T",
    prompt: "p",
    agent: "fx",
    column: "ready",
    workdir: "/wt/t1",
    isolation: "worktree",
    taskType: "task",
    archivedAt: null,
    pendingInteractionCount: 0,
    hasOpenableRun: false,
    ...over,
  } as unknown as Task;
}

function diff(repoName: string | null, file: string): TaskDiff {
  return {
    base: "abc1234",
    repo: repoName,
    files: [
      {
        path: file,
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        truncated: false,
        hunks: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ],
  };
}

function makeClient(t: Task, calls: Array<string | undefined>): AgetorClient {
  return {
    listTasks: async () => [t],
    getDiff: async (_id: string, repoName?: string | null) => {
      calls.push(repoName ?? undefined);
      return diff(repoName ?? null, repoName ? `${repoName}.txt` : "solo.txt");
    },
  } as unknown as AgetorClient;
}

beforeEach(() => {
  outputs.length = 0;
  json.length = 0;
});

test("single-repository diff is unchanged: one request, one JSON object path, no repo section", async () => {
  const calls: Array<string | undefined> = [];
  currentClient = makeClient(task({ workdir: "/src/solo" }), calls);

  await cmdDiff(["t1"], flags);
  expect(calls).toEqual([undefined]);
  expect(outputs.join("\n")).toContain("solo.txt");

  json.length = 0;
  await cmdDiff(["t1"], { ...flags, json: true });
  expect(json).toHaveLength(1);
  expect(Array.isArray(json[0])).toBe(false);
});

test("multi-repository diff prints every repository, labelled", async () => {
  const calls: Array<string | undefined> = [];
  currentClient = makeClient(task({ repositories: [repo("frontend"), repo("backend")] }), calls);

  await cmdDiff(["t1"], flags);
  expect(calls).toEqual(["frontend", "backend"]);
  const text = outputs.join("\n");
  expect(text).toContain("── frontend ──");
  expect(text).toContain("── backend ──");
  expect(text).toContain("frontend.txt");
  expect(text).toContain("backend.txt");
});

test("multi-repository --repo narrows to one repository and keeps the single-object JSON shape", async () => {
  const calls: Array<string | undefined> = [];
  currentClient = makeClient(task({ repositories: [repo("frontend"), repo("backend")] }), calls);

  await cmdDiff(["--repo", "backend", "t1"], flags);
  expect(calls).toEqual(["backend"]);
  const text = outputs.join("\n");
  expect(text).toContain("backend.txt");
  expect(text).not.toContain("frontend.txt");
  expect(text).not.toContain("── backend ──");

  json.length = 0;
  await cmdDiff(["t1", "--repo", "frontend"], { ...flags, json: true });
  expect(json).toHaveLength(1);
  expect(Array.isArray(json[0])).toBe(false);
});

test("multi-repository aggregate JSON is an array of per-repository diffs", async () => {
  currentClient = makeClient(task({ repositories: [repo("frontend"), repo("backend")] }), []);
  await cmdDiff(["t1"], { ...flags, json: true });
  expect(json).toHaveLength(1);
  expect(Array.isArray(json[0])).toBe(true);
  expect((json[0] as TaskDiff[]).length).toBe(2);
});

test("an unknown --repo name fails with the available repository names", async () => {
  currentClient = makeClient(task({ repositories: [repo("frontend"), repo("backend")] }), []);
  await expect(cmdDiff(["t1", "--repo", "nope"], flags)).rejects.toThrow(
    'no repository "nope" on this task (have: frontend, backend)',
  );
});

test("one repository's failing diff doesn't hide its siblings; the command exits non-zero (review N3)", async () => {
  const before = process.exitCode;
  try {
    currentClient = {
      listTasks: async () => [task({ repositories: [repo("frontend"), repo("backend")] })],
      getDiff: async (_id: string, repoName?: string | null) => {
        if (repoName === "frontend") throw new Error("worktree missing\u001b[2J");
        return diff(repoName ?? null, `${repoName}.txt`);
      },
    } as unknown as AgetorClient;

    process.exitCode = 0;
    await cmdDiff(["t1"], flags);
    const text = outputs.join("\n");
    expect(text).toContain("── frontend ──");
    expect(text).toContain("! diff failed: worktree missing\\u001b[2J");
    expect(text).toContain("── backend ──");
    expect(text).toContain("backend.txt");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await cmdDiff(["t1"], { ...flags, json: true });
    expect(json[0]).toEqual([
      { repo: "frontend", error: "worktree missing\u001b[2J" },
      diff("backend", "backend.txt"),
    ]);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = before;
  }
});

test("--repo naming the failing repository fails the command with its error", async () => {
  currentClient = {
    listTasks: async () => [task({ repositories: [repo("frontend"), repo("backend")] })],
    getDiff: async () => {
      throw new Error("worktree missing");
    },
  } as unknown as AgetorClient;
  await expect(cmdDiff(["t1", "--repo", "frontend"], flags)).rejects.toThrow("worktree missing");
});

test("a multi task left with one repository keeps the labelled per-repository form (round 15)", async () => {
  const calls: Array<string | undefined> = [];
  currentClient = makeClient(task({ multiRepo: true, repositories: [repo("backend")] }), calls);

  await cmdDiff(["t1"], flags);
  // Asked by name: the workspace root itself is not a repository.
  expect(calls).toEqual(["backend"]);
  expect(outputs.join("\n")).toContain("── backend ──");

  json.length = 0;
  await cmdDiff(["t1"], { ...flags, json: true });
  expect(Array.isArray(json[0])).toBe(true);
});
