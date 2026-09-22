import { test, expect, mock, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import type { Pipeline, PipelineGraph, PipelineInput } from "../../shared/types.ts";
import { newStep } from "../../shared/pipeline.ts";

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
  parsePipelineFile,
  parseExportFlags,
  parseImportFlags,
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
  expect(parseExportFlags(["--out", "/tmp/x.json"])).toEqual({ out: "/tmp/x.json" });
});

test("parseExportFlags: no --out leaves it undefined", () => {
  expect(parseExportFlags([])).toEqual({});
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
