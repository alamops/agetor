import type { Task } from "../shared/types.ts";

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
