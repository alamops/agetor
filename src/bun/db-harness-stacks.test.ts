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

function seedTask(opts: { updatedAt?: number } = {}): string {
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
    updatedAt: opts.updatedAt ?? Date.now(),
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
    // updatedAt 1 (not "now"): a write that bumped it to Date.now() would be
    // indistinguishable from the seed if both landed in the same millisecond.
    const taskId = seedTask({ updatedAt: 1 });
    expect(dbm.tasks.get(taskId)!.updatedAt).toBe(1);
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
    expect(after.updatedAt).toBe(1);

    // The generic SET clause skips harness_state: a patch that carries one
    // (a stale copy, or a caller that slipped it past the allow-list) leaves
    // the stored value alone.
    dbm.tasks.update(taskId, {
      harnessState: { stackId: "clobbered", position: 0, tried: [], pendingSwap: null, allExhausted: null, lastMove: null },
    } as never);
    expect(dbm.tasks.get(taskId)?.harnessState?.stackId).toBe("stack-1");
    dbm.tasks.update(taskId, { harnessState: null } as never);
    expect(dbm.tasks.get(taskId)?.harnessState?.stackId).toBe("stack-1");
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
    // A different session re-keys the row: its list names only the new
    // session's files, and the first transfer's file (still on disk) moves to
    // the orphan store under the session it was copied for, so it stays
    // removable (migration 088).
    expect(dbm.harnessSessionHandoffs.get(taskId, "claude-b", "claude_session_id")).toMatchObject({
      sessionId: "s-2",
      copiedPaths: ["/tmp/y.jsonl"],
      createdAt: 20,
    });
    const orphans = () =>
      dbm.harnessOrphanedCopies.list({ harnessId: "claude-b" }).map((r) => [r.sessionId, r.path]);
    expect(orphans()).toEqual([["s-1", "/tmp/x.jsonl"]]);
    // The same session merges, and a repeat path is not duplicated.
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: "claude-b",
      columnName: "claude_session_id",
      sessionId: "s-2",
      copiedPaths: ["/tmp/y.jsonl", "/tmp/z.jsonl"],
      createdAt: 25,
    });
    expect(dbm.harnessSessionHandoffs.get(taskId, "claude-b", "claude_session_id")?.copiedPaths).toEqual([
      "/tmp/y.jsonl",
      "/tmp/z.jsonl",
    ]);
    // Putting the first session back whole reclaims its path from the store.
    dbm.harnessSessionHandoffs.upsert({
      taskId,
      harnessId: "claude-b",
      columnName: "claude_session_id",
      sessionId: "s-1",
      copiedPaths: ["/tmp/x.jsonl"],
      createdAt: 10,
    });
    expect(orphans()).toEqual([
      ["s-2", "/tmp/y.jsonl"],
      ["s-2", "/tmp/z.jsonl"],
    ]);
    dbm.harnessOrphanedCopies.deleteForHarness("claude-b");
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

  test("harnesses.delete removes the account's stack membership explicitly and renumbers the survivors (no FK cascade since 085)", () => {
    const fks = dbm.db.query<{ table: string }, []>(`PRAGMA foreign_key_list(harness_stack_members)`).all();
    expect(fks.map((f) => f.table)).toEqual(["harness_stacks"]);
    const tag = randomUUID().slice(0, 8);
    const ids = ["a", "b", "c"].map((x) => `del-member-${x}-${tag}`);
    for (const id of ids) {
      dbm.harnesses.insert({
        id,
        kind: "claude-code",
        label: id,
        home: mkdtempSync(path.join(tmpdir(), "agetor-del-member-")),
        env: {},
      } as never);
    }
    const stackId = `stack-del-${tag}`;
    dbm.db.run(
      `INSERT INTO harness_stacks (id, label, kind, created_at, updated_at) VALUES (?, 'S', 'claude-code', 1, 1)`,
      [stackId],
    );
    ids.forEach((id, position) =>
      dbm.db.run(`INSERT INTO harness_stack_members (stack_id, harness_id, position) VALUES (?, ?, ?)`, [stackId, id, position]),
    );
    dbm.harnesses.delete(ids[1]!);
    const rows = dbm.db
      .query<{ harness_id: string; position: number }, [string]>(
        `SELECT harness_id, position FROM harness_stack_members WHERE stack_id = ? ORDER BY position`,
      )
      .all(stackId);
    expect(rows).toEqual([
      { harness_id: ids[0]!, position: 0 },
      { harness_id: ids[2]!, position: 1 },
    ]);
    // The membership change bumps the stack's updated_at (optimistic edits).
    expect(
      dbm.db.query<{ updated_at: number }, [string]>(`SELECT updated_at FROM harness_stacks WHERE id = ?`).get(stackId)!.updated_at,
    ).toBeGreaterThan(1);
    dbm.db.run(`DELETE FROM harness_stacks WHERE id = ?`, [stackId]);
    for (const id of [ids[0]!, ids[2]!]) dbm.harnesses.delete(id);
  });

  test("mainUserRows/hasToolUse read the main run stream", () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    expect(dbm.runs.mainUserRows(runId).map((r) => r.data)).toEqual([]);
    expect(dbm.runs.hasToolUse(runId)).toBe(false);
    dbm.runs.appendEvent(runId, "user", "hello");
    dbm.runs.appendEvent(runId, "assistant", "hi");
    expect(dbm.runs.mainUserRows(runId).map((r) => r.data)).toEqual(["hello"]);
    // A folded follow-up and a subagent's own user event: the retry needs the
    // ordered main-stream texts and must never pick up a subagent's.
    dbm.runs.appendEvent(runId, "user", "follow-up");
    dbm.runs.appendEvent(runId, "user", "subagent words", null, "agent-1");
    expect(dbm.runs.mainUserRows(runId).map((r) => r.data)).toEqual(["hello", "follow-up"]);
    dbm.runs.appendEvent(runId, "tool_use", JSON.stringify({ id: "t1", name: "Bash" }));
    expect(dbm.runs.hasToolUse(runId)).toBe(true);
  });

  test("mainUserRows marks twin exactly on rows that carry a line_uuid", () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    dbm.runs.appendEvent(runId, "user", "typed, no twin");
    dbm.runs.appendEvent(runId, "user", "from the jsonl", `uuid-${randomUUID()}`);
    dbm.runs.appendEvent(runId, "user", "typed again");
    dbm.runs.appendEvent(runId, "assistant", "ignored", `uuid-${randomUUID()}`);
    expect(dbm.runs.mainUserRows(runId)).toEqual([
      { data: "typed, no twin", twin: false },
      { data: "from the jsonl", twin: true },
      { data: "typed again", twin: false },
    ]);
  });

  test("087: swap history survives a task delete and an account delete; limit and provenance rows go with the account", () => {
    const tag = randomUUID().slice(0, 8);
    const accountId = `hist-acct-${tag}`;
    dbm.harnesses.insert({
      id: accountId, kind: "claude-code", label: accountId,
      home: mkdtempSync(path.join(tmpdir(), "agetor-hist-")), env: {},
    } as never);
    const stackId = `hist-stack-${tag}`;
    dbm.db.run(`INSERT INTO harness_stacks (id, label, kind, created_at, updated_at) VALUES (?, 'H', 'claude-code', 1, 1)`, [stackId]);
    const taskId = seedTask();
    dbm.db.run(
      `INSERT INTO harness_swap_events (id, stack_id, task_id, task_title, from_harness_id, from_label, to_harness_id, to_label, trigger, at)
       VALUES (?, ?, ?, 'Title', ?, 'From label', 'other', 'To label', 'limit', 5)`,
      [`ev-${tag}`, stackId, taskId, accountId],
    );
    dbm.db.run(`INSERT INTO harness_limit_state (harness_id, model, reason, source, exhausted_until_ms, updated_at) VALUES (?, '', 'quota', 'claude-pane', 9, 1)`, [accountId]);
    dbm.db.run(`INSERT INTO harness_limit_state (harness_id, model, reason, source, exhausted_until_ms, updated_at) VALUES (?, 'm1', 'quota', 'codex-error', 9, 1)`, [accountId]);
    dbm.db.run(`INSERT INTO harness_mirror_provenance (harness_id, scope, path, updated_at) VALUES (?, 'file', '/p', 1)`, [accountId]);
    const events = () =>
      dbm.db.query<{ task_title: string; from_label: string }, [string]>(`SELECT task_title, from_label FROM harness_swap_events WHERE stack_id = ?`).all(stackId);

    expect(dbm.db.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).get()!.foreign_keys).toBe(1);
    dbm.db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    expect(events()).toEqual([{ task_title: "Title", from_label: "From label" }]);
    dbm.harnesses.delete(accountId);
    expect(events()).toEqual([{ task_title: "Title", from_label: "From label" }]);
    for (const table of ["harness_limit_state", "harness_mirror_provenance"]) {
      expect(dbm.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE harness_id = ?`).get(accountId)!.n).toBe(0);
    }
    // The cascade is on the stack only.
    dbm.db.run(`DELETE FROM harness_stacks WHERE id = ?`, [stackId]);
    expect(events()).toEqual([]);
  });

  test("lastUserEventId skips a hidden harness-stack continuation (live echo and pasted_content twin) but not prose mentioning the tag", () => {
    const taskId = seedTask();
    const runId = seedRun(taskId);
    const wrapped = "<harness-stack-continuation>\nContinue the task.\n</harness-stack-continuation>";
    const real = dbm.runs.appendEvent(runId, "user", "the user's real message")!.id;
    dbm.runs.appendEvent(runId, "assistant", "ok");
    dbm.runs.appendEvent(runId, "user", wrapped);
    dbm.runs.appendEvent(runId, "user", `<pasted_content id="ab12">\n${wrapped}\n</pasted_content id="ab12">`);
    expect(dbm.isHiddenContinuationUserText(wrapped)).toBe(true);
    expect(dbm.isHiddenContinuationUserText(`<pasted_content id="ab12">\n${wrapped}\n</pasted_content id="ab12">`)).toBe(true);
    expect(dbm.runs.lastUserEventId(taskId)).toBe(real);
    // More hidden rows than one page: the walk keeps paging back.
    for (let i = 0; i < 12; i++) dbm.runs.appendEvent(runId, "user", wrapped);
    expect(dbm.runs.lastUserEventId(taskId)).toBe(real);
    // A user message that merely mentions the tag in prose is a real anchor.
    const prose = dbm.runs.appendEvent(runId, "user", `what does ${wrapped} mean? and more`)!.id;
    expect(dbm.runs.lastUserEventId(taskId)).toBe(prose);
    // beforeId still bounds the walk.
    expect(dbm.runs.lastUserEventId(taskId, prose)).toBe(real);
    expect(dbm.runs.lastUserEventId(taskId, real)).toBeNull();
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
