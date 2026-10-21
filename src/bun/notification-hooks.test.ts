import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-notification-hooks-"));
process.env.AGETOR_DATA_DIR ??= dataDir;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

import type { ColumnId, GlobalEvent } from "../shared/types.ts";
import type { TaskNotificationRemoval } from "../shared/os-notification.ts";

afterAll(() => {
  rmTestDataDir(dataDir);
});

const resolved = (taskId: string, pipelineParentId?: string): GlobalEvent => ({
  kind: "interaction",
  taskId,
  runId: "r1",
  state: "resolved",
  interactionId: "i1",
  ts: Date.now(),
  ...(pipelineParentId ? { pipelineParentId } : {}),
});

const column = (
  taskId: string,
  prev: ColumnId | null,
  next: ColumnId,
  pipelineParentId?: string,
): GlobalEvent => ({
  kind: "column",
  taskId,
  runId: null,
  column: next,
  prev,
  ts: Date.now(),
  ...(pipelineParentId ? { pipelineParentId } : {}),
});

describe("removalForEvent", () => {
  test("an answered question with nothing else pending removes the waiting entry", async () => {
    const { removalForEvent } = await import("./notification-hooks.ts");
    expect(removalForEvent(resolved("t1"), { pendingFor: () => 0 })).toEqual({
      taskId: "t1",
      ifKinds: ["waiting"],
    });
  });

  test("an answered question with another still pending removes nothing", async () => {
    const { removalForEvent } = await import("./notification-hooks.ts");
    expect(removalForEvent(resolved("t1"), { pendingFor: () => 1 })).toBeNull();
  });

  test("a step's answered question targets the pipeline parent", async () => {
    const { removalForEvent } = await import("./notification-hooks.ts");
    const asked: string[] = [];
    const r = removalForEvent(resolved("step-1", "parent-1"), {
      pendingFor: (id) => {
        asked.push(id);
        return 0;
      },
    });
    expect(asked).toEqual(["parent-1"]);
    expect(r).toEqual({ taskId: "parent-1", ifKinds: ["waiting"] });
  });

  test("leaving blocked removes the reason family", async () => {
    const { removalForEvent } = await import("./notification-hooks.ts");
    expect(removalForEvent(column("t1", "blocked", "running"))).toEqual({
      taskId: "t1",
      ifKinds: ["waiting", "blocked", "api-error", "session-ended", "unknown-command"],
    });
  });

  test("a step's own column event never removes", async () => {
    const { removalForEvent } = await import("./notification-hooks.ts");
    expect(removalForEvent(column("step-1", "blocked", "review", "parent-1"))).toBeNull();
  });

  test("other column moves, pending questions and other kinds remove nothing", async () => {
    const { removalForEvent } = await import("./notification-hooks.ts");
    expect(removalForEvent(column("t1", "running", "review"))).toBeNull();
    expect(removalForEvent(column("t1", "running", "blocked"))).toBeNull();
    expect(removalForEvent(column("t1", null, "running"))).toBeNull();
    expect(
      removalForEvent({ ...resolved("t1"), state: "pending" } as GlobalEvent, { pendingFor: () => 0 }),
    ).toBeNull();
    expect(
      removalForEvent({ kind: "run-status", taskId: "t1", runId: "r1", status: "succeeded", ts: 1 }),
    ).toBeNull();
  });
});

describe("task lookups", () => {
  async function makeParentWithStep() {
    const { createTask } = await import("./orchestrator.ts");
    const { tasks } = await import("./db.ts");
    const base = await createTask({
      title: "notification-hooks: base",
      prompt: "p",
      agent: "claude-code",
      workdir: process.cwd(),
      isolation: "none",
    });
    if ("error" in base) throw new Error(base.error);
    const parentId = randomUUID();
    const stepId = randomUUID();
    tasks.insert({ ...base.task, id: parentId, title: "pipeline parent", pipelineId: "pl-hooks" });
    tasks.insert({ ...base.task, id: stepId, title: "pipeline · step", pipelineParentId: parentId, pipelineStepId: "s1" });
    const cleanup = () => {
      tasks.delete(stepId);
      tasks.delete(parentId);
      tasks.delete(base.task.id);
    };
    return { baseId: base.task.id, parentId, stepId, cleanup };
  }

  test("notificationTargetTaskId maps a step to its parent, anything else to itself", async () => {
    const { notificationTargetTaskId } = await import("./notification-hooks.ts");
    const { baseId, parentId, stepId, cleanup } = await makeParentWithStep();
    try {
      expect(notificationTargetTaskId(stepId)).toBe(parentId);
      expect(notificationTargetTaskId(parentId)).toBe(parentId);
      expect(notificationTargetTaskId(baseId)).toBe(baseId);
      expect(notificationTargetTaskId("no-such-task")).toBe("no-such-task");
    } finally {
      cleanup();
    }
  });

  test("pendingInteractionsFor counts a parent's steps", async () => {
    const { pendingInteractionsFor } = await import("./notification-hooks.ts");
    const { registerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
    const { parentId, stepId, cleanup } = await makeParentWithStep();
    try {
      expect(pendingInteractionsFor(parentId)).toBe(0);
      registerTmuxPrompt({
        taskId: stepId,
        runId: "r1",
        paneText: "?",
        choices: [{ key: "1", label: "Yes" }],
        fingerprint: "fp-hooks-step",
      });
      expect(pendingInteractionsFor(parentId)).toBe(1);
      expect(pendingInteractionsFor(stepId)).toBe(1);
      cancelPendingForTask(stepId, "test");
      expect(pendingInteractionsFor(parentId)).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("installNotificationRemovalHooks (real interaction bus)", () => {
  test("a cancelled prompt records exactly one waiting removal", async () => {
    const { installNotificationRemovalHooks } = await import("./notification-hooks.ts");
    const { registerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
    const taskId = `hooks-${randomUUID()}`;
    const removals: TaskNotificationRemoval[] = [];
    const unsub = installNotificationRemovalHooks((r) => {
      if (r.taskId === taskId) removals.push(r);
    });
    try {
      registerTmuxPrompt({
        taskId,
        runId: "r1",
        paneText: "?",
        choices: [{ key: "1", label: "Yes" }],
        fingerprint: "fp-hooks-one",
      });
      expect(removals).toEqual([]);
      cancelPendingForTask(taskId, "test");
      expect(removals).toEqual([{ taskId, ifKinds: ["waiting"] }]);
    } finally {
      unsub();
    }
  });

  test("two stacked prompts record a removal only after the last resolves", async () => {
    const { installNotificationRemovalHooks } = await import("./notification-hooks.ts");
    const { registerTmuxPrompt, answerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
    const taskId = `hooks-${randomUUID()}`;
    const removals: TaskNotificationRemoval[] = [];
    const unsub = installNotificationRemovalHooks((r) => {
      if (r.taskId === taskId) removals.push(r);
    });
    try {
      const first = registerTmuxPrompt({
        taskId,
        runId: "r1",
        paneText: "?",
        choices: [{ key: "1", label: "Yes" }],
        fingerprint: "fp-hooks-a",
      });
      registerTmuxPrompt({
        taskId,
        runId: "r1",
        paneText: "??",
        choices: [{ key: "1", label: "Yes" }],
        fingerprint: "fp-hooks-b",
      });
      expect(answerTmuxPrompt(first.id, { key: "__external__" })).toBe(true);
      expect(removals).toEqual([]);
      cancelPendingForTask(taskId, "test");
      expect(removals).toEqual([{ taskId, ifKinds: ["waiting"] }]);
    } finally {
      unsub();
    }
  });

  test("unsubscribing stops recording", async () => {
    const { installNotificationRemovalHooks } = await import("./notification-hooks.ts");
    const { registerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
    const taskId = `hooks-${randomUUID()}`;
    const removals: TaskNotificationRemoval[] = [];
    const unsub = installNotificationRemovalHooks((r) => {
      if (r.taskId === taskId) removals.push(r);
    });
    unsub();
    registerTmuxPrompt({
      taskId,
      runId: "r1",
      paneText: "?",
      choices: [{ key: "1", label: "Yes" }],
      fingerprint: "fp-hooks-unsub",
    });
    cancelPendingForTask(taskId, "test");
    expect(removals).toEqual([]);
  });
});
