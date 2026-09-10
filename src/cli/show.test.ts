import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { Harness, Run, Task } from "../shared/types.ts";

/**
 * `cmdShow` (commands/show.ts) reaches for a client via `getClient(flags)`
 * internally, same as every other one-shot command — this suite mocks
 * `./context.ts` (for `getClient`) and `./output.ts` (to capture `out()`)
 * and drives the real `cmdShow` against a fake `AgetorClient`, following the
 * same mocking idiom `resume.test.ts`/`files.test.ts` established.
 *
 * Covers the code-review fix (`docs/plans/fx-recovery-follow-ups.md`):
 * `cmdShow` used to print the literal string "auto" for any task with a
 * `null` mode, which is a lie for fx (a null fx mode actually spawns as
 * `yolo`/"Full access" via `defaultModeFor`, not `auto`). It now resolves
 * the task's harness kind and prints `defaultModeFor(kind) + " (default)"`,
 * or "-" when the kind can't be resolved.
 */

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

mock.module("./output.ts", () => ({
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
  errln: () => {},
  printJson: (data: unknown) => {
    outputs.push(JSON.stringify(data));
  },
}));

afterAll(() => {
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdShow } = await import("./commands/show.ts");

const TASK_ID = "abcdefgh12345678";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "T",
    column: "ready",
    runId: null,
    pendingInteractionCount: 0,
    archivedAt: null,
    hasOpenableRun: false,
    agent: "fx",
    model: "zai/glm-5.3-flash",
    mode: null,
    workdir: "/repo",
    branch: null,
    issueUrl: null,
    prompt: "do the thing",
    ...overrides,
  } as unknown as Task;
}

function harness(id: string, kind: Harness["kind"]): Harness {
  return { id, kind, label: id, isBuiltin: true, home: null, bin: null, env: {}, enabled: true };
}

function makeClient(
  t: Task,
  opts: {
    harnesses?: Harness[];
    listHarnesses?: AgetorClient["listHarnesses"];
    runs?: Run[];
  } = {},
): AgetorClient {
  return {
    listTasks: async () => [t],
    getRuns: async () => opts.runs ?? [],
    pendingInteractions: async () => [],
    listHarnesses: opts.listHarnesses
      ?? (async () => ({ harnesses: opts.harnesses ?? [], statuses: [] })),
  } as unknown as AgetorClient;
}

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdShow>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdShow>[1];

test("show: a null-mode fx task with no matching harness row falls back to the built-in agent-id heuristic and prints 'yolo (default)'", async () => {
  outputs.length = 0;
  // No harness rows at all (e.g. listHarnesses 200s with an empty list) —
  // `agent: "fx"` is itself a valid AgentKind for a built-in harness.
  currentClient = makeClient(task({ agent: "fx", mode: null }), { harnesses: [] });

  await cmdShow([TASK_ID], flags);

  const modeLine = outputs.find((l) => l.includes("mode"));
  expect(modeLine).toContain("yolo (default)");
  expect(modeLine).not.toContain(" auto");
});

test("show: a null-mode fx task resolves its kind via listHarnesses when the harness id differs from the AgentKind", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ agent: "fx-work-acct", mode: null }), {
    harnesses: [harness("fx-work-acct", "fx")],
  });

  await cmdShow([TASK_ID], flags);

  const modeLine = outputs.find((l) => l.includes("mode"));
  expect(modeLine).toContain("yolo (default)");
});

test("show: a null-mode claude-code task prints 'auto (default)', not the bare literal 'auto'", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ agent: "claude-code", mode: null }), {
    harnesses: [harness("claude-code", "claude-code")],
  });

  await cmdShow([TASK_ID], flags);

  const modeLine = outputs.find((l) => l.includes("mode"));
  expect(modeLine).toContain("auto (default)");
});

test("show: an explicit stored mode is printed verbatim, with no '(default)' suffix and no harness lookup", async () => {
  outputs.length = 0;
  let lookedUp = false;
  currentClient = makeClient(task({ agent: "fx", mode: "ask" }), {
    listHarnesses: async () => {
      lookedUp = true;
      return { harnesses: [], statuses: [] };
    },
  });

  await cmdShow([TASK_ID], flags);

  const modeLine = outputs.find((l) => l.includes("mode"));
  expect(modeLine).toContain("mode: ask");
  expect(modeLine).not.toContain("(default)");
  expect(lookedUp).toBe(false);
});

test("show: an unresolvable kind (harness gone, agent id not a built-in kind) prints '-'", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ agent: "deleted-custom-harness", mode: null }), {
    harnesses: [],
  });

  await cmdShow([TASK_ID], flags);

  const modeLine = outputs.find((l) => l.includes("mode"));
  expect(modeLine).toContain("mode: -");
});

test("show: a failed listHarnesses call degrades to the built-in-id heuristic instead of throwing", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ agent: "fx", mode: null }), {
    listHarnesses: async () => {
      throw new Error("network error");
    },
  });

  await expect(cmdShow([TASK_ID], flags)).resolves.toBeUndefined();
  const modeLine = outputs.find((l) => l.includes("mode"));
  expect(modeLine).toContain("yolo (default)");
});

test("show --json: never calls listHarnesses (mode resolution is a human-output-only nicety)", async () => {
  outputs.length = 0;
  let lookedUp = false;
  currentClient = makeClient(task({ agent: "fx", mode: null }), {
    listHarnesses: async () => {
      lookedUp = true;
      return { harnesses: [], statuses: [] };
    },
  });

  await cmdShow([TASK_ID], jsonFlags);

  expect(lookedUp).toBe(false);
  expect(outputs).toHaveLength(1);
  const parsed = JSON.parse(outputs[0]!);
  expect(parsed.task.mode).toBeNull();
});

test("show: missing task-id argument throws the usage error", async () => {
  outputs.length = 0;
  currentClient = makeClient(task());
  await expect(cmdShow([], flags)).rejects.toThrow(/usage: agetor show/);
});
