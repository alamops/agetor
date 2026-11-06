import { describe, expect, test } from "bun:test";
import { resolvePipelineLaunch, type PipelineLaunchResolution } from "./pipeline-launch.ts";
import type {
  AgentProfile,
  AgentStatus,
  Harness,
  PipelineGraph,
  PipelineStep,
} from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "profile-plan",
    name: "Planner",
    harness: "harness-1",
    model: "opus-5",
    effort: "high",
    mode: "auto",
    speed: "off",
    opencodeServer: "shared",
    maxMode: false,
    instructions: "",
    skills: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    id: "harness-1",
    kind: "claude-code",
    label: "Claude Code",
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    harnessId: "harness-1",
    kind: "claude-code",
    bin: "claude",
    available: true,
    path: "/usr/local/bin/claude",
    version: "1.0.0",
    reason: null,
    installHint: null,
    account: null,
    usage: null,
    loggedIn: null,
    authHelp: null,
    ...overrides,
  };
}

function makeStep(input: Partial<PipelineStep> & { id: string; name: string }): PipelineStep {
  return {
    instructions: "",
    agentProfileId: "profile-plan",
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...input,
  };
}

function makeGraph(input: {
  steps: PipelineStep[];
  edges?: PipelineGraph["edges"];
  startStepId?: string | null;
}): PipelineGraph {
  return {
    steps: input.steps,
    edges: input.edges ?? [],
    startStepId: input.startStepId === undefined ? (input.steps[0]?.id ?? null) : input.startStepId,
  };
}

/** The healthy baseline every case overrides one field of. */
function readyInput(graph: PipelineGraph) {
  return {
    graph,
    profiles: [makeProfile()],
    profilesLoaded: true,
    harnesses: [makeHarness()],
    agents: [makeStatus()],
  };
}

const oneStep = () =>
  makeGraph({ steps: [makeStep({ id: "step-plan", name: "Plan" })] });

function expectBlocked(resolution: PipelineLaunchResolution, fragment: string): void {
  expect(resolution.state).toBe("blocked");
  expect(resolution.reason).toContain(fragment);
}

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

describe("resolvePipelineLaunch", () => {
  test("no graph reports no-pipeline with no resolved identity", () => {
    const resolution = resolvePipelineLaunch({
      ...readyInput(oneStep()),
      graph: null,
    });
    expect(resolution).toEqual({
      state: "no-pipeline",
      reason: null,
      startStep: null,
      startProfile: null,
      startHarness: null,
      startStatus: undefined,
    });
  });

  test("a valid one-step graph with a loaded profile and available harness is ready", () => {
    const graph = oneStep();
    const profile = makeProfile();
    const harness = makeHarness();
    const status = makeStatus();
    const resolution = resolvePipelineLaunch({
      graph,
      profiles: [profile],
      profilesLoaded: true,
      harnesses: [harness],
      agents: [status],
    });

    expect(resolution.state).toBe("ready");
    expect(resolution.reason).toBeNull();
    expect(resolution.startStep).toMatchObject({ id: "step-plan", name: "Plan" });
    expect(resolution.startStep?.type).toBe("agent");
    expect(resolution.startProfile).toEqual(profile);
    expect(resolution.startHarness).toEqual(harness);
    expect(resolution.startStatus).toEqual(status);
  });

  test("loggedIn null (unknown) never blocks", () => {
    const resolution = resolvePipelineLaunch({
      ...readyInput(oneStep()),
      agents: [makeStatus({ loggedIn: null })],
    });
    expect(resolution.state).toBe("ready");
    expect(resolution.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Graph validity / entry point
// ---------------------------------------------------------------------------

describe("resolvePipelineLaunch graph rules", () => {
  test("duplicate step names block with the validator's message", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "b", name: "  plan  " }),
      ],
      startStepId: "a",
    });
    expectBlocked(resolvePipelineLaunch(readyInput(graph)), "pipeline graph is invalid: duplicate step name");
  });

  test("a dangling startStepId blocks with the validator's message", () => {
    const graph = makeGraph({
      steps: [makeStep({ id: "a", name: "Plan" })],
      startStepId: "nope",
    });
    expectBlocked(
      resolvePipelineLaunch(readyInput(graph)),
      "pipeline graph is invalid: startStepId must reference an existing step",
    );
  });

  test("two root steps with no startStepId block as unresolvable", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Alpha" }),
        makeStep({ id: "b", name: "Beta" }),
      ],
      startStepId: null,
    });
    const resolution = resolvePipelineLaunch(readyInput(graph));
    expectBlocked(resolution, "pipeline has no resolvable start step");
    expect(resolution.startStep).toBeNull();
  });

  test("an empty graph is blocked (no resolvable start step)", () => {
    expectBlocked(
      resolvePipelineLaunch(readyInput(makeGraph({ steps: [], startStepId: null }))),
      "pipeline has no resolvable start step",
    );
  });

  test("a human start step is blocked by the validator, carrying its message", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "gate", name: "Review", type: "human", agentProfileId: null }),
      ],
      edges: [{ id: "e1", from: "a", to: "gate", label: "" }],
      startStepId: "gate",
    });
    expectBlocked(
      resolvePipelineLaunch(readyInput(graph)),
      'step "Review" is a human step and can\'t be the start step',
    );
  });

  test("a human later step is fine as long as the start step is an agent step", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "gate", name: "Review", type: "human", agentProfileId: null }),
      ],
      edges: [{ id: "e1", from: "a", to: "gate", label: "" }],
      startStepId: "a",
    });
    expect(resolvePipelineLaunch(readyInput(graph)).state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

describe("resolvePipelineLaunch profile rules", () => {
  test("a later non-human step with no agent blocks and names it", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "b", name: "Build", agentProfileId: null }),
      ],
      edges: [{ id: "e1", from: "a", to: "b", label: "" }],
      startStepId: "a",
    });
    expectBlocked(resolvePipelineLaunch(readyInput(graph)), 'step "Build" has no agent');
  });

  test("a later step pointing at a missing profile blocks once the list has loaded", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "b", name: "Build", agentProfileId: "profile-gone" }),
      ],
      edges: [{ id: "e1", from: "a", to: "b", label: "" }],
      startStepId: "a",
    });
    expectBlocked(
      resolvePipelineLaunch(readyInput(graph)),
      'agent for step "Build" no longer exists',
    );
  });

  test("the same missing later profile is only checking while the list has never loaded", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "b", name: "Build", agentProfileId: "profile-gone" }),
      ],
      edges: [{ id: "e1", from: "a", to: "b", label: "" }],
      startStepId: "a",
    });
    const resolution = resolvePipelineLaunch({
      ...readyInput(graph),
      profilesLoaded: false,
    });
    expect(resolution.state).toBe("checking");
    expect(resolution.reason).toBeNull();
  });

  test("a deleted start profile blocks with the server's message", () => {
    const graph = oneStep();
    const resolution = resolvePipelineLaunch({
      ...readyInput(graph),
      profiles: [],
    });
    expectBlocked(resolution, 'agent for step "Plan" no longer exists');
    expect(resolution.startProfile).toBeNull();
  });

  test("an unresolvable start profile is checking while the list has never loaded", () => {
    const resolution = resolvePipelineLaunch({
      ...readyInput(oneStep()),
      profiles: [],
      profilesLoaded: false,
    });
    expect(resolution.state).toBe("checking");
    expect(resolution.reason).toBeNull();
    expect(resolution.startStep).not.toBeNull();
    expect(resolution.startProfile).toBeNull();
  });

  test("a start step with no agent blocks even while the list is not loaded", () => {
    const graph = makeGraph({
      steps: [makeStep({ id: "a", name: "Plan", agentProfileId: null })],
      startStepId: "a",
    });
    expectBlocked(
      resolvePipelineLaunch({ ...readyInput(graph), profiles: [], profilesLoaded: false }),
      'step "Plan" has no agent',
    );
  });
});

// ---------------------------------------------------------------------------
// Start-step harness
// ---------------------------------------------------------------------------

describe("resolvePipelineLaunch start harness rules", () => {
  test("a missing harness blocks, labelled by the profile's raw harness id", () => {
    const graph = oneStep();
    const resolution = resolvePipelineLaunch({
      ...readyInput(graph),
      profiles: [makeProfile({ harness: "harness-gone" })],
    });
    expectBlocked(
      resolution,
      "harness-gone is disabled — re-enable it in Settings to start new runs.",
    );
    expect(resolution.startHarness).toBeNull();
  });

  test("a disabled harness blocks with its label", () => {
    const resolution = resolvePipelineLaunch({
      ...readyInput(oneStep()),
      harnesses: [makeHarness({ enabled: false, label: "Claude Code" })],
    });
    expectBlocked(
      resolution,
      "Claude Code is disabled — re-enable it in Settings to start new runs.",
    );
  });

  test("an unavailable harness blocks with its own reason and install hint", () => {
    const response = resolvePipelineLaunch({
      ...readyInput(oneStep()),
      agents: [
        makeStatus({
          available: false,
          reason: "the claude binary isn't on PATH",
          installHint: "npm i -g @anthropic-ai/claude-code",
        }),
      ],
    });
    expectBlocked(response, "Claude Code is not available — the claude binary isn't on PATH.");
    expect(response.reason).toContain("Install it with: npm i -g @anthropic-ai/claude-code");
  });

  test("a harness with no status at all blocks as unavailable", () => {
    expectBlocked(
      resolvePipelineLaunch({ ...readyInput(oneStep()), agents: [] }),
      "Claude Code is not available — its status couldn't be determined.",
    );
  });

  test("a positively logged-out harness blocks with its auth help", () => {
    const resolution = resolvePipelineLaunch({
      ...readyInput(oneStep()),
      agents: [makeStatus({ loggedIn: false, authHelp: "run `claude login`" })],
    });
    expectBlocked(resolution, "Claude Code isn't logged in — run `claude login`");
  });

  test("a logged-out harness with no auth help falls back to the generic hint", () => {
    expectBlocked(
      resolvePipelineLaunch({
        ...readyInput(oneStep()),
        agents: [makeStatus({ loggedIn: false })],
      }),
      "Claude Code isn't logged in — run its login command",
    );
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("resolvePipelineLaunch purity", () => {
  test("never mutates its inputs", () => {
    const graph = makeGraph({
      steps: [
        makeStep({ id: "a", name: "Plan" }),
        makeStep({ id: "b", name: "Build", agentProfileId: "profile-gone" }),
      ],
      edges: [{ id: "e1", from: "a", to: "b", label: "" }],
      startStepId: "a",
    });
    const input = readyInput(graph);
    const before = structuredClone(input);
    resolvePipelineLaunch(input);
    expect(input).toEqual(before);
  });
});
