import { describe, expect, test } from "bun:test";
import {
  BUNDLE_FILE_EXT,
  BUNDLE_FORMAT,
  BUNDLE_LIMITS,
  BUNDLE_MAX_BYTES,
  buildBundle,
  numberedFileName,
  parseBundleText,
  serializeBundle,
  type BundleSelection,
} from "./bundle.ts";
import { newStep } from "./pipeline.ts";
import { AGENT_PROFILE_LIMITS } from "./agent-profile.ts";
import { PIPELINE_LIMITS } from "./types.ts";
import type { AgentProfile, Harness, Pipeline, PipelineStep } from "./types.ts";

const NOW = new Date("2026-10-01T20:00:00.000Z");

const HARNESSES: Pick<Harness, "id" | "kind" | "label">[] = [
  { id: "claude-code", kind: "claude-code", label: "Claude Code" },
  { id: "codex", kind: "codex", label: "Codex" },
  { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
];

function profile(id: string, name: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    name,
    harness: "claude-code",
    model: "opus-5.5",
    effort: "high",
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

function step(id: string, name: string, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return newStep({ id, name, position: { x: 10, y: 20 }, ...overrides });
}

function pipeline(id: string, name: string, steps: PipelineStep[], overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id,
    name,
    description: "",
    graph: { steps, edges: [], startStepId: steps[0]?.id ?? null },
    maxSteps: 25,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const select = (s: Partial<BundleSelection>): BundleSelection => ({ agentIds: [], pipelineIds: [], all: false, ...s });

function build(
  selection: Partial<BundleSelection>,
  profiles: AgentProfile[],
  pipelines: Pipeline[] = [],
  harnesses = HARNESSES,
) {
  return buildBundle({ selection: select(selection), profiles, pipelines, harnesses, agetorVersion: "1.0.0", now: NOW });
}

function mustBuild(...args: Parameters<typeof build>) {
  const r = build(...args);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("buildBundle", () => {
  test("a single Agent carries its harness id, kind and label", () => {
    const worker = profile("p1", "Secondary Worker", {
      harness: "secondary-claude-code",
      instructions: "Be careful.",
      skills: ["write-plan"],
    });
    const r = mustBuild({ agentIds: ["p1"] }, [worker]);
    expect(r.bundle.format).toBe(BUNDLE_FORMAT);
    expect(r.bundle.version).toBe(1);
    expect(r.bundle.exportedAt).toBe(NOW.toISOString());
    expect(r.bundle.agetorVersion).toBe("1.0.0");
    expect(r.bundle.pipelines).toEqual([]);
    expect(r.bundle.agents).toEqual([
      {
        key: "secondary-worker",
        name: "Secondary Worker",
        harness: { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
        model: "opus-5.5",
        effort: "high",
        mode: null,
        fast: false,
        maxMode: false,
        instructions: "Be careful.",
        skills: ["write-plan"],
      },
    ]);
    expect(r.filename).toBe(`secondary-worker${BUNDLE_FILE_EXT}`);
    expect(r.warnings).toEqual([]);
  });

  test("a Pipeline embeds every step and delegation Agent exactly once and references them by key", () => {
    const planner = profile("p1", "Planner");
    const coder = profile("p2", "Coder");
    const helper = profile("p3", "Helper");
    const p = pipeline("pl1", "Review pipeline", [
      step("s1", "Plan", { agentProfileId: "p1", subagents: { profileIds: ["p3", "p2"], cap: 2 } }),
      step("s2", "Code", { agentProfileId: "p2", subagents: { profileIds: ["p3"], cap: null } }),
      step("s3", "Again", { agentProfileId: "p1" }),
    ]);
    const r = mustBuild({ pipelineIds: ["pl1"] }, [planner, coder, helper], [p]);
    // Step Agents first, in step order, then delegation Agents.
    expect(r.bundle.agents.map((a) => a.key)).toEqual(["planner", "coder", "helper"]);
    const steps = r.bundle.pipelines[0]!.graph.steps;
    expect(steps.map((s) => s.agent)).toEqual(["planner", "coder", "planner"]);
    expect(steps[0]!.subagents).toEqual({ agents: ["helper", "coder"], cap: 2 });
    expect(steps[0]!.position).toEqual({ x: 10, y: 20 });
    expect(steps[0]).not.toHaveProperty("agentProfileId");
    expect(r.bundle.pipelines[0]!.graph.startStepId).toBe("s1");
    expect(r.filename).toBe(`review-pipeline${BUNDLE_FILE_EXT}`);
  });

  test("selected Agents come first in name order, then pipeline-referenced ones; multi-select dedupes", () => {
    const a = profile("pa", "alpha");
    const b = profile("pb", "Bravo");
    const z = profile("pz", "Zulu");
    const p = pipeline("pl1", "P", [step("s1", "One", { agentProfileId: "pz" }), step("s2", "Two", { agentProfileId: "pa" })]);
    const r = mustBuild({ agentIds: ["pb", "pa", "pa"], pipelineIds: ["pl1", "pl1"] }, [a, b, z], [p]);
    expect(r.bundle.agents.map((x) => x.name)).toEqual(["alpha", "Bravo", "Zulu"]);
    expect(r.bundle.pipelines).toHaveLength(1);
    expect(r.filename).toBe(`agetor-export-2026-10-01${BUNDLE_FILE_EXT}`);
  });

  test("all exports every Agent and every Pipeline", () => {
    const r = mustBuild({ all: true }, [profile("p1", "B"), profile("p2", "A")], [pipeline("pl", "P", [])]);
    expect(r.bundle.agents.map((a) => a.name)).toEqual(["A", "B"]);
    expect(r.bundle.pipelines.map((p) => p.name)).toEqual(["P"]);
  });

  test("all with nothing to export is an error", () => {
    const r = build({ all: true }, []);
    expect(r.ok).toBe(false);
  });

  test("an empty selection and an unknown id are errors", () => {
    expect(build({}, [profile("p1", "A")])).toEqual({ ok: false, error: "nothing selected to export" });
    expect(build({ agentIds: ["nope"] }, [profile("p1", "A")])).toEqual({ ok: false, error: 'unknown agent "nope"' });
    expect(build({ pipelineIds: ["nope"] }, [])).toEqual({ ok: false, error: 'unknown pipeline "nope"' });
  });

  test("a step whose Agent was deleted exports without an Agent, with a warning", () => {
    const p = pipeline("pl1", "P", [
      step("s1", "Plan", { agentProfileId: "gone", subagents: { profileIds: ["gone-too"], cap: null } }),
    ]);
    const r = mustBuild({ pipelineIds: ["pl1"] }, [], [p]);
    expect(r.bundle.pipelines[0]!.graph.steps[0]!.agent).toBeNull();
    expect(r.bundle.pipelines[0]!.graph.steps[0]!.subagents.agents).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('step "Plan"');
  });

  test("an Agent whose harness no longer resolves is skipped with a warning", () => {
    const orphan = profile("p1", "Orphan", { harness: "deleted-harness" });
    const ok = profile("p2", "Fine");
    const p = pipeline("pl1", "P", [step("s1", "One", { agentProfileId: "p1" })]);
    const r = mustBuild({ agentIds: ["p1", "p2"], pipelineIds: ["pl1"] }, [orphan, ok], [p]);
    expect(r.bundle.agents.map((a) => a.name)).toEqual(["Fine"]);
    expect(r.bundle.pipelines[0]!.graph.steps[0]!.agent).toBeNull();
    expect(r.warnings.some((w) => w.includes('"Orphan" was skipped'))).toBe(true);
    // Selecting only that Agent leaves nothing to export.
    const only = build({ agentIds: ["p1"] }, [orphan]);
    expect(only.ok).toBe(false);
  });

  test("keys are slugged, fall back to agent-<n>, and get numbered on a clash", () => {
    const r = mustBuild({ agentIds: ["a", "b", "c", "d"] }, [
      profile("a", "Code Reviewer"),
      profile("b", "code reviewer!"),
      profile("c", "🤖"),
      profile("d", "Ünïcode Ágent"),
    ]);
    // Name order: "Code Reviewer", "code reviewer!", "Ünïcode Ágent", "🤖".
    expect(r.bundle.agents.map((a) => a.key)).toEqual(["code-reviewer", "code-reviewer-2", "unicode-agent", "agent-4"]);
    const long = mustBuild({ agentIds: ["x", "y"] }, [profile("x", "a".repeat(90)), profile("y", "A".repeat(90))]);
    expect(long.bundle.agents.map((a) => a.key)).toEqual(["a".repeat(64), `${"a".repeat(62)}-2`]);
  });

  test("an Agent-only or Pipeline-only single item names the file after it; empty slugs fall back", () => {
    expect(mustBuild({ agentIds: ["p"] }, [profile("p", "🤖")]).filename).toBe(`agent${BUNDLE_FILE_EXT}`);
    expect(mustBuild({ pipelineIds: ["pl"] }, [], [pipeline("pl", "!!!", [])]).filename).toBe(
      `pipeline${BUNDLE_FILE_EXT}`,
    );
  });

  test("round trip: parse(serialize(build(x))) reproduces Agents and graphs", () => {
    const planner = profile("p1", "Planner", { harness: "secondary-claude-code", skills: ["a", "b"], instructions: "x\ny" });
    const coder = profile("p2", "Coder", { harness: "codex", model: "gpt-6.1-sol", effort: null, mode: "ask" });
    const s1 = step("s1", "Plan", { agentProfileId: "p1", subagents: { profileIds: ["p2"], cap: 3 }, transition: "all" });
    const s2 = step("s2", "Code", { agentProfileId: "p2", join: "all" });
    const p = pipeline("pl1", "Review", [s1, s2], {
      description: "two steps",
      maxSteps: 40,
      graph: { steps: [s1, s2], edges: [{ id: "e1", from: "s1", to: "s2", label: "go" }], startStepId: "s1" },
    });
    const built = mustBuild({ pipelineIds: ["pl1"] }, [planner, coder], [p]);
    const text = serializeBundle(built.bundle);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "format": "agetor-bundle",');
    const parsed = parseBundleText(text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.bundle.legacy).toBe(false);
    expect(parsed.bundle.agents).toEqual(built.bundle.agents);
    expect(parsed.bundle.exportedAt).toBe(NOW.toISOString());
    expect(parsed.bundle.agetorVersion).toBe("1.0.0");
    const pp = parsed.bundle.pipelines[0]!;
    expect(pp.name).toBe("Review");
    expect(pp.description).toBe("two steps");
    expect(pp.maxSteps).toBe(40);
    expect(pp.legacyHints).toBeNull();
    expect(pp.graph.edges).toEqual([{ id: "e1", from: "s1", to: "s2", label: "go" }]);
    expect(pp.graph.startStepId).toBe("s1");
    expect(pp.graph.steps.map((s) => [s.id, s.agentProfileId, s.subagents.profileIds, s.transition, s.join])).toEqual([
      ["s1", "planner", ["coder"], "all", "any"],
      ["s2", "coder", [], "choose", "all"],
    ]);
  });
});

describe("numberedFileName", () => {
  test("numbers before the bundle extension", () => {
    expect(numberedFileName("x.agetor.json", 1)).toBe("x.agetor.json");
    expect(numberedFileName("x.agetor.json", 2)).toBe("x (2).agetor.json");
    expect(numberedFileName("x.json", 3)).toBe("x (3).json");
    expect(numberedFileName("x", 4)).toBe("x (4)");
  });
});

// ── parseBundleText ──────────────────────────────────────────────────────

function agentJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "worker",
    name: "Worker",
    harness: { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
    model: "opus-5.5",
    effort: "high",
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    ...overrides,
  };
}

function stepJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    name: "Plan",
    instructions: "",
    agent: "worker",
    position: { x: 0, y: 0 },
    subagents: { agents: [], cap: null },
    transition: "choose",
    join: "any",
    ...overrides,
  };
}

function bundleJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "agetor-bundle",
    version: 1,
    exportedAt: "2026-10-01T20:00:00.000Z",
    agetorVersion: "1.0.0",
    agents: [agentJson()],
    pipelines: [
      { name: "P", description: "", maxSteps: 25, graph: { steps: [stepJson()], edges: [], startStepId: "s1" } },
    ],
    ...overrides,
  };
}

function parseObj(obj: unknown) {
  return parseBundleText(JSON.stringify(obj));
}

function expectError(obj: unknown, code: string, contains?: string) {
  const r = typeof obj === "string" ? parseBundleText(obj) : parseObj(obj);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.code).toBe(code as typeof r.code);
  if (contains) expect(r.error).toContain(contains);
}

describe("parseBundleText", () => {
  test("parses a valid bundle and maps agent keys onto the graph", () => {
    const r = parseObj(bundleJson());
    if (!r.ok) throw new Error(r.error);
    expect(r.bundle.agents[0]!.harness).toEqual({
      id: "secondary-claude-code",
      kind: "claude-code",
      label: "Claude Code (secondary)",
    });
    expect(r.bundle.pipelines[0]!.graph.steps[0]!.agentProfileId).toBe("worker");
  });

  test("accepts a leading byte-order mark", () => {
    expect(parseBundleText(`﻿${JSON.stringify(bundleJson())}`).ok).toBe(true);
  });

  test("ignores unknown keys and never surfaces harness home/bin/env", () => {
    const r = parseObj(
      bundleJson({
        extra: 1,
        agents: [
          agentJson({
            surprise: true,
            harness: { id: "h", kind: "claude-code", label: "H", home: "/Users/x", bin: "/bin/sh", env: { A: "1" } },
          }),
        ],
        pipelines: [],
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.bundle.agents[0]!.harness).toEqual({ id: "h", kind: "claude-code", label: "H" });
    expect(r.bundle.agents[0]).not.toHaveProperty("surprise");
    expect(JSON.stringify(r.bundle)).not.toContain("/bin/sh");
  });

  test("normalizes optional fields", () => {
    const r = parseObj(
      bundleJson({
        agents: [
          {
            key: "k",
            name: "  Spaced  ",
            harness: { id: "claude-code", kind: "claude-code" },
            model: "opus-5.5",
            effort: "",
            skills: ["/plan", "plan", " /review "],
          },
        ],
        pipelines: [],
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.bundle.agents[0]).toEqual({
      key: "k",
      name: "Spaced",
      harness: { id: "claude-code", kind: "claude-code", label: "claude-code" },
      model: "opus-5.5",
      effort: null,
      mode: null,
      fast: false,
      maxMode: false,
      instructions: "",
      skills: ["plan", "review"],
    });
  });

  test("a bundle without maxSteps gets the default", () => {
    const b = bundleJson();
    delete (b.pipelines as Record<string, unknown>[])[0]!.maxSteps;
    const r = parseObj(b);
    if (!r.ok) throw new Error(r.error);
    expect(r.bundle.pipelines[0]!.maxSteps).toBe(PIPELINE_LIMITS.maxStepsDefault);
  });

  test("rejects text over the size cap", () => {
    expectError(" ".repeat(BUNDLE_MAX_BYTES + 1), "too-large");
    // Multi-byte characters count in UTF-8 bytes.
    expectError(`"${"é".repeat(BUNDLE_MAX_BYTES / 2 + 1)}"`, "too-large");
  });

  test("rejects invalid JSON, non-objects and foreign formats", () => {
    expectError("{nope", "invalid-json");
    expectError([1, 2], "unrecognized");
    expectError("null", "unrecognized");
    expectError({ hello: "world" }, "unrecognized");
    expectError(bundleJson({ format: "something-else" }), "unrecognized");
  });

  test("rejects bad and newer versions", () => {
    expectError(bundleJson({ version: "1" }), "invalid", "version");
    expectError(bundleJson({ version: 1.5 }), "invalid", "version");
    expectError(bundleJson({ version: 0 }), "invalid", "version");
    expectError(bundleJson({ version: 2 }), "unsupported-version", "update agetor to import this file");
  });

  test("rejects empty files and over-count files", () => {
    expectError(bundleJson({ agents: [], pipelines: [] }), "invalid", "nothing to import");
    expectError(bundleJson({ agents: {}, pipelines: [] }), "invalid", "agents must be an array");
    const many = Array.from({ length: BUNDLE_LIMITS.agents + 1 }, (_, i) => agentJson({ key: `k${i}` }));
    expectError(bundleJson({ agents: many, pipelines: [] }), "invalid", `${BUNDLE_LIMITS.agents} Agents`);
    const pipes = Array.from({ length: BUNDLE_LIMITS.pipelines + 1 }, (_, i) => ({ name: `P${i}`, graph: { steps: [], edges: [] } }));
    expectError(bundleJson({ agents: [], pipelines: pipes }), "invalid", `${BUNDLE_LIMITS.pipelines} Pipelines`);
  });

  test("rejects fields over their caps", () => {
    const only = (a: Record<string, unknown>) => bundleJson({ agents: [agentJson(a)], pipelines: [] });
    expectError(only({ name: "x".repeat(AGENT_PROFILE_LIMITS.name + 1) }), "invalid", "name");
    expectError(only({ instructions: "x".repeat(AGENT_PROFILE_LIMITS.instructions + 1) }), "invalid", "instructions");
    expectError(only({ skills: Array.from({ length: 51 }, (_, i) => `s${i}`) }), "invalid", "at most 50 skills");
    expectError(only({ skills: ["x".repeat(AGENT_PROFILE_LIMITS.skillName + 1)] }), "invalid", "skill name");
    expectError(only({ model: "m".repeat(BUNDLE_LIMITS.model + 1) }), "invalid", "model");
    expectError(only({ key: "k".repeat(BUNDLE_LIMITS.key + 1) }), "invalid", "key");
    expectError(
      only({ harness: { id: "h".repeat(BUNDLE_LIMITS.harnessId + 1), kind: "claude-code", label: "" } }),
      "invalid",
      "harness.id",
    );
    expectError(
      bundleJson({ pipelines: [{ name: "P", description: "d".repeat(PIPELINE_LIMITS.description + 1), graph: { steps: [], edges: [] } }] }),
      "invalid",
      "description",
    );
  });

  test("rejects wrong field types", () => {
    const only = (a: Record<string, unknown>) => bundleJson({ agents: [agentJson(a)], pipelines: [] });
    expectError(only({ skills: ["ok", 3] }), "invalid", "skills");
    expectError(only({ skills: "plan" }), "invalid", "skills");
    expectError(only({ fast: "yes" }), "invalid", "fast");
    expectError(only({ harness: "claude-code" }), "invalid", "harness");
    expectError(only({ model: "" }), "invalid", "model is required");
    expectError(only({ effort: 3 }), "invalid", "effort");
    expectError(bundleJson({ agents: ["x"] }), "invalid", "agents[0] must be an object");
  });

  test("rejects control characters in identifiers but allows tabs and newlines in text", () => {
    const only = (a: Record<string, unknown>) => bundleJson({ agents: [agentJson(a)], pipelines: [] });
    expectError(only({ name: "bad\u0007name" }), "invalid", "control characters");
    expectError(only({ key: "a\nb" }), "invalid", "control characters");
    expectError(only({ model: "m\u007f" }), "invalid", "control characters");
    expectError(only({ skills: ["a\u0001"] }), "invalid", "control characters");
    expectError(only({ harness: { id: "h", kind: "claude-code", label: "L\u0000" } }), "invalid", "control characters");
    expectError(only({ instructions: "ok\u001bnot" }), "invalid", "control characters");
    expect(parseObj(only({ instructions: "tab\there\r\nnew line" })).ok).toBe(true);
    expectError(
      bundleJson({ pipelines: [{ name: "P", description: "x\u0002", graph: { steps: [], edges: [] } }] }),
      "invalid",
      "description",
    );
    expectError(
      bundleJson({ pipelines: [{ name: "P", graph: { steps: [stepJson({ instructions: "a\u0003" })], edges: [] } }] }),
      "invalid",
      "instructions",
    );
  });

  test("rejects duplicate keys and references to unknown keys", () => {
    expectError(bundleJson({ agents: [agentJson(), agentJson({ name: "Other" })] }), "invalid", 'duplicate Agent key "worker"');
    expectError(bundleJson({ agents: [{ ...agentJson(), key: undefined }] }), "invalid", "key is required");
    expectError(
      bundleJson({ pipelines: [{ name: "P", graph: { steps: [stepJson({ agent: "ghost" })], edges: [] } }] }),
      "invalid",
      'unknown Agent "ghost"',
    );
    expectError(
      bundleJson({
        pipelines: [{ name: "P", graph: { steps: [stepJson({ subagents: { agents: ["ghost"], cap: null } })], edges: [] } }],
      }),
      "invalid",
      'delegates to unknown Agent "ghost"',
    );
    expectError(
      bundleJson({ pipelines: [{ name: "P", graph: { steps: [stepJson({ agent: 5 })], edges: [] } }] }),
      "invalid",
      "agent must be",
    );
  });

  test("rejects maxSteps out of range and invalid graphs", () => {
    const pipe = (p: Record<string, unknown>) =>
      bundleJson({ pipelines: [{ name: "P", graph: { steps: [stepJson()], edges: [] }, ...p }] });
    expectError(pipe({ maxSteps: 0 }), "invalid", "maxSteps");
    expectError(pipe({ maxSteps: 201 }), "invalid", "maxSteps");
    expectError(pipe({ maxSteps: 2.5 }), "invalid", "maxSteps");
    expectError(pipe({ graph: { steps: [stepJson(), stepJson()], edges: [] } }), "invalid", "duplicate step id");
    expectError(pipe({ graph: "nope" }), "invalid", "graph must be an object");
  });

  test("a legacy pipeline file parses with its name hints", () => {
    const legacy = {
      name: "Old pipeline",
      description: "from before bundles",
      maxSteps: 30,
      graph: {
        steps: [
          {
            id: "s1",
            name: "Plan",
            instructions: "",
            agentProfileId: "old-id-1",
            profileName: "Planner",
            position: { x: 0, y: 0 },
            subagents: { profileIds: ["old-id-2", "old-id-2", "old-id-3"], profileNames: ["Helper", "Helper", null], cap: null },
            transition: "choose",
            join: "any",
          },
        ],
        edges: [],
        startStepId: "s1",
      },
    };
    const r = parseObj(legacy);
    if (!r.ok) throw new Error(r.error);
    expect(r.bundle.legacy).toBe(true);
    expect(r.bundle.agents).toEqual([]);
    const p = r.bundle.pipelines[0]!;
    expect(p.name).toBe("Old pipeline");
    expect(p.maxSteps).toBe(30);
    expect(p.graph.steps[0]!.agentProfileId).toBe("old-id-1");
    expect(p.graph.steps[0]!.subagents.profileIds).toEqual(["old-id-2", "old-id-3"]);
    expect(p.legacyHints).toEqual({ s1: { profileName: "Planner", subagentProfileNames: ["Helper", null] } });
  });

  test("a legacy file without maxSteps keeps it undefined; an invalid legacy graph is rejected", () => {
    const r = parseObj({ name: "Old", graph: { steps: [], edges: [] } });
    if (!r.ok) throw new Error(r.error);
    expect(r.bundle.pipelines[0]!.maxSteps).toBeUndefined();
    expectError({ name: "Old", graph: { steps: "x", edges: [] } }, "invalid", "graph.steps must be an array");
    expectError({ name: "  ", graph: { steps: [], edges: [] } }, "invalid", "name is required");
  });
});
