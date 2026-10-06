import type { AgentProfile, Pipeline, Task } from "../shared/types.ts";

/**
 * Typed `Task` fixture for CLI tests. Every required `Task` field is spelled
 * out on a value annotated `: Task`, so a rename or a newly-required field on
 * the shared interface fails `tsc` here instead of silently passing through a
 * fixture cast via `as unknown as Task` (review finding L-CLI13 — the old
 * per-file fixtures cast through `unknown`, so shape drift never surfaced).
 *
 * `over` is a `Partial<Task>` — also typed — so a test can't pass a field the
 * interface doesn't have either. Defaults are the cheapest honest shape: a
 * never-run, non-isolated task on a built-in harness.
 */
export function makeTask(over: Partial<Task> = {}): Task {
  const base: Task = {
    id: "abcdefgh12345678",
    title: "T",
    prompt: "do the thing",
    column: "ready",
    agent: "claude-code",
    workdir: "/repo",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    issueUrl: null,
    agentProfileId: null,
    agentProfile: null,
    pipelineId: null,
    pipelineRun: null,
    pipelineParentId: null,
    pipelineStepId: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    draft: null,
    plans: [],
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    todoProgress: null,
    sentFiles: null,
    fxRecovery: null,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
  return { ...base, ...over };
}

/** Typed `AgentProfile` fixture — same rationale as {@link makeTask}. */
export function makeAgentProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  const base: AgentProfile = {
    id: "prof-a",
    name: "Investigator",
    harness: "claude-code",
    model: "opus-5.5",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    createdAt: 1,
    updatedAt: 1,
  };
  return { ...base, ...over };
}

/** Typed `Pipeline` fixture — same rationale as {@link makeTask}. */
export function makePipelineFixture(over: Partial<Pipeline> = {}): Pipeline {
  const base: Pipeline = {
    id: "pipe-123456789",
    name: "Bug fix flow",
    description: "",
    graph: { steps: [], edges: [], startStepId: null },
    maxSteps: 25,
    createdAt: 1,
    updatedAt: 1,
  };
  return { ...base, ...over };
}
