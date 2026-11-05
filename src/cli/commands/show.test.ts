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

test("show prints an imported Claude session", async () => {
  currentClient = fakeClient(makeTask({
    importedClaude: {
      sessionId: "sess-1",
      gitBranch: "main",
      importedAt: 1,
      configDir: "/tmp/claude",
      status: "ready",
      backfillOffset: 0,
      error: null,
    },
  }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs).toContain("  imported: sess-1 (on main, ready)");
});

// ── OpenCode (docs/plans/add-opencode-harness.md W3-D) ──────────────────

function opencodeClient(task: Task, harness: { id: string; home: string | null; version: string | null }): AgetorClient {
  return {
    ...fakeClient(task),
    listHarnesses: async () => ({
      harnesses: [{ id: harness.id, kind: "opencode", label: "OpenCode", isBuiltin: false, home: harness.home, bin: null, env: {}, enabled: true }],
      statuses: [{ harnessId: harness.id, version: harness.version }],
    }),
  } as unknown as AgetorClient;
}

test("show prints no opencode server line for an opencode task, whatever the harness or its stored option", async () => {
  currentClient = opencodeClient(makeTask({ agent: "oc-a", opencodeServer: "standalone" }), {
    id: "oc-a",
    home: null,
    version: "opencode v2.1.3",
  });
  await cmdShow(["abcdefgh"], flags);
  expect(outputs.some((l) => l.includes("opencode server"))).toBe(false);
  expect(outputs.some((l) => l.includes("standalone"))).toBe(false);

  outputs.length = 0;
  currentClient = opencodeClient(makeTask({ agent: "oc-b", opencodeServer: "shared" }), {
    id: "oc-b",
    home: "/Users/me/oc-b",
    version: "1.19.4",
  });
  await cmdShow(["abcdefgh"], flags);
  expect(outputs.some((l) => l.includes("opencode server") || l.includes("OpenCode 1"))).toBe(false);
});

test("show skips the harness lookup for a built-in opencode task with a stored mode", async () => {
  let lookups = 0;
  currentClient = {
    ...fakeClient(makeTask({ agent: "opencode", mode: "ask" })),
    listHarnesses: async () => { lookups++; throw new Error("down"); },
  } as unknown as AgetorClient;
  await cmdShow(["abcdefgh"], flags);
  expect(lookups).toBe(0);
  expect(outputs.some((l) => l.includes("mode: ask"))).toBe(true);
});

test("show prints an imported OpenCode session, with the error of a failed import", async () => {
  currentClient = fakeClient(makeTask({
    agent: "opencode",
    importedOpencode: {
      sessionId: "ses_abc123",
      harnessId: "opencode",
      directory: "/repo",
      importedAt: 1,
      status: "failed",
      error: "export timed out",
    },
  }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs).toContain("  imported: ses_abc123 (OpenCode via opencode, failed)");
  expect(outputs).toContain("    ⚠ export timed out");
});

// ── human review gates (docs/architecture/pipelines.md §11) ─────────────

test("show prints pending human reviews and the decide command", async () => {
  const run = {
    pipelineId: "pl-1",
    pipelineName: "P",
    snapshot: {
      graph: {
        steps: [
          { id: "a", name: "A", type: "agent", instructions: "", agentProfileId: null, transition: "choose", join: "any", subagents: { profileIds: [], cap: null }, position: { x: 0, y: 0 } },
          { id: "h", name: "H", type: "human", instructions: "", agentProfileId: null, transition: "choose", join: "any", subagents: { profileIds: [], cap: null }, position: { x: 0, y: 0 } },
        ],
        edges: [{ id: "e", from: "a", to: "h", label: "" }],
        startStepId: "a",
      },
      profiles: {},
      maxSteps: 25,
      capturedAt: 1,
    },
    status: "review",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    humanSteps: [{ stepId: "h", seq: 3, startedAt: 1, arrivals: [{ fromStepId: "a", seq: 2, handoff: null }] }],
    stepCount: 1,
    startedAt: 1,
    endedAt: null,
  } as unknown as NonNullable<Task["pipelineRun"]>;
  currentClient = fakeClient(makeTask({ pipelineId: "pl-1", pipelineRun: run }));
  await cmdShow(["abcdefgh"], flags);
  expect(outputs.some((l) => l.includes("1 pending human review"))).toBe(true);
  expect(outputs.some((l) => l.includes("H  seq 3  from A"))).toBe(true);
  expect(outputs.some((l) => l.includes("agetor pipeline review abcdefgh"))).toBe(true);
});

// ── `agetor harness ls` notices (pure helpers in harness.ts) ─────────────

test("harnessNoticeLines: one escaped line per notice, none when absent", async () => {
  const { harnessNoticeLines, harnessShellLoginHint } = await import("./harness.ts");
  expect(harnessNoticeLines("opencode", {
    notices: ["No OpenCode credentials found — run `opencode auth login`", "", "bad\u001b[2J"],
  })).toEqual([
    "  i opencode No OpenCode credentials found — run `opencode auth login`",
    "  i opencode bad\\u001b[2J",
  ]);
  expect(harnessNoticeLines("codex", {})).toEqual([]);
  expect(harnessNoticeLines("codex", undefined)).toEqual([]);
  expect(harnessShellLoginHint("opencode", "opencode")).toBe("run opencode auth login to authenticate");
  expect(harnessShellLoginHint("claude-code", "claude")).toBe("run claude /login to authenticate");
  expect(harnessShellLoginHint("gemini", "gemini")).toBe("log in to gemini here");
});
