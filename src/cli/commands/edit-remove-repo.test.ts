// `agetor edit <task> --remove-repo <name>` (issue #291, round 15): removes a
// repository from a multi-repository task through
// `DELETE /tasks/:id/repositories/:name`, prints an escaped status line, and
// fails with the core's message when the removal is refused.
import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { ApiError, type AgetorClient } from "../api-client.ts";
import type { Task, TaskRepository } from "../../shared/types.ts";
import { makeTask } from "../test-fixtures.ts";

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
  printJson: (v: unknown) => {
    json.push(v);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdEdit } = await import("./manage.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdEdit>[1];

function repo(name: string, branch: string | null): TaskRepository {
  return {
    path: `/src/${name}`,
    name,
    branch,
    branchSource: "created",
    worktreePath: `/ws/${name}`,
    baseRef: null,
    checkoutBranch: null,
    prUrl: null,
  };
}

function multiTask(repos: TaskRepository[]): Task {
  return makeTask({ workdir: "/ws", worktreePath: "/ws", isolation: "worktree", multiRepo: true, repositories: repos });
}

beforeEach(() => {
  outputs.length = 0;
  json.length = 0;
});

test("--remove-repo removes the named repository and names the kept branch", async () => {
  const calls: Array<[string, string]> = [];
  const task = multiTask([repo("frontend", "agetor/x-fe"), repo("backend", "agetor/x-be")]);
  currentClient = {
    listTasks: async () => [task],
    removeTaskRepository: async (id: string, name: string) => {
      calls.push([id, name]);
      return { ...task, repositories: [repo("frontend", "agetor/x-fe")] };
    },
    patchTask: async () => {
      throw new Error("no patch expected");
    },
  } as unknown as AgetorClient;
  await cmdEdit(["abcdefgh", "--remove-repo", "backend"], flags);
  expect(calls).toEqual([[task.id, "backend"]]);
  expect(outputs).toEqual([`✓ removed repository backend from ${task.id.slice(0, 8)} (branch agetor/x-be kept)`]);
});

test("--remove-repo escapes the repository and branch names", async () => {
  const evil = "be\u001b[2J";
  const task = multiTask([repo("frontend", null), repo(evil, "br\u0007anch")]);
  currentClient = {
    listTasks: async () => [task],
    removeTaskRepository: async () => ({ ...task, repositories: [repo("frontend", null)] }),
  } as unknown as AgetorClient;
  await cmdEdit(["abcdefgh", "--remove-repo", evil], flags);
  expect(outputs.join("\n")).not.toContain("\u001b");
  expect(outputs.join("\n")).not.toContain("\u0007");
  expect(outputs[0]).toContain("removed repository be\\u001b[2J");
  expect(outputs[0]).toContain("(branch br\\u0007anch kept)");
});

test("a refused removal fails with the core's message and prints no success line", async () => {
  const task = multiTask([repo("frontend", "a"), repo("backend", "b")]);
  currentClient = {
    listTasks: async () => [task],
    removeTaskRepository: async () => {
      throw new ApiError(409, { error: "backend has uncommitted changes", code: "dirty" }, "backend has uncommitted changes");
    },
  } as unknown as AgetorClient;
  await expect(cmdEdit(["abcdefgh", "--remove-repo", "backend"], flags)).rejects.toThrow(
    "backend has uncommitted changes",
  );
  expect(outputs).toEqual([]);
});

test("--remove-repo is repeatable, applied in order, and combines with a patch", async () => {
  const calls: string[] = [];
  let current = multiTask([repo("a", "ba"), repo("b", "bb"), repo("c", null)]);
  currentClient = {
    listTasks: async () => [current],
    removeTaskRepository: async (_id: string, name: string) => {
      calls.push(`rm:${name}`);
      current = { ...current, repositories: (current.repositories ?? []).filter((r) => r.name !== name) };
      return current;
    },
    patchTask: async (_id: string, patch: Record<string, unknown>) => {
      calls.push(`patch:${Object.keys(patch).join(",")}`);
      return { ...current, ...patch };
    },
  } as unknown as AgetorClient;
  await cmdEdit(["abcdefgh", "--remove-repo", "b", "--title", "New", "--remove-repo", "c"], flags);
  expect(calls).toEqual(["rm:b", "rm:c", "patch:title"]);
  expect(outputs[0]).toContain("removed repository b");
  expect(outputs[0]).toContain("(branch bb kept)");
  // No branch was created for `c`, so nothing to say it was kept.
  expect(outputs[1]).toContain("removed repository c from");
  expect(outputs[1]).not.toContain("kept");
  expect(outputs[2]).toContain("updated");
});

test("--json prints the final task only", async () => {
  const task = multiTask([repo("frontend", "a"), repo("backend", "b")]);
  const after = { ...task, repositories: [repo("frontend", "a")] };
  currentClient = {
    listTasks: async () => [task],
    removeTaskRepository: async () => after,
  } as unknown as AgetorClient;
  await cmdEdit(["abcdefgh", "--remove-repo", "backend"], { ...flags, json: true });
  expect(outputs).toEqual([]);
  expect(json).toEqual([after]);
});

test("--remove-repo needs a value", async () => {
  currentClient = { listTasks: async () => [] } as unknown as AgetorClient;
  await expect(cmdEdit(["abcdefgh", "--remove-repo"], flags)).rejects.toThrow();
});
