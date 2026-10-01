// Route-level tests for the Agents/Pipelines bundle (docs/plans/
// agents-pipelines-import-export.md K4, TT-B): `/bundle/export`,
// `/bundle/export/save`, `/bundle/pick-file`, `/bundle/import/preview` and
// `/bundle/import`. AGETOR_DATA_DIR and the ports are set at module scope
// BEFORE `./db.ts`/`./server.ts` are imported. Two servers run: a headless one
// (no native bridge, like the CLI daemon) and one with `makeTestNative`, so
// the reveal / native-panel / 501 branches are all reachable.
import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentProfile, Pipeline } from "../shared/types.ts";
import { BUNDLE_MAX_BYTES, parseBundleText } from "../shared/bundle.ts";
import type { BundleImportPlan } from "../shared/bundle-import.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeTestNative } from "./test-native.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-bundle-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Keep every harness probe cheap and local: no real CLI is ever spawned.
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
const DOWNLOADS = path.join(DATA_DIR, "fake-downloads");
const PICKS = path.join(DATA_DIR, "fake-picks");
process.env.AGETOR_DOWNLOADS_DIR = DOWNLOADS;
// Unique ports (4594 headless, 4596 with a native bridge); 4595 is the CLI
// round-trip test's.
const HEADLESS = "http://127.0.0.1:4594";
const NATIVE = "http://127.0.0.1:4596";

const revealed: string[] = [];
let dialogResult: string[] = [];
const dialogCalls: Record<string, unknown>[] = [];

let servers: { stop: () => void }[] = [];
let token: string;
let db: typeof import("./db.ts").db;
let harnesses: typeof import("./db.ts").harnesses;

beforeAll(async () => {
  ({ db, harnesses } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  process.env.AGETOR_API_PORT = "4594";
  const headless = startApiServer() as unknown as { stop: () => void };
  process.env.AGETOR_API_PORT = "4596";
  const withNative = startApiServer({
    native: makeTestNative({
      revealPath: (p) => {
        revealed.push(p);
        return true;
      },
      openFileDialog: async (opts) => {
        dialogCalls.push(opts);
        return dialogResult;
      },
    }),
  }) as unknown as { stop: () => void };
  servers = [headless, withNative];
  token = API_TOKEN;
});

afterAll(() => {
  for (const s of servers) s.stop();
  rmTestDataDir(DATA_DIR);
});

beforeEach(() => {
  db.run(`DROP TRIGGER IF EXISTS bundle_test_fail_insert`);
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM pipelines`);
  db.run(`DELETE FROM agent_profiles`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`UPDATE harnesses SET enabled = 0 WHERE id = 'codex'`);
  rmSync(DOWNLOADS, { recursive: true, force: true });
  rmSync(PICKS, { recursive: true, force: true });
  delete process.env.AGETOR_FAKE_PICK_REFS_DIR;
  revealed.length = 0;
  dialogCalls.length = 0;
  dialogResult = [];
});

const call = (p: string, body: unknown, base = HEADLESS, headers: Record<string, string> = {}) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const get = async <T>(p: string): Promise<T> => {
  const res = await fetch(`${HEADLESS}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as T;
};

async function createProfile(body: Record<string, unknown>): Promise<AgentProfile> {
  const res = await call("/agent-profiles", { harness: "claude-code", model: "opus-5.5", ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentProfile;
}

async function createPipeline(name: string, steps: { id: string; name: string; profileId: string | null; sub?: string[] }[]) {
  const res = await call("/pipelines", {
    name,
    graph: {
      steps: steps.map((s, i) => ({
        id: s.id,
        name: s.name,
        instructions: `do ${s.name}`,
        agentProfileId: s.profileId,
        position: { x: i * 100, y: 0 },
        subagents: { profileIds: s.sub ?? [], cap: null },
      })),
      edges: steps.slice(1).map((s, i) => ({ id: `e${i}`, from: steps[i]!.id, to: s.id, label: "" })),
      startStepId: steps[0]?.id ?? null,
    },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Pipeline;
}

function addSecondaryHarness(kind: "claude-code" | "codex" = "claude-code") {
  harnesses.insert({ id: "secondary-claude-code", kind, label: "Claude Code (secondary)" });
}

/** A bundle exported from a "machine" that has the secondary harness. */
async function exportedSecondaryBundle(): Promise<string> {
  addSecondaryHarness();
  const planner = await createProfile({ name: "Planner", harness: "secondary-claude-code", skills: [] });
  const helper = await createProfile({ name: "Helper" });
  await createPipeline("Review", [
    { id: "s1", name: "Plan", profileId: planner.id, sub: [helper.id] },
    { id: "s2", name: "Check", profileId: helper.id },
  ]);
  const res = await call("/bundle/export", { all: true });
  expect(res.status).toBe(200);
  const { text } = (await res.json()) as { text: string };
  db.run(`DELETE FROM pipelines`);
  db.run(`DELETE FROM agent_profiles`);
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  return text;
}

test("every bundle route requires the bearer token", async () => {
  for (const route of ["/bundle/export", "/bundle/export/save", "/bundle/pick-file", "/bundle/import/preview", "/bundle/import"]) {
    const res = await fetch(`${HEADLESS}${route}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  }
});

describe("POST /bundle/export", () => {
  test("exports by ids and embeds the referenced Agents once", async () => {
    addSecondaryHarness();
    const planner = await createProfile({ name: "Planner", harness: "secondary-claude-code" });
    const solo = await createProfile({ name: "Solo" });
    const pipeline = await createPipeline("Review", [
      { id: "s1", name: "Plan", profileId: planner.id, sub: [planner.id] },
      { id: "s2", name: "Again", profileId: planner.id },
    ]);
    const res = await call("/bundle/export", { pipelineIds: [pipeline.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: { agents: { key: string; harness: unknown }[]; pipelines: { graph: { steps: { agent: string }[] } }[] };
      text: string;
      filename: string;
      warnings: string[];
      counts: { agents: number; pipelines: number };
    };
    expect(body.counts).toEqual({ agents: 1, pipelines: 1 });
    expect(body.filename).toBe("review.agetor.json");
    expect(body.bundle.agents[0]!.harness).toEqual({
      id: "secondary-claude-code",
      kind: "claude-code",
      label: "Claude Code (secondary)",
    });
    expect(body.bundle.pipelines[0]!.graph.steps.map((s) => s.agent)).toEqual(["planner", "planner"]);
    expect(body.text).toBe(`${JSON.stringify(body.bundle, null, 2)}\n`);
    expect(body.text).not.toContain(planner.id);

    const one = await call("/bundle/export", { agentIds: [solo.id] });
    expect(((await one.json()) as { filename: string }).filename).toBe("solo.agetor.json");
  });

  test("all exports everything; unknown ids and empty selections are 400", async () => {
    await createProfile({ name: "A" });
    await createPipeline("P", [{ id: "s1", name: "One", profileId: null }]);
    const all = (await (await call("/bundle/export", { all: true })).json()) as { counts: unknown; filename: string };
    expect(all.counts).toEqual({ agents: 1, pipelines: 1 });
    expect(all.filename).toMatch(/^agetor-export-\d{4}-\d{2}-\d{2}\.agetor\.json$/);

    const unknown = await call("/bundle/export", { agentIds: ["nope"] });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('"nope"');
    expect((await call("/bundle/export", {})).status).toBe(400);
    expect((await call("/bundle/export", { agentIds: "x" })).status).toBe(400);
    expect((await call("/bundle/export", { all: true, agentIds: ["x"] })).status).toBe(400);
  });
});

describe("POST /bundle/export/save", () => {
  test("Save to Downloads writes the export text, numbers a second save, and reports revealed:false headless", async () => {
    const p = await createProfile({ name: "Worker" });
    const exported = (await (await call("/bundle/export", { agentIds: [p.id] })).json()) as { text: string };

    const first = await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" });
    expect(first.status).toBe(200);
    const a = (await first.json()) as { path: string; filename: string; revealed: boolean; counts: unknown };
    expect(a.filename).toBe("worker.agetor.json");
    expect(a.path).toBe(path.join(DOWNLOADS, "worker.agetor.json"));
    expect(a.revealed).toBe(false);
    expect(a.counts).toEqual({ agents: 1, pipelines: 0 });
    const written = readFileSync(a.path, "utf8");
    // `exportedAt` differs between two requests; everything else is identical.
    expect(written.replace(/"exportedAt": "[^"]+"/, "")).toBe(exported.text.replace(/"exportedAt": "[^"]+"/, ""));

    const second = (await (await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" })).json()) as {
      filename: string;
    };
    expect(second.filename).toBe("worker (2).agetor.json");
    expect(readdirSync(DOWNLOADS).sort()).toEqual(["worker (2).agetor.json", "worker.agetor.json"]);
  });

  test("with a native bridge, Save to Downloads reveals the file", async () => {
    const p = await createProfile({ name: "Worker" });
    const res = await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" }, NATIVE);
    const body = (await res.json()) as { path: string; revealed: boolean };
    expect(body.revealed).toBe(true);
    expect(revealed).toEqual([body.path]);
  });

  test("Choose folder uses the fake-pick seam directory", async () => {
    const p = await createProfile({ name: "Worker" });
    mkdirSync(PICKS, { recursive: true });
    process.env.AGETOR_FAKE_PICK_REFS_DIR = PICKS;
    const res = await call("/bundle/export/save", { agentIds: [p.id], target: "folder" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; revealed: boolean };
    expect(body.path).toBe(path.join(PICKS, "worker.agetor.json"));
    expect(body.revealed).toBe(false);
    expect(existsSync(body.path)).toBe(true);
  });

  test("Choose folder is 501 headless without the seam, and cancelled when the panel returns nothing", async () => {
    const p = await createProfile({ name: "Worker" });
    expect((await call("/bundle/export/save", { agentIds: [p.id], target: "folder" })).status).toBe(501);

    dialogResult = [""];
    const cancelled = await call("/bundle/export/save", { agentIds: [p.id], target: "folder" }, NATIVE);
    expect(await cancelled.json()).toEqual({ cancelled: true });
    expect(dialogCalls[0]).toMatchObject({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });

    const dir = path.join(DATA_DIR, "picked-folder");
    dialogResult = [dir];
    mkdirSync(dir, { recursive: true });
    const saved = (await (await call("/bundle/export/save", { agentIds: [p.id], target: "folder" }, NATIVE)).json()) as {
      path: string;
    };
    expect(saved.path).toBe(path.join(dir, "worker.agetor.json"));
  });

  test("a bad target or selection is 400", async () => {
    const p = await createProfile({ name: "Worker" });
    expect((await call("/bundle/export/save", { agentIds: [p.id], target: "desktop" })).status).toBe(400);
    expect((await call("/bundle/export/save", { agentIds: ["nope"], target: "downloads" })).status).toBe(400);
  });
});

describe("POST /bundle/pick-file", () => {
  test("the seam returns the first .json file in name order", async () => {
    mkdirSync(PICKS, { recursive: true });
    writeFileSync(path.join(PICKS, "b.json"), '{"b":1}');
    writeFileSync(path.join(PICKS, "a.agetor.json"), '{"a":1}');
    writeFileSync(path.join(PICKS, "0-notes.txt"), "not json");
    process.env.AGETOR_FAKE_PICK_REFS_DIR = PICKS;
    const res = await call("/bundle/pick-file", {});
    expect(await res.json()).toEqual({ text: '{"a":1}', filename: "a.agetor.json" });
  });

  test("an over-size file is 400; an empty seam directory is a cancelled pick", async () => {
    mkdirSync(PICKS, { recursive: true });
    process.env.AGETOR_FAKE_PICK_REFS_DIR = PICKS;
    expect(await (await call("/bundle/pick-file", {})).json()).toEqual({ cancelled: true });
    writeFileSync(path.join(PICKS, "big.json"), "x".repeat(BUNDLE_MAX_BYTES + 1));
    const res = await call("/bundle/pick-file", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("too large");
  });

  test("headless without the seam is 501; the native panel is filtered to json", async () => {
    expect((await call("/bundle/pick-file", {})).status).toBe(501);
    const file = path.join(DATA_DIR, "chosen.json");
    writeFileSync(file, "{}");
    dialogResult = [file];
    const res = await call("/bundle/pick-file", {}, NATIVE);
    expect(await res.json()).toEqual({ text: "{}", filename: "chosen.json" });
    expect(dialogCalls[0]).toMatchObject({ allowedFileTypes: "json", canChooseFiles: true, allowsMultipleSelection: false });
  });
});

describe("POST /bundle/import/preview", () => {
  test("a missing additional-account harness falls back to the built-in with a warning", async () => {
    const text = await exportedSecondaryBundle();
    const res = await call("/bundle/import/preview", { text });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as BundleImportPlan;
    const planner = plan.agents.find((a) => a.sourceName === "Planner")!;
    expect(planner.resolution).toBe("fallback");
    expect(planner.harnessId).toBe("claude-code");
    expect(planner.fileHarness).toEqual({ id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" });
    expect(plan.warnings.map((w) => w.code)).toContain("harness-fallback");
    expect(plan.canImport).toBe(true);
    // Preview writes nothing.
    expect(await get<AgentProfile[]>("/agent-profiles")).toEqual([]);
  });

  test("a local harness with the same id and kind binds exactly; same id with another kind falls back", async () => {
    const text = await exportedSecondaryBundle();
    addSecondaryHarness("claude-code");
    const exact = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    expect(exact.agents.find((a) => a.sourceName === "Planner")!.resolution).toBe("exact");

    db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
    addSecondaryHarness("codex");
    const other = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    const planner = other.agents.find((a) => a.sourceName === "Planner")!;
    expect(planner.resolution).toBe("fallback");
    expect(planner.harnessId).toBe("claude-code");
  });

  test("unparseable files are 400 with a code", async () => {
    const bad = await call("/bundle/import/preview", { text: "{nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("invalid-json");
    const newer = await call("/bundle/import/preview", { text: JSON.stringify({ format: "agetor-bundle", version: 2 }) });
    expect(((await newer.json()) as { code: string }).code).toBe("unsupported-version");
    expect((await call("/bundle/import/preview", { notText: 1 })).status).toBe(400);
    expect((await call("/bundle/import/preview", { text: "{}", options: { harnessMap: [1] } })).status).toBe(400);
  });

  test("an oversized request body is refused before it is parsed", async () => {
    // The server answers before reading the body; `connection: close` keeps
    // the unread upload from wedging the next request on a reused socket.
    const res = await call(
      "/bundle/import/preview",
      { text: "x".repeat(2 * BUNDLE_MAX_BYTES + 70 * 1024) },
      HEADLESS,
      { connection: "close" },
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too-large");
  });
});

describe("POST /bundle/import", () => {
  test("creates the Agents and the Pipeline with step references rewritten to the new ids", async () => {
    const text = await exportedSecondaryBundle();
    const res = await call("/bundle/import", { text });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agents: AgentProfile[];
      pipelines: Pipeline[];
      enabledHarnesses: string[];
      warnings: { code: string }[];
    };
    // "Export all" lists Agents in name order.
    expect(body.agents.map((a) => [a.name, a.harness])).toEqual([
      ["Helper", "claude-code"],
      ["Planner", "claude-code"],
    ]);
    expect(body.enabledHarnesses).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain("harness-fallback");
    const [helper, planner] = body.agents;
    const steps = body.pipelines[0]!.graph.steps;
    expect(steps.map((s) => s.agentProfileId)).toEqual([planner!.id, helper!.id]);
    expect(steps[0]!.subagents.profileIds).toEqual([helper!.id]);
    expect(body.pipelines[0]!.graph.edges).toHaveLength(1);
    const stored = await get<Pipeline[]>("/pipelines");
    expect(stored[0]!.graph.steps[0]!.agentProfileId).toBe(planner!.id);

    // A second import of the same file renames everything that clashes.
    const again = (await (await call("/bundle/import", { text })).json()) as { agents: AgentProfile[]; pipelines: Pipeline[] };
    expect(again.agents.map((a) => a.name)).toEqual(["Helper (imported)", "Planner (imported)"]);
    expect(again.pipelines.map((p) => p.name)).toEqual(["Review (imported)"]);
    expect(again.pipelines[0]!.graph.steps[0]!.agentProfileId).toBe(again.agents[1]!.id);
  });

  test("an unknown harness kind is 409 with the plan, then imports with a harness map and reset settings", async () => {
    const text = JSON.stringify({
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
          fast: true,
        },
      ],
      pipelines: [],
    });
    const blocked = await call("/bundle/import", { text });
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: string; plan: BundleImportPlan };
    expect(body.plan.blocking.map((b) => b.code)).toEqual(["unknown-kind"]);
    expect(await get<AgentProfile[]>("/agent-profiles")).toEqual([]);

    const ok = await call("/bundle/import", { text, options: { harnessMap: { "grok-2": "claude-code" } } });
    expect(ok.status).toBe(201);
    const [agent] = ((await ok.json()) as { agents: AgentProfile[] }).agents;
    expect([agent!.harness, agent!.model, agent!.effort, agent!.mode, agent!.fast]).toEqual([
      "claude-code",
      "opus-5.5",
      null,
      null,
      false,
    ]);
  });

  test("enableHarnesses enables a disabled fallback harness inside the import", async () => {
    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [{ key: "c", name: "Coder", harness: { id: "codex-2", kind: "codex", label: "Codex 2" }, model: "gpt-6.1-sol" }],
    });
    const preview = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    expect(preview.harnesses).toMatchObject([{ id: "codex", enabled: false, canEnable: true, willEnable: false }]);
    expect(preview.warnings.map((w) => w.code)).toContain("harness-disabled");

    const res = await call("/bundle/import", { text, options: { enableHarnesses: ["codex"] } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { enabledHarnesses: string[] }).enabledHarnesses).toEqual(["codex"]);
    expect(harnesses.get("codex")!.enabled).toBe(true);
  });

  test("is atomic: a failing last Pipeline leaves no Agents behind and the harness still disabled", async () => {
    db.run(
      `CREATE TRIGGER bundle_test_fail_insert BEFORE INSERT ON pipelines WHEN NEW.name = 'Boom'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [{ key: "c", name: "Coder", harness: { id: "codex", kind: "codex", label: "Codex" }, model: "gpt-6.1-sol" }],
      pipelines: [
        { name: "Fine", graph: { steps: [{ id: "s1", name: "One", agent: "c" }], edges: [] } },
        { name: "Boom", graph: { steps: [{ id: "s1", name: "One", agent: "c" }], edges: [] } },
      ],
    });
    const res = await call("/bundle/import", { text, options: { enableHarnesses: "all" } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("nothing was imported");
    expect(await get<AgentProfile[]>("/agent-profiles")).toEqual([]);
    expect(await get<Pipeline[]>("/pipelines")).toEqual([]);
    expect(harnesses.get("codex")!.enabled).toBe(false);
  });

  test("a legacy pipeline file imports, remapping Agents by name", async () => {
    const local = await createProfile({ name: "Planner" });
    const legacy = {
      name: "Old",
      graph: {
        steps: [
          {
            id: "s1",
            name: "Plan",
            agentProfileId: "id-from-another-machine",
            profileName: "planner",
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        startStepId: "s1",
      },
    };
    const text = JSON.stringify(legacy);
    expect(parseBundleText(text).ok).toBe(true);
    const preview = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    expect(preview.legacy).toBe(true);
    expect(preview.pipelines[0]!.steps[0]!.legacy).toBe("remapped");
    const res = await call("/bundle/import", { text });
    expect(res.status).toBe(201);
    const { pipelines } = (await res.json()) as { pipelines: Pipeline[] };
    expect(pipelines[0]!.graph.steps[0]!.agentProfileId).toBe(local.id);
  });

  test("an explicit name that clashes is 409; a free one is used", async () => {
    await createProfile({ name: "Taken" });
    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [{ key: "w", name: "Worker", harness: { id: "claude-code", kind: "claude-code", label: "Claude Code" }, model: "opus-5.5" }],
    });
    const clash = await call("/bundle/import", { text, options: { agentNames: { w: "taken" } } });
    expect(clash.status).toBe(409);
    const ok = await call("/bundle/import", { text, options: { singleName: "Mine" } });
    expect(((await ok.json()) as { agents: AgentProfile[] }).agents[0]!.name).toBe("Mine");
  });
});
