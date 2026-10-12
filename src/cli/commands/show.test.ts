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

const { cmdShow, promptSummary } = await import("./show.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdShow>[1];

beforeEach(() => {
  outputs.length = 0;
});

function fakeClient(task: Task): AgetorClient {
  return {
    listTasks: async () => [task],
    getRuns: async () => [],
    pendingInteractions: async () => [],
    listHarnesses: async () => ({ harnesses: [] }),
  } as unknown as AgetorClient;
}

test("promptSummary: one escaped line, cut to 240 characters", () => {
  // An issue body quoted into the prompt can carry a terminal escape.
  expect(promptSummary("Fix it\n\u001b]0;pwned\u0007 now\r\nplease")).toBe("Fix it \\u001b]0;pwned\\u0007 now please");
  expect(promptSummary("a‮b")).toBe("a\\u202eb");
  const long = promptSummary("x".repeat(500));
  expect(long).toBe(`${"x".repeat(239)}…`);
  expect(promptSummary("plain prompt")).toBe("plain prompt");
});

test("promptSummary: the cut never leaves half an emoji or a stranded joiner", () => {
  // 238 x's + an emoji: the cut at 239 code units would split its surrogate pair.
  expect(promptSummary(`${"x".repeat(238)}🚀${"y".repeat(10)}`)).toBe(`${"x".repeat(238)}…`);
  // A ZWJ left at the end once the emoji it joined is cut off is dropped too.
  expect(promptSummary(`${"x".repeat(236)}👩‍💻${"y".repeat(10)}`)).toBe(`${"x".repeat(236)}👩…`);
});

// ── last-seen checkout (docs/plans/codex-terminal-worktree-error.md T9) ──

test("show prints the last-seen checkout with a drift suffix when it differs", async () => {
  currentClient = fakeClient(makeTask({ isolation: "worktree", branch: "agetor/abc-fix", checkoutBranch: "implement/x" }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs).toContain("  branch: agetor/abc-fix");
  expect(outputs).toContain("  checkout: implement/x (drifted from task branch)");
});

test("show prints the checkout without a suffix when it matches the task branch", async () => {
  currentClient = fakeClient(makeTask({ isolation: "worktree", branch: "agetor/abc-fix", checkoutBranch: "agetor/abc-fix" }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs).toContain("  checkout: agetor/abc-fix");
});

test("show omits the checkout line while it was never observed", async () => {
  currentClient = fakeClient(makeTask({ isolation: "worktree", branch: "agetor/abc-fix", checkoutBranch: null }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs.some((l) => l.includes("checkout:"))).toBe(false);
});

test("show escapes control characters in branch names", async () => {
  currentClient = fakeClient(makeTask({ isolation: "worktree", branch: "agetor/abc", checkoutBranch: "x\u001b[31m" }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs.some((l) => l.includes("checkout: x\\u001b[31m"))).toBe(true);
});
