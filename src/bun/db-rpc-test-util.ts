// Test-only helpers for the db-rpc / db-async tests (imported only from
// *.test.ts, so tree-shaken out of the bundle like github-test-util.ts).
import { randomUUID } from "node:crypto";
import type { Run, Task } from "../shared/types.ts";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "db-rpc",
    prompt: "p",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

export function makeRun(taskId: string, overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: "agetor-test-db-rpc",
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    ...overrides,
  };
}
