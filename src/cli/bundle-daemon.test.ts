// CLI-against-real-server coverage for the Agents/Pipelines bundle
// (docs/plans/agents-pipelines-import-export.md TT-C): `agetor export` /
// `agetor import` and the `profile`/`pipeline` export|import shortcuts run
// against an in-process `startApiServer()` over a temp data dir, so the CLI's
// flag handling, the HTTP contract and the server's planner/transaction are
// exercised end to end. Same setup as `agent-profile-daemon.test.ts`:
// `AGETOR_DATA_DIR` and a unique `AGETOR_API_PORT` (4595) are set before any
// `../bun/*` import; `getClient` and the output helpers are mocked so the
// commands talk to this server and their output is captured.
import { test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "./api-client.ts";
import type { Flags } from "./context.ts";
import type { AgentProfile, Pipeline } from "../shared/types.ts";
import { DEFAULT_MODEL } from "../shared/types.ts";
import { parseBundleText } from "../shared/bundle.ts";
import type { BundleImportPlan, BundleImportResponse } from "../shared/bundle-import.ts";
import { rmTestDataDir } from "../bun/test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-bundle-daemon-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port — 4594/4596 are the bundle endpoint test's.
process.env.AGETOR_API_PORT = "4595";
// Harness probes stay local and instant; nothing here ever starts a task.
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_DRIVER = "fake";

const FILES = mkdtempSync(path.join(tmpdir(), "agetor-cli-bundle-files-"));

import * as realContext from "./context.ts";
import * as realOutput from "./output.ts";

const realContextSnapshot = { ...realContext };
const realOutputSnapshot = { ...realOutput };

let currentClient: AgetorClient | null = null;
const outputs: string[] = [];
const errors: string[] = [];
const jsonOutputs: unknown[] = [];

mock.module("./context.ts", () => ({
  ...realContextSnapshot,
  getClient: async () => {
    if (!currentClient) throw new Error("no client set for this test");
    return currentClient;
  },
}));

const id = (s: string) => s;
mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  isTTY: false,
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
  mock.module("./context.ts", () => realContextSnapshot);
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { cmdExport, cmdImport } = await import("./commands/bundle.ts");
const { cmdAgentProfile } = await import("./commands/agent-profile.ts");
const { cmdPipeline } = await import("./commands/pipeline.ts");

let server: { stop: () => void };
let db: typeof import("../bun/db.ts").db;
let harnesses: typeof import("../bun/db.ts").harnesses;
let client: AgetorClient;

beforeAll(async () => {
  ({ db, harnesses } = await import("../bun/db.ts"));
  const { startApiServer, API_TOKEN } = await import("../bun/server.ts");
  const { AgetorClient: RealAgetorClient } = await import("./api-client.ts");
  server = startApiServer() as unknown as { stop: () => void };
  client = new RealAgetorClient({ port: 4595, token: API_TOKEN });
  currentClient = client;
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

function wipe(): void {
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM pipelines`);
  db.run(`DELETE FROM agent_profiles`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`UPDATE harnesses SET enabled = 0 WHERE id = 'codex'`);
}

beforeEach(() => {
  outputs.length = 0;
  errors.length = 0;
  jsonOutputs.length = 0;
});

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, plain: true, noDaemon: true, ...over });
const file = (name: string) => path.join(FILES, name);
const rendered = () => outputs.join("\n");

/** The "source machine": a secondary claude-code account, two Agents and a
 *  Pipeline that uses both (one as a delegation Agent). */
async function seedSourceMachine(): Promise<void> {
  wipe();
  harnesses.insert({ id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" });
  await cmdAgentProfile(
    ["add", "Planner", "--harness", "secondary-claude-code", "--model", "opus-5.5", "--instructions", "Plan it."],
    flags(),
  );
  await cmdAgentProfile(["add", "Helper", "--harness", "claude-code", "--model", "opus-5.5"], flags());
  const profiles = await client.listAgentProfiles();
  const planner = profiles.find((p) => p.name === "Planner")!;
  const helper = profiles.find((p) => p.name === "Helper")!;
  await client.createPipeline({
    name: "Review",
    graph: {
      steps: [
        {
          id: "s1",
          name: "Plan",
          instructions: "Make a plan.",
          agentProfileId: planner.id,
          position: { x: 0, y: 0 },
          subagents: { profileIds: [helper.id], cap: 2 },
          transition: "choose",
          join: "any",
        },
        {
          id: "s2",
          name: "Check",
          instructions: "",
          agentProfileId: helper.id,
          position: { x: 200, y: 0 },
          subagents: { profileIds: [], cap: null },
          transition: "choose",
          join: "any",
        },
      ],
      edges: [{ id: "e1", from: "s1", to: "s2", label: "" }],
      startStepId: "s1",
    },
  });
}

test("round trip: export --all, dry run on a machine without the account, import, import again", async () => {
  await seedSourceMachine();
  const out = file("all.agetor.json");
  await cmdExport(["--all", "--out", out], flags());
  expect(rendered()).toContain(`wrote 2 Agents, 1 Pipeline to ${out}`);
  const parsed = parseBundleText(readFileSync(out, "utf8"));
  if (!parsed.ok) throw new Error(parsed.error);
  const planner = parsed.bundle.agents.find((a) => a.name === "Planner")!;
  expect(planner.harness).toEqual({ id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" });

  // The "target machine": no secondary account, no Agents, no Pipelines.
  wipe();
  outputs.length = 0;
  await cmdImport([out, "--dry-run"], flags());
  const dry = rendered();
  expect(dry).toContain("dry run — nothing was imported");
  expect(dry).toContain("Planner → Claude Code (claude-code) — fallback for Claude Code (secondary) (secondary-claude-code)");
  expect(dry).toContain("! Agent \"Planner\": harness \"Claude Code (secondary)\" (secondary-claude-code) isn't on this machine");
  expect(await client.listAgentProfiles()).toEqual([]);

  outputs.length = 0;
  await cmdImport([out], flags());
  expect(rendered()).toContain("imported 2 Agents, 1 Pipeline");
  const profiles = await client.listAgentProfiles();
  expect(profiles.map((p) => [p.name, p.harness]).sort()).toEqual([
    ["Helper", "claude-code"],
    ["Planner", "claude-code"],
  ]);
  const [pipeline] = await client.listPipelines();
  const byName = new Map(profiles.map((p) => [p.name, p.id] as const));
  expect(pipeline!.graph.steps.map((s) => s.agentProfileId)).toEqual([byName.get("Planner")!, byName.get("Helper")!]);
  expect(pipeline!.graph.steps[0]!.subagents).toEqual({ profileIds: [byName.get("Helper")!], cap: 2 });

  outputs.length = 0;
  await cmdImport([out], flags());
  expect(rendered()).toContain("Planner (imported)");
  const names = (await client.listAgentProfiles()).map((p) => p.name).sort();
  expect(names).toEqual(["Helper", "Helper (imported)", "Planner", "Planner (imported)"]);
  expect((await client.listPipelines()).map((p) => p.name).sort()).toEqual(["Review", "Review (imported)"]);
});

test("pipeline export and profile export print parseable bundles", async () => {
  await seedSourceMachine();
  outputs.length = 0;
  await cmdPipeline(["export", "review"], flags());
  const pipelineBundle = parseBundleText(outputs.join("\n"));
  if (!pipelineBundle.ok) throw new Error(pipelineBundle.error);
  expect(pipelineBundle.bundle.pipelines.map((p) => p.name)).toEqual(["Review"]);
  expect(pipelineBundle.bundle.agents.map((a) => a.name)).toEqual(["Planner", "Helper"]);

  outputs.length = 0;
  await cmdAgentProfile(["export", "Helper"], flags());
  const profileBundle = parseBundleText(outputs.join("\n"));
  if (!profileBundle.ok) throw new Error(profileBundle.error);
  expect(profileBundle.bundle.agents.map((a) => a.name)).toEqual(["Helper"]);
  expect(profileBundle.bundle.pipelines).toEqual([]);
});

test("profile import and --name on an Agents-only file", async () => {
  await seedSourceMachine();
  const out = file("helper.agetor.json");
  await cmdAgentProfile(["export", "Helper", "--out", out, "--force"], flags());
  await cmdAgentProfile(["import", out, "--name", "Helper Two"], flags());
  expect((await client.listAgentProfiles()).map((p) => p.name)).toContain("Helper Two");
  // A typed name that's taken blocks the import instead of being suffixed.
  await expect(cmdAgentProfile(["import", out, "--name", "helper"], flags())).rejects.toThrow(/nothing was imported/);
  expect(rendered()).toContain("pick another --name");
});

test("--name renames a single-pipeline file's pipeline", async () => {
  await seedSourceMachine();
  const out = file("review.agetor.json");
  await cmdPipeline(["export", "Review", "--out", out, "--force"], flags());
  await cmdPipeline(["import", out, "--name", "Review Copy"], flags());
  expect((await client.listPipelines()).map((p) => p.name).sort()).toEqual(["Review", "Review Copy"]);
});

test("an unknown harness kind fails with the --harness-map hint, then imports with a map and reset settings", async () => {
  wipe();
  const out = file("future.agetor.json");
  writeFileSync(
    out,
    JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [
        {
          key: "future",
          name: "Future",
          harness: { id: "grok-2", kind: "grok", label: "Grok" },
          model: "grok-9",
          effort: "max",
          mode: "turbo",
        },
      ],
    }),
  );
  await expect(cmdImport([out], flags())).rejects.toThrow(/nothing was imported — 1 blocking issue/);
  expect(rendered()).toContain("hint: map a file harness to a local one with --harness-map");
  expect(await client.listAgentProfiles()).toEqual([]);

  outputs.length = 0;
  await cmdImport([out, "--harness-map", "grok-2=claude-code"], flags());
  const [agent] = await client.listAgentProfiles();
  expect([agent!.harness, agent!.model, agent!.effort, agent!.mode]).toEqual([
    "claude-code",
    DEFAULT_MODEL["claude-code"],
    null,
    null,
  ]);
});

test("--enable-harnesses enables a disabled harness the Agents land on", async () => {
  wipe();
  const out = file("codex.agetor.json");
  writeFileSync(
    out,
    JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [{ key: "c", name: "Coder", harness: { id: "codex-2", kind: "codex", label: "Codex 2" }, model: "gpt-6.1-sol" }],
    }),
  );
  await cmdImport([out, "--dry-run"], flags());
  expect(rendered()).toContain("pass --enable-harnesses to enable codex");
  outputs.length = 0;
  await cmdImport([out, "--enable-harnesses"], flags());
  expect(rendered()).toContain("enabled harness codex");
  expect(harnesses.get("codex")!.enabled).toBe(true);
});

test("a legacy pipeline file imports through pipeline import, matching Agents by name", async () => {
  wipe();
  await cmdAgentProfile(["add", "Planner", "--harness", "claude-code", "--model", "opus-5.5"], flags());
  const out = file("legacy.json");
  writeFileSync(
    out,
    JSON.stringify({
      name: "Old flow",
      graph: {
        steps: [
          { id: "s1", name: "Plan", agentProfileId: "id-from-elsewhere", profileName: "Planner", position: { x: 0, y: 0 } },
        ],
        edges: [],
        startStepId: "s1",
      },
    }),
  );
  outputs.length = 0;
  await cmdPipeline(["import", out, "--dry-run"], flags());
  expect(rendered()).toContain("legacy file");
  await cmdPipeline(["import", out], flags());
  const [planner] = await client.listAgentProfiles();
  const [pipeline] = await client.listPipelines();
  expect(pipeline!.name).toBe("Old flow");
  expect(pipeline!.graph.steps[0]!.agentProfileId).toBe(planner!.id);
});

test("--out refuses an existing file without --force", async () => {
  await seedSourceMachine();
  const out = file("exists.agetor.json");
  writeFileSync(out, "keep me");
  await expect(cmdExport(["--all", "--out", out], flags())).rejects.toThrow(/refusing to overwrite/);
  expect(readFileSync(out, "utf8")).toBe("keep me");
  await cmdExport(["--all", "--out", out, "--force"], flags());
  expect(readFileSync(out, "utf8")).not.toBe("keep me");
});

test("--json shapes: export, dry run and import", async () => {
  await seedSourceMachine();
  const out = file("json.agetor.json");
  await cmdExport(["--profile", "Helper", "--pipeline", "Review", "--out", out, "--force"], flags({ json: true }));
  expect(jsonOutputs[0]).toEqual({ written: out, counts: { agents: 2, pipelines: 1 }, warnings: [] });
  expect(existsSync(out)).toBe(true);

  wipe();
  jsonOutputs.length = 0;
  await cmdImport([out, "--dry-run"], flags({ json: true }));
  const plan = jsonOutputs[0] as BundleImportPlan;
  expect(plan.canImport).toBe(true);
  expect(plan.agents.map((a) => a.resolution).sort()).toEqual(["exact", "fallback"]);

  jsonOutputs.length = 0;
  await cmdImport([out], flags({ json: true }));
  const result = jsonOutputs[0] as BundleImportResponse;
  expect(result.agents.map((a: AgentProfile) => a.name).sort()).toEqual(["Helper", "Planner"]);
  expect(result.pipelines.map((p: Pipeline) => p.name)).toEqual(["Review"]);
  expect(result.enabledHarnesses).toEqual([]);
});
