// Migration 084 + the DB accessors it added (harness stacks T01).
// Runs in the shared test DB, so every row it creates is unique and every
// row it mutates is restored through `snapshotHarnessState`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-db-harness-stacks-"));

type Db = typeof import("./db.ts");
let dbm: Db;
let restore: () => void;

const taskIds: string[] = [];
const runIds: string[] = [];

beforeAll(async () => {
  dbm = await import("./db.ts");
  const { snapshotHarnessState } = await import("./test-harness-state.ts");
  restore = snapshotHarnessState();
});

afterAll(() => {
  for (const id of runIds) dbm.db.run("DELETE FROM runs WHERE id = ?", [id]);
  for (const id of taskIds) dbm.db.run("DELETE FROM tasks WHERE id = ?", [id]);
  restore();
});

function seedTask(): string {
  const id = randomUUID();
  taskIds.push(id);
  dbm.tasks.insert({
    id,
    title: "stack db",
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
    archivedAt: null,
  } as never);
  return id;
}

function seedRun(taskId: string, patch: Partial<import("../shared/types.ts").Run> = {}): string {
  const id = randomUUID();
  runIds.push(id);
  dbm.runs.insert({
    id,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    ...patch,
  });
  return id;
}

describe("084 tables and tasks.harness_state", () => {
  test("the tables and column exist", () => {
    for (const table of ["harness_stacks", "harness_stack_members", "harness_limit_state", "harness_session_handoffs"]) {
      expect(dbm.db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table), table).toBeTruthy();
    }
    const columns = dbm.db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all().map((r) => r.name);
    expect(columns).toContain("harness_state");
  });

  test("setHarnessState is patch-proof and never bumps updated_at", () => {
    const taskId = seedTask();
    const before = dbm.tasks.get(taskId)!;
    dbm.tasks.setHarnessState(taskId, {
      stackId: "stack-1",
      position: 1,
      tried: ["a"],
      pendingSwap: null,
      allExhausted: null,
      lastMove: null,
    });
    const after = dbm.tasks.get(taskId)!;
    expect(after.harnessState?.stackId).toBe("stack-1");
    expect(after.updatedAt).toBe(before.updatedAt);

    dbm.tasks.update(taskId, { title: "renamed" });
    expect(dbm.tasks.get(taskId)?.harnessState?.stackId).toBe("stack-1");

    dbm.tasks.setHarnessState(taskId, null);
    expect(dbm.tasks.get(taskId)?.harnessState).toBeNull();
  });

  test("a malformed harness_state parses as null", () => {
    const taskId = seedTask();
    dbm.db.run("UPDATE tasks SET harness_state = ? WHERE id = ?", ["{not json", taskId]);
    expect(dbm.tasks.get(taskId)?.harnessState).toBeNull();
  });

  test("handoffs upsert, list, delete-one and cascade with the task", () => {
    const taskId = seedTask();
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: "claude-b",
      columnName: "claude_session_id",
      sessionId: "s-1",
      copiedPaths: ["/tmp/x.jsonl"],
      createdAt: 10,
    });
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: "claude-b",
      columnName: "claude_session_id",
      sessionId: "s-2",
      copiedPaths: ["/tmp/y.jsonl"],
      createdAt: 20,
    });
    expect(dbm.harnessSessionHandoffs.get(taskId, "claude-b", "claude_session_id")).toMatchObject({
      sessionId: "s-2",
      copiedPaths: ["/tmp/y.jsonl"],
    });
    expect(dbm.harnessSessionHandoffs.listForTask(taskId)).toHaveLength(1);
    dbm.harnessSessionHandoffs.deleteOne(taskId, "claude-b", "claude_session_id");
    expect(dbm.harnessSessionHandoffs.listForTask(taskId)).toEqual([]);

    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: "claude-b",
      columnName: "claude_session_id",
      sessionId: "s-3",
      copiedPaths: [],
      createdAt: 30,
    });
    dbm.tasks.delete(taskId);
    expect(dbm.harnessSessionHandoffs.listForTask(taskId)).toEqual([]);
  });

  test("harnesses.delete drops the handoff rows that name it as destination", () => {
    const taskId = seedTask();
    const harnessId = `del-handoff-${randomUUID().slice(0, 8)}`;
    dbm.harnesses.insert({
      id: harnessId,
      kind: "claude-code",
      label: harnessId,
      home: mkdtempSync(path.join(tmpdir(), "agetor-del-handoff-")),
      env: {},
    } as never);
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId,
      columnName: "claude_session_id",
      sessionId: "s-delete",
      copiedPaths: [],
      createdAt: 1,
    });
    expect(dbm.harnessSessionHandoffs.listForHarness(harnessId)).toHaveLength(1);
    dbm.harnesses.delete(harnessId);
    expect(dbm.harnessSessionHandoffs.listForHarness(harnessId)).toEqual([]);
  });

  test("mainUserTexts/hasToolUse read the main run stream", () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    expect(dbm.runs.mainUserTexts(runId)).toEqual([]);
    expect(dbm.runs.hasToolUse(runId)).toBe(false);
    dbm.runs.appendEvent(runId, "user", "hello");
    dbm.runs.appendEvent(runId, "assistant", "hi");
    expect(dbm.runs.mainUserTexts(runId)).toEqual(["hello"]);
    // A folded follow-up and a subagent's own user event: the retry needs the
    // ordered main-stream texts and must never pick up a subagent's.
    dbm.runs.appendEvent(runId, "user", "follow-up");
    dbm.runs.appendEvent(runId, "user", "subagent words", null, "agent-1");
    expect(dbm.runs.mainUserTexts(runId)).toEqual(["hello", "follow-up"]);
    dbm.runs.appendEvent(runId, "tool_use", JSON.stringify({ id: "t1", name: "Bash" }));
    expect(dbm.runs.hasToolUse(runId)).toBe(true);
  });

  test("newestSessionForHarness and hasRunning", () => {
    const taskId = seedTask();
    const older = seedRun(taskId, { startedAt: 100, status: "succeeded", claudeSessionId: "old" });
    const newer = seedRun(taskId, { startedAt: 200, status: "succeeded", claudeSessionId: "new" });
    expect(dbm.runs.newestSessionForHarness(taskId, "claude_session_id", "claude-code")).toEqual({
      sessionId: "new",
      startedAt: 200,
    });
    expect(dbm.runs.newestSessionForHarness(taskId, "claude_session_id", "nope")).toBeNull();
    expect(dbm.runs.hasRunning(taskId)).toBe(false);
    dbm.runs.update(newer, { status: "running" });
    expect(dbm.runs.hasRunning(taskId)).toBe(true);
    dbm.runs.update(newer, { status: "succeeded" });
    expect(older).toBeTruthy();
  });
});
