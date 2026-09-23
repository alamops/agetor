import { describe, expect, test } from "bun:test";
import {
  HANDOFF_TAG,
  HANDOFF_UNTRUSTED_CONTENT_WARNING,
  composeStepPrompt,
  deriveRunStatus,
  effectiveStepCap,
  incomingSteps,
  matchPipelineRef,
  newStep,
  normalizeHandoff,
  outgoingSteps,
  parseHandoff,
  pipelineStepProgress,
  renderHandoffFile,
  resolveNextSteps,
  resolveStartStep,
  stepNameById,
  validatePipelineGraph,
} from "./pipeline.ts";
import type {
  AgentProfileSnapshot,
  Handoff,
  Pipeline,
  PipelineEdge,
  PipelineGraph,
  PipelineRunState,
  PipelineStep,
} from "./types.ts";
import { PIPELINE_LIMITS } from "./types.ts";

function makeStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: overrides.id ?? "step-1",
    name: "Step 1",
    instructions: "",
    agentProfileId: null,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...overrides,
  };
}

function makeEdge(overrides: Partial<PipelineEdge> = {}): PipelineEdge {
  return { id: "edge-1", from: "step-1", to: "step-2", label: "", ...overrides };
}

function makeGraph(overrides: Partial<PipelineGraph> = {}): PipelineGraph {
  return { steps: [], edges: [], startStepId: null, ...overrides };
}

function makeProfileSnapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    id: "profile-1",
    name: "Reviewer",
    harness: "claude-code",
    harnessKind: "claude-code",
    harnessLabel: "Claude Code",
    model: "sonnet-5",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "Be thorough.",
    skills: [],
    capturedAt: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    pipelineId: "pipeline-1",
    pipelineName: "My Pipeline",
    snapshot: null,
    status: "idle",
    active: [],
    joins: {},
    blocked: [],
    history: [],
    stepCount: 0,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "pipeline-1",
    name: "My Pipeline",
    description: "",
    graph: makeGraph(),
    maxSteps: 25,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// newStep

describe("newStep", () => {
  test("defaults every field", () => {
    const s = newStep();
    expect(s.name).toBe("New step");
    expect(s.instructions).toBe("");
    expect(s.agentProfileId).toBeNull();
    expect(s.position).toEqual({ x: 0, y: 0 });
    expect(s.subagents).toEqual({ profileIds: [], cap: null });
    expect(s.transition).toBe("choose");
    expect(s.join).toBe("any");
    expect(typeof s.id).toBe("string");
    expect(s.id.length).toBeGreaterThan(0);
  });

  test("generates a distinct id per call", () => {
    expect(newStep().id).not.toBe(newStep().id);
  });

  test("partial overrides win", () => {
    const s = newStep({ name: "Custom", transition: "all" });
    expect(s.name).toBe("Custom");
    expect(s.transition).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// validatePipelineGraph

describe("validatePipelineGraph", () => {
  test("an empty steps array is valid (editor draft)", () => {
    const result = validatePipelineGraph({ steps: [], edges: [], startStepId: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.steps).toEqual([]);
  });

  test("rejects a non-object input", () => {
    expect(validatePipelineGraph(null).ok).toBe(false);
    expect(validatePipelineGraph("nope").ok).toBe(false);
    expect(validatePipelineGraph([]).ok).toBe(false);
  });

  test("rejects steps not an array", () => {
    const result = validatePipelineGraph({ steps: "nope", edges: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate step names case-insensitively, trimmed", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", name: "Review" }), makeStep({ id: "b", name: "  review  " })],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate step name/);
  });

  test("rejects an empty step name", () => {
    const result = validatePipelineGraph({ steps: [makeStep({ id: "a", name: "   " })], edges: [] });
    expect(result.ok).toBe(false);
  });

  test("trims step names", () => {
    const result = validatePipelineGraph({ steps: [makeStep({ id: "a", name: "  Trimmed  " })], edges: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.steps[0]!.name).toBe("Trimmed");
  });

  test("rejects a duplicate step id", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", name: "One" }), makeStep({ id: "a", name: "Two" })],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate step id/);
  });

  test("rejects a dangling edge (unknown from/to step)", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "ghost" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown step/);
  });

  test("rejects a self-edge", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "a" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/self-edge/);
  });

  test("collapses duplicate identical edges (same from+to) to one", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b", label: "first" }),
        makeEdge({ id: "e2", from: "a", to: "b", label: "second" }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.edges).toHaveLength(1);
      expect(result.graph.edges[0]!.label).toBe("first");
    }
  });

  test("rejects steps beyond PIPELINE_LIMITS.steps", () => {
    const steps = Array.from({ length: 51 }, (_, i) => makeStep({ id: `s${i}`, name: `Step ${i}` }));
    const result = validatePipelineGraph({ steps, edges: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects instructions over the length cap", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", instructions: "x".repeat(20_001) })],
      edges: [],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a startStepId that isn't a step", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" })],
      edges: [],
      startStepId: "ghost",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/startStepId/);
  });

  test("accepts a valid startStepId", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" })],
      edges: [],
      startStepId: "a",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.startStepId).toBe("a");
  });

  test("rejects a non-positive-integer subagents.cap", () => {
    const bad = [0, -1, 1.5, "3"];
    for (const cap of bad) {
      const result = validatePipelineGraph({
        steps: [makeStep({ id: "a", subagents: { profileIds: [], cap } as unknown as PipelineStep["subagents"] })],
        edges: [],
      });
      expect(result.ok).toBe(false);
    }
  });

  test("accepts a null or positive-integer subagents.cap", () => {
    for (const cap of [null, 1, 5]) {
      const result = validatePipelineGraph({
        steps: [makeStep({ id: "a", subagents: { profileIds: [], cap } as PipelineStep["subagents"] })],
        edges: [],
      });
      expect(result.ok).toBe(true);
    }
  });

  test("defaults missing transition/join/subagents", () => {
    const result = validatePipelineGraph({
      steps: [{ id: "a", name: "A", instructions: "", agentProfileId: null, position: { x: 0, y: 0 } }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.graph.steps[0]!;
      expect(step.transition).toBe("choose");
      expect(step.join).toBe("any");
      expect(step.subagents).toEqual({ profileIds: [], cap: null });
    }
  });

  test("rejects an invalid transition value", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", transition: "sideways" as PipelineStep["transition"] })],
      edges: [],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an invalid join value", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", join: "some" as PipelineStep["join"] })],
      edges: [],
    });
    expect(result.ok).toBe(false);
  });

  test("clamps non-finite positions to 0", () => {
    const result = validatePipelineGraph({
      steps: [{ ...makeStep({ id: "a" }), position: { x: Number.NaN, y: Infinity } }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.steps[0]!.position).toEqual({ x: 0, y: 0 });
  });

  test("dedupes subagents.profileIds", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", subagents: { profileIds: ["p1", "p1", "p2"], cap: null } })],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.steps[0]!.subagents.profileIds).toEqual(["p1", "p2"]);
  });

  test("drops unknown keys on a step", () => {
    const result = validatePipelineGraph({
      steps: [{ ...makeStep({ id: "a" }), somethingElse: "nope" }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.steps[0]).not.toHaveProperty("somethingElse");
  });

  test("rejects edges beyond PIPELINE_LIMITS.edges", () => {
    const steps = [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })];
    const edges = Array.from({ length: 201 }, (_, i) => makeEdge({ id: `e${i}`, from: "a", to: "b" }));
    const result = validatePipelineGraph({ steps, edges });
    expect(result.ok).toBe(false);
  });

  test("rejects a step id over PIPELINE_LIMITS.id chars", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "x".repeat(PIPELINE_LIMITS.id + 1) })],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/step id .* exceeds/);
  });

  test("accepts a step id exactly at PIPELINE_LIMITS.id chars", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "x".repeat(PIPELINE_LIMITS.id) })],
      edges: [],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an edge id over PIPELINE_LIMITS.id chars", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [makeEdge({ id: "e".repeat(PIPELINE_LIMITS.id + 1), from: "a", to: "b" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/edge id .* exceeds/);
  });

  test("rejects an edge label over PIPELINE_LIMITS.edgeLabel chars", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "b", label: "x".repeat(PIPELINE_LIMITS.edgeLabel + 1) })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/label exceeds/);
  });

  test("accepts an edge label exactly at PIPELINE_LIMITS.edgeLabel chars", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "b", label: "x".repeat(PIPELINE_LIMITS.edgeLabel) })],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects more than PIPELINE_LIMITS.subagentProfiles profile ids", () => {
    const profileIds = Array.from({ length: PIPELINE_LIMITS.subagentProfiles + 1 }, (_, i) => `p${i}`);
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", subagents: { profileIds, cap: null } })],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/subagents\.profileIds exceeds/);
  });

  test("accepts exactly PIPELINE_LIMITS.subagentProfiles profile ids", () => {
    const profileIds = Array.from({ length: PIPELINE_LIMITS.subagentProfiles }, (_, i) => `p${i}`);
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", subagents: { profileIds, cap: null } })],
      edges: [],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a subagents.cap over PIPELINE_LIMITS.subagentCap", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", subagents: { profileIds: [], cap: PIPELINE_LIMITS.subagentCap + 1 } })],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/subagents\.cap exceeds/);
  });

  test("accepts a subagents.cap exactly at PIPELINE_LIMITS.subagentCap", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a", subagents: { profileIds: [], cap: PIPELINE_LIMITS.subagentCap } })],
      edges: [],
    });
    expect(result.ok).toBe(true);
  });

  test("clamps an out-of-range finite position into [-positionAbs, positionAbs]", () => {
    const result = validatePipelineGraph({
      steps: [{ ...makeStep({ id: "a" }), position: { x: PIPELINE_LIMITS.positionAbs * 2, y: -PIPELINE_LIMITS.positionAbs * 2 } }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.steps[0]!.position).toEqual({
        x: PIPELINE_LIMITS.positionAbs,
        y: -PIPELINE_LIMITS.positionAbs,
      });
    }
  });

  test("accepts a position exactly at positionAbs unchanged", () => {
    const result = validatePipelineGraph({
      steps: [{ ...makeStep({ id: "a" }), position: { x: PIPELINE_LIMITS.positionAbs, y: 0 } }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.steps[0]!.position).toEqual({ x: PIPELINE_LIMITS.positionAbs, y: 0 });
  });

  test("rejects a step with a missing/empty id even when other fields are otherwise valid", () => {
    const result = validatePipelineGraph({
      steps: [{ ...makeStep({}), id: "" }],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-empty id/);
  });

  test("rejects an edge with a missing/empty id", () => {
    const result = validatePipelineGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [{ ...makeEdge({}), id: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-empty id/);
  });
});

// ---------------------------------------------------------------------------
// resolveStartStep

describe("resolveStartStep", () => {
  test("honors an explicit startStepId", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "b" })],
      startStepId: "b",
    });
    expect(resolveStartStep(g)?.id).toBe("b");
  });

  test("falls back to the unique step with no incoming edges", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "b" })],
    });
    expect(resolveStartStep(g)?.id).toBe("a");
  });

  test("returns null on a cycle with no unique start", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b" }),
        makeEdge({ id: "e2", from: "b", to: "a" }),
      ],
    });
    expect(resolveStartStep(g)).toBeNull();
  });

  test("returns null with zero steps", () => {
    expect(resolveStartStep(makeGraph())).toBeNull();
  });

  test("returns null when two steps both have no incoming edges", () => {
    const g = makeGraph({ steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })], edges: [] });
    expect(resolveStartStep(g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// outgoingSteps / incomingSteps

describe("outgoingSteps / incomingSteps", () => {
  const g = makeGraph({
    steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" }), makeStep({ id: "c", name: "C" })],
    edges: [
      makeEdge({ id: "e1", from: "a", to: "b", label: "to b" }),
      makeEdge({ id: "e2", from: "a", to: "c", label: "to c" }),
    ],
  });

  test("outgoingSteps returns targets in edge order", () => {
    const out = outgoingSteps(g, "a");
    expect(out.map((o) => o.step.id)).toEqual(["b", "c"]);
    expect(out.map((o) => o.edge.label)).toEqual(["to b", "to c"]);
  });

  test("outgoingSteps is empty for a terminal step", () => {
    expect(outgoingSteps(g, "b")).toEqual([]);
  });

  test("incomingSteps returns sources in edge order", () => {
    const inc = incomingSteps(g, "c");
    expect(inc.map((o) => o.step.id)).toEqual(["a"]);
  });

  test("incomingSteps is empty for a start step", () => {
    expect(incomingSteps(g, "a")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseHandoff

function fullHandoffJson(overrides: Partial<Handoff> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    purpose: "Ship the feature",
    summary: "Did the thing",
    reason: "Done, handing off",
    next: "Step 2",
    artifacts: ["src/foo.ts"],
    openQuestions: ["Any edge cases?"],
    status: "done",
    ...overrides,
  });
}

describe("parseHandoff", () => {
  test("parses a well-formed handoff block", () => {
    const text = `Some prose.\n\n<${HANDOFF_TAG}>\n${fullHandoffJson()}\n</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handoff.purpose).toBe("Ship the feature");
      expect(result.handoff.next).toBe("Step 2");
      expect(result.handoff.artifacts).toEqual(["src/foo.ts"]);
      expect(result.handoff.status).toBe("done");
      expect(result.handoff.schemaVersion).toBe(1);
    }
  });

  test("finds the tag anywhere in the text, not just at the end", () => {
    const text = `<${HANDOFF_TAG}>${fullHandoffJson()}</${HANDOFF_TAG}>\nsome trailing prose the agent added`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
  });

  test("strips a ```json fence", () => {
    const text = `<${HANDOFF_TAG}>\n\`\`\`json\n${fullHandoffJson()}\n\`\`\`\n</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.purpose).toBe("Ship the feature");
  });

  test("strips a bare ``` fence (no json hint)", () => {
    const text = `<${HANDOFF_TAG}>\n\`\`\`\n${fullHandoffJson()}\n\`\`\`\n</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
  });

  test("tolerates trailing prose after the closing tag", () => {
    const text = `<${HANDOFF_TAG}>${fullHandoffJson()}</${HANDOFF_TAG}>\n\nThanks, that's everything!`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
  });

  test("last <handoff> block wins over an earlier draft", () => {
    const draft = fullHandoffJson({ next: "Draft target" });
    const final = fullHandoffJson({ next: "Final target" });
    const text = `<${HANDOFF_TAG}>${draft}</${HANDOFF_TAG}>\n\nActually wait, let me redo this.\n\n<${HANDOFF_TAG}>${final}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.next).toBe("Final target");
  });

  test("tolerates attributes on the open tag", () => {
    const text = `<${HANDOFF_TAG} id="abc" data-x="1">${fullHandoffJson()}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
  });

  test("tolerates whitespace around the close tag", () => {
    const text = `<${HANDOFF_TAG}>${fullHandoffJson()}</ ${HANDOFF_TAG} >`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
  });

  test("missing tag entirely -> ok:false, raw:null", () => {
    const result = parseHandoff("Just some plain text with no handoff at all.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no <handoff> block found/);
      expect(result.raw).toBeNull();
    }
  });

  test("invalid json inside the tag -> ok:false with raw text, error mentions parsing", () => {
    const text = `<${HANDOFF_TAG}>not json at all, no braces here</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/could not be parsed/);
      expect(result.raw).toContain("not json");
    }
  });

  test("brace-balanced recovery: prose before/after a valid JSON object", () => {
    const text = `<${HANDOFF_TAG}>Here is my handoff:\n${fullHandoffJson()}\nHope that helps!</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.purpose).toBe("Ship the feature");
  });

  test("brace-balanced recovery tolerates braces inside string values", () => {
    const withBraceInString = fullHandoffJson({ summary: "Rendered {curly} braces in output" });
    const text = `<${HANDOFF_TAG}>prefix noise\n${withBraceInString}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.summary).toBe("Rendered {curly} braces in output");
  });

  test("field defaults: missing fields fill in empty/null/[] ", () => {
    const text = `<${HANDOFF_TAG}>{}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handoff.purpose).toBe("");
      expect(result.handoff.summary).toBe("");
      expect(result.handoff.reason).toBe("");
      expect(result.handoff.next).toBeNull();
      expect(result.handoff.artifacts).toEqual([]);
      expect(result.handoff.openQuestions).toEqual([]);
      expect(result.handoff.status).toBeUndefined();
      expect(result.handoff.schemaVersion).toBe(1);
    }
  });

  test("empty-string next normalizes to null", () => {
    const text = `<${HANDOFF_TAG}>${fullHandoffJson({ next: "" })}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.next).toBeNull();
  });

  test("non-string entries in artifacts/openQuestions are dropped", () => {
    const text = `<${HANDOFF_TAG}>${JSON.stringify({ artifacts: ["ok.ts", 42, null, "also-ok.ts"], openQuestions: [true, "q1"] })}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handoff.artifacts).toEqual(["ok.ts", "also-ok.ts"]);
      expect(result.handoff.openQuestions).toEqual(["q1"]);
    }
  });

  test("caps a string field at PIPELINE_LIMITS.handoffField", () => {
    const text = `<${HANDOFF_TAG}>${JSON.stringify({ summary: "x".repeat(9000) })}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.summary.length).toBe(8000);
  });

  test("caps an array field at PIPELINE_LIMITS.handoffArray", () => {
    const artifacts = Array.from({ length: 60 }, (_, i) => `file-${i}.ts`);
    const text = `<${HANDOFF_TAG}>${JSON.stringify({ artifacts })}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.artifacts).toHaveLength(50);
  });

  test("an unparseable status is simply omitted, not an error", () => {
    const text = `<${HANDOFF_TAG}>${JSON.stringify({ status: "weird" })}</${HANDOFF_TAG}>`;
    const result = parseHandoff(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeHandoff

describe("normalizeHandoff", () => {
  test("normalizes a well-formed object exactly like parseHandoff's own normalization", () => {
    const raw = JSON.parse(fullHandoffJson());
    const handoff = normalizeHandoff(raw);
    expect(handoff.purpose).toBe("Ship the feature");
    expect(handoff.next).toBe("Step 2");
    expect(handoff.artifacts).toEqual(["src/foo.ts"]);
    expect(handoff.status).toBe("done");
    expect(handoff.schemaVersion).toBe(1);
  });

  test("non-object input normalizes to all-defaults with status undefined", () => {
    for (const input of [null, undefined, "nope", 42, [], true]) {
      const handoff = normalizeHandoff(input);
      expect(handoff).toEqual({
        schemaVersion: 1,
        purpose: "",
        summary: "",
        reason: "",
        next: null,
        artifacts: [],
        openQuestions: [],
      });
      expect(handoff.status).toBeUndefined();
    }
  });

  test("caps a string field and an array field the same as parseHandoff", () => {
    const handoff = normalizeHandoff({ summary: "x".repeat(9000), artifacts: Array.from({ length: 60 }, (_, i) => `f${i}`) });
    expect(handoff.summary.length).toBe(PIPELINE_LIMITS.handoffField);
    expect(handoff.artifacts).toHaveLength(PIPELINE_LIMITS.handoffArray);
  });

  test("never throws on hostile input", () => {
    expect(() => normalizeHandoff({ next: 123, artifacts: "not-an-array", status: {} })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderHandoffFile

describe("renderHandoffFile", () => {
  test("includes the untrusted-content warning, step name, seq, and the handoff itself", () => {
    const handoff = fullHandoffJsonObj({ summary: "Found the bug" });
    const rendered = renderHandoffFile({ fromStepName: "Investigate", seq: 3, handoff });
    const parsed = JSON.parse(rendered);
    expect(parsed._untrusted).toBe(HANDOFF_UNTRUSTED_CONTENT_WARNING);
    expect(parsed.fromStep).toBe("Investigate");
    expect(parsed.seq).toBe(3);
    expect(parsed.handoff).toEqual(handoff);
  });

  test("is pretty-printed JSON", () => {
    const rendered = renderHandoffFile({ fromStepName: "S", seq: 1, handoff: fullHandoffJsonObj() });
    expect(rendered).toContain("\n  ");
  });
});

// ---------------------------------------------------------------------------
// resolveNextSteps

describe("resolveNextSteps", () => {
  test("terminal when there are no outgoing edges", () => {
    const g = makeGraph({ steps: [makeStep({ id: "a" })], edges: [] });
    expect(resolveNextSteps(g, "a", null)).toEqual({ kind: "terminal" });
  });

  test("a single outgoing edge is taken regardless of handoff.next", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" })],
      edges: [makeEdge({ id: "e1", from: "a", to: "b" })],
    });
    const handoff = { ...fullHandoffJsonObj(), next: "Something Else" };
    expect(resolveNextSteps(g, "a", handoff)).toEqual({ kind: "steps", stepIds: ["b"] });
    expect(resolveNextSteps(g, "a", null)).toEqual({ kind: "steps", stepIds: ["b"] });
  });

  test("multiple outgoing edges: matches by step name (case-insensitive)", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "Branch B" }), makeStep({ id: "c", name: "Branch C" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b" }),
        makeEdge({ id: "e2", from: "a", to: "c" }),
      ],
    });
    const handoff = { ...fullHandoffJsonObj(), next: "  branch c  " };
    expect(resolveNextSteps(g, "a", handoff)).toEqual({ kind: "steps", stepIds: ["c"] });
  });

  test("multiple outgoing edges: matches by step id when name doesn't match", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "Branch B" }), makeStep({ id: "c", name: "Branch C" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b" }),
        makeEdge({ id: "e2", from: "a", to: "c" }),
      ],
    });
    const handoff = { ...fullHandoffJsonObj(), next: "c" };
    expect(resolveNextSteps(g, "a", handoff)).toEqual({ kind: "steps", stepIds: ["c"] });
  });

  test("multiple outgoing edges: matches by edge label when name/id don't match", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "Branch B" }), makeStep({ id: "c", name: "Branch C" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b", label: "happy path" }),
        makeEdge({ id: "e2", from: "a", to: "c", label: "sad path" }),
      ],
    });
    const handoff = { ...fullHandoffJsonObj(), next: "Sad Path" };
    expect(resolveNextSteps(g, "a", handoff)).toEqual({ kind: "steps", stepIds: ["c"] });
  });

  test("multiple outgoing edges, no next -> ambiguous with candidate names", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "Branch B" }), makeStep({ id: "c", name: "Branch C" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b" }),
        makeEdge({ id: "e2", from: "a", to: "c" }),
      ],
    });
    expect(resolveNextSteps(g, "a", null)).toEqual({ kind: "ambiguous", candidates: ["Branch B", "Branch C"] });
  });

  test("multiple outgoing edges, unmatched next -> unknown with candidate names", () => {
    const g = makeGraph({
      steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "Branch B" }), makeStep({ id: "c", name: "Branch C" })],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b" }),
        makeEdge({ id: "e2", from: "a", to: "c" }),
      ],
    });
    const handoff = { ...fullHandoffJsonObj(), next: "Nonexistent" };
    expect(resolveNextSteps(g, "a", handoff)).toEqual({
      kind: "unknown",
      next: "Nonexistent",
      candidates: ["Branch B", "Branch C"],
    });
  });

  test("transition:'all' starts every outgoing target regardless of next", () => {
    const g = makeGraph({
      steps: [
        makeStep({ id: "a", transition: "all" }),
        makeStep({ id: "b", name: "B" }),
        makeStep({ id: "c", name: "C" }),
      ],
      edges: [
        makeEdge({ id: "e1", from: "a", to: "b" }),
        makeEdge({ id: "e2", from: "a", to: "c" }),
      ],
    });
    const handoff = { ...fullHandoffJsonObj(), next: "B" };
    expect(resolveNextSteps(g, "a", handoff)).toEqual({ kind: "steps", stepIds: ["b", "c"] });
    expect(resolveNextSteps(g, "a", null)).toEqual({ kind: "steps", stepIds: ["b", "c"] });
  });
});

function fullHandoffJsonObj(overrides: Partial<Handoff> = {}): Handoff {
  return {
    schemaVersion: 1,
    purpose: "Ship the feature",
    summary: "Did the thing",
    reason: "Done, handing off",
    next: "Step 2",
    artifacts: [],
    openQuestions: [],
    status: "done",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveRunStatus

describe("deriveRunStatus", () => {
  test("blocked wins when any block is present, even with active executions", () => {
    const run = makeRun({
      active: [{ stepId: "a", taskId: "t1", seq: 1 }],
      blocked: [{ taskId: "t2", stepId: "b", kind: "handoff-missing", message: "no handoff" }],
    });
    expect(deriveRunStatus(run)).toBe("blocked");
  });

  test("running when active and not blocked", () => {
    const run = makeRun({ active: [{ stepId: "a", taskId: "t1", seq: 1 }] });
    expect(deriveRunStatus(run)).toBe("running");
  });

  test("preserves a stored cancelled status when nothing active/blocked", () => {
    const run = makeRun({ status: "cancelled" });
    expect(deriveRunStatus(run)).toBe("cancelled");
  });

  test("preserves a stored idle status when nothing active/blocked", () => {
    const run = makeRun({ status: "idle" });
    expect(deriveRunStatus(run)).toBe("idle");
  });

  test("done when nothing active/blocked and status isn't idle/cancelled", () => {
    const run = makeRun({ status: "running" });
    expect(deriveRunStatus(run)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// effectiveStepCap

describe("effectiveStepCap", () => {
  test("falls back to PIPELINE_LIMITS.maxStepsDefault with no snapshot", () => {
    expect(effectiveStepCap(makeRun())).toBe(PIPELINE_LIMITS.maxStepsDefault);
  });

  test("uses the snapshot's maxSteps with no extensions", () => {
    const run = makeRun({
      snapshot: { graph: makeGraph(), maxSteps: 10, profiles: {}, capturedAt: 0 },
    });
    expect(effectiveStepCap(run)).toBe(10);
  });

  test("scales by (1 + capExtensions)", () => {
    const run = makeRun({
      snapshot: { graph: makeGraph(), maxSteps: 10, profiles: {}, capturedAt: 0 },
      capExtensions: 2,
    });
    expect(effectiveStepCap(run)).toBe(30);
  });

  test("undefined capExtensions behaves like 0", () => {
    const run = makeRun({
      snapshot: { graph: makeGraph(), maxSteps: 5, profiles: {}, capturedAt: 0 },
    });
    expect(effectiveStepCap(run)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// composeStepPrompt

describe("composeStepPrompt", () => {
  const baseStep = makeStep({ id: "s1", name: "Implement", instructions: "Write the code." });

  test("contains the pipeline/step header and the goal verbatim", () => {
    const prompt = composeStepPrompt({
      pipelineName: "Ship It",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "Build the login page end to end.",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain('Pipeline "Ship It"');
    expect(prompt).toContain("step 2 of at most 25");
    expect(prompt).toContain("Implement");
    expect(prompt).toContain("Build the login page end to end.");
    expect(prompt).toContain("Write the code.");
  });

  test("first step says there's no prior handoff", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain("This is the first step — there is no prior handoff.");
  });

  test("inlines the previous step's handoff JSON when inlineHandoff is true", () => {
    const handoff = fullHandoffJsonObj({ summary: "Found the bug in auth.ts" });
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "goal",
      previous: [{ stepName: "Investigate", handoff, filePath: "/tmp/handoff-1.json" }],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain('From "Investigate"');
    expect(prompt).toContain("Found the bug in auth.ts");
    expect(prompt).toContain('"schemaVersion": 1');
  });

  test("carries the untrusted-content warning when there is prior handoff context", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "goal",
      previous: [{ stepName: "Investigate", handoff: fullHandoffJsonObj(), filePath: "/tmp/handoff-1.json" }],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain(HANDOFF_UNTRUSTED_CONTENT_WARNING);
  });

  test("omits the untrusted-content warning on the first step (no prior handoff)", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).not.toContain(HANDOFF_UNTRUSTED_CONTENT_WARNING);
  });

  test("inline byte budget: a later entry that would exceed the cap falls back to its file pointer", () => {
    const bigA = "A".repeat(10_000);
    const bigB = "B".repeat(10_000);
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 3,
      stepCap: 25,
      goal: "goal",
      previous: [
        { stepName: "First", handoff: fullHandoffJsonObj({ summary: bigA }), filePath: "/tmp/h1.json" },
        { stepName: "Second", handoff: fullHandoffJsonObj({ summary: bigB }), filePath: "/tmp/h2.json" },
      ],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain(bigA);
    expect(prompt).not.toContain(bigB);
    expect(prompt).toContain("(handoff too large to inline — saved to /tmp/h2.json)");
  });

  test("inline byte budget: falls back to the no-file message when a too-large entry has no filePath", () => {
    const bigA = "A".repeat(10_000);
    const bigB = "B".repeat(10_000);
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 3,
      stepCap: 25,
      goal: "goal",
      previous: [
        { stepName: "First", handoff: fullHandoffJsonObj({ summary: bigA }), filePath: null },
        { stepName: "Second", handoff: fullHandoffJsonObj({ summary: bigB }), filePath: null },
      ],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain(bigA);
    expect(prompt).not.toContain(bigB);
    expect(prompt).toContain("(handoff too large to inline; no file available)");
  });

  test("inline byte budget boundary: exactly at the cap inlines, one byte over falls back", () => {
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(JSON.stringify(fullHandoffJsonObj({ summary: "" }), null, 2)).length;
    const fillAtCap = "x".repeat(PIPELINE_LIMITS.handoffInlineMaxBytes - baseBytes);
    const commonArgs = {
      pipelineName: "P",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "goal",
      outgoing: [],
      transition: "choose" as const,
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    };

    const atCapPrompt = composeStepPrompt({
      ...commonArgs,
      previous: [{ stepName: "Prev", handoff: fullHandoffJsonObj({ summary: fillAtCap }), filePath: "/tmp/h.json" }],
    });
    expect(atCapPrompt).toContain(fillAtCap);
    expect(atCapPrompt).not.toContain("too large to inline");

    const overCapPrompt = composeStepPrompt({
      ...commonArgs,
      previous: [{ stepName: "Prev", handoff: fullHandoffJsonObj({ summary: `${fillAtCap}x` }), filePath: "/tmp/h.json" }],
    });
    expect(overCapPrompt).toContain("(handoff too large to inline — saved to /tmp/h.json)");
    expect(overCapPrompt).not.toContain(`${fillAtCap}x`);
  });

  test("inline byte budget still applies with inlineHandoff:false (gemini path) — nothing ever inlines", () => {
    const bigA = "A".repeat(10_000);
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "goal",
      previous: [{ stepName: "First", handoff: fullHandoffJsonObj({ summary: bigA }), filePath: "/tmp/h1.json" }],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: false,
      parallelSiblings: [],
    });
    expect(prompt).not.toContain(bigA);
    expect(prompt).toContain("(handoff saved to /tmp/h1.json)");
    expect(prompt).not.toContain("too large to inline");
  });

  test("points at the file path instead of inlining when inlineHandoff is false", () => {
    const handoff = fullHandoffJsonObj();
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "goal",
      previous: [{ stepName: "Investigate", handoff, filePath: "/tmp/handoff-1.json" }],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: false,
      parallelSiblings: [],
    });
    expect(prompt).toContain("(handoff saved to /tmp/handoff-1.json)");
    expect(prompt).not.toContain('"schemaVersion": 1');
  });

  test("notes a missing prior handoff", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 2,
      stepCap: 25,
      goal: "goal",
      previous: [{ stepName: "Investigate", handoff: null, filePath: null }],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain("(no handoff was provided)");
  });

  test("renders several previous entries after a join", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 3,
      stepCap: 25,
      goal: "goal",
      previous: [
        { stepName: "Branch A", handoff: fullHandoffJsonObj({ summary: "A done" }), filePath: null },
        { stepName: "Branch B", handoff: fullHandoffJsonObj({ summary: "B done" }), filePath: null },
      ],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain('From "Branch A"');
    expect(prompt).toContain("A done");
    expect(prompt).toContain('From "Branch B"');
    expect(prompt).toContain("B done");
  });

  test("delegation section lists subagent profiles with cap", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [makeProfileSnapshot({ name: "Tester", skills: ["run-tests"] })],
      subagentCap: 2,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain("Limit: 2 subagent(s)");
    expect(prompt).toContain("**Tester**");
    expect(prompt).toContain("harness Claude Code");
    expect(prompt).toContain("skills: /run-tests");
  });

  test("delegation section says no limit when cap is null", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [makeProfileSnapshot()],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain("No limit on how many.");
  });

  test("delegation section says not to spawn subagents when the list is empty", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain("Do not spawn subagents for this step.");
  });

  test("parallel-siblings section appears only when siblings are present", () => {
    const withSiblings = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "all",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: ["Docs", "Tests"],
    });
    expect(withSiblings).toContain("## Running in parallel");
    expect(withSiblings).toContain("Docs, Tests");
    expect(withSiblings).toContain("checkout, reset, stash, rebase");

    const withoutSiblings = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(withoutSiblings).not.toContain("## Running in parallel");
  });

  test("next rule: terminal step", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain('This is the last step: set "next" to null.');
  });

  test("next rule: transition 'all' names every outgoing step and says set next to null", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [{ name: "Docs", label: "" }, { name: "Tests", label: "" }],
      transition: "all",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain('set "next" to null: Docs, Tests');
  });

  test("next rule: exactly one outgoing step names it directly", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [{ name: "Review", label: "" }],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain('The next step is "Review"; set "next" to "Review".');
  });

  test("next rule: several outgoing steps asks to choose by name", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [{ name: "Happy", label: "happy path" }, { name: "Sad", label: "" }],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain("Choose exactly one next step by name:");
    expect(prompt).toContain("Happy (happy path)");
    expect(prompt).toContain("Sad");
  });

  test("mentions the handoff tag and the closing-tag warning", () => {
    const prompt = composeStepPrompt({
      pipelineName: "P",
      step: baseStep,
      stepIndex: 1,
      stepCap: 25,
      goal: "goal",
      previous: [],
      outgoing: [],
      transition: "choose",
      subagentProfiles: [],
      subagentCap: null,
      inlineHandoff: true,
      parallelSiblings: [],
    });
    expect(prompt).toContain(`<${HANDOFF_TAG}>`);
    expect(prompt).toContain(`</${HANDOFF_TAG}>`);
    expect(prompt).toContain("Do not put anything after the closing");
  });
});

// ---------------------------------------------------------------------------
// matchPipelineRef

describe("matchPipelineRef", () => {
  const pipelines = [
    makePipeline({ id: "p1", name: "Ship It" }),
    makePipeline({ id: "p2", name: "Review Loop" }),
    makePipeline({ id: "p3", name: "review loop" }),
  ];

  test("exact id match wins", () => {
    const result = matchPipelineRef(pipelines, "p1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pipeline.id).toBe("p1");
  });

  test("unique case-insensitive, trimmed name match", () => {
    const result = matchPipelineRef(pipelines, "  ship it  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pipeline.id).toBe("p1");
  });

  test("ambiguous name match", () => {
    const result = matchPipelineRef(pipelines, "Review Loop");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ambiguous pipeline/);
  });

  test("unknown ref", () => {
    const result = matchPipelineRef(pipelines, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown pipeline/);
  });
});

// ---------------------------------------------------------------------------
// stepNameById

describe("stepNameById", () => {
  const g = makeGraph({ steps: [makeStep({ id: "a", name: "Alpha" })] });

  test("returns the step's name", () => {
    expect(stepNameById(g, "a")).toBe("Alpha");
  });

  test("falls back to the id when the step isn't found", () => {
    expect(stepNameById(g, "ghost")).toBe("ghost");
  });
});

// ---------------------------------------------------------------------------
// pipelineStepProgress

describe("pipelineStepProgress", () => {
  test("counts succeeded and advanced-manually as completed", () => {
    const run = makeRun({
      history: [
        { seq: 1, stepId: "a", taskId: "t1", startedAt: 0, endedAt: 1, outcome: "succeeded", handoff: null, nextStepIds: ["b"] },
        { seq: 2, stepId: "b", taskId: "t2", startedAt: 1, endedAt: 2, outcome: "advanced-manually", handoff: null, nextStepIds: [] },
        { seq: 3, stepId: "c", taskId: "t3", startedAt: 2, endedAt: 3, outcome: "failed", handoff: null, nextStepIds: [] },
      ],
      snapshot: {
        graph: makeGraph({ steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "B" }), makeStep({ id: "c", name: "C" })] }),
        maxSteps: 25,
        profiles: {},
        capturedAt: 0,
      },
    });
    const progress = pipelineStepProgress(run);
    expect(progress.completed).toBe(2);
    expect(progress.total).toBe(3);
    expect(progress.label).toBe("2/3");
  });

  test("appends the first active step's name to the label", () => {
    const run = makeRun({
      active: [{ stepId: "b", taskId: "t2", seq: 2 }],
      snapshot: {
        graph: makeGraph({ steps: [makeStep({ id: "a" }), makeStep({ id: "b", name: "Branch B" })] }),
        maxSteps: 25,
        profiles: {},
        capturedAt: 0,
      },
    });
    const progress = pipelineStepProgress(run);
    expect(progress.active).toBe(1);
    expect(progress.label).toBe("0/2 · Branch B");
  });

  test("total is 0 before the first run (no snapshot)", () => {
    const progress = pipelineStepProgress(makeRun());
    expect(progress.total).toBe(0);
    expect(progress.label).toBe("0/0");
  });
});
