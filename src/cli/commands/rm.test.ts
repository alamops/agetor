import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import type { AgetorClient } from "../api-client.ts";
import type { TaskTeardownPreview } from "../../shared/types.ts";
import { makeTask } from "../test-fixtures.ts";

// `agetor rm` names every branch the delete removes, read from
// `GET /tasks/:id/teardown-preview` before deleting
// (docs/plans/codex-terminal-worktree-error.md T9/U8).

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const jsonOutputs: unknown[] = [];

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
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const { cmdRm, teardownPhrase } = await import("./lifecycle.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdRm>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdRm>[1];

const task = makeTask({ title: "Drifted", isolation: "worktree", branch: "agetor/abc-fix", worktreePath: "/wt" });

let deleted: string[] = [];

function fakeClient(preview: TaskTeardownPreview | null): AgetorClient {
  return {
    listTasks: async () => [task],
    getTeardownPreview: async () => preview,
    deleteTask: async (id: string) => {
      deleted.push(id);
    },
  } as unknown as AgetorClient;
}

const both: TaskTeardownPreview = {
  branches: ["agetor/abc-fix", "implement/x"],
  liveBranch: "implement/x",
  taskBranch: "agetor/abc-fix",
  source: "live",
  excluded: [],
};

beforeEach(() => {
  outputs.length = 0;
  jsonOutputs.length = 0;
  deleted = [];
  process.exitCode = 0;
});

test("refusal names both branches and deletes nothing", async () => {
  currentClient = fakeClient(both);
  await cmdRm(["abcdefgh"], flags);
  expect(deleted).toEqual([]);
  expect(process.exitCode).toBe(1);
  expect(outputs).toEqual([
    `refusing to delete without --yes. Would delete "Drifted" (abcdefgh) and its worktree + branches agetor/abc-fix, implement/x.`,
  ]);
  process.exitCode = 0;
});

test("success line names the removed branches", async () => {
  currentClient = fakeClient(both);
  await cmdRm(["abcdefgh", "--yes"], flags);
  expect(deleted).toEqual([task.id]);
  expect(outputs).toEqual(["✗ deleted abcdefgh and its worktree + branches agetor/abc-fix, implement/x"]);
});

test("a single branch reads singular", async () => {
  currentClient = fakeClient({ ...both, branches: ["agetor/abc-fix"], liveBranch: "agetor/abc-fix", source: "task-branch" });
  await cmdRm(["abcdefgh"], flags);
  expect(outputs[0]).toContain("and its worktree + branch agetor/abc-fix.");
  process.exitCode = 0;
});

test("an older core without the preview route degrades to the task row's branch", async () => {
  currentClient = fakeClient(null);
  await cmdRm(["abcdefgh"], flags);
  expect(outputs[0]).toContain("and its worktree + branch agetor/abc-fix.");
  process.exitCode = 0;
  outputs.length = 0;
  await cmdRm(["abcdefgh", "--yes"], flags);
  expect(outputs).toEqual(["✗ deleted abcdefgh"]);
});

test("with no preview, a drifted row's last-seen checkout is named as a possible removal", async () => {
  const drifted = { ...task, checkoutBranch: "implement/x" };
  currentClient = { ...fakeClient(null), listTasks: async () => [drifted] } as unknown as AgetorClient;
  await cmdRm(["abcdefgh"], flags);
  expect(outputs[0]).toContain(
    "and its worktree + branch agetor/abc-fix (and possibly implement/x, the branch it was last on).",
  );
  process.exitCode = 0;
});

test("teardownPhrase escapes branch names in the no-preview fallback", () => {
  expect(teardownPhrase(null, { branch: "a\u001b[31m", checkoutBranch: "b\u0007" })).toBe(
    "its worktree + branch a\\u001b[31m (and possibly b\\u0007, the branch it was last on)",
  );
  expect(teardownPhrase(null, { branch: null, checkoutBranch: null })).toBe("its worktree + branch");
  expect(teardownPhrase(null, { branch: "x", checkoutBranch: "x" })).toBe("its worktree + branch x");
});

test("--json carries the deleted branches", async () => {
  currentClient = fakeClient(both);
  await cmdRm(["abcdefgh"], jsonFlags);
  expect(jsonOutputs).toEqual([{ deleted: task.id, branches: ["agetor/abc-fix", "implement/x"] }]);
});

test("branch names are escaped", async () => {
  currentClient = fakeClient({ ...both, branches: ["agetor/abc-fix", "evil\u001b[2J"] });
  await cmdRm(["abcdefgh"], flags);
  expect(outputs[0]).toContain("evil\\u001b[2J");
  process.exitCode = 0;
});
