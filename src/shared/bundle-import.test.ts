import { describe, expect, test } from "bun:test";
import { parseBundleText, type ParsedBundle } from "./bundle.ts";
import {
  importedName,
  planBundleImport,
  type BundleImportOptions,
  type BundleLocalHarness,
  type BundleLocalState,
} from "./bundle-import.ts";
import { DEFAULT_MODEL } from "./types.ts";

function harness(id: string, kind: BundleLocalHarness["kind"], overrides: Partial<BundleLocalHarness> = {}): BundleLocalHarness {
  return {
    id,
    kind,
    label: id === "claude-code" ? "Claude Code" : id === "codex" ? "Codex" : id,
    isBuiltin: id === kind,
    enabled: true,
    available: true,
    loggedIn: null,
    reason: null,
    installHint: null,
    ...overrides,
  };
}

function localState(overrides: Partial<BundleLocalState> = {}): BundleLocalState {
  return {
    harnesses: [harness("claude-code", "claude-code"), harness("codex", "codex", { enabled: false })],
    knownKinds: ["claude-code", "codex", "cursor", "gemini", "fx"],
    agentNames: [],
    pipelineNames: [],
    profiles: [],
    knownModels: {},
    knownSkills: {},
    ...overrides,
  };
}

function agent(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    harness: { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    ...overrides,
  };
}

function parse(obj: Record<string, unknown>): ParsedBundle {
  const r = parseBundleText(JSON.stringify(obj));
  if (!r.ok) throw new Error(r.error);
  return r.bundle;
}

function bundle(agents: Record<string, unknown>[], pipelines: Record<string, unknown>[] = []): ParsedBundle {
  return parse({ format: "agetor-bundle", version: 1, agents, pipelines });
}

function pipe(name: string, steps: Record<string, unknown>[] = []): Record<string, unknown> {
  return { name, description: "", maxSteps: 25, graph: { steps, edges: [], startStepId: null } };
}

function stepJson(id: string, agentKey: string | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `Step ${id}`, instructions: "", agent: agentKey, position: { x: 0, y: 0 }, ...overrides };
}

const plan = (parsed: ParsedBundle, local = localState(), options?: BundleImportOptions) =>
  planBundleImport(parsed, local, options);

describe("importedName", () => {
  test("walks (imported), (imported 2), … and truncates to the limit", () => {
    expect(importedName("Worker", new Set(), 80)).toBe("Worker (imported)");
    expect(importedName("Worker", new Set(["worker (imported)"]), 80)).toBe("Worker (imported 2)");
    expect(importedName("Worker", new Set(["worker (imported)", "worker (imported 2)"]), 80)).toBe(
      "Worker (imported 3)",
    );
    const long = "x".repeat(80);
    const name = importedName(long, new Set(), 80);
    expect(name).toHaveLength(80);
    expect(name.endsWith(" (imported)")).toBe(true);
    const second = importedName(long, new Set([name.toLowerCase()]), 80);
    expect(second).toHaveLength(80);
    expect(second.endsWith(" (imported 2)")).toBe(true);
  });

  test("never splits a surrogate pair when truncating", () => {
    const base = `${"x".repeat(68)}🤖🤖`;
    const name = importedName(base, new Set(), 80);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("planBundleImport — harness resolution (K5)", () => {
  test("exact: a local harness with the file's id and kind binds without a warning", () => {
    const local = localState({ harnesses: [harness("claude-code", "claude-code"), harness("secondary-claude-code", "claude-code")] });
    const p = plan(bundle([agent("worker")]), local);
    expect(p.agents[0]!.resolution).toBe("exact");
    expect(p.agents[0]!.harnessId).toBe("secondary-claude-code");
    expect(p.warnings).toEqual([]);
    expect(p.canImport).toBe(true);
  });

  test("fallback: a missing harness id binds the built-in of the same kind with a warning", () => {
    const p = plan(bundle([agent("worker")]));
    const a = p.agents[0]!;
    expect(a.resolution).toBe("fallback");
    expect(a.harnessId).toBe("claude-code");
    expect(a.harnessKind).toBe("claude-code");
    expect(a.harnessLabel).toBe("Claude Code");
    expect(a.candidateHarnessIds).toEqual(["claude-code"]);
    expect(a.warnings.map((w) => w.code)).toEqual(["harness-fallback"]);
    expect(a.warnings[0]!.message).toContain("secondary-claude-code");
    expect(a.warnings[0]!.message).toContain("Claude Code");
    // Settings are kept verbatim on a fallback.
    expect([a.model, a.effort, a.mode]).toEqual(["opus-5.5", "high", "auto"]);
    expect(p.canImport).toBe(true);
  });

  test("fallback: the same id with another kind is treated as missing", () => {
    const local = localState({
      harnesses: [harness("claude-code", "claude-code"), harness("secondary-claude-code", "codex")],
    });
    const a = plan(bundle([agent("worker")]), local).agents[0]!;
    expect(a.resolution).toBe("fallback");
    expect(a.harnessId).toBe("claude-code");
    expect(a.warnings[0]!.message).toContain("is a codex harness");
  });

  test("mapped: an override naming a same-kind harness binds it, via harnessMap or agentHarness", () => {
    const local = localState({
      harnesses: [harness("claude-code", "claude-code"), harness("claude-2", "claude-code"), harness("claude-3", "claude-code")],
    });
    const byMap = plan(bundle([agent("worker")]), local, { harnessMap: { "secondary-claude-code": "claude-2" } });
    expect(byMap.agents[0]!.resolution).toBe("mapped");
    expect(byMap.agents[0]!.harnessId).toBe("claude-2");
    expect(byMap.agents[0]!.warnings).toEqual([]);
    const byAgent = plan(bundle([agent("worker")]), local, {
      harnessMap: { "secondary-claude-code": "claude-2" },
      agentHarness: { worker: "claude-3" },
    });
    expect(byAgent.agents[0]!.harnessId).toBe("claude-3");
    expect(byAgent.agents[0]!.candidateHarnessIds).toEqual(["claude-code", "claude-2", "claude-3"]);
  });

  test("an override naming a harness of another kind blocks", () => {
    const p = plan(bundle([agent("worker")]), localState(), { agentHarness: { worker: "codex" } });
    expect(p.agents[0]!.resolution).toBe("unresolved");
    expect(p.agents[0]!.harnessId).toBeNull();
    expect(p.blocking.map((b) => b.code)).toEqual(["harness-kind-mismatch"]);
    expect(p.canImport).toBe(false);
  });

  test("an override naming a harness that isn't local blocks", () => {
    const p = plan(bundle([agent("worker")]), localState(), { harnessMap: { "secondary-claude-code": "nope" } });
    expect(p.blocking.map((b) => b.code)).toEqual(["unknown-local-harness"]);
  });

  test("unknown kind: unresolved and blocking until mapped", () => {
    const parsed = bundle([agent("future", { harness: { id: "grok", kind: "grok", label: "Grok" }, model: "grok-9" })]);
    const p = plan(parsed);
    const a = p.agents[0]!;
    expect(a.resolution).toBe("unresolved");
    expect(a.candidateHarnessIds).toEqual(["claude-code", "codex"]);
    expect(p.blocking.map((b) => b.code)).toEqual(["unknown-kind"]);
    expect(p.canImport).toBe(false);
  });

  test("rebound: an unknown kind mapped to any local harness resets its settings", () => {
    const parsed = bundle([
      agent("future", { harness: { id: "grok", kind: "grok", label: "Grok" }, model: "grok-9", fast: true, maxMode: true }),
    ]);
    const p = plan(parsed, localState(), { harnessMap: { grok: "codex" } });
    const a = p.agents[0]!;
    expect(a.resolution).toBe("rebound");
    expect(a.harnessId).toBe("codex");
    expect([a.model, a.effort, a.mode, a.fast, a.maxMode]).toEqual([DEFAULT_MODEL.codex, null, null, false, false]);
    expect(a.warnings.map((w) => w.code)).toEqual(["settings-reset"]);
    expect(p.canImport).toBe(true);
  });
});

describe("planBundleImport — harness status warnings", () => {
  test("a disabled target warns and can be enabled; not installed and logged out only warn", () => {
    const local = localState({
      harnesses: [
        harness("claude-code", "claude-code", { loggedIn: false }),
        harness("codex", "codex", { enabled: false, available: false, reason: "codex not on PATH", installHint: "npm i -g codex" }),
      ],
    });
    const parsed = bundle([
      agent("a"),
      agent("b", { harness: { id: "codex-2", kind: "codex", label: "Codex 2" }, model: "gpt-6.1-sol" }),
    ]);
    const p = plan(parsed, local);
    expect(p.harnesses.map((h) => [h.id, h.enabled, h.canEnable, h.willEnable])).toEqual([
      ["claude-code", true, false, false],
      ["codex", false, true, false],
    ]);
    expect(p.harnesses[0]!.warnings.map((w) => w.code)).toEqual(["harness-logged-out"]);
    expect(p.harnesses[1]!.warnings.map((w) => w.code)).toEqual(["harness-disabled", "harness-not-installed"]);
    expect(p.harnesses[1]!.warnings[1]!.message).toContain("npm i -g codex");
    expect(p.canImport).toBe(true);
  });

  test("enableHarnesses as a list or 'all' turns the disabled warning into willEnable", () => {
    const parsed = bundle([agent("b", { harness: { id: "codex-2", kind: "codex", label: "Codex 2" }, model: "gpt-6.1-sol" })]);
    const listed = plan(parsed, localState(), { enableHarnesses: ["codex"] });
    expect(listed.harnesses[0]!.willEnable).toBe(true);
    expect(listed.harnesses[0]!.warnings).toEqual([]);
    const all = plan(parsed, localState(), { enableHarnesses: "all" });
    expect(all.harnesses[0]!.willEnable).toBe(true);
    const other = plan(parsed, localState(), { enableHarnesses: ["claude-code"] });
    expect(other.harnesses[0]!.willEnable).toBe(false);
  });

  test("an already-enabled harness is never marked to enable", () => {
    const p = plan(bundle([agent("a")]), localState(), { enableHarnesses: "all" });
    expect(p.harnesses[0]).toMatchObject({ id: "claude-code", canEnable: false, willEnable: false });
  });
});

describe("planBundleImport — names (K6)", () => {
  test("a clashing name is renamed (imported), (imported 2), …; others are untouched", () => {
    const local = localState({ agentNames: ["worker", "Worker (imported)"], pipelineNames: ["P"] });
    const p = plan(bundle([agent("worker"), agent("fresh")], [pipe("p"), pipe("Q")]), local);
    expect(p.agents.map((a) => [a.name, a.renamed])).toEqual([
      ["Worker (imported 2)", true],
      ["Fresh", false],
    ]);
    expect(p.pipelines.map((x) => [x.name, x.renamed])).toEqual([
      ["p (imported)", true],
      ["Q", false],
    ]);
  });

  test("two items of the same file with the same name don't collide", () => {
    const p = plan(bundle([agent("a", { name: "Same" }), agent("b", { name: "same" })]));
    expect(p.agents.map((a) => a.name)).toEqual(["Same", "same (imported)"]);
  });

  test("an automatic rename is truncated to the 80-char limit", () => {
    const longName = "n".repeat(80);
    const p = plan(bundle([agent("a", { name: longName })]), localState({ agentNames: [longName] }));
    expect(p.agents[0]!.name).toHaveLength(80);
    expect(p.agents[0]!.name.endsWith(" (imported)")).toBe(true);
  });

  test("an explicit name is used as typed and must be free", () => {
    const local = localState({ agentNames: ["Taken"] });
    const ok = plan(bundle([agent("a")]), local, { agentNames: { a: "  Brand New  " } });
    expect(ok.agents[0]!.name).toBe("Brand New");
    expect(ok.agents[0]!.renamed).toBe(true);
    expect(ok.canImport).toBe(true);

    const clash = plan(bundle([agent("a")]), local, { agentNames: { a: "taken" } });
    expect(clash.agents[0]!.errors.map((e) => e.code)).toEqual(["name-in-use"]);
    expect(clash.canImport).toBe(false);

    const twice = plan(bundle([agent("a"), agent("b")]), localState(), { agentNames: { a: "Dup", b: "dup" } });
    expect(twice.agents[1]!.errors.map((e) => e.code)).toEqual(["name-in-use"]);

    const tooLong = plan(bundle([agent("a")]), localState(), { agentNames: { a: "x".repeat(81) } });
    expect(tooLong.blocking.map((e) => e.code)).toEqual(["name-invalid"]);

    const blank = plan(bundle([agent("a")]), localState(), { agentNames: { a: "   " } });
    expect(blank.agents[0]!.name).toBe("A");
  });

  test("explicit names are reserved before automatic renames", () => {
    const local = localState({ agentNames: ["Foo"] });
    const p = plan(bundle([agent("a", { name: "Foo" }), agent("b", { name: "Bar" })]), local, {
      agentNames: { b: "Foo (imported)" },
    });
    expect(p.agents.map((a) => a.name)).toEqual(["Foo (imported 2)", "Foo (imported)"]);
    expect(p.canImport).toBe(true);
  });

  test("explicit pipeline names are keyed by index", () => {
    const p = plan(bundle([], [pipe("A"), pipe("B")]), localState(), { pipelineNames: { "1": "Renamed" } });
    expect(p.pipelines.map((x) => x.name)).toEqual(["A", "Renamed"]);
  });

  test("singleName renames the only Pipeline, else the only Agent of an Agents-only file", () => {
    const onePipe = plan(bundle([agent("a")], [pipe("P", [stepJson("s1", "a")])]), localState(), { singleName: "Mine" });
    expect(onePipe.pipelines[0]!.name).toBe("Mine");
    expect(onePipe.agents[0]!.name).toBe("A");

    const oneAgent = plan(bundle([agent("a")]), localState(), { singleName: "Solo" });
    expect(oneAgent.agents[0]!.name).toBe("Solo");

    const two = plan(bundle([agent("a"), agent("b")]), localState(), { singleName: "Solo" });
    expect(two.blocking.map((b) => b.code)).toEqual(["name-not-applicable"]);
    const twoPipes = plan(bundle([], [pipe("A"), pipe("B")]), localState(), { singleName: "Solo" });
    expect(twoPipes.canImport).toBe(false);

    const clash = plan(bundle([], [pipe("A")]), localState({ pipelineNames: ["Solo"] }), { singleName: "Solo" });
    expect(clash.blocking.map((b) => b.code)).toEqual(["name-in-use"]);
  });
});

describe("planBundleImport — pipelines", () => {
  test("steps carry the planned Agent names; a step with no Agent warns", () => {
    const p = plan(
      bundle([agent("worker")], [pipe("P", [stepJson("s1", "worker"), stepJson("s2", null)])]),
      localState({ agentNames: ["Worker"] }),
    );
    expect(p.pipelines[0]!.steps.map((s) => [s.agentKey, s.agentName, s.legacy])).toEqual([
      ["worker", "Worker (imported)", null],
      [null, null, null],
    ]);
    expect(p.pipelines[0]!.warnings.map((w) => w.code)).toEqual(["step-without-agent"]);
    expect(p.pipelines[0]!.graph.steps[0]!.agentProfileId).toBe("worker");
    expect(p.legacy).toBe(false);
  });

  test("legacy files: kept, remapped, ambiguous and dangling references", () => {
    const parsed = parse({
      name: "Old",
      graph: {
        steps: [
          { id: "s1", name: "Kept", agentProfileId: "local-1", profileName: "Whatever", position: { x: 0, y: 0 } },
          { id: "s2", name: "Remapped", agentProfileId: "gone-1", profileName: "planner", position: { x: 0, y: 0 } },
          { id: "s3", name: "Ambiguous", agentProfileId: "gone-2", profileName: "Twin", position: { x: 0, y: 0 } },
          {
            id: "s4",
            name: "Dangling",
            agentProfileId: "gone-3",
            position: { x: 0, y: 0 },
            subagents: { profileIds: ["gone-4", "local-1"], profileNames: ["Planner", null], cap: null },
          },
        ],
        edges: [],
      },
    });
    const local = localState({
      profiles: [
        { id: "local-1", name: "Existing" },
        { id: "local-2", name: "Planner" },
        { id: "t1", name: "Twin" },
        { id: "t2", name: "twin" },
      ],
    });
    const p = plan(parsed, local);
    expect(p.legacy).toBe(true);
    expect(p.agents).toEqual([]);
    const pp = p.pipelines[0]!;
    expect(pp.steps.map((s) => [s.name, s.legacy, s.agentName])).toEqual([
      ["Kept", "kept", "Existing"],
      ["Remapped", "remapped", "Planner"],
      ["Ambiguous", "dangling", "Twin"],
      ["Dangling", "dangling", null],
    ]);
    expect(pp.graph.steps.map((s) => s.agentProfileId)).toEqual(["local-1", "local-2", "gone-2", "gone-3"]);
    expect(pp.graph.steps[3]!.subagents.profileIds).toEqual(["local-2", "local-1"]);
    expect(pp.warnings.map((w) => w.code)).toEqual(["legacy-ambiguous-agent", "legacy-missing-agent"]);
    expect(p.canImport).toBe(true);
  });
});

describe("planBundleImport — model and skill warnings (K14)", () => {
  test("a model outside the known list warns; null means no warning", () => {
    const parsed = bundle([agent("a", { model: "opus-9" })]);
    const warn = plan(parsed, localState({ knownModels: { "claude-code": ["opus-5.5", "sonnet-5.5"] } }));
    expect(warn.agents[0]!.warnings.map((w) => w.code)).toEqual(["harness-fallback", "unknown-model"]);
    const quiet = plan(parsed, localState({ knownModels: { "claude-code": null } }));
    expect(quiet.agents[0]!.warnings.map((w) => w.code)).toEqual(["harness-fallback"]);
    const listed = plan(bundle([agent("a")]), localState({ knownModels: { "claude-code": ["opus-5.5"] } }));
    expect(listed.agents[0]!.warnings.map((w) => w.code)).toEqual(["harness-fallback"]);
  });

  test("a rebound Agent is not model-checked", () => {
    const parsed = bundle([agent("f", { harness: { id: "grok", kind: "grok", label: "Grok" }, model: "grok-9" })]);
    const p = plan(parsed, localState({ knownModels: { codex: [] } }), { harnessMap: { grok: "codex" } });
    expect(p.agents[0]!.warnings.map((w) => w.code)).toEqual(["settings-reset"]);
  });

  test("skills not discoverable at user level warn (case-insensitive); null means no warning", () => {
    const parsed = bundle([agent("a", { skills: ["Write-Plan", "ghost", "other-ghost"] })]);
    const warn = plan(parsed, localState({ knownSkills: { "claude-code": ["write-plan"] } }));
    const skillWarning = warn.agents[0]!.warnings.find((w) => w.code === "unknown-skills");
    expect(skillWarning?.message).toContain("/ghost, /other-ghost");
    expect(skillWarning?.message).not.toContain("Write-Plan");
    const quiet = plan(parsed, localState({ knownSkills: { "claude-code": null } }));
    expect(quiet.agents[0]!.warnings.some((w) => w.code === "unknown-skills")).toBe(false);
  });
});

describe("planBundleImport — robustness", () => {
  test("never throws on malformed options", () => {
    const parsed = bundle([agent("a")], [pipe("P", [stepJson("s1", "a")])]);
    const bad = {
      harnessMap: ["x"],
      agentHarness: null,
      agentNames: { a: 5 },
      pipelineNames: "nope",
      singleName: 3,
      enableHarnesses: [1, "codex"],
    } as unknown as BundleImportOptions;
    const p = plan(parsed, localState(), bad);
    expect(p.agents[0]!.name).toBe("A");
    expect(p.canImport).toBe(true);
  });

  test("flattens warnings and blocking issues across the plan", () => {
    const parsed = bundle(
      [agent("a"), agent("f", { harness: { id: "grok", kind: "grok", label: "Grok" } })],
      [pipe("P", [stepJson("s1", null)])],
    );
    const p = plan(parsed);
    expect(p.warnings.map((w) => w.code)).toEqual(["harness-fallback", "step-without-agent"]);
    expect(p.blocking.map((b) => b.code)).toEqual(["unknown-kind"]);
    expect(p.localHarnesses.map((h) => h.id)).toEqual(["claude-code", "codex"]);
  });
});
