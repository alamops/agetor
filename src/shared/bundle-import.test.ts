import { describe, expect, test } from "bun:test";
import { findInvisibleChar, LEGACY_HINT_MAX, parseBundleText, type ParsedBundle } from "./bundle.ts";
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

  test("drops a joiner the cut strands, so the name still imports", () => {
    // 80 - " (imported)".length = 69 code units: 66 x's, the woman (2) and
    // the ZWJ (1) — the cut lands between the ZWJ and the emoji it joined.
    const base = `${"x".repeat(66)}👩\u200d💻`;
    expect(base.slice(0, 69).endsWith("\u200d")).toBe(true);
    const name = importedName(base, new Set(), 80);
    expect(name).toBe(`${"x".repeat(66)}👩 (imported)`);
    expect(findInvisibleChar(name)).toBeNull();
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

  test("a local harness of a kind this build can't run is never offered or bindable", () => {
    // The harnesses.kind CHECK still admits retired kinds, so such a row can exist.
    const local = localState({
      harnesses: [
        harness("claude-code", "claude-code"),
        harness("codex", "codex"),
        harness("kimi", "kimi" as BundleLocalHarness["kind"], { isBuiltin: false }),
      ],
    });
    const parsed = bundle([agent("future", { harness: { id: "grok", kind: "grok", label: "Grok" }, model: "grok-9" })]);
    const unmapped = plan(parsed, local);
    expect(unmapped.agents[0]!.candidateHarnessIds).toEqual(["claude-code", "codex"]);
    const mapped = plan(parsed, local, { agentHarness: { future: "kimi" } });
    const a = mapped.agents[0]!;
    expect(a.resolution).toBe("unresolved");
    expect(a.harnessId).toBeNull();
    expect(mapped.blocking.map((b) => b.code)).toEqual(["unsupported-local-harness"]);
    expect(mapped.canImport).toBe(false);
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

    const invisible = plan(bundle([agent("a")]), localState(), { agentNames: { a: "Taken\u200b" } });
    expect(invisible.blocking.map((e) => e.code)).toEqual(["name-invalid"]);
    expect(invisible.blocking[0]!.message).toContain("U+200B");

    // SQLite would store a lone surrogate as a different name than the one
    // previewed, so a typed one is refused like any other bad name.
    for (const typed of ["Review\ud800er", "Review\udc00"]) {
      const lone = plan(bundle([agent("a")]), localState(), { agentNames: { a: typed } });
      expect(lone.blocking.map((e) => e.code)).toEqual(["name-invalid"]);
      expect(lone.blocking[0]!.message).toContain("must not contain a lone surrogate");
    }
    const lonePipe = plan(bundle([], [pipe("A")]), localState(), { pipelineNames: { "0": "Ship\ud800" } });
    expect(lonePipe.blocking.map((e) => e.code)).toEqual(["name-invalid"]);
    // A surrogate pair is ordinary text.
    expect(plan(bundle([agent("a")]), localState(), { agentNames: { a: "Review 😀" } }).blocking).toEqual([]);
  });

  test("a name that only differs by its spaces clashes with the local one", () => {
    const local = localState({ agentNames: ["Code Reviewer"], pipelineNames: ["Ship It"] });
    const p = plan(
      bundle(
        [
          agent("a", { name: "Code\u00a0Reviewer" }),
          agent("b", { name: "Code  Reviewer" }),
          agent("c", { name: "Code\u2800Reviewer" }),
        ],
        [pipe("Ship\u3000It")],
      ),
      local,
    );
    expect(p.agents.map((a) => a.renamed)).toEqual([true, true, true]);
    expect(p.agents.map((a) => a.name)).toEqual([
      "Code\u00a0Reviewer (imported)",
      "Code  Reviewer (imported 2)",
      "Code\u2800Reviewer (imported 3)",
    ]);
    expect(p.pipelines[0]!.renamed).toBe(true);
    // A typed name that only differs by its spaces is in use.
    const typed = plan(bundle([agent("d")]), local, { agentNames: { d: "code\u2002reviewer" } });
    expect(typed.agents[0]!.errors.map((e) => e.code)).toEqual(["name-in-use"]);
  });

  test("a lookalike name (invisible characters, another composition) clashes with the local one", () => {
    const local = localState({ agentNames: ["Café", "❤ Team"], pipelineNames: ["Reviewer"] });
    // Decomposed "é" and an emoji-presentation selector both parse.
    const p = plan(bundle([agent("a", { name: "Cafe\u0301" }), agent("b", { name: "❤\ufe0f Team" })]), local);
    expect(p.agents.map((a) => [a.name, a.renamed])).toEqual([
      ["Cafe\u0301 (imported)", true],
      ["❤\ufe0f Team (imported)", true],
    ]);
    // The parser refuses a trailing ZWJ or selector; the planner holds even
    // when handed one directly, and drops the stranded character from the
    // automatic name.
    const parsed = bundle([], [pipe("P1"), pipe("P2")]);
    parsed.pipelines[0]!.name = "Reviewer\u200d";
    parsed.pipelines[1]!.name = "Reviewer\ufe0f";
    expect(plan(parsed, local).pipelines.map((x) => [x.name, x.renamed])).toEqual([
      ["Reviewer (imported)", true],
      ["Reviewer (imported 2)", true],
    ]);
    // A typed name that only differs by composition is in use.
    const typed = plan(bundle([agent("c")]), local, { agentNames: { c: "CAFE\u0301" } });
    expect(typed.agents[0]!.errors.map((e) => e.code)).toEqual(["name-in-use"]);
  });

  test("a name the database stores under the same name_key always clashes", () => {
    // name_key is trim().toLowerCase() (db.ts). Lower-casing and NFC don't
    // commute: "j\u030c" composes to U+01F0, "J\u030c" stays decomposed, yet
    // both lower-case to the same key — so the planner must clash them or
    // every commit would 409 against a preview that said it can import.
    const local = localState({ agentNames: ["j\u030c"], pipelineNames: ["J\u030cob"] });
    const p = plan(bundle([agent("a", { name: "J\u030c" })], [pipe("j\u030cob")]), local);
    expect(p.agents[0]!.renamed).toBe(true);
    expect(p.pipelines[0]!.renamed).toBe(true);
    const typed = plan(bundle([agent("b")]), local, { agentNames: { b: "J\u030c" } });
    expect(typed.agents[0]!.errors.map((e) => e.code)).toEqual(["name-in-use"]);
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

  test("a legacy step stored without an Agent previews none, whatever its name hint says", () => {
    const parsed = parse({
      name: "Old",
      graph: {
        steps: [{ id: "s1", name: "Review", agentProfileId: null, profileName: "Reviewer", position: { x: 0, y: 0 } }],
        edges: [],
      },
    });
    const p = plan(parsed, localState({ profiles: [{ id: "local-1", name: "Reviewer" }] }));
    const pp = p.pipelines[0]!;
    expect(pp.steps.map((s) => [s.name, s.legacy, s.agentName])).toEqual([["Review", null, null]]);
    expect(pp.graph.steps[0]!.agentProfileId).toBeNull();
    expect(pp.warnings.map((w) => w.code)).toEqual(["step-without-agent"]);
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

describe("planBundleImport — fingerprint", () => {
  test("is stable for the same file and machine, and changes with what the import would create", () => {
    const parsed = bundle([agent("a"), agent("b")], [pipe("P", [stepJson("s1", "a")])]);
    const base = plan(parsed);
    expect(base.fingerprint).toMatch(/^[0-9a-z]+$/);
    expect(plan(parsed).fingerprint).toBe(base.fingerprint);
    // A warning that changes nothing written keeps it.
    const loggedOut = localState({
      harnesses: [harness("claude-code", "claude-code", { loggedIn: false }), harness("codex", "codex", { enabled: false })],
    });
    expect(plan(parsed, loggedOut).fingerprint).toBe(base.fingerprint);
    // A name taken in between renames an Agent or a Pipeline.
    expect(plan(parsed, localState({ agentNames: ["A"] })).fingerprint).not.toBe(base.fingerprint);
    expect(plan(parsed, localState({ pipelineNames: ["P"] })).fingerprint).not.toBe(base.fingerprint);
    // A local harness with the file's id appearing binds the Agents elsewhere.
    const exact = localState({
      harnesses: [...localState().harnesses, harness("secondary-claude-code", "claude-code")],
    });
    expect(plan(parsed, exact).fingerprint).not.toBe(base.fingerprint);
  });

  test("covers the harnesses an import enables", () => {
    const parsed = bundle([agent("a", { harness: { id: "codex", kind: "codex", label: "Codex" }, model: "gpt-6.1-sol" })]);
    expect(plan(parsed).fingerprint).not.toBe(plan(parsed, localState(), { enableHarnesses: "all" }).fingerprint);
  });

  test("a harness enabled elsewhere after the preview is not drift", () => {
    const parsed = bundle([agent("a", { harness: { id: "codex", kind: "codex", label: "Codex" }, model: "gpt-6.1-sol" })]);
    // Previewed: codex disabled, the user asked to enable it.
    const previewed = plan(parsed, localState(), { enableHarnesses: ["codex"] });
    // Committed: someone enabled codex in Settings meanwhile.
    const enabledMeanwhile = localState({
      harnesses: [harness("claude-code", "claude-code"), harness("codex", "codex")],
    });
    const committed = plan(parsed, enabledMeanwhile, { enableHarnesses: ["codex"] });
    expect(committed.harnesses[0]!.willEnable).toBe(false);
    expect(committed.fingerprint).toBe(previewed.fingerprint);
    // Left disabled is still a different outcome.
    expect(plan(parsed).fingerprint).not.toBe(previewed.fingerprint);
  });

  test("a harness toggled elsewhere that the import doesn't enable is not drift", () => {
    const parsed = bundle([agent("a", { harness: { id: "codex", kind: "codex", label: "Codex" }, model: "gpt-6.1-sol" })]);
    // Previewed: codex disabled and left disabled.
    const previewed = plan(parsed);
    expect(previewed.harnesses[0]!.willEnable).toBe(false);
    // Committed: someone enabled codex in Settings meanwhile.
    const enabledMeanwhile = localState({
      harnesses: [harness("claude-code", "claude-code"), harness("codex", "codex")],
    });
    expect(plan(parsed, enabledMeanwhile).fingerprint).toBe(previewed.fingerprint);
    // And the other way round: enabled at preview, disabled before Confirm.
    expect(plan(parsed).fingerprint).toBe(plan(parsed, enabledMeanwhile).fingerprint);
  });
});

describe("planBundleImport — legacy fingerprint", () => {
  const legacyFile = () =>
    parse({
      name: "Old",
      graph: {
        steps: [
          {
            id: "s1",
            name: "Work",
            agentProfileId: "local-1",
            position: { x: 0, y: 0 },
            subagents: { profileIds: ["local-2"], profileNames: [null], cap: null },
          },
        ],
        edges: [],
      },
    });
  const both = localState({
    profiles: [
      { id: "local-1", name: "Worker" },
      { id: "local-2", name: "Helper" },
    ],
  });

  test("an Agent a step keeps, deleted before Confirm, is drift", () => {
    const parsed = legacyFile();
    const previewed = plan(parsed, both);
    expect(previewed.pipelines[0]!.steps[0]!.legacy).toBe("kept");
    const deleted = plan(parsed, localState({ profiles: [{ id: "local-2", name: "Helper" }] }));
    expect(deleted.pipelines[0]!.steps[0]!.legacy).toBe("dangling");
    // Same stored id either way — only the outcome tells them apart.
    expect(deleted.pipelines[0]!.graph.steps[0]!.agentProfileId).toBe("local-1");
    expect(deleted.fingerprint).not.toBe(previewed.fingerprint);
  });

  test("a delegated Agent deleted before Confirm is drift", () => {
    const parsed = legacyFile();
    const previewed = plan(parsed, both);
    expect(previewed.pipelines[0]!.steps[0]!.delegationLegacy).toEqual(["kept"]);
    const deleted = plan(parsed, localState({ profiles: [{ id: "local-1", name: "Worker" }] }));
    expect(deleted.pipelines[0]!.steps[0]!.delegationLegacy).toEqual(["dangling"]);
    expect(deleted.pipelines[0]!.graph.steps[0]!.subagents.profileIds).toEqual(["local-2"]);
    expect(deleted.fingerprint).not.toBe(previewed.fingerprint);
    expect(plan(parsed, both).fingerprint).toBe(previewed.fingerprint);
  });
});

describe("planBundleImport — option keys that shadow Object.prototype", () => {
  test("a __proto__ Agent key or harness id is honored like any other", () => {
    const parsed = bundle([
      agent("__proto__", { harness: { id: "constructor", kind: "claude-code", label: "Odd" } }),
    ]);
    const options = JSON.parse('{"agentNames":{"__proto__":"Renamed"},"harnessMap":{"constructor":"claude-code"}}');
    const p = plan(parsed, localState(), options);
    expect(p.agents[0]!.name).toBe("Renamed");
    expect(p.agents[0]!.resolution).toBe("mapped");
    // Without overrides, the prototype's own members never read as one.
    const bare = plan(parsed);
    expect(bare.agents[0]!.name).toBe("__proto__");
    expect(bare.agents[0]!.resolution).toBe("fallback");
  });

  test("legacy hints are bounded: an over-long one is dropped, a long one is cut for display", () => {
    const huge = "H".repeat(LEGACY_HINT_MAX + 1);
    const long = `${"Planner ".repeat(20)}x`.trim(); // under the cap, over any display width
    const parsed = parse({
      name: "Old",
      graph: {
        steps: [
          { id: "s1", name: "Huge", agentProfileId: "gone-1", profileName: huge, position: { x: 0, y: 0 } },
          {
            id: "s2",
            name: "Long",
            agentProfileId: "gone-2",
            profileName: long,
            position: { x: 0, y: 0 },
            subagents: { profileIds: ["gone-3"], profileNames: [huge], cap: null },
          },
        ],
        edges: [],
      },
    });
    expect(long.length).toBeLessThanOrEqual(LEGACY_HINT_MAX);
    // Dropped in the parser: no hint survives to be echoed into every plan.
    expect(parsed.pipelines[0]!.legacyHints).toEqual({
      s1: { profileName: null, subagentProfileNames: [] },
      s2: { profileName: long, subagentProfileNames: [null] },
    });
    const p = plan(parsed, localState({ profiles: [{ id: "l1", name: "Planner" }] }));
    const pp = p.pipelines[0]!;
    expect(pp.steps.map((s) => s.agentName)).toEqual([null, `${long.slice(0, 80)}…`]);
    const messages = pp.warnings.map((w) => w.message);
    expect(messages).toHaveLength(3);
    for (const m of messages) expect(m.length).toBeLessThan(250);
    expect(messages[0]).toContain("Agent gone-1 isn't defined");
    expect(messages[1]).toContain(`Agent "${long.slice(0, 60)}…" isn't defined`);
    expect(messages[2]).toContain("Agent gone-3 isn't defined");
  });

  test("a legacy hint cut for display never strands a joiner", () => {
    // The 60-unit cut lands right after the ZWJ that joined 👩 to 💻.
    const hint = `${"x".repeat(57)}👩\u200d💻 Planner`;
    const parsed = parse({
      name: "Old",
      graph: { steps: [{ id: "s1", name: "S", agentProfileId: "gone", profileName: hint, position: { x: 0, y: 0 } }], edges: [] },
    });
    const message = plan(parsed).pipelines[0]!.warnings[0]!.message;
    expect(message).toContain(`Agent "${"x".repeat(57)}👩…" isn't defined`);
    expect(message).not.toContain("\u200d…");
  });

  test("legacy name hints resolve through one lookup per plan, many references against many Agents", () => {
    const profiles = Array.from({ length: 3000 }, (_, i) => ({ id: `l${i}`, name: `Agent ${i}` }));
    // 50 steps × (1 + 20 delegations): 1050 references, half resolvable.
    const hintFor = (n: number): string => (n % 2 === 0 ? `agent ${n}` : `Missing ${n}`);
    const steps = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      name: `Step ${i}`,
      agentProfileId: `gone-${i}`,
      profileName: hintFor(i),
      position: { x: 0, y: 0 },
      subagents: {
        profileIds: Array.from({ length: 20 }, (_, j) => `gone-${i}-${j}`),
        profileNames: Array.from({ length: 20 }, (_, j) => hintFor(100 + i * 20 + j)),
        cap: null,
      },
    }));
    const parsed = parse({ name: "Old", graph: { steps, edges: [] } });
    const started = performance.now();
    const p = plan(parsed, localState({ profiles }));
    // Was ~1.5 s with a per-reference scan of every local Agent.
    expect(performance.now() - started).toBeLessThan(500);
    const outcomes = p.pipelines[0]!.steps.map((s) => s.legacy);
    expect(outcomes.filter((o) => o === "remapped")).toHaveLength(25);
    expect(outcomes.filter((o) => o === "dangling")).toHaveLength(25);
    const first = p.pipelines[0]!.graph.steps[0]!;
    expect(first.agentProfileId).toBe("l0");
    expect(first.subagents.profileIds.slice(0, 2)).toEqual(["l100", "gone-0-1"]);
  });

  test("a legacy step id that shadows Object.prototype keeps its own hints", () => {
    const parsed = parse({
      name: "Old",
      graph: {
        steps: [
          { id: "__proto__", name: "Proto", agentProfileId: "gone-1", profileName: "Planner", position: { x: 0, y: 0 } },
          { id: "constructor", name: "Ctor", agentProfileId: "gone-2", position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
    });
    expect(Object.hasOwn(parsed.pipelines[0]!.legacyHints!, "__proto__")).toBe(true);
    const p = plan(parsed, localState({ profiles: [{ id: "local-2", name: "Planner" }] }));
    expect(p.pipelines[0]!.steps.map((s) => [s.name, s.legacy, s.agentName])).toEqual([
      ["Proto", "remapped", "Planner"],
      ["Ctor", "dangling", null],
    ]);
  });
});
