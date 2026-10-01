import { test, expect, mock, afterAll, beforeEach, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "../api-client.ts";
import type { BundleExportResponse } from "../../shared/bundle.ts";
import type { BundleImportPlan, BundleImportResponse, PlannedAgent } from "../../shared/bundle-import.ts";
import { makeAgentProfile, makePipelineFixture } from "../test-fixtures.ts";

/**
 * `agetor export` / `agetor import` (and the profile/pipeline shortcuts) —
 * docs/plans/agents-pipelines-import-export.md K15. Same mocking idiom as
 * `pipeline.test.ts`: `../context.ts` for `getClient`, `../output.ts` to
 * capture `out()`/`errln()`/`printJson()` with an identity palette.
 */

import * as realContext from "../context.ts";
import * as realOutput from "../output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const errors: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("../context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no fake client set for this test");
    return currentClient;
  },
}));

const id = (s: string) => s;
mock.module("../output.ts", () => ({
  ...realOutputSnapshot,
  c: { dim: id, bold: id, red: id, green: id, yellow: id, cyan: id, gray: id, magenta: id, blue: id },
  out: (msg = "") => {
    outputs.push(msg);
  },
  errln: (msg = "") => {
    errors.push(msg);
  },
  printJson: (data: unknown) => {
    jsonOutputs.push(data);
  },
}));

afterAll(() => {
  mock.module("../context.ts", () => realContextSnapshot);
  mock.module("../output.ts", () => realOutputSnapshot);
});

const {
  cmdExport,
  cmdExportOne,
  cmdImport,
  cmdImportAs,
  importPlanLines,
  importResultLines,
  parseExportFlags,
  parseHarnessMap,
  parseImportFlags,
} = await import("./bundle.ts");

const flags = { json: false, plain: true, noDaemon: true } as unknown as Parameters<typeof cmdExport>[1];
const jsonFlags = { ...flags, json: true } as unknown as Parameters<typeof cmdExport>[1];

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  jsonOutputs.length = 0;
  currentClient = null;
});

const TEXT = '{\n  "format": "agetor-bundle"\n}\n';

function exportResponse(over: Partial<BundleExportResponse> = {}): BundleExportResponse {
  return {
    bundle: { format: "agetor-bundle", version: 1, exportedAt: "x", agetorVersion: "1.0.0", agents: [], pipelines: [] },
    text: TEXT,
    filename: "x.agetor.json",
    warnings: [],
    counts: { agents: 1, pipelines: 0 },
    ...over,
  };
}

function plannedAgent(over: Partial<PlannedAgent> = {}): PlannedAgent {
  return {
    key: "worker",
    sourceName: "Worker",
    name: "Worker",
    renamed: false,
    fileHarness: { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
    resolution: "fallback",
    harnessId: "claude-code",
    harnessKind: "claude-code",
    harnessLabel: "Claude Code",
    candidateHarnessIds: ["claude-code"],
    model: "opus-5.5",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    warnings: [],
    errors: [],
    ...over,
  };
}

function plan(over: Partial<BundleImportPlan> = {}): BundleImportPlan {
  return {
    legacy: false,
    agents: [],
    pipelines: [],
    harnesses: [],
    localHarnesses: [
      { id: "claude-code", kind: "claude-code", label: "Claude Code", isBuiltin: true, enabled: true, available: true, loggedIn: null, reason: null, installHint: null },
      { id: "codex", kind: "codex", label: "Codex", isBuiltin: true, enabled: false, available: true, loggedIn: null, reason: null, installHint: null },
    ],
    warnings: [],
    blocking: [],
    canImport: true,
    ...over,
  };
}

const VALID_BUNDLE = JSON.stringify({
  format: "agetor-bundle",
  version: 1,
  agents: [
    { key: "worker", name: "Worker", harness: { id: "secondary-claude-code", kind: "claude-code", label: "L" }, model: "opus-5.5" },
  ],
});

async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-bundle-cli-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("flag parsers", () => {
  test("parseExportFlags: repeatable selectors, --agent alias, --all, --out, --force", () => {
    expect(
      parseExportFlags(["--profile", "a", "--agent", "b", "--pipeline", "p", "--out", "-", "--force"]),
    ).toEqual({ profiles: ["a", "b"], pipelines: ["p"], all: false, out: "-", force: true });
    expect(parseExportFlags(["--all"])).toEqual({ profiles: [], pipelines: [], all: true, force: false });
  });

  test("parseExportFlags: unknown flags, positionals and missing values throw", () => {
    expect(() => parseExportFlags(["--nope"])).toThrow(/usage: agetor export/);
    expect(() => parseExportFlags(["stray"])).toThrow(/usage: agetor export/);
    expect(() => parseExportFlags(["--profile"])).toThrow(/needs a value/);
    expect(() => parseExportFlags(["--x"], "profile export")).toThrow(/usage: agetor profile export/);
  });

  test("parseImportFlags: every flag, repeatable --harness-map", () => {
    expect(
      parseImportFlags(["--dry-run", "--harness-map", "a=b", "--harness-map", "c = d", "--name", "N", "--enable-harnesses"]),
    ).toEqual({ dryRun: true, harnessMap: { a: "b", c: "d" }, name: "N", enableHarnesses: true });
    expect(parseImportFlags([])).toEqual({ dryRun: false, harnessMap: {}, enableHarnesses: false });
    expect(() => parseImportFlags(["--force"])).toThrow(/usage: agetor import/);
  });

  test("parseHarnessMap: <fileId>=<localId>, later wins, malformed throws", () => {
    expect(parseHarnessMap(["x=y", "x=z", "a=b=c"])).toEqual({ x: "z", a: "b=c" });
    expect(() => parseHarnessMap(["nope"])).toThrow(/expects <fileHarnessId>=<localHarnessId>/);
    expect(() => parseHarnessMap(["=y"])).toThrow();
    expect(() => parseHarnessMap(["x="])).toThrow();
  });
});

describe("printers", () => {
  test("importPlanLines: agents with their bound harness and resolution, pipelines, warnings", () => {
    const lines = importPlanLines(
      plan({
        agents: [plannedAgent(), plannedAgent({ key: "b", name: "Bee (imported)", sourceName: "Bee", renamed: true, resolution: "exact" })],
        pipelines: [
          { index: 0, sourceName: "P", name: "P", renamed: false, description: "", maxSteps: 25, steps: [], graph: { steps: [], edges: [], startStepId: null }, warnings: [], errors: [] },
        ],
        harnesses: [{ id: "codex", kind: "codex", label: "Codex", enabled: false, canEnable: true, willEnable: false, warnings: [] }],
        warnings: [{ code: "harness-fallback", message: "falls back" }],
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("2 Agents to create:");
    expect(text).toContain("+ Worker → Claude Code (claude-code) — fallback for Claude Code (secondary) (secondary-claude-code)");
    expect(text).toContain('+ Bee (imported) (was "Bee") → Claude Code (claude-code)');
    expect(text).toContain("1 Pipeline to create:");
    expect(text).toContain("+ P — 0 steps");
    expect(text).toContain("! falls back");
    expect(text).toContain("pass --enable-harnesses to enable codex");
  });

  test("importPlanLines: blocking issues carry hints; legacy files are labelled", () => {
    const harness = importPlanLines(
      plan({ legacy: true, blocking: [{ code: "unknown-kind", message: "grok" }], canImport: false }),
    ).join("\n");
    expect(harness).toContain("legacy file");
    expect(harness).toContain("1 blocking issue:");
    expect(harness).toContain("✗ grok");
    expect(harness).toContain("--harness-map <fileHarnessId>=<localHarnessId> — local harnesses: claude-code (claude-code), codex (codex)");
    const name = importPlanLines(plan({ blocking: [{ code: "name-in-use", message: "taken" }] }), { singleNameFlag: true }).join("\n");
    expect(name).toContain("hint: pick another --name");
    const notApplicable = importPlanLines(plan({ blocking: [{ code: "name-not-applicable", message: "x" }] })).join("\n");
    expect(notApplicable).toContain("--name only applies");
  });

  test("importPlanLines: a disabled harness that will be enabled is listed", () => {
    const text = importPlanLines(
      plan({ harnesses: [{ id: "codex", kind: "codex", label: "Codex", enabled: false, canEnable: true, willEnable: true, warnings: [] }] }),
    ).join("\n");
    expect(text).toContain("~ harness Codex (codex) will be enabled");
  });

  test("importResultLines: counts, created items, enabled harnesses, warnings", () => {
    const result: BundleImportResponse = {
      agents: [makeAgentProfile({ id: "a1", name: "Worker" })],
      pipelines: [makePipelineFixture({ id: "p1", name: "Flow" })],
      enabledHarnesses: ["codex"],
      warnings: [{ code: "harness-fallback", message: "falls back" }],
      plan: plan({ agents: [plannedAgent()] }),
    };
    expect(importResultLines(result)).toEqual([
      "✓ imported 1 Agent, 1 Pipeline",
      "  + Agent Worker → Claude Code (claude-code) (a1)",
      "  + Pipeline Flow (p1)",
      "  ✓ enabled harness codex",
      "  ! falls back",
    ]);
  });
});

describe("cmdExport", () => {
  test("resolves --profile/--pipeline refs to ids client-side and prints the text", async () => {
    const sent: unknown[] = [];
    currentClient = {
      listAgentProfiles: async () => [makeAgentProfile({ id: "a1", name: "Worker" })],
      listPipelines: async () => [makePipelineFixture({ id: "p1", name: "Flow" })],
      exportBundle: async (sel: unknown) => {
        sent.push(sel);
        return exportResponse({ warnings: ["left something out"] });
      },
    } as unknown as AgetorClient;
    await cmdExport(["--profile", "worker", "--pipeline", "p1"], flags);
    expect(sent).toEqual([{ agentIds: ["a1"], pipelineIds: ["p1"] }]);
    expect(outputs).toEqual([TEXT.replace(/\n$/, "")]);
    // Warnings never pollute stdout.
    expect(errors).toEqual(["! left something out"]);
  });

  test("--all sends all:true and never lists anything", async () => {
    const sent: unknown[] = [];
    currentClient = { exportBundle: async (sel: unknown) => (sent.push(sel), exportResponse()) } as unknown as AgetorClient;
    await cmdExport(["--all"], flags);
    expect(sent).toEqual([{ all: true }]);
  });

  test("no selector is a usage error; --all with a selector is an error", async () => {
    await expect(cmdExport([], flags)).rejects.toThrow(/usage: agetor export/);
    await expect(cmdExport(["--all", "--profile", "x"], flags)).rejects.toThrow(/can't be combined/);
  });

  test("an unknown ref fails with the profile vocabulary", async () => {
    currentClient = { listAgentProfiles: async () => [] } as unknown as AgetorClient;
    await expect(cmdExport(["--profile", "ghost"], flags)).rejects.toThrow(/unknown profile "ghost"/);
  });

  test("--out writes the file, refuses an existing one without --force, and --json reports it", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "out.agetor.json");
      currentClient = { exportBundle: async () => exportResponse() } as unknown as AgetorClient;
      await cmdExport(["--all", "--out", file], jsonFlags);
      expect(readFileSync(file, "utf8")).toBe(TEXT);
      expect(jsonOutputs).toEqual([{ written: file, counts: { agents: 1, pipelines: 0 }, warnings: [] }]);
      await expect(cmdExport(["--all", "--out", file], flags)).rejects.toThrow(/refusing to overwrite/);
    });
  });

  test("profile export <ref> is the same bundle selected by one Agent", async () => {
    const sent: unknown[] = [];
    const client = {
      listAgentProfiles: async () => [makeAgentProfile({ id: "a1", name: "Worker" })],
      exportBundle: async (sel: unknown) => (sent.push(sel), exportResponse()),
    } as unknown as AgetorClient;
    await cmdExportOne("profile", ["Worker"], flags, client);
    expect(sent).toEqual([{ agentIds: ["a1"], pipelineIds: [] }]);
    await expect(cmdExportOne("profile", [], flags, client)).rejects.toThrow(/usage: agetor profile export/);
    await expect(cmdExportOne("profile", ["Worker", "--pipeline", "p"], flags, client)).rejects.toThrow(
      /usage: agetor profile export/,
    );
  });
});

describe("cmdImport", () => {
  test("sends --harness-map, --name and --enable-harnesses as import options", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const sent: unknown[] = [];
      currentClient = {
        importBundle: async (text: string, options: unknown) => {
          sent.push({ text, options });
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      await cmdImport([file, "--harness-map", "secondary-claude-code=claude-2", "--name", "Solo", "--enable-harnesses"], flags);
      expect(sent).toEqual([
        {
          text: VALID_BUNDLE,
          options: { harnessMap: { "secondary-claude-code": "claude-2" }, singleName: "Solo", enableHarnesses: "all" },
        },
      ]);
    });
  });

  test("--dry-run --json prints the plan; a blocked dry run fails", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      currentClient = { previewBundleImport: async () => plan() } as unknown as AgetorClient;
      await cmdImport([file, "--dry-run"], jsonFlags);
      expect(jsonOutputs).toEqual([plan()]);

      const blocked = plan({ blocking: [{ code: "unknown-kind", message: "x" }], canImport: false });
      currentClient = { previewBundleImport: async () => blocked } as unknown as AgetorClient;
      await expect(cmdImport([file, "--dry-run"], flags)).rejects.toThrow(/would be blocked by 1 issue/);
    });
  });

  test("a blocked import under --json prints the core's error body", async () => {
    const { ApiError } = await import("../api-client.ts");
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      const body = { error: "blocked", plan: plan({ blocking: [{ code: "unknown-kind", message: "x" }], canImport: false }) };
      currentClient = {
        importBundle: async () => {
          throw new ApiError(409, body, "blocked");
        },
      } as unknown as AgetorClient;
      await expect(cmdImport([file], jsonFlags)).rejects.toThrow(/nothing was imported/);
      expect(jsonOutputs).toEqual([body]);
    });
  });

  test("a 400 from the core propagates; a 404 explains an older core", async () => {
    const { ApiError } = await import("../api-client.ts");
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      currentClient = {
        importBundle: async () => {
          throw new ApiError(404, null, "not found");
        },
      } as unknown as AgetorClient;
      await expect(cmdImport([file], flags)).rejects.toThrow(/older than this CLI/);
    });
  });

  test("missing or oversized files fail before any network call", async () => {
    await inTempDir(async (dir) => {
      await expect(cmdImport([], flags)).rejects.toThrow(/usage: agetor import/);
      await expect(cmdImport([path.join(dir, "nope.json")], flags)).rejects.toThrow(/can't read/);
      const big = path.join(dir, "big.json");
      writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 1));
      await expect(cmdImport([big], flags)).rejects.toThrow(/too large/);
    });
  });

  test("profile import / pipeline import run the same import", async () => {
    await inTempDir(async (dir) => {
      const file = path.join(dir, "in.json");
      writeFileSync(file, VALID_BUNDLE);
      let calls = 0;
      const client = {
        importBundle: async () => {
          calls++;
          return { agents: [], pipelines: [], enabledHarnesses: [], warnings: [], plan: plan() } satisfies BundleImportResponse;
        },
      } as unknown as AgetorClient;
      await cmdImportAs("profile", [file], flags, client);
      await cmdImportAs("pipeline", [file], flags, client);
      expect(calls).toBe(2);
      await expect(cmdImportAs("profile", [file, "--bad"], flags, client)).rejects.toThrow(/usage: agetor profile import/);
    });
  });
});
