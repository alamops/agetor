// Route-level tests for the Agents/Pipelines bundle (docs/plans/
// agents-pipelines-import-export.md K4, TT-B): `/bundle/export`,
// `/bundle/export/save`, `/bundle/pick-file`, `/bundle/import/preview` and
// `/bundle/import`. AGETOR_DATA_DIR and the ports are set at module scope
// BEFORE `./db.ts`/`./server.ts` are imported. Two servers run: a headless one
// (no native bridge, like the CLI daemon) and one with `makeTestNative`, so
// the reveal / native-panel / 501 branches are all reachable.
import { test, expect, beforeAll, afterAll, beforeEach, describe, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MODEL, type AgentProfile, type Pipeline } from "../shared/types.ts";
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
// fx can't be /bin/echo (its probe requires the "coding agent" marker): a
// stub that reports no login, so the planner sees a logged-out fx harness.
// It answers neither `models --json` nor anything else, so fx discovery is
// empty — the case that used to count every curated row as known.
const FX_STUB = path.join(DATA_DIR, "fx-stub");
writeFileSync(
  FX_STUB,
  `#!/bin/sh\n`
    + `if [ "$1" = "--version" ]; then echo "0.0.10"; exit 0; fi\n`
    + `if [ "$1" = "--help" ]; then echo "Fast, native coding agent for the terminal"; exit 0; fi\n`
    + `if [ "$1" = "status" ]; then echo '{"auth":"missing","auth_help":"Run fx login"}'; exit 0; fi\n`
    + `exit 1\n`,
  { mode: 0o755 },
);
process.env.AGETOR_FX_BIN = FX_STUB;
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
      bundle?: unknown;
      text: string;
      filename: string;
      warnings: string[];
      counts: { agents: number; pipelines: number };
    };
    expect(body.counts).toEqual({ agents: 1, pipelines: 1 });
    expect(body.filename).toBe("review.agetor.json");
    // The response carries the file text only — no duplicate parsed copy.
    expect(body.bundle).toBeUndefined();
    const bundle = JSON.parse(body.text) as {
      agents: { key: string; harness: unknown }[];
      pipelines: { graph: { steps: { agent: string }[] } }[];
    };
    expect(bundle.agents[0]!.harness).toEqual({
      id: "secondary-claude-code",
      kind: "claude-code",
      label: "Claude Code (secondary)",
    });
    expect(bundle.pipelines[0]!.graph.steps.map((s) => s.agent)).toEqual(["planner", "planner"]);
    expect(body.text).toBe(`${JSON.stringify(bundle, null, 2)}\n`);
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

  test("data the app stores with control characters exports as a file import accepts", async () => {
    const esc = "\u001b[31m";
    const agent = await createProfile({ name: "Colorful", instructions: `pasted${esc}output\n\tindented` });
    expect(agent.instructions).toContain("\u001b");
    const pipeline = await createPipeline("Colors", [{ id: "s1", name: "One", profileId: agent.id }]);
    const patched = await fetch(`${HEADLESS}/pipelines/${pipeline.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ description: `about${esc}colors` }),
    });
    expect(patched.status).toBe(200);

    const res = await call("/bundle/export", { pipelineIds: [pipeline.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; warnings: string[] };
    expect(body.warnings).toEqual([
      'Agent "Colorful": control or invisible characters were removed from its instructions',
      'Pipeline "Colors": control or invisible characters were removed from its description',
    ]);
    expect(body.text).not.toContain("\\u001b");
    expect(parseBundleText(body.text).ok).toBe(true);

    const imported = await call("/bundle/import", { text: body.text });
    expect(imported.status).toBe(201);
    const result = (await imported.json()) as { agents: AgentProfile[]; pipelines: Pipeline[] };
    expect(result.agents[0]!.instructions).toBe("pastedoutput\n\tindented");
    expect(result.pipelines[0]!.description).toBe("aboutcolors");
  });

  test("an export over the import size limit is 400 and writes nothing", async () => {
    const big = "x".repeat(20_000);
    const count = Math.ceil(BUNDLE_MAX_BYTES / big.length) + 1;
    for (let i = 0; i < count; i++) await createProfile({ name: `Big ${i}`, instructions: big });
    const res = await call("/bundle/export", { all: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("over the 2 MB import limit");
    const saved = await call("/bundle/export/save", { all: true, target: "downloads" });
    expect(saved.status).toBe(400);
    expect(existsSync(DOWNLOADS) ? readdirSync(DOWNLOADS) : []).toEqual([]);
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

  test("a picked folder with a comma in its path is saved there, and a missing folder is never created", async () => {
    const p = await createProfile({ name: "Worker" });
    const dir = path.join(DATA_DIR, "Backups, 2026");
    mkdirSync(dir, { recursive: true });
    // Electrobun splits the panel's answer on ",".
    dialogResult = dir.split(",");
    const res = await call("/bundle/export/save", { agentIds: [p.id], target: "folder" }, NATIVE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(path.join(dir, "worker.agetor.json"));
    expect(existsSync(path.join(DATA_DIR, "Backups"))).toBe(false);

    // A folder name may end in a space; the answer is never trimmed.
    const spaced = path.join(DATA_DIR, "Exports ");
    mkdirSync(spaced, { recursive: true });
    dialogResult = [spaced];
    const spacedRes = await call("/bundle/export/save", { agentIds: [p.id], target: "folder" }, NATIVE);
    expect(spacedRes.status).toBe(200);
    expect(((await spacedRes.json()) as { path: string }).path).toBe(path.join(spaced, "worker.agetor.json"));

    // A relative answer isn't a pick.
    dialogResult = ["relative/folder"];
    const relative = await call("/bundle/export/save", { agentIds: [p.id], target: "folder" }, NATIVE);
    expect(await relative.json()).toEqual({ cancelled: true });
    expect(existsSync(path.join(process.cwd(), "relative"))).toBe(false);

    const gone = path.join(DATA_DIR, "gone-folder");
    dialogResult = [gone];
    const missing = await call("/bundle/export/save", { agentIds: [p.id], target: "folder" }, NATIVE);
    expect(missing.status).toBe(500);
    expect(((await missing.json()) as { error: string }).error).toContain("is not a folder");
    expect(existsSync(gone)).toBe(false);
  });

  test("a symlink at the export's name counts as taken and is never followed", async () => {
    const p = await createProfile({ name: "Worker" });
    mkdirSync(DOWNLOADS, { recursive: true });
    const outside = path.join(DATA_DIR, "outside.txt");
    symlinkSync(outside, path.join(DOWNLOADS, "worker.agetor.json"));
    const res = await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { filename: string }).filename).toBe("worker (2).agetor.json");
    expect(existsSync(outside)).toBe(false);
  });

  test("a folder Agetor may not write to answers 500 with a privacy-settings hint, not a bare errno", async () => {
    const p = await createProfile({ name: "Worker" });
    const locked = path.join(DATA_DIR, "locked-downloads");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    process.env.AGETOR_DOWNLOADS_DIR = locked;
    try {
      const res = await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("macOS didn't allow Agetor to write to your Downloads folder");
      expect(body.error).toContain("Files and Folders");
    } finally {
      process.env.AGETOR_DOWNLOADS_DIR = DOWNLOADS;
      chmodSync(locked, 0o700);
    }
  });

  test("a Downloads path that is a file or a dangling symlink says so, not a bare EEXIST", async () => {
    const p = await createProfile({ name: "Worker" });
    const asFile = path.join(DATA_DIR, "downloads-file");
    writeFileSync(asFile, "not a folder");
    const dangling = path.join(DATA_DIR, "downloads-dangling");
    symlinkSync(path.join(DATA_DIR, "nowhere"), dangling);
    try {
      for (const dir of [asFile, dangling]) {
        process.env.AGETOR_DOWNLOADS_DIR = dir;
        const res = await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" });
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: string }).error).toBe(
          `couldn't save the export: ${dir} exists but isn't a folder`,
        );
      }
      // A file above the folder: ENOTDIR.
      process.env.AGETOR_DOWNLOADS_DIR = path.join(asFile, "inner");
      const res = await call("/bundle/export/save", { agentIds: [p.id], target: "downloads" });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe(
        `couldn't save the export: part of ${path.join(asFile, "inner")} isn't a folder`,
      );
    } finally {
      process.env.AGETOR_DOWNLOADS_DIR = DOWNLOADS;
    }
  });

  test("bundleSaveErrorMessage: EPERM/EACCES get the privacy hint, anything else its own message", async () => {
    const { bundleSaveErrorMessage } = await import("./bundle.ts");
    const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code });
    expect(bundleSaveErrorMessage(errno("EPERM"), "folder", "/Volumes/X")).toBe(
      "couldn't save the export: macOS didn't allow Agetor to write to /Volumes/X — allow it in System Settings → Privacy & Security, or use Copy JSON instead",
    );
    expect(bundleSaveErrorMessage(errno("EACCES"), "downloads", "/Users/x/Downloads")).toContain("or Choose folder instead");
    expect(bundleSaveErrorMessage(errno("ENOSPC"), "downloads", "/d")).toBe(
      "couldn't save the export: ENOSPC: operation not permitted",
    );
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

    // A picked file whose path has a comma comes back split by Electrobun.
    const commaDir = path.join(DATA_DIR, "Exports, old");
    mkdirSync(commaDir, { recursive: true });
    const commaFile = path.join(commaDir, "a, b.agetor.json");
    writeFileSync(commaFile, "{}");
    dialogResult = commaFile.split(",");
    const comma = await call("/bundle/pick-file", {}, NATIVE);
    expect(await comma.json()).toEqual({ text: "{}", filename: "a, b.agetor.json" });
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

  test("a logged-out harness knows only the models its pickers offer: catalog-gated rows warn", async () => {
    const fxAgent = (key: string, name: string, model: string) => ({
      key,
      name,
      harness: { id: "fx", kind: "fx", label: "fx" },
      model,
    });
    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [fxAgent("g", "Gated", "anthropic/claude-opus-5"), fxAgent("p", "Plain", DEFAULT_MODEL.fx)],
    });
    const plan = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    expect(plan.harnesses.find((h) => h.id === "fx")?.warnings.map((w) => w.code)).toContain("harness-logged-out");
    const byName = (n: string) => plan.agents.find((a) => a.sourceName === n)!.warnings.map((w) => w.code);
    // Discovery is empty, which alone would count every curated row as known;
    // logged out, a catalog-gated row isn't offered, so it warns.
    expect(byName("Gated")).toContain("unknown-model");
    expect(byName("Plain")).not.toContain("unknown-model");
    expect(plan.canImport).toBe(true);
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

  test("an oversized request body is refused before it is parsed, and the connection stays usable", async () => {
    // No `connection: close`: the server drains the refused upload, so the
    // next request on the reused keep-alive socket isn't wedged behind it.
    const res = await call("/bundle/import/preview", { text: "x".repeat(2 * BUNDLE_MAX_BYTES + 70 * 1024) });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("too-large");
    expect(body.error).toContain("request is too large");
    const next = await call("/bundle/import/preview", { text: "{" });
    expect(next.status).toBe(400);
  });

  test("a chunked body with no Content-Length is capped while it is read", async () => {
    const chunk = new TextEncoder().encode("x".repeat(256 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far past the cap: the server refuses once the read passes it and
        // drains the rest without holding it.
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${HEADLESS}/bundle/import/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too-large");
    expect((await call("/bundle/import/preview", { text: "{" })).status).toBe(400);
  });

  test("a Content-Length body past the drain cap is refused by the server itself, and the connection stays usable", async () => {
    const { REFUSED_BODY_DRAIN_MAX_BYTES } = await import("./server.ts");
    const started = Date.now();
    const res = await fetch(`${HEADLESS}/bundle/import/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: new Uint8Array(REFUSED_BODY_DRAIN_MAX_BYTES + 1024),
    });
    expect(res.status).toBe(413);
    await res.arrayBuffer();
    // The next request on the reused socket answers at once, not after the
    // 255 s idleTimeout a cancelled drain would leave it waiting for.
    const next = await call("/bundle/import/preview", { text: "{" });
    expect(next.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("drainRefusedBody", () => {
  test("gives up on a body that stalls mid-upload, and cancels it", async () => {
    const { drainRefusedBody } = await import("./server.ts");
    let cancelled = false;
    let reads = 0;
    const stalled = new ReadableStream<Uint8Array>({
      pull(controller) {
        // One chunk, then nothing ever again — a client that stopped sending.
        if (reads++ === 0) controller.enqueue(new Uint8Array(1024));
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = Date.now();
    await drainRefusedBody(stalled.getReader(), 50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
  });

  test("returns as soon as a short body ends, without cancelling", async () => {
    const { drainRefusedBody } = await import("./server.ts");
    let cancelled = false;
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    await drainRefusedBody(short.getReader(), 60_000);
    expect(cancelled).toBe(false);
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

  // A name taken between the in-transaction re-plan and the insert (another
  // writer racing the commit) reaches the insert as a name error: the whole
  // import rolls back and the route answers 409 with a fresh plan instead of
  // a 500. Stubbed, since the plan itself never hands a taken name over.
  for (const which of ["agent", "pipeline"] as const) {
    test(`a ${which} name error from the insert is 409 with a plan, and nothing is imported`, async () => {
      const { agentProfiles, pipelines, AgentProfileNameError, PipelineNameError } = await import("./db.ts");
      const spy =
        which === "agent"
          ? spyOn(agentProfiles, "insert").mockImplementation((input) => {
              throw new AgentProfileNameError(input.name);
            })
          : spyOn(pipelines, "insert").mockImplementation((input) => {
              throw new PipelineNameError(input.name);
            });
      try {
        const text = JSON.stringify({
          format: "agetor-bundle",
          version: 1,
          agents: [{ key: "c", name: "Coder", harness: { id: "claude-code", kind: "claude-code", label: "Claude Code" }, model: "opus-5.5" }],
          pipelines: [{ name: "Flow", graph: { steps: [{ id: "s1", name: "One", agent: "c" }], edges: [] } }],
        });
        const res = await call("/bundle/import", { text });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: string; plan: BundleImportPlan };
        const taken = which === "agent" ? `agent name "Coder"` : `pipeline name "Flow"`;
        expect(body.error).toBe(`${taken} is already in use — preview the import again`);
        expect(body.plan.agents.map((a) => a.name)).toEqual(["Coder"]);
        expect(body.plan.pipelines.map((p) => p.name)).toEqual(["Flow"]);
      } finally {
        spy.mockRestore();
      }
      expect(await get<AgentProfile[]>("/agent-profiles")).toEqual([]);
      expect(await get<Pipeline[]>("/pipelines")).toEqual([]);
    });
  }

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

  test("a commit whose re-plan differs from the previewed fingerprint is 409 with the new plan", async () => {
    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [{ key: "d", name: "Drifter", harness: { id: "claude-code", kind: "claude-code", label: "Claude Code" }, model: "opus-5.5" }],
    });
    const preview = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    expect(preview.agents[0]!.name).toBe("Drifter");
    // The name is taken after the preview: the import would now create
    // "Drifter (imported)", which is not what the user confirmed.
    await createProfile({ name: "Drifter" });
    const stale = await call("/bundle/import", { text, planFingerprint: preview.fingerprint });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; plan: BundleImportPlan };
    expect(body.error).toContain("changed since the preview");
    expect(body.plan.agents[0]!.name).toBe("Drifter (imported)");
    const names = (await get<AgentProfile[]>("/agent-profiles")).map((a) => a.name);
    expect(names.filter((n) => n.startsWith("Drifter"))).toEqual(["Drifter"]);
    // Confirming the new plan imports it.
    const ok = await call("/bundle/import", { text, planFingerprint: body.plan.fingerprint });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { agents: AgentProfile[] }).agents[0]!.name).toBe("Drifter (imported)");
    // A non-string fingerprint is a bad request.
    expect((await call("/bundle/import", { text, planFingerprint: 7 })).status).toBe(400);
  });

  test("option maps keep a __proto__ key", async () => {
    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [{ key: "__proto__", name: "Proto", harness: { id: "claude-code", kind: "claude-code", label: "Claude Code" }, model: "opus-5.5" }],
    });
    const res = await call("/bundle/import", `{"text":${JSON.stringify(text)},"options":{"agentNames":{"__proto__":"Proto Renamed"}}}`);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { agents: AgentProfile[] }).agents[0]!.name).toBe("Proto Renamed");
  });

  test("names that differ only by an invisible character export distinct and import onto a fresh machine unrenamed", async () => {
    // The app stores both: `name_key` is lower(trim(name)), which keeps U+200B.
    const plain = await createProfile({ name: "Reviewer" });
    const hidden = await createProfile({ name: "Reviewer\u200b" });
    expect(hidden.name).toBe("Reviewer\u200b");
    await createPipeline("Flow", [{ id: "s1", name: "Look", profileId: plain.id }]);
    await createPipeline("Flow\u200b", [{ id: "s1", name: "Look", profileId: hidden.id }]);

    const res = await call("/bundle/export", { all: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; warnings: string[] };
    const parsed = parseBundleText(body.text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.bundle.agents.map((a) => a.name).sort()).toEqual(["Reviewer", "Reviewer 2"]);
    expect(parsed.bundle.pipelines.map((p) => p.name).sort()).toEqual(["Flow", "Flow 2"]);
    expect(body.warnings.filter((w) => w.endsWith("so it was renamed to keep them distinct"))).toEqual([
      'Agent "Reviewer 2": control or invisible characters were removed from its name; after cleanup its name matched another one in this export, so it was renamed to keep them distinct',
      'Pipeline "Flow 2": control or invisible characters were removed from its name; after cleanup its name matched another one in this export, so it was renamed to keep them distinct',
    ]);
    // Each Pipeline still points at its own Agent.
    const agentOf = (pipelineName: string) => {
      const key = parsed.bundle.pipelines.find((p) => p.name === pipelineName)!.graph.steps[0]!.agentProfileId;
      return parsed.bundle.agents.find((a) => a.key === key)!.name;
    };
    expect([agentOf("Flow"), agentOf("Flow 2")]).toEqual(["Reviewer", "Reviewer 2"]);

    // A fresh machine: nothing in the file clashes with anything, so the
    // preview renames nothing and the import keeps every name.
    db.run(`DELETE FROM pipelines`);
    db.run(`DELETE FROM agent_profiles`);
    const plan = (await (await call("/bundle/import/preview", { text: body.text })).json()) as BundleImportPlan;
    expect(plan.canImport).toBe(true);
    expect(plan.agents.map((a) => a.renamed)).toEqual([false, false]);
    expect(plan.pipelines.map((p) => p.renamed)).toEqual([false, false]);
    const imported = await call("/bundle/import", { text: body.text, planFingerprint: plan.fingerprint });
    expect(imported.status).toBe(201);
    const result = (await imported.json()) as { agents: AgentProfile[]; pipelines: Pipeline[] };
    expect(result.agents.map((a) => a.name).sort()).toEqual(["Reviewer", "Reviewer 2"]);
    expect(result.pipelines.map((p) => p.name).sort()).toEqual(["Flow", "Flow 2"]);
    const idOf = new Map(result.agents.map((a) => [a.name, a.id] as const));
    for (const p of result.pipelines) {
      expect(p.graph.steps[0]!.agentProfileId).toBe(idOf.get(p.name === "Flow" ? "Reviewer" : "Reviewer 2")!);
    }
  });

  test("skills are normalized the same way by the routes, the preview and the import", async () => {
    // The route strips every leading slash, so `//foo` is stored as `foo`.
    const stored = await createProfile({ name: "Skilled", skills: ["//foo", " / /foo", "/bar/baz", "foo"] });
    expect(stored.skills).toEqual(["foo", "bar/baz"]);

    const text = JSON.stringify({
      format: "agetor-bundle",
      version: 1,
      agents: [
        {
          key: "s",
          name: "From File",
          harness: { id: "claude-code", kind: "claude-code", label: "Claude Code" },
          model: "opus-5.5",
          skills: ["//foo", "/foo", "/plugin:a/b"],
        },
      ],
    });
    const plan = (await (await call("/bundle/import/preview", { text })).json()) as BundleImportPlan;
    // What the preview shows is exactly what gets stored.
    expect(plan.agents[0]!.skills).toEqual(["foo", "plugin:a/b"]);
    const res = await call("/bundle/import", { text, planFingerprint: plan.fingerprint });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { agents: AgentProfile[] }).agents[0]!.skills).toEqual(["foo", "plugin:a/b"]);
  });

  test("a repeated edge is refused as a repeat; a broken repeated edge is refused for its real problem", async () => {
    const agent = { key: "a", name: "A", harness: { id: "claude-code", kind: "claude-code", label: "Claude Code" }, model: "opus-5.5" };
    const steps = [
      { id: "s1", name: "One", agent: "a" },
      { id: "s2", name: "Two", agent: "a" },
    ];
    const file = (edges: unknown[]) =>
      JSON.stringify({
        format: "agetor-bundle",
        version: 1,
        agents: [agent],
        pipelines: [{ name: "P", graph: { steps, edges, startStepId: "s1" } }],
      });
    const repeated = await call("/bundle/import", {
      text: file([
        { id: "e1", from: "s1", to: "s2", label: "yes" },
        { id: "e2", from: "s1", to: "s2", label: "no" },
      ]),
    });
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({
      error: 'Pipeline "P", edge "e2" repeats the connection from step "One" to step "Two" (edge "e1") — keep one of them',
      code: "invalid",
    });
    const selfEdges = await call("/bundle/import/preview", {
      text: file([
        { id: "e1", from: "s1", to: "s1" },
        { id: "e2", from: "s1", to: "s1" },
      ]),
    });
    expect(selfEdges.status).toBe(400);
    const selfBody = (await selfEdges.json()) as { error: string; code: string };
    expect(selfBody.code).toBe("invalid");
    expect(selfBody.error).not.toContain("repeats the connection");
    expect(await get<AgentProfile[]>("/agent-profiles")).toEqual([]);
    expect(await get<Pipeline[]>("/pipelines")).toEqual([]);
  });
});
