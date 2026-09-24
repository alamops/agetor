import { test, expect, mock, afterAll } from "bun:test";
import type { AgetorClient } from "./api-client.ts";
import type { Harness, PipelineRunState, Run, Task } from "../shared/types.ts";
import { newStep } from "../shared/pipeline.ts";
import { makeTask } from "./test-fixtures.ts";
import { ApiError } from "./api-client.ts";

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

// Typed via the shared `makeTask` (L-CLI13) — a `Task` field rename now
// fails typecheck here instead of slipping through an `as unknown as Task`.
function task(overrides: Partial<Task> = {}): Task {
  return makeTask({
    id: TASK_ID,
    agent: "fx",
    model: "zai/glm-5.3-flash",
    ...overrides,
  });
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
    getPipelineRun?: AgetorClient["getPipelineRun"];
    pending?: Array<{ id: string; kind: string; taskId: string }>;
  } = {},
): AgetorClient {
  return {
    listTasks: async () => [t],
    getRuns: async () => opts.runs ?? [],
    pendingInteractions: async () => opts.pending ?? [],
    listHarnesses: opts.listHarnesses
      ?? (async () => ({ harnesses: opts.harnesses ?? [], statuses: [] })),
    getPipelineRun: opts.getPipelineRun,
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

test("show: a task bound to an agent profile prints a 'profile:' line (not 'agent profile:') with the snapshot name/id", async () => {
  outputs.length = 0;
  currentClient = makeClient(
    task({
      agent: "claude-code",
      mode: "auto",
      agentProfileId: "prof-1",
      agentProfile: {
        id: "prof-1",
        name: "Reviewer",
        harness: "claude-code",
        harnessKind: "claude-code",
        harnessLabel: "claude-code",
        model: "opus-5",
        effort: null,
        mode: null,
        fast: false,
        maxMode: false,
        instructions: "",
        skills: [],
        capturedAt: 0,
      },
    }),
    { harnesses: [harness("claude-code", "claude-code")] },
  );

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain("profile: Reviewer (prof-1)");
  expect(rendered).not.toContain("agent profile:");
});

test("show: missing task-id argument throws the usage error", async () => {
  outputs.length = 0;
  currentClient = makeClient(task());
  await expect(cmdShow([], flags)).rejects.toThrow(/usage: agetor show/);
});

// ── pipeline (docs/plans/pipelines.md §3 D11/T7) ─────────────────────────

function pipelineRun(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  const s1 = newStep({ id: "s1", name: "Investigate" });
  const s2 = newStep({ id: "s2", name: "Fix" });
  return {
    pipelineId: "pipe-1",
    pipelineName: "Bug fix flow",
    snapshot: {
      graph: { steps: [s1, s2], edges: [{ id: "e1", from: "s1", to: "s2", label: "" }], startStepId: "s1" },
      maxSteps: 25,
      profiles: {},
      capturedAt: 0,
    },
    status: "blocked",
    active: [{ stepId: "s2", taskId: "step-task-1", seq: 2 }],
    joins: {},
    blocked: [{ taskId: "step-task-1", stepId: "s2", kind: "handoff-missing", message: "no <handoff> block found" }],
    history: [
      { seq: 1, stepId: "s1", taskId: "step-task-0", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: null, nextStepIds: ["s2"] },
    ],
    stepCount: 2,
    startedAt: 0,
    endedAt: null,
    ...overrides,
  };
}

test("show: a pipeline (parent) task prints a 'pipeline:' line with name/id/status/steps, and each blocked message", async () => {
  outputs.length = 0;
  currentClient = makeClient(
    task({ pipelineId: "pipe-1", pipelineRun: pipelineRun() }),
  );

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain("pipeline: Bug fix flow (pipe-1)");
  expect(rendered).toContain("status: blocked");
  expect(rendered).toContain("steps: 1/2 · Fix");
  expect(rendered).toContain("no <handoff> block found");
});

test("show: a pipeline task with no blocked entries prints no '⚠' lines", async () => {
  outputs.length = 0;
  currentClient = makeClient(
    task({ pipelineId: "pipe-1", pipelineRun: pipelineRun({ status: "running", blocked: [] }) }),
  );

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain("pipeline: Bug fix flow (pipe-1)");
  expect(rendered).not.toContain("⚠");
});

test("show: a task with no pipelineId prints no 'pipeline:' line even with pipelineRun set (defensive)", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ pipelineId: null, pipelineRun: pipelineRun() }));

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).not.toContain("pipeline:");
});

test("show: a pipeline step task prints a 'step of:' line resolved from the parent's frozen snapshot", async () => {
  outputs.length = 0;
  const parentTask = { id: "parent-1", title: "Fix the login bug", pipelineRun: pipelineRun() } as unknown as Task;
  currentClient = makeClient(
    task({ pipelineParentId: "parent-1", pipelineStepId: "s2" }),
    { getPipelineRun: async () => ({ task: parentTask, steps: [] }) },
  );

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain("step of: Fix the login bug (parent-1) · step Fix");
});

test("show: a pipeline step task with no resolvable step id falls back to its own title", async () => {
  outputs.length = 0;
  const parentTask = { id: "parent-1", title: "Fix the login bug", pipelineRun: pipelineRun() } as unknown as Task;
  currentClient = makeClient(
    task({ pipelineParentId: "parent-1", pipelineStepId: null, title: "Fix step task" }),
    { getPipelineRun: async () => ({ task: parentTask, steps: [] }) },
  );

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain("step of: Fix the login bug (parent-1) · step Fix step task");
});

test("show: a pipeline step task whose parent lookup 404s (orphaned step) says so and that it can be deleted/archived directly", async () => {
  outputs.length = 0;
  currentClient = makeClient(
    task({ pipelineParentId: "parent-1", pipelineStepId: "s2" }),
    {
      getPipelineRun: async () => {
        throw new ApiError(404, { error: "task not found" }, "task not found");
      },
    },
  );

  await expect(cmdShow([TASK_ID], flags)).resolves.toBeUndefined();
  const rendered = outputs.join("\n");
  expect(rendered).toContain(
    "step of: parent-1 (pipeline task no longer exists — this step can be deleted/archived directly)",
  );
});

test("show: a pipeline step task whose parent lookup fails for any other reason still prints the bare parent id (never silently dropped)", async () => {
  outputs.length = 0;
  currentClient = makeClient(
    task({ pipelineParentId: "parent-1", pipelineStepId: "s2" }),
    {
      getPipelineRun: async () => {
        throw new Error("network error");
      },
    },
  );

  await expect(cmdShow([TASK_ID], flags)).resolves.toBeUndefined();
  const rendered = outputs.join("\n");
  expect(rendered).toContain("step of: parent-1");
  expect(rendered).not.toContain("no longer exists");
});

test("show: a pipeline (parent) task annotates its agent line as the start step's harness, and colors the run status via colorRunStatus", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ pipelineId: "pipe-1", pipelineRun: pipelineRun({ status: "done" }) }));

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain("agent: fx (start step's harness — steps own the launch)");
  expect(rendered).toContain("status: done");
});

test("show: a plain task never carries the start-step annotation", async () => {
  outputs.length = 0;
  currentClient = makeClient(task());
  await cmdShow([TASK_ID], flags);
  expect(outputs.join("\n")).not.toContain("start step's harness");
});

test("show: a pending interaction aggregated from a step task names that step task; one on the task itself doesn't", async () => {
  outputs.length = 0;
  currentClient = makeClient(task({ pipelineId: "pipe-1", pipelineRun: pipelineRun() }), {
    pending: [
      { id: "i1", kind: "ask_questions", taskId: "step-task-1abcdef" },
      { id: "i2", kind: "tmux_prompt", taskId: TASK_ID },
    ],
  });

  await cmdShow([TASK_ID], flags);

  const rendered = outputs.join("\n");
  expect(rendered).toContain(`! 2 pending interaction(s) — answer: agetor answer ${TASK_ID.slice(0, 8)}`);
  expect(rendered).toContain("↳ ask_questions on step task step-tas");
  expect(rendered).not.toContain("↳ tmux_prompt");
});

test("show: a task with no pipelineParentId never calls getPipelineRun", async () => {
  outputs.length = 0;
  let called = false;
  currentClient = makeClient(task(), {
    getPipelineRun: async () => {
      called = true;
      return { task: task(), steps: [] };
    },
  });

  await cmdShow([TASK_ID], flags);
  expect(called).toBe(false);
});
