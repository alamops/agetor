import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import type { AgentProfile, Pipeline, PipelineGraph, PipelineInput, PipelineRunState, Task } from "../../shared/types.ts";
import { newStep } from "../../shared/pipeline.ts";
import { makeTask } from "../test-fixtures.ts";

/**
 * `cmdPipeline` (this file's own `commands/pipeline.ts`) reaches for a client
 * via `getClient(flags)` — same mocking idiom `ls.test.ts`/`show.test.ts`/
 * `agent-profile.test.ts` established: mock `../context.ts` (for
 * `getClient`) and `../output.ts` (to capture `out()`/`printJson()`), with
 * `c.*` wrapped to plain identity functions so rendered text carries no ANSI
 * codes to strip.
 */

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

const {
  cmdPipeline,
  formatPipelineListRow,
  pipelineShowLines,
  pipelineStatusLines,
  parsePipelineFile,
  parseExportFlags,
  parseImportFlags,
  parseAdvanceFlags,
  parseRetryFlags,
  resolveStepRef,
  resolveActiveStepRef,
  resolveImportProfiles,
  withProfileHints,
  colorRunStatus,
} = await import("./pipeline.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdPipeline>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdPipeline>[1];

beforeEach(() => {
  outputs.length = 0;
  jsonOutputs.length = 0;
});

// ── fixtures ─────────────────────────────────────────────────────────────

function emptyGraph(): PipelineGraph {
  return { steps: [], edges: [], startStepId: null };
}

function twoStepGraph(): PipelineGraph {
  const a = newStep({ id: "s1", name: "Investigate", agentProfileId: "prof-a" });
  const b = newStep({ id: "s2", name: "Fix", agentProfileId: "prof-b" });
  return {
    steps: [a, b],
    edges: [{ id: "e1", from: "s1", to: "s2", label: "done" }],
    startStepId: "s1",
  };
}

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pipe-123456789",
    name: "Bug fix flow",
    description: "",
    graph: emptyGraph(),
    maxSteps: 25,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeClient(over: Partial<AgetorClient> = {}): AgetorClient {
  return {
    listPipelines: async () => [],
    ...over,
  } as unknown as AgetorClient;
}

// ── task-scoped subcommand fixtures (retry/advance/restart/status) ────────
// `resolveTask` (shared by every task-targeting command) resolves through
// `client.listTasks()`, so these tests stub that instead of `listPipelines`.

// Typed via the shared `makeTask` (L-CLI13) — a `Task` field rename now
// fails typecheck here instead of slipping through an `as unknown as Task`.
function task(over: Partial<Task> = {}): Task {
  return makeTask({
    id: "parent-1",
    title: "Fix the login bug",
    prompt: "p",
    agent: "claude-code",
    column: "running",
    workdir: "/tmp",
    isolation: "worktree",
    pipelineId: "pipe-1",
    ...over,
  });
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "prof-a",
    name: "Investigator",
    harness: "claude-code",
    model: "opus-5",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function pipelineRun(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "pipe-1",
    pipelineName: "Bug fix flow",
    snapshot: {
      graph: {
        steps: [
          { id: "s1", name: "Investigate", instructions: "", agentProfileId: null, position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any" },
          { id: "s2", name: "Fix", instructions: "", agentProfileId: null, position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any" },
        ],
        edges: [{ id: "e1", from: "s1", to: "s2", label: "" }],
        startStepId: "s1",
      },
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

// ── formatPipelineListRow ────────────────────────────────────────────────

test("formatPipelineListRow: id truncated to 8 chars, name, step count, task count", () => {
  const row = formatPipelineListRow(makePipeline({ id: "abcdefgh12345", graph: twoStepGraph(), taskCount: 4 }));
  expect(row).toEqual(["abcdefgh", "Bug fix flow", "2", "4"]);
});

test("formatPipelineListRow: undefined taskCount renders as 0", () => {
  const row = formatPipelineListRow(makePipeline({ taskCount: undefined }));
  expect(row[3]).toBe("0");
});

// ── pipelineShowLines ────────────────────────────────────────────────────

test("pipelineShowLines: an empty pipeline reports 'no steps'", () => {
  const lines = pipelineShowLines(makePipeline());
  expect(lines.join("\n")).toContain("no steps");
  expect(lines[0]).toContain("Bug fix flow");
});

test("pipelineShowLines: description/max-steps/start-step/used-by header line", () => {
  const lines = pipelineShowLines(
    makePipeline({ description: "Fixes reported bugs.", graph: twoStepGraph(), maxSteps: 10, taskCount: 2 }),
  );
  const header = lines.join("\n");
  expect(header).toContain("Fixes reported bugs.");
  expect(header).toContain("max steps: 10");
  expect(header).toContain("start step: Investigate");
  expect(header).toContain("used by: 2 tasks");
});

test("pipelineShowLines: each step prints its profile id, transition/join, and (start) marker on the start step", () => {
  const lines = pipelineShowLines(makePipeline({ graph: twoStepGraph() }));
  const text = lines.join("\n");
  expect(text).toContain("1. Investigate");
  expect(text).toContain("(start)");
  expect(text).toContain("profile: prof-a");
  expect(text).toContain("transition: choose");
  expect(text).toContain("join: any");
  expect(text).toContain("2. Fix");
  expect(text).not.toMatch(/2\. Fix.*\(start\)/s);
});

test("pipelineShowLines: an edge with a label renders 'Target (label)'; a terminal step reports no outgoing edges", () => {
  const lines = pipelineShowLines(makePipeline({ graph: twoStepGraph() }));
  const text = lines.join("\n");
  expect(text).toContain("Fix (done)");
  expect(text).toContain("(terminal — no outgoing edges)");
});

test("pipelineShowLines: an edge with no label renders just the target name", () => {
  const g = twoStepGraph();
  g.edges[0]!.label = "";
  const lines = pipelineShowLines(makePipeline({ graph: g }));
  const text = lines.join("\n");
  expect(text).toContain("→: Fix");
  expect(text).not.toContain("Fix (");
});

test("pipelineShowLines: with a live profile list, a step's profile renders as '<name> (<id>)' and a dangling id as '<id> (missing)'", () => {
  const profiles = [makeProfile({ id: "prof-a", name: "Investigator" })]; // prof-b is NOT defined
  const text = pipelineShowLines(makePipeline({ graph: twoStepGraph() }), profiles).join("\n");
  expect(text).toContain("profile: Investigator (prof-a)");
  expect(text).toContain("profile: prof-b (missing)");
});

test("pipelineShowLines: a null profile list (listing failed) prints bare ids, never a false '(missing)'", () => {
  const text = pipelineShowLines(makePipeline({ graph: twoStepGraph() }), null).join("\n");
  expect(text).toContain("profile: prof-a");
  expect(text).not.toContain("(missing)");
});

test("pipelineShowLines: a step's subagent profiles render resolved by name with the cap", () => {
  const g = twoStepGraph();
  g.steps[0]!.subagents = { profileIds: ["prof-a", "prof-zzz"], cap: 3 };
  const text = pipelineShowLines(makePipeline({ graph: g }), [makeProfile()]).join("\n");
  expect(text).toContain("subagents: Investigator (prof-a), prof-zzz (missing)  (cap 3)");
  // The step with no subagents prints no such line.
  expect(text.split("subagents:").length).toBe(2);
});

test("cmdPipeline show: resolves profile names through listAgentProfiles, and degrades to bare ids when the listing fails", async () => {
  const pipeline = makePipeline({ id: "p1", graph: twoStepGraph() });
  currentClient = makeClient({
    listPipelines: async () => [pipeline],
    listAgentProfiles: async () => [makeProfile({ id: "prof-a", name: "Investigator" })],
  });
  await cmdPipeline(["show", "p1"], flags);
  expect(outputs.join("\n")).toContain("profile: Investigator (prof-a)");
  expect(outputs.join("\n")).toContain("profile: prof-b (missing)");

  outputs.length = 0;
  currentClient = makeClient({
    listPipelines: async () => [pipeline],
    listAgentProfiles: async () => {
      throw new Error("boom");
    },
  });
  await cmdPipeline(["show", "p1"], flags);
  expect(outputs.join("\n")).toContain("profile: prof-a");
  expect(outputs.join("\n")).not.toContain("(missing)");
});

test("colorRunStatus: is exported for `agetor show` (identity under the mocked palette)", () => {
  expect(colorRunStatus("blocked")).toBe("blocked");
  expect(colorRunStatus("done")).toBe("done");
  expect(colorRunStatus("idle")).toBe("idle");
});

test("pipelineShowLines: a step with no bound profile prints 'none'", () => {
  const g = twoStepGraph();
  g.steps[0]!.agentProfileId = null;
  const lines = pipelineShowLines(makePipeline({ graph: g }));
  expect(lines.join("\n")).toContain("profile: none");
});

// ── parsePipelineFile ────────────────────────────────────────────────────

test("parsePipelineFile: a minimal valid file parses into a PipelineInput", () => {
  const result = parsePipelineFile(JSON.stringify({ name: "My pipeline", graph: emptyGraph() }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.input.name).toBe("My pipeline");
    expect(result.input.graph).toEqual(emptyGraph());
    expect(result.input.description).toBeUndefined();
    expect(result.input.maxSteps).toBeUndefined();
  }
});

test("parsePipelineFile: description and maxSteps carry through when present", () => {
  const result = parsePipelineFile(
    JSON.stringify({ name: "P", description: "desc", graph: emptyGraph(), maxSteps: 10 }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.input.description).toBe("desc");
    expect(result.input.maxSteps).toBe(10);
  }
});

test("parsePipelineFile: invalid JSON fails with an 'invalid JSON' error", () => {
  const result = parsePipelineFile("{ not json");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("invalid JSON");
});

test("parsePipelineFile: a JSON array (not an object) is rejected", () => {
  const result = parsePipelineFile("[]");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("JSON object");
});

test("parsePipelineFile: a missing/empty name is rejected", () => {
  expect(parsePipelineFile(JSON.stringify({ graph: emptyGraph() })).ok).toBe(false);
  expect(parsePipelineFile(JSON.stringify({ name: "   ", graph: emptyGraph() })).ok).toBe(false);
});

test("parsePipelineFile: an invalid graph surfaces validatePipelineGraph's own error", () => {
  const result = parsePipelineFile(JSON.stringify({ name: "P", graph: { steps: "nope", edges: [], startStepId: null } }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("graph.steps must be an array");
});

test("parsePipelineFile: a non-integer maxSteps is rejected", () => {
  const result = parsePipelineFile(JSON.stringify({ name: "P", graph: emptyGraph(), maxSteps: 2.5 }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("maxSteps");
});

// ── parseExportFlags / parseImportFlags ──────────────────────────────────

test("parseExportFlags: --out <file>", () => {
  expect(parseExportFlags(["--out", "/tmp/x.json"])).toEqual({ out: "/tmp/x.json", force: false });
});

test("parseExportFlags: no --out leaves it undefined; force defaults false", () => {
  expect(parseExportFlags([])).toEqual({ force: false });
});

test("parseExportFlags: --force sets force; --out - is kept verbatim (stdout)", () => {
  expect(parseExportFlags(["--out", "-", "--force"])).toEqual({ out: "-", force: true });
});

test("parseExportFlags: --out with nothing after it throws 'needs a value'", () => {
  expect(() => parseExportFlags(["--out"])).toThrow(/needs a value/);
});

test("parseImportFlags: --name <n>", () => {
  expect(parseImportFlags(["--name", "Renamed"])).toEqual({ name: "Renamed" });
});

test("parseImportFlags: no --name leaves it undefined", () => {
  expect(parseImportFlags([])).toEqual({});
});

// ── cmdPipeline: ls ──────────────────────────────────────────────────────

test("cmdPipeline ls: no pipelines -> a dim hint, no table", async () => {
  currentClient = makeClient({ listPipelines: async () => [] });
  await cmdPipeline([], flags);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("no pipelines defined");
});

test("cmdPipeline (default subcommand is ls)", async () => {
  currentClient = makeClient({ listPipelines: async () => [] });
  await cmdPipeline([], flags);
  expect(outputs[0]).toContain("no pipelines defined");
});

test("cmdPipeline ls: renders a table row per pipeline", async () => {
  currentClient = makeClient({
    listPipelines: async () => [makePipeline({ id: "p1", name: "Flow A", graph: twoStepGraph(), taskCount: 3 })],
  });
  await cmdPipeline(["ls"], flags);
  const rendered = outputs.join("\n");
  expect(rendered).toContain("Flow A");
  expect(rendered).toContain("p1");
  expect(rendered).toContain("2"); // step count
  expect(rendered).toContain("3"); // task count
});

test("cmdPipeline ls --json: prints the raw array", async () => {
  const pipelines = [makePipeline({ id: "p1" })];
  currentClient = makeClient({ listPipelines: async () => pipelines });
  await cmdPipeline(["ls"], jsonFlags);
  expect(jsonOutputs).toEqual([pipelines]);
});

test("cmdPipeline list: 'list' is an alias for 'ls'", async () => {
  currentClient = makeClient({ listPipelines: async () => [] });
  await cmdPipeline(["list"], flags);
  expect(outputs[0]).toContain("no pipelines defined");
});

// ── cmdPipeline: show ────────────────────────────────────────────────────

test("cmdPipeline show: missing ref throws the usage error", async () => {
  currentClient = makeClient();
  await expect(cmdPipeline(["show"], flags)).rejects.toThrow(/usage: agetor pipeline/);
});

test("cmdPipeline show: unknown ref throws matchPipelineRef's error", async () => {
  currentClient = makeClient({ listPipelines: async () => [makePipeline({ id: "p1", name: "Flow A" })] });
  await expect(cmdPipeline(["show", "does-not-exist"], flags)).rejects.toThrow(/unknown pipeline "does-not-exist"/);
});

test("cmdPipeline show: resolves by id and renders pipelineShowLines", async () => {
  const pipeline = makePipeline({ id: "p1", name: "Flow A", graph: twoStepGraph() });
  currentClient = makeClient({ listPipelines: async () => [pipeline] });
  await cmdPipeline(["show", "p1"], flags);
  expect(outputs).toEqual(pipelineShowLines(pipeline));
});

test("cmdPipeline show: resolves by case-insensitive, trimmed name", async () => {
  const pipeline = makePipeline({ id: "p1", name: "Flow A" });
  currentClient = makeClient({ listPipelines: async () => [pipeline] });
  await cmdPipeline(["show", "  flow a  "], flags);
  expect(outputs[0]).toContain("Flow A");
});

test("cmdPipeline show --json: prints the raw pipeline object", async () => {
  const pipeline = makePipeline({ id: "p1" });
  currentClient = makeClient({ listPipelines: async () => [pipeline] });
  await cmdPipeline(["show", "p1"], jsonFlags);
  expect(jsonOutputs).toEqual([pipeline]);
});

// ── cmdPipeline: rm ──────────────────────────────────────────────────────

test("cmdPipeline rm: missing ref throws the usage error", async () => {
  currentClient = makeClient();
  await expect(cmdPipeline(["rm"], flags)).rejects.toThrow(/usage: agetor pipeline/);
});

test("cmdPipeline rm: resolves the ref and calls deletePipeline with its id", async () => {
  const deleted: string[] = [];
  currentClient = makeClient({
    listPipelines: async () => [makePipeline({ id: "p1", name: "Flow A" })],
    deletePipeline: async (id: string) => {
      deleted.push(id);
    },
  });
  await cmdPipeline(["rm", "Flow A"], flags);
  expect(deleted).toEqual(["p1"]);
  expect(outputs[0]).toContain("removed pipeline");
  expect(outputs[0]).toContain("Flow A");
});

test("cmdPipeline delete: 'delete' is an alias for 'rm'", async () => {
  const deleted: string[] = [];
  currentClient = makeClient({
    listPipelines: async () => [makePipeline({ id: "p1", name: "Flow A" })],
    deletePipeline: async (id: string) => {
      deleted.push(id);
    },
  });
  await cmdPipeline(["delete", "p1"], jsonFlags);
  expect(deleted).toEqual(["p1"]);
  expect(jsonOutputs).toEqual([{ removed: "p1" }]);
});

// ── cmdPipeline: export ──────────────────────────────────────────────────

test("cmdPipeline export: no --out prints PipelineInput JSON to stdout", async () => {
  const pipeline = makePipeline({ id: "p1", name: "Flow A", description: "d", graph: twoStepGraph(), maxSteps: 12 });
  currentClient = makeClient({ listPipelines: async () => [pipeline] });
  await cmdPipeline(["export", "p1"], flags);
  expect(outputs).toHaveLength(1);
  const parsed = JSON.parse(outputs[0]!) as PipelineInput;
  expect(parsed).toEqual({ name: "Flow A", description: "d", graph: twoStepGraph(), maxSteps: 12 });
  // Only PipelineInput fields — no server-assigned id/createdAt/taskCount.
  expect(parsed).not.toHaveProperty("id");
  expect(parsed).not.toHaveProperty("taskCount");
});

test("cmdPipeline export: writes profileName / subagents.profileNames hints when the profile listing is available", async () => {
  const g = twoStepGraph();
  g.steps[0]!.subagents = { profileIds: ["prof-b", "prof-gone"], cap: null };
  const pipeline = makePipeline({ id: "p1", name: "Flow A", graph: g });
  currentClient = makeClient({
    listPipelines: async () => [pipeline],
    listAgentProfiles: async () => [
      makeProfile({ id: "prof-a", name: "Investigator" }),
      makeProfile({ id: "prof-b", name: "Fixer" }),
    ],
  });
  await cmdPipeline(["export", "p1"], flags);
  const parsed = JSON.parse(outputs[0]!) as { graph: { steps: Array<Record<string, unknown>> } };
  expect(parsed.graph.steps[0]!.profileName).toBe("Investigator");
  expect(parsed.graph.steps[0]!.subagents).toEqual({ profileIds: ["prof-b", "prof-gone"], cap: null, profileNames: ["Fixer", null] });
  expect(parsed.graph.steps[1]!.profileName).toBe("Fixer");
  expect(parsed.graph.steps[1]!.subagents).toEqual({ profileIds: [], cap: null }); // no ids → no profileNames key
});

test("withProfileHints: a step whose profile id matches no live profile gets no profileName key at all", () => {
  const input: PipelineInput = { name: "P", graph: twoStepGraph() };
  const hinted = withProfileHints(input, [makeProfile({ id: "prof-a", name: "Investigator" })]);
  const steps = hinted.graph.steps as unknown as Array<Record<string, unknown>>;
  expect(steps[0]!.profileName).toBe("Investigator");
  expect(steps[1]).not.toHaveProperty("profileName");
  // The original input is not mutated.
  expect(input.graph.steps[0]).not.toHaveProperty("profileName");
});

test("cmdPipeline export --out <existing file>: refuses to overwrite without --force (and never hits the network)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    await Bun.write(file, "{}");
    let listed = false;
    currentClient = makeClient({
      listPipelines: async () => {
        listed = true;
        return [makePipeline({ id: "p1" })];
      },
    });
    await expect(cmdPipeline(["export", "p1", "--out", file], flags)).rejects.toThrow(/refusing to overwrite .*--force/);
    expect(listed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{}");

    await cmdPipeline(["export", "p1", "--out", file, "--force"], flags);
    expect((JSON.parse(readFileSync(file, "utf8")) as PipelineInput).name).toBe("Bug fix flow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPipeline export --out -: prints to stdout (symmetry with `import -`)", async () => {
  currentClient = makeClient({ listPipelines: async () => [makePipeline({ id: "p1", name: "Flow A" })] });
  await cmdPipeline(["export", "p1", "--out", "-"], flags);
  expect(outputs).toHaveLength(1);
  expect((JSON.parse(outputs[0]!) as PipelineInput).name).toBe("Flow A");
  expect(outputs[0]).not.toContain("wrote");
});

test("cmdPipeline export: missing ref throws the usage error", async () => {
  currentClient = makeClient();
  await expect(cmdPipeline(["export"], flags)).rejects.toThrow(/usage: agetor pipeline export/);
});

test("cmdPipeline export --out <file>: writes the JSON to disk instead of stdout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    const pipeline = makePipeline({ id: "p1", name: "Flow A", graph: twoStepGraph() });
    currentClient = makeClient({ listPipelines: async () => [pipeline] });
    await cmdPipeline(["export", "p1", "--out", file], flags);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain("wrote");
    expect(outputs[0]).toContain(file);

    const written = JSON.parse(readFileSync(file, "utf8")) as PipelineInput;
    expect(written.name).toBe("Flow A");
    expect(written.graph).toEqual(twoStepGraph());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cmdPipeline: import ──────────────────────────────────────────────────

test("cmdPipeline import: missing file argument throws the usage error", async () => {
  currentClient = makeClient();
  await expect(cmdPipeline(["import"], flags)).rejects.toThrow(/usage: agetor pipeline import/);
});

test("cmdPipeline import: reads, validates, and POSTs the file's PipelineInput", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    const input: PipelineInput = { name: "Flow A", description: "d", graph: twoStepGraph(), maxSteps: 12 };
    await Bun.write(file, JSON.stringify(input));
    const created: PipelineInput[] = [];
    currentClient = makeClient({
      createPipeline: async (i: PipelineInput) => {
        created.push(i);
        return makePipeline({ id: "new-id", ...i });
      },
    });

    await cmdPipeline(["import", file], flags);

    expect(created).toEqual([input]);
    expect(outputs[0]).toContain("imported pipeline");
    expect(outputs[0]).toContain("Flow A");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPipeline import: --name overrides the file's own name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    await Bun.write(file, JSON.stringify({ name: "Flow A", graph: emptyGraph() }));
    const created: PipelineInput[] = [];
    currentClient = makeClient({
      createPipeline: async (i: PipelineInput) => {
        created.push(i);
        return makePipeline({ id: "new-id", ...i });
      },
    });

    await cmdPipeline(["import", file, "--name", "Renamed flow"], flags);

    expect(created[0]!.name).toBe("Renamed flow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPipeline import: a dangling step profile id with a hint that names exactly one live profile is remapped (and reported)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    const g = twoStepGraph(); // prof-a / prof-b — neither exists on "this machine"
    const steps = g.steps as unknown as Array<Record<string, unknown>>;
    steps[0]!.profileName = "Investigator";
    steps[1]!.profileName = "Fixer";
    await Bun.write(file, JSON.stringify({ name: "Flow A", graph: g }));
    const created: PipelineInput[] = [];
    currentClient = makeClient({
      listAgentProfiles: async () => [makeProfile({ id: "local-1", name: "investigator" })], // case-insensitive
      createPipeline: async (i: PipelineInput) => {
        created.push(i);
        return makePipeline({ id: "new-id", ...i });
      },
    });

    await cmdPipeline(["import", file], flags);

    expect(created[0]!.graph.steps[0]!.agentProfileId).toBe("local-1");
    expect(created[0]!.graph.steps[1]!.agentProfileId).toBe("prof-b"); // no unique "Fixer" here — left dangling
    // The posted graph is the validator's normalized shape — hints stripped.
    expect(created[0]!.graph.steps[0]).not.toHaveProperty("profileName");
    const rendered = outputs.join("\n");
    expect(rendered).toContain("imported pipeline");
    expect(rendered).toContain('step "Investigate": agent profile prof-a isn\'t defined here — remapped to "investigator" (local-1)');
    expect(rendered).toContain('! step "Fix": agent profile prof-b ("Fixer") isn\'t defined on this machine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPipeline import --json: remaps and warnings fold into a `warnings` array on the created pipeline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    await Bun.write(file, JSON.stringify({ name: "Flow A", graph: twoStepGraph() }));
    currentClient = makeClient({
      listAgentProfiles: async () => [makeProfile({ id: "prof-a" })], // prof-b dangling, no hint
      createPipeline: async (i: PipelineInput) => makePipeline({ id: "new-id", ...i }),
    });
    await cmdPipeline(["import", file], jsonFlags);
    const printed = jsonOutputs[0] as { id: string; warnings?: string[] };
    expect(printed.id).toBe("new-id");
    expect(printed.warnings).toEqual([
      'step "Fix": agent profile prof-b isn\'t defined on this machine — assign one in the editor before running this pipeline',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPipeline import: every profile id resolving locally prints no warnings and no `warnings` key under --json", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    await Bun.write(file, JSON.stringify({ name: "Flow A", graph: twoStepGraph() }));
    currentClient = makeClient({
      listAgentProfiles: async () => [makeProfile({ id: "prof-a" }), makeProfile({ id: "prof-b", name: "Fixer" })],
      createPipeline: async (i: PipelineInput) => makePipeline({ id: "new-id", ...i }),
    });
    await cmdPipeline(["import", file], jsonFlags);
    expect(jsonOutputs[0] as object).not.toHaveProperty("warnings");
    outputs.length = 0;
    await cmdPipeline(["import", file], flags);
    expect(outputs.join("\n")).not.toContain("!");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdPipeline import: a failed profile listing warns that references weren't checked, but still imports", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "flow-a.json");
  try {
    await Bun.write(file, JSON.stringify({ name: "Flow A", graph: twoStepGraph() }));
    let called = false;
    currentClient = makeClient({
      listAgentProfiles: async () => {
        throw new Error("boom");
      },
      createPipeline: async (i: PipelineInput) => {
        called = true;
        return makePipeline({ id: "new-id", ...i });
      },
    });
    await cmdPipeline(["import", file], flags);
    expect(called).toBe(true);
    expect(outputs.join("\n")).toContain("! couldn't list this machine's agent profiles");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveImportProfiles: subagents.profileIds entries remap by their positional profileNames hint and warn when dangling", () => {
  const g = twoStepGraph();
  g.steps[0]!.subagents = { profileIds: ["gone-1", "gone-2", "prof-a"], cap: 2 };
  const hints = new Map([["s1", { profileName: null, subagentProfileNames: ["Fixer", null, null] }]]);
  const profiles = [makeProfile({ id: "prof-a" }), makeProfile({ id: "prof-b", name: "Fixer" })];
  const r = resolveImportProfiles({ name: "P", graph: g }, hints, profiles);
  expect(r.input.graph.steps[0]!.subagents.profileIds).toEqual(["prof-b", "gone-2", "prof-a"]);
  expect(r.remapped).toHaveLength(1);
  expect(r.remapped[0]).toContain('step "Investigate" subagent: agent profile gone-1 isn\'t defined here — remapped to "Fixer" (prof-b)');
  // gone-2 has no hint → warned; prof-a resolves → silent; s2's prof-b resolves → silent.
  expect(r.warnings).toEqual([
    'step "Investigate" subagent: agent profile gone-2 isn\'t defined on this machine — assign one in the editor before running this pipeline',
  ]);
  // Input is not mutated.
  expect(g.steps[0]!.subagents.profileIds).toEqual(["gone-1", "gone-2", "prof-a"]);
});

test("resolveImportProfiles: an ambiguous hint (two live profiles with that name) is NOT remapped — warned instead", () => {
  const hints = new Map([["s1", { profileName: "Dup", subagentProfileNames: [] }]]);
  const profiles = [makeProfile({ id: "x1", name: "Dup" }), makeProfile({ id: "x2", name: "dup " })];
  const r = resolveImportProfiles({ name: "P", graph: twoStepGraph() }, hints, profiles);
  expect(r.input.graph.steps[0]!.agentProfileId).toBe("prof-a");
  expect(r.remapped).toEqual([]);
  expect(r.warnings.some((w) => w.includes('prof-a ("Dup")'))).toBe(true);
});

test("parsePipelineFile: profileName / subagents.profileNames hints are extracted per step id and stripped from the graph", () => {
  const result = parsePipelineFile(
    JSON.stringify({
      name: "P",
      graph: {
        steps: [
          { ...newStep({ id: "s1", name: "A", agentProfileId: "p1" }), profileName: "Alpha", subagents: { profileIds: ["q1"], cap: null, profileNames: ["Q"] } },
          { ...newStep({ id: "s2", name: "B" }), profileName: 42 },
        ],
        edges: [],
        startStepId: "s1",
      },
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.hints.get("s1")).toEqual({ profileName: "Alpha", subagentProfileNames: ["Q"] });
    expect(result.hints.get("s2")).toEqual({ profileName: null, subagentProfileNames: [] });
    expect(result.input.graph.steps[0]).not.toHaveProperty("profileName");
    expect(result.input.graph.steps[0]!.subagents).toEqual({ profileIds: ["q1"], cap: null });
  }
});

test("cmdPipeline import: an invalid file throws without calling createPipeline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-pipeline-"));
  const file = path.join(dir, "bad.json");
  try {
    await Bun.write(file, "not json");
    let called = false;
    currentClient = makeClient({
      createPipeline: async () => {
        called = true;
        return makePipeline();
      },
    });

    await expect(cmdPipeline(["import", file], flags)).rejects.toThrow(/invalid pipeline file/);
    expect(called).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cmdPipeline: unknown subcommand ──────────────────────────────────────

test("cmdPipeline: an unrecognized subcommand throws", async () => {
  currentClient = makeClient();
  await expect(cmdPipeline(["frobnicate"], flags)).rejects.toThrow(/unknown pipeline subcommand: frobnicate/);
});

// ── resolveStepRef ───────────────────────────────────────────────────────

test("resolveStepRef: resolves by exact step id", () => {
  const g = pipelineRun().snapshot!.graph;
  expect(resolveStepRef(g, "s2")).toBe("s2");
});

test("resolveStepRef: resolves by case-insensitive, trimmed name", () => {
  const g = pipelineRun().snapshot!.graph;
  expect(resolveStepRef(g, "  fix  ")).toBe("s2");
});

test("resolveStepRef: resolves by an edge label (case-insensitive, trimmed) to the edge's TARGET step — parity with resolveNextSteps", () => {
  const g = twoStepGraph(); // e1: s1 → s2, label "done"
  expect(resolveStepRef(g, " DONE ")).toBe("s2");
});

test("resolveStepRef: precedence is name, then id, then label", () => {
  const g: PipelineGraph = {
    steps: [
      newStep({ id: "go", name: "Start" }),
      newStep({ id: "s2", name: "go" }), // NAME "go" collides with step id "go" — name wins
      newStep({ id: "s3", name: "Third" }),
    ],
    edges: [{ id: "e1", from: "go", to: "s3", label: "s2" }], // LABEL "s2" collides with step id "s2" — id wins
    startStepId: "go",
  };
  expect(resolveStepRef(g, "go")).toBe("s2");
  expect(resolveStepRef(g, "s2")).toBe("s2");
  expect(resolveStepRef(g, "s3")).toBe("s3");
});

test("resolveStepRef: a label shared by edges into different targets is ambiguous", () => {
  const g: PipelineGraph = {
    steps: [newStep({ id: "a", name: "A" }), newStep({ id: "b", name: "B" }), newStep({ id: "c", name: "C" })],
    edges: [
      { id: "e1", from: "a", to: "b", label: "next" },
      { id: "e2", from: "a", to: "c", label: "next" },
    ],
    startStepId: "a",
  };
  expect(() => resolveStepRef(g, "next")).toThrow(/ambiguous edge label "next": leads to B, C/);
});

test("resolveStepRef: an unknown ref throws, listing every step name", () => {
  const g = pipelineRun().snapshot!.graph;
  expect(() => resolveStepRef(g, "nope")).toThrow(/unknown step "nope" — steps: Investigate, Fix/);
});

test("resolveStepRef: an ambiguous name throws listing the matches", () => {
  const g: PipelineGraph = {
    steps: [
      newStep({ id: "a1", name: "Review" }),
      newStep({ id: "a2", name: "review" }), // duplicate name at the graph level isn't possible via
    ],                                        // validatePipelineGraph, but resolveStepRef stays defensive
    edges: [],
    startStepId: "a1",
  };
  expect(() => resolveStepRef(g, "review")).toThrow(/ambiguous step "review"/);
});

// ── resolveActiveStepRef ─────────────────────────────────────────────────

test("resolveActiveStepRef: resolves by exact task id", () => {
  const run = pipelineRun({ active: [{ stepId: "s2", taskId: "step-task-12345678", seq: 2 }] });
  expect(resolveActiveStepRef(run, "step-task-12345678")).toBe("step-task-12345678");
});

test("resolveActiveStepRef: resolves by a unique prefix of an active task id", () => {
  const run = pipelineRun({ active: [{ stepId: "s2", taskId: "step-task-12345678", seq: 2 }] });
  expect(resolveActiveStepRef(run, "step-task-1234")).toBe("step-task-12345678");
});

test("resolveActiveStepRef: an ambiguous prefix throws, listing every active execution's short id + step name", () => {
  const run = pipelineRun({
    active: [
      { stepId: "s1", taskId: "step-task-aaa111", seq: 1 },
      { stepId: "s2", taskId: "step-task-aaa222", seq: 2 },
    ],
  });
  expect(() => resolveActiveStepRef(run, "step-task-aaa")).toThrow(/is ambiguous among active executions/);
  try {
    resolveActiveStepRef(run, "step-task-aaa");
    throw new Error("expected to throw");
  } catch (err) {
    const msg = (err as Error).message;
    expect(msg).toContain("Investigate");
    expect(msg).toContain("Fix");
  }
});

test("resolveActiveStepRef: no matching active execution throws, listing candidates", () => {
  const run = pipelineRun({ active: [{ stepId: "s2", taskId: "step-task-12345678", seq: 2 }] });
  expect(() => resolveActiveStepRef(run, "nope")).toThrow(/no active execution matches "nope"/);
});

test("resolveActiveStepRef: no active executions at all reports '(no active executions)'", () => {
  const run = pipelineRun({ active: [] });
  expect(() => resolveActiveStepRef(run, "nope")).toThrow(/\(no active executions\)/);
});

test("resolveActiveStepRef: an empty or whitespace-only ref is rejected outright, not matched against everything", () => {
  // `"anything".startsWith("")` is always true, so a blank `--from ""` must
  // not silently "resolve" to the first active execution.
  const run = pipelineRun({
    active: [
      { stepId: "s1", taskId: "step-task-aaa111", seq: 1 },
      { stepId: "s2", taskId: "step-task-aaa222", seq: 2 },
    ],
  });
  expect(() => resolveActiveStepRef(run, "")).toThrow(/non-empty task id/);
  expect(() => resolveActiveStepRef(run, "   ")).toThrow(/non-empty task id/);
});

// ── parseAdvanceFlags ────────────────────────────────────────────────────

test("parseAdvanceFlags: --next is repeatable", () => {
  expect(parseAdvanceFlags(["--next", "Fix", "--next", "Verify"])).toEqual({
    next: ["Fix", "Verify"],
    finish: false,
  });
});

test("parseAdvanceFlags: --finish sets the flag", () => {
  expect(parseAdvanceFlags(["--finish"])).toEqual({ next: [], finish: true });
});

test("parseAdvanceFlags: --from <task-id>", () => {
  expect(parseAdvanceFlags(["--from", "step-task-1"])).toEqual({ next: [], finish: false, from: "step-task-1" });
});

test("parseAdvanceFlags: no flags -> empty next, finish false, from undefined", () => {
  expect(parseAdvanceFlags([])).toEqual({ next: [], finish: false });
});

test("parseAdvanceFlags: an unknown flag throws the pipeline-advance usage error, instead of being silently ignored", () => {
  expect(() => parseAdvanceFlags(["--frmo", "step-task-1"])).toThrow(/usage: agetor pipeline advance/);
  expect(() => parseAdvanceFlags(["--next", "Fix", "--bogus"])).toThrow(/usage: agetor pipeline advance/);
});

// ── parseRetryFlags ──────────────────────────────────────────────────────

test("parseRetryFlags: --from <task-id>", () => {
  expect(parseRetryFlags(["--from", "step-task-1"])).toEqual({ from: "step-task-1" });
});

test("parseRetryFlags: no flags -> from undefined", () => {
  expect(parseRetryFlags([])).toEqual({});
});

test("parseRetryFlags: an unknown flag throws the pipeline-retry usage error, instead of being silently ignored", () => {
  expect(() => parseRetryFlags(["--bogus"])).toThrow(/usage: agetor pipeline retry/);
});

// ── pipelineStatusLines ──────────────────────────────────────────────────

test("pipelineStatusLines: a task that never ran its pipeline reports so", () => {
  const lines = pipelineStatusLines(task({ pipelineRun: null }), []);
  expect(lines.join("\n")).toContain("pipeline has never run");
});

test("pipelineStatusLines: status/progress header, blocked, active, and history sections", () => {
  const t = task({ pipelineRun: pipelineRun() });
  const lines = pipelineStatusLines(t, []);
  const text = lines.join("\n");
  expect(text).toContain("Fix the login bug");
  expect(text).toContain("Bug fix flow");
  expect(text).toContain("blocked");
  expect(text).toContain("no <handoff> block found");
  expect(text).toContain("active");
  expect(text).toContain("Fix"); // active step s2's name
  expect(text).toContain("history");
  expect(text).toContain("Investigate"); // history entry s1's name
  expect(text).toContain("succeeded");
});

test("pipelineStatusLines: an active step's own live column is shown when its step task is known", () => {
  const t = task({ pipelineRun: pipelineRun() });
  const steps = [task({ id: "step-task-1", column: "blocked", pipelineId: undefined })];
  const lines = pipelineStatusLines(t, steps);
  expect(lines.join("\n")).toContain("blocked");
});

test("pipelineStatusLines: history rows print the response kind and (reminded) when set", () => {
  const t = task({
    pipelineRun: pipelineRun({
      history: [
        {
          seq: 1,
          stepId: "s1",
          taskId: "step-task-0",
          startedAt: 0,
          endedAt: 1,
          outcome: "succeeded",
          handoff: null,
          nextStepIds: ["s2"],
          responseKind: "handoff",
        },
        {
          seq: 2,
          stepId: "s2",
          taskId: "step-task-1",
          startedAt: 1,
          endedAt: null,
          outcome: null,
          handoff: null,
          nextStepIds: [],
          responseKind: "handoff-missing",
          reminder: { at: 5, reason: "handoff-missing", runId: "run-1", detail: "still no valid handoff", delivered: true },
        },
      ],
    }),
  });
  const text = pipelineStatusLines(t, []).join("\n");
  expect(text).toContain("[handoff]");
  expect(text).toContain("[handoff-missing]");
  expect(text).toContain("(reminder sent)");
});

test("pipelineStatusLines: a reminder recorded with delivered:false prints (reminder failed) instead", () => {
  const t = task({
    pipelineRun: pipelineRun({
      history: [
        {
          seq: 1,
          stepId: "s1",
          taskId: "step-task-0",
          startedAt: 0,
          endedAt: null,
          outcome: null,
          handoff: null,
          nextStepIds: [],
          responseKind: "handoff-missing",
          reminder: { at: 5, reason: "handoff-missing", runId: "run-1", detail: "still no valid handoff", delivered: false },
        },
      ],
    }),
  });
  const text = pipelineStatusLines(t, []).join("\n");
  expect(text).toContain("(reminder failed)");
  expect(text).not.toContain("(reminder sent)");
});

test("pipelineStatusLines: a history row with no responseKind/reminder omits both notes", () => {
  const t = task({ pipelineRun: pipelineRun() });
  const lines = pipelineStatusLines(t, []);
  const historyLine = lines.find((l) => l.includes("1. Investigate"));
  expect(historyLine).toBeDefined();
  expect(historyLine).not.toContain("[");
  expect(historyLine).not.toContain("(reminded)");
});

// ── cmdPipeline: retry (task-scoped) ─────────────────────────────────────

test("cmdPipeline retry: missing ref throws the usage error", async () => {
  currentClient = makeClient({ listTasks: async () => [] });
  await expect(cmdPipeline(["retry"], flags)).rejects.toThrow(/usage: agetor pipeline retry/);
});

test("cmdPipeline retry: a non-pipeline task throws", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineId: null })] });
  await expect(cmdPipeline(["retry", "parent-1"], flags)).rejects.toThrow(/is not a pipeline task/);
});

test("cmdPipeline retry: a bad flag fails BEFORE any task lookup (no network round-trip)", async () => {
  let listed = false;
  currentClient = makeClient({
    listTasks: async () => {
      listed = true;
      return [task()];
    },
  });
  await expect(cmdPipeline(["retry", "parent-1", "--bogus"], flags)).rejects.toThrow(/usage: agetor pipeline retry .*--from/);
  expect(listed).toBe(false);
});

test("cmdPipeline retry: a step task id (pipelineParentId set) is refused, pointing at the parent", async () => {
  currentClient = makeClient({
    listTasks: async () => [task({ id: "step-task-1", pipelineId: null, pipelineParentId: "parent-12345678" })],
  });
  await expect(cmdPipeline(["retry", "step-task-1"], flags)).rejects.toThrow(
    /"step-task-1" is a step task of pipeline task parent-1 — target that id instead/,
  );
});

test("cmdPipeline status: a step task id is refused too (every task-scoped subcommand shares the guard)", async () => {
  currentClient = makeClient({
    listTasks: async () => [task({ id: "step-task-1", pipelineId: null, pipelineParentId: "parent-12345678" })],
  });
  await expect(cmdPipeline(["status", "step-task-1"], flags)).rejects.toThrow(/is a step task of pipeline task parent-1/);
});

test("cmdPipeline retry: resolves the task and calls retryPipeline", async () => {
  const retried: string[] = [];
  currentClient = makeClient({
    listTasks: async () => [task()],
    retryPipeline: async (id: string) => {
      retried.push(id);
      return task();
    },
  });
  await cmdPipeline(["retry", "parent-1"], flags);
  expect(retried).toEqual(["parent-1"]);
  expect(outputs[0]).toContain("retrying pipeline");
});

test("cmdPipeline retry --json: prints the raw task", async () => {
  const updated = task({ column: "running" });
  currentClient = makeClient({ listTasks: async () => [task()], retryPipeline: async () => updated });
  await cmdPipeline(["retry", "parent-1"], jsonFlags);
  expect(jsonOutputs).toEqual([updated]);
});

test("cmdPipeline retry --from <task-id>: resolves against the run's active executions and forwards it", async () => {
  const calls: Array<{ id: string; targetTaskId: string | undefined }> = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    retryPipeline: async (id: string, targetTaskId?: string) => {
      calls.push({ id, targetTaskId });
      return task();
    },
  });
  await cmdPipeline(["retry", "parent-1", "--from", "step-task-1"], flags);
  expect(calls).toEqual([{ id: "parent-1", targetTaskId: "step-task-1" }]);
});

test("cmdPipeline retry --from <prefix>: a unique prefix of an active task id resolves too", async () => {
  const calls: Array<{ id: string; targetTaskId: string | undefined }> = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    retryPipeline: async (id: string, targetTaskId?: string) => {
      calls.push({ id, targetTaskId });
      return task();
    },
  });
  await cmdPipeline(["retry", "parent-1", "--from", "step-task-"], flags);
  expect(calls).toEqual([{ id: "parent-1", targetTaskId: "step-task-1" }]);
});

test("cmdPipeline retry --from with no matching active execution throws", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: pipelineRun() })] });
  await expect(cmdPipeline(["retry", "parent-1", "--from", "nope"], flags)).rejects.toThrow(
    /no active execution matches "nope"/,
  );
});

test("cmdPipeline retry --from before a first Run (no pipelineRun) throws", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: null })] });
  await expect(cmdPipeline(["retry", "parent-1", "--from", "step-task-1"], flags)).rejects.toThrow(
    /pipeline has never run — nothing to retry/,
  );
});

test("cmdPipeline retry without --from omits targetTaskId (retries everything eligible)", async () => {
  const calls: Array<{ id: string; targetTaskId: string | undefined }> = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    retryPipeline: async (id: string, targetTaskId?: string) => {
      calls.push({ id, targetTaskId });
      return task();
    },
  });
  await cmdPipeline(["retry", "parent-1"], flags);
  expect(calls).toEqual([{ id: "parent-1", targetTaskId: undefined }]);
});

// ── cmdPipeline: advance (task-scoped) ───────────────────────────────────

test("cmdPipeline advance: missing ref throws the usage error", async () => {
  currentClient = makeClient({ listTasks: async () => [] });
  await expect(cmdPipeline(["advance"], flags)).rejects.toThrow(/usage: agetor pipeline advance/);
});

test("cmdPipeline advance: neither --next nor --finish throws the usage error", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: pipelineRun() })] });
  await expect(cmdPipeline(["advance", "parent-1"], flags)).rejects.toThrow(/usage: agetor pipeline advance/);
});

test("cmdPipeline advance: --next and --finish together throws", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: pipelineRun() })] });
  await expect(
    cmdPipeline(["advance", "parent-1", "--next", "Fix", "--finish"], flags),
  ).rejects.toThrow(/mutually exclusive/);
});

test("cmdPipeline advance: --finish sends nextStepIds: null", async () => {
  const bodies: unknown[] = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    advancePipeline: async (id: string, body: unknown) => {
      bodies.push({ id, body });
      return task();
    },
  });
  await cmdPipeline(["advance", "parent-1", "--finish"], flags);
  expect(bodies).toEqual([{ id: "parent-1", body: { nextStepIds: null } }]);
  expect(outputs[0]).toContain("advanced pipeline");
});

test("cmdPipeline advance: --next <name> resolves against the run's snapshot graph", async () => {
  const bodies: unknown[] = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    advancePipeline: async (id: string, body: unknown) => {
      bodies.push({ id, body });
      return task();
    },
  });
  await cmdPipeline(["advance", "parent-1", "--next", "Fix"], flags);
  expect(bodies).toEqual([{ id: "parent-1", body: { nextStepIds: ["s2"] } }]);
});

test("cmdPipeline advance: --next by step id works too", async () => {
  const bodies: unknown[] = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    advancePipeline: async (id: string, body: unknown) => {
      bodies.push({ id, body });
      return task();
    },
  });
  await cmdPipeline(["advance", "parent-1", "--next", "s2"], flags);
  expect(bodies).toEqual([{ id: "parent-1", body: { nextStepIds: ["s2"] } }]);
});

test("cmdPipeline advance: --next by edge label resolves to the edge's target step", async () => {
  const bodies: unknown[] = [];
  const run = pipelineRun();
  run.snapshot!.graph.edges[0]!.label = "fix it";
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: run })],
    advancePipeline: async (id: string, body: unknown) => {
      bodies.push({ id, body });
      return task();
    },
  });
  await cmdPipeline(["advance", "parent-1", "--next", "Fix It"], flags);
  expect(bodies).toEqual([{ id: "parent-1", body: { nextStepIds: ["s2"] } }]);
});

test("cmdPipeline advance: a bad flag fails BEFORE any task lookup (no network round-trip)", async () => {
  let listed = false;
  currentClient = makeClient({
    listTasks: async () => {
      listed = true;
      return [task({ pipelineRun: pipelineRun() })];
    },
  });
  await expect(cmdPipeline(["advance", "parent-1", "--bogus"], flags)).rejects.toThrow(/usage: agetor pipeline advance/);
  await expect(cmdPipeline(["advance", "parent-1", "--next", "Fix", "--finish"], flags)).rejects.toThrow(/mutually exclusive/);
  await expect(cmdPipeline(["advance", "parent-1"], flags)).rejects.toThrow(/usage: agetor pipeline advance/);
  expect(listed).toBe(false);
});

test("cmdPipeline advance: a step task id (pipelineParentId set) is refused, pointing at the parent", async () => {
  currentClient = makeClient({
    listTasks: async () => [task({ id: "step-task-1", pipelineId: null, pipelineParentId: "parent-12345678" })],
  });
  await expect(cmdPipeline(["advance", "step-task-1", "--finish"], flags)).rejects.toThrow(
    /"step-task-1" is a step task of pipeline task parent-1 — target that id instead/,
  );
});

test("cmdPipeline advance: an unknown --next step name throws, listing candidates", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: pipelineRun() })] });
  await expect(cmdPipeline(["advance", "parent-1", "--next", "Nope"], flags)).rejects.toThrow(
    /unknown step "Nope" — steps: Investigate, Fix/,
  );
});

test("cmdPipeline advance: --from is forwarded as fromTaskId", async () => {
  const bodies: unknown[] = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    advancePipeline: async (id: string, body: unknown) => {
      bodies.push({ id, body });
      return task();
    },
  });
  await cmdPipeline(["advance", "parent-1", "--finish", "--from", "step-task-1"], flags);
  expect(bodies).toEqual([{ id: "parent-1", body: { nextStepIds: null, fromTaskId: "step-task-1" } }]);
});

test("cmdPipeline advance: --from accepts a unique prefix of an active task id", async () => {
  const bodies: unknown[] = [];
  currentClient = makeClient({
    listTasks: async () => [task({ pipelineRun: pipelineRun() })],
    advancePipeline: async (id: string, body: unknown) => {
      bodies.push({ id, body });
      return task();
    },
  });
  await cmdPipeline(["advance", "parent-1", "--finish", "--from", "step-task-"], flags);
  expect(bodies).toEqual([{ id: "parent-1", body: { nextStepIds: null, fromTaskId: "step-task-1" } }]);
});

test("cmdPipeline advance: --from with no matching active execution throws, listing candidates", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: pipelineRun() })] });
  await expect(
    cmdPipeline(["advance", "parent-1", "--finish", "--from", "nope"], flags),
  ).rejects.toThrow(/no active execution matches "nope"/);
});

test("cmdPipeline advance: --from before a first Run (no pipelineRun) throws", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: null })] });
  await expect(
    cmdPipeline(["advance", "parent-1", "--finish", "--from", "step-task-1"], flags),
  ).rejects.toThrow(/pipeline has never run — nothing to advance/);
});

test("cmdPipeline advance: --next before a first Run (no snapshot) throws", async () => {
  currentClient = makeClient({ listTasks: async () => [task({ pipelineRun: null })] });
  await expect(cmdPipeline(["advance", "parent-1", "--next", "Fix"], flags)).rejects.toThrow(
    /no run snapshot yet/,
  );
});

// ── cmdPipeline: restart (task-scoped) ───────────────────────────────────

test("cmdPipeline restart: missing ref throws the usage error", async () => {
  currentClient = makeClient({ listTasks: async () => [] });
  await expect(cmdPipeline(["restart"], flags)).rejects.toThrow(/usage: agetor pipeline restart/);
});

test("cmdPipeline restart: resolves the task and calls restartPipeline", async () => {
  const restarted: string[] = [];
  currentClient = makeClient({
    listTasks: async () => [task()],
    restartPipeline: async (id: string) => {
      restarted.push(id);
      return { runId: "run-1" };
    },
  });
  await cmdPipeline(["restart", "parent-1"], flags);
  expect(restarted).toEqual(["parent-1"]);
  expect(outputs[0]).toContain("restarted pipeline");
  expect(outputs[0]).toContain("run-1".slice(0, 8));
});

test("cmdPipeline restart: pending: true prints the still-launching message", async () => {
  currentClient = makeClient({
    listTasks: async () => [task()],
    restartPipeline: async () => ({ runId: "run-1", pending: true as const }),
  });
  await cmdPipeline(["restart", "parent-1"], flags);
  expect(outputs[0]).toContain("restarting pipeline");
  expect(outputs[0]).toContain("still in progress");
});

test("cmdPipeline restart --json: prints the raw { runId, pending? } response", async () => {
  const res = { runId: "run-1", pending: true as const };
  currentClient = makeClient({ listTasks: async () => [task()], restartPipeline: async () => res });
  await cmdPipeline(["restart", "parent-1"], jsonFlags);
  expect(jsonOutputs).toEqual([res]);
});

// ── cmdPipeline: status (task-scoped) ────────────────────────────────────

test("cmdPipeline status: missing ref throws the usage error", async () => {
  currentClient = makeClient({ listTasks: async () => [] });
  await expect(cmdPipeline(["status"], flags)).rejects.toThrow(/usage: agetor pipeline status/);
});

test("cmdPipeline status: resolves the task, fetches the pipeline run, and renders pipelineStatusLines", async () => {
  const t = task({ pipelineRun: pipelineRun() });
  currentClient = makeClient({
    listTasks: async () => [t],
    getPipelineRun: async (id: string) => {
      expect(id).toBe("parent-1");
      return { task: t, steps: [] };
    },
  });
  await cmdPipeline(["status", "parent-1"], flags);
  expect(outputs).toEqual(pipelineStatusLines(t, []));
});

test("cmdPipeline status --json: prints { task, steps }", async () => {
  const t = task({ pipelineRun: pipelineRun() });
  const steps = [task({ id: "step-task-1" })];
  currentClient = makeClient({
    listTasks: async () => [t],
    getPipelineRun: async () => ({ task: t, steps }),
  });
  await cmdPipeline(["status", "parent-1"], jsonFlags);
  expect(jsonOutputs).toEqual([{ task: t, steps }]);
});
