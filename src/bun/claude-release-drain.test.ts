import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GlobalEvent } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

/*
 * RC1 (docs/plans/handoff-identification-fix.md §3.1): the subagent watcher
 * scans the session JSONL independently of the session tailer, so it can
 * settle the last background subagent of a HELD task — and reach the
 * orchestrator's release hook `maybeReleaseHeldTask` — before the tailer has
 * dispatched the very `<task-notification>` line that starts Claude's
 * auto-continuation. `maybeReleaseHeldTask` now drains the session's JSONL
 * first, so a line that is already on disk adopts the continuation (task.runId
 * -> a running continuation run) and the release bails: no `review` flicker,
 * and nothing settles the pre-continuation run.
 *
 * Drives the REAL orchestrator, the REAL subagent settle path
 * (`settleSubagentById`) and the REAL claude-tmux tailer over a synthetic
 * SessionState (`__forTest.installSession`) — only tmux is a no-op stub.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-release-drain-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // Force orchestrator.ts's module-init wiring (settle hook, continuation
  // factory) before any test settles a subagent.
  await import("./orchestrator.ts");
});

afterAll(() => {
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  rmTestDataDir(DATA_DIR);
});

const createdTaskIds: string[] = [];
afterEach(async () => {
  const { db } = await import("./db.ts");
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

/** The `<task-notification>` breadcrumb claude injects as a `user` line when a
 *  background agent finishes (same shape claude-continuation.test.ts uses). */
function taskNotificationLine(taskTag: string, uuid: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    origin: { kind: "task-notification" },
    message: { content: `<task-notification><task-id>${taskTag}</task-id></task-notification>` },
  }) + "\n";
}

interface HeldFixture {
  taskId: string;
  /** The pre-continuation run, `succeeded`, whose settle held the task. */
  runId: string;
  subagentId: string;
  jsonlPath: string;
  state: ReturnType<(typeof import("./claude-tmux.ts"))["__forTest"]["installSession"]>;
}

/**
 * A claude task parked in `running` by the #92 hold: its terminal run R
 * succeeded, one background subagent is still `running`, and a live (synthetic)
 * session tails an empty JSONL at offset 0.
 */
async function heldTask(): Promise<HeldFixture> {
  const { createTask } = await import("./orchestrator.ts");
  const { runs, tasks, subagents } = await import("./db.ts");
  const { __forTest } = await import("./claude-tmux.ts");
  const created = await createTask({
    title: "release-drain",
    prompt: "hello",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // never materialize a worktree off the live repo in tests
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  createdTaskIds.push(taskId);

  const runId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: now - 5000,
    endedAt: now,
    exitCode: 0,
    tmuxSession: `agetor-test-${taskId}`,
    claudeSessionId: `sess-${randomUUID()}`,
    codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  tasks.update(taskId, { column: "running", runId });

  const subagentId = `agent-${randomUUID()}`;
  subagents.insertIfAbsent({
    id: subagentId,
    taskId,
    runId,
    parentKind: "subagent",
    agentType: "general-purpose",
    description: "background review",
    spawnDepth: 1,
    sourcePath: `/tmp/${subagentId}.jsonl`,
    status: "running",
    startedAt: now - 4000,
    endedAt: null,
  });

  const dir = mkdtempSync(path.join(tmpdir(), "agetor-release-drain-sess-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const state = __forTest.installSession(taskId, jsonlPath);
  return { taskId, runId, subagentId, jsonlPath, state };
}

/** Tear down what the adoption leaves behind: the continuation's armed
 *  watchdog timer, its `active` entry, and the synthetic session. */
async function cleanup(f: HeldFixture): Promise<void> {
  const { __forTest } = await import("./claude-tmux.ts");
  const { tasks } = await import("./db.ts");
  const wd = __forTest.getContinuationWatchdog(f.state);
  if (wd) clearTimeout(wd.timer);
  const current = tasks.get(f.taskId)?.runId;
  if (current && current !== f.runId) {
    const { cancelRun } = await import("./orchestrator.ts");
    await cancelRun(current);
  }
  __forTest.uninstallSession(f.taskId);
}

test("RC1: a task-notification line already on disk is adopted by the release drain — the card stays running and the pre-continuation run is not settled", async () => {
  const f = await heldTask();
  const { runs, tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");
  const { subscribeGlobal } = await import("./orchestrator.ts");

  const events: GlobalEvent[] = [];
  const unsubscribe = subscribeGlobal((e) => {
    if ("taskId" in e && e.taskId === f.taskId) events.push(e);
  });
  try {
    // The notification line is on disk, but the tailer has not read it yet.
    appendFileSync(f.jsonlPath, taskNotificationLine("agent-rc1", "uuid-notif-rc1"));
    expect(f.state.offset).toBe(0);
    expect(tasks.get(f.taskId)?.runId).toBe(f.runId);

    // The subagent watcher wins the race: it settles the last running
    // subagent, which reaches `maybeReleaseHeldTask` via the settle hook.
    expect(settleSubagentById(f.subagentId, "completed", "receipt")).toBe(true);
    expect(subagents.hasRunning(f.taskId)).toBe(false);

    // The drain dispatched the line first: the continuation is adopted and is
    // the task's current run, `running`.
    const task = tasks.get(f.taskId)!;
    expect(task.runId).not.toBe(f.runId);
    const continuation = runs.get(task.runId!)!;
    expect(continuation.origin).toBe("continuation");
    expect(continuation.status).toBe("running");
    expect(task.column).toBe("running");

    // Nothing released the card, and nothing settled the old run for anyone
    // listening (no `review` column move, no run-status).
    expect(events.filter((e) => e.kind === "column" && e.column === "review")).toEqual([]);
    expect(events.filter((e) => e.kind === "run-status")).toEqual([]);
    expect(runs.get(f.runId)?.status).toBe("succeeded");
  } finally {
    unsubscribe();
    await cleanup(f);
  }
});

test("RC1 negative: with no notification line on disk the release still goes to review, exactly as before", async () => {
  const f = await heldTask();
  const { tasks, subagents } = await import("./db.ts");
  const { settleSubagentById } = await import("./claude-subagents.ts");
  const { subscribeGlobal } = await import("./orchestrator.ts");

  const events: GlobalEvent[] = [];
  const unsubscribe = subscribeGlobal((e) => {
    if ("taskId" in e && e.taskId === f.taskId) events.push(e);
  });
  try {
    expect(settleSubagentById(f.subagentId, "completed", "receipt")).toBe(true);
    expect(subagents.hasRunning(f.taskId)).toBe(false);

    const task = tasks.get(f.taskId)!;
    expect(task.runId).toBe(f.runId);
    expect(task.column).toBe("review");
    expect(events.some((e) => e.kind === "column" && e.column === "review")).toBe(true);
  } finally {
    unsubscribe();
    await cleanup(f);
  }
});
